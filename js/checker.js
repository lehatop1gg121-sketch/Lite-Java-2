/**
 * checker.js — Умная проверка решений
 *
 * АЛГОРИТМ:
 * 1. Отправляем код на Piston API → реальная компиляция и выполнение
 * 2. Если ошибка компиляции → ПРОВАЛ (показываем ошибку компилятора)
 * 3. Если вывод совпадает с expected → проверяем codeContains
 *    (ключевые слова в комментариях и строках НЕ считаются)
 * 4. Только если ВСЁ совпало → SUCCESS
 */

window.SmartChecker = {

    /**
     * Убирает комментарии и строковые литералы из кода,
     * чтобы ключевые слова в них не засчитывались.
     */
    stripCommentsAndStrings(code) {
        let result = '';
        let i = 0;
        const len = code.length;

        while (i < len) {
            // Однострочный комментарий //
            if (code[i] === '/' && code[i + 1] === '/') {
                while (i < len && code[i] !== '\n') i++;
                result += ' ';
                continue;
            }
            // Многострочный комментарий /* ... */
            if (code[i] === '/' && code[i + 1] === '*') {
                i += 2;
                while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i++;
                i += 2;
                result += ' ';
                continue;
            }
            // Строковый литерал "..."
            if (code[i] === '"') {
                i++;
                while (i < len && !(code[i] === '"' && code[i - 1] !== '\\')) i++;
                i++;
                result += '""';
                continue;
            }
            // Символьный литерал '...'
            if (code[i] === "'") {
                i++;
                while (i < len && !(code[i] === "'" && code[i - 1] !== '\\')) i++;
                i++;
                result += "''";
                continue;
            }
            result += code[i];
            i++;
        }
        return result;
    },

    /**
     * Проверяет наличие паттерна ТОЛЬКО в реальном коде
     * (не в комментариях, не внутри строк).
     */
    containsPattern(rawCode, pattern) {
        const cleanCode = this.stripCommentsAndStrings(rawCode);
        try {
            const regex = new RegExp(pattern, 'i');
            return regex.test(cleanCode);
        } catch (e) {
            const plain = pattern.replace(/\\\\/g, '\\').replace(/\\/g, '');
            return cleanCode.includes(plain);
        }
    },

    /**
     * Нормализует вывод: trim, lowercase.
     */
    normalizeOutput(str) {
        return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    },

    /**
     * Гибкое сравнение вывода с ожидаемым.
     */
    outputMatches(actual, expected) {
        const nActual   = this.normalizeOutput(actual);
        const nExpected = this.normalizeOutput(expected);
        const cActual   = nActual.replace(/\s+/g, '');
        const cExpected = nExpected.replace(/\s+/g, '');

        return (
            nActual === nExpected ||
            nActual.toLowerCase().includes(nExpected.toLowerCase()) ||
            cActual === cExpected
        );
    },

    /**
     * Получить версию Java из Piston API (с таймаутом).
     */
    async getJavaVersion() {
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 5000);
            const res = await fetch('https://emkc.org/api/v2/piston/runtimes', { signal: controller.signal });
            clearTimeout(tid);
            if (!res.ok) return '15.0.2';
            const runtimes = await res.json();
            const javaRuntime = runtimes.find(r => r.language === 'java');
            return javaRuntime ? javaRuntime.version : '15.0.2';
        } catch {
            return '15.0.2';
        }
    },

    /**
     * Главная функция проверки решения.
     */
    async check(task, filesObj) {
        const result = { success: false, message: '', detail: '' };
        const allCode = Object.values(filesObj).join('\n');

        let compileError  = false;
        let runtimeError  = false;
        let programOutput = '';

        // ── ЭТАП 1: Запуск через Piston API ─────────────────────────────
        try {
            const pistonFiles = Object.keys(filesObj).map(name => ({
                name,
                content: filesObj[name]
            }));

            const javaVersion = await this.getJavaVersion();

            // Таймаут 15 секунд
            const controller = new AbortController();
            const timeoutId  = setTimeout(() => controller.abort(), 15000);

            let response;
            try {
                response = await fetch('https://emkc.org/api/v2/piston/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify({
                        language: 'java',
                        version: javaVersion,
                        files: pistonFiles
                    })
                });
            } finally {
                clearTimeout(timeoutId);
            }

            if (response.status === 429) {
                result.message = '⚠️ Сервер компилятора перегружен';
                result.detail  = 'Подождите 10–15 секунд и попробуйте снова.';
                return result;
            }

            if (!response.ok) {
                result.message = `⚠️ Ошибка сервера компилятора (код ${response.status})`;
                result.detail  = 'Попробуйте повторить через несколько секунд.';
                return result;
            }

            const data = await response.json();

            if (data.compile && data.compile.code !== 0) {
                compileError  = true;
                programOutput = (data.compile.output || data.compile.stderr || '').trim();
            } else if (data.run) {
                if (data.run.code !== 0 && data.run.stderr) {
                    runtimeError  = true;
                    programOutput = (data.run.output || data.run.stderr || '').trim();
                } else {
                    programOutput = (data.run.output || '').trim();
                }
            }

        } catch (err) {
            // Выводим реальную ошибку в консоль для отладки
            console.error('[SmartChecker] Piston fetch error:', err.name, err.message);

            if (err.name === 'AbortError') {
                result.message = '⚠️ Сервер компилятора не ответил вовремя (таймаут 15 с)';
                result.detail  = 'Попробуйте ещё раз. Если проблема повторяется — Piston API временно недоступен.';
            } else if (err.message && err.message.includes('Failed to fetch')) {
                result.message = '⚠️ Не удалось подключиться к компилятору';
                result.detail  = 'Возможные причины:\n• Piston API (emkc.org) временно недоступен\n• Запрос заблокирован браузером или антивирусом\n\nОткройте консоль браузера (F12) для подробностей.';
            } else {
                result.message = '⚠️ Ошибка при обращении к компилятору';
                result.detail  = `${err.name}: ${err.message}\n\nОткройте консоль (F12) для подробностей.`;
            }
            return result;
        }

        // ── ЭТАП 2: Ошибка компиляции ───────────────────────────────────
        if (compileError) {
            const errorLines = programOutput
                .split('\n')
                .filter(l => l.trim())
                .slice(0, 8)
                .join('\n');

            result.message = '✗ Ошибка компиляции — код не является валидным Java';
            result.detail  = errorLines;
            return result;
        }

        // ── ЭТАП 3: Ошибка выполнения ────────────────────────────────────
        if (runtimeError) {
            const errorLines = programOutput
                .split('\n')
                .filter(l => l.trim())
                .slice(0, 5)
                .join('\n');

            result.message = '✗ Ошибка во время выполнения программы';
            result.detail  = errorLines;
            return result;
        }

        // ── ЭТАП 4: Проверка вывода программы ───────────────────────────
        if (!this.outputMatches(programOutput, task.expected)) {
            const shown = programOutput || '(пустой вывод)';
            result.message = '✗ Программа скомпилировалась, но вывод неверный';
            result.detail  = `Ожидалось: "${task.expected}"\nПолучено:  "${shown}"`;
            return result;
        }

        // ── ЭТАП 5: Проверка используемых конструкций (codeContains) ────
        // Только после успешной компиляции и правильного вывода.
        // Ключевые слова в комментариях и строках НЕ считаются.
        if (task.codeContains && task.codeContains.length > 0) {
            for (const pattern of task.codeContains) {
                if (!this.containsPattern(allCode, pattern)) {
                    const human = pattern
                        .replace(/\\\\/g, '')
                        .replace(/\\/g, '')
                        .trim();

                    result.message = '✗ Вывод верный, но нужная конструкция не используется';
                    result.detail  = `Необходимо использовать: <code>${human}</code>\nУбедитесь, что элемент языка применён в коде, а не упомянут в комментарии.`;
                    return result;
                }
            }
        }

        // ── ВСЁ ПРОШЛО ──────────────────────────────────────────────────
        result.success = true;
        result.message = '✓ Решение принято! Отличная работа!';
        result.detail  = programOutput ? `Вывод программы: "${programOutput}"` : '';
        return result;
    }
};
