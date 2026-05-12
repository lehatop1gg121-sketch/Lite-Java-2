/**
 * checker.js — Умная проверка решений
 *
 * АЛГОРИТМ:
 * 1. Отправляем код на Piston API → реальная компиляция и выполнение
 * 2. Если ошибка компиляции → ПРОВАЛ (показываем ошибку)
 * 3. Если вывод совпадает с expected → проверяем codeContains
 *    (ключевые слова в комментариях и строках НЕ считаются)
 * 4. Только если ВСЁ совпало → SUCCESS
 *
 * Если интернет недоступен → задание НЕ засчитывается.
 * Обойти проверку "написав ключевые слова" невозможно — код обязан компилироваться
 * и давать правильный вывод.
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
     * (не в комментариях и не внутри строк).
     * Поддерживает regex-паттерны из roadmap.json.
     */
    containsPattern(rawCode, pattern) {
        const cleanCode = this.stripCommentsAndStrings(rawCode);

        try {
            // JSON-паттерны типа "\\+" → создаём реальный regex
            const regex = new RegExp(pattern, 'i');
            return regex.test(cleanCode);
        } catch (e) {
            // Невалидный regex — plain search
            const plain = pattern.replace(/\\\\/g, '\\').replace(/\\/g, '');
            return cleanCode.includes(plain);
        }
    },

    /**
     * Нормализует вывод для сравнения:
     * trim, collapse whitespace, lowercase.
     */
    normalizeOutput(str) {
        return str
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .trim();
    },

    /**
     * Гибкое сравнение вывода программы с ожидаемым.
     * Проверяет точное совпадение, вхождение и компактное совпадение.
     */
    outputMatches(actual, expected) {
        const nActual  = this.normalizeOutput(actual);
        const nExpected = this.normalizeOutput(expected);

        // Компактные версии (без пробелов) для числовых ответов вроде "1 2 3" vs "123"
        const cActual   = nActual.replace(/\s+/g, '');
        const cExpected = nExpected.replace(/\s+/g, '');

        return (
            nActual === nExpected              ||  // точное совпадение
            nActual.toLowerCase().includes(nExpected.toLowerCase()) ||  // вхождение (case-insensitive)
            cActual === cExpected                  // компактное совпадение
        );
    },

    /**
     * Получить версию Java из Piston API.
     */
    async getJavaVersion() {
        try {
            const res = await fetch('https://emkc.org/api/v2/piston/runtimes');
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
     *
     * @param {Object} task — объект задачи из roadmap.json { expected, codeContains }
     * @param {Object} filesObj — { 'Main.java': '...', 'Car.java': '...' }
     * @returns {Object} { success: bool, message: string, detail: string }
     */
    async check(task, filesObj) {
        const result = { success: false, message: '', detail: '' };
        const allCode = Object.values(filesObj).join('\n');

        // ── ЭТАП 1: Запуск через Piston API ─────────────────────────────
        let pistonAvailable = true;
        let compileError    = false;
        let runtimeError    = false;
        let programOutput   = '';

        try {
            const pistonFiles = Object.keys(filesObj).map(name => ({
                name,
                content: filesObj[name]
            }));

            const javaVersion = await this.getJavaVersion();

            const response = await fetch('https://emkc.org/api/v2/piston/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    language: 'java',
                    version: javaVersion,
                    files: pistonFiles
                })
            });

            if (response.status === 429) {
                throw new Error('rate_limit');
            }
            if (!response.ok) {
                throw new Error(`http_${response.status}`);
            }

            const data = await response.json();

            // Ошибка компиляции
            if (data.compile && data.compile.code !== 0) {
                compileError = true;
                programOutput = (data.compile.output || data.compile.stderr || '').trim();
            } else if (data.run) {
                if (data.run.code !== 0 && data.run.stderr) {
                    runtimeError = true;
                    programOutput = (data.run.output || data.run.stderr || '').trim();
                } else {
                    programOutput = (data.run.output || '').trim();
                }
            }

        } catch (networkError) {
            pistonAvailable = false;

            if (networkError.message === 'rate_limit') {
                result.message = '⚠️ Сервер перегружен. Подождите несколько секунд и попробуйте снова.';
                result.detail  = 'Лимит запросов к компилятору исчерпан.';
                return result;
            }

            // Нет интернета — не принимаем решение без компиляции
            result.message = '⚠️ Нет соединения с сервером компиляции';
            result.detail  = 'Для проверки решения необходим интернет. Убедитесь в подключении и попробуйте ещё раз.';
            return result;
        }

        // ── ЭТАП 2: Проверка результата компиляции ──────────────────────
        if (compileError) {
            // Берём первые 8 строк ошибки — они самые информативные
            const errorLines = programOutput
                .split('\n')
                .filter(l => l.trim())
                .slice(0, 8)
                .join('\n');

            result.message = '✗ Ошибка компиляции — код не является валидным Java';
            result.detail  = errorLines;
            return result;
        }

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

        // ── ЭТАП 3: Проверка вывода программы ───────────────────────────
        if (!this.outputMatches(programOutput, task.expected)) {
            const shown = programOutput || '(пустой вывод)';
            result.message = '✗ Программа скомпилировалась, но вывод неверный';
            result.detail  = `Ожидалось: "${task.expected}"\nПолучено:  "${shown}"`;
            return result;
        }

        // ── ЭТАП 4: Семантическая проверка кода (codeContains) ──────────
        // Выполняется ТОЛЬКО после успешной компиляции и правильного вывода.
        // Гарантирует, что нужные конструкции Java реально использованы в коде.
        if (task.codeContains && task.codeContains.length > 0) {
            for (const pattern of task.codeContains) {
                if (!this.containsPattern(allCode, pattern)) {
                    // Генерируем читаемый вид паттерна для пользователя
                    const human = pattern
                        .replace(/\\\\/g, '')
                        .replace(/\\/g, '')
                        .trim();

                    result.message = `✗ Вывод верный, но нужная конструкция не используется`;
                    result.detail  = `Необходимо использовать: <code>${human}</code>\n`
                                   + `Подсказка: убедитесь, что вы применяете нужный элемент языка, `
                                   + `а не просто упоминаете его в комментарии.`;
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
