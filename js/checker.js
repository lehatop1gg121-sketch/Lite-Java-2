/**
 * checker.js — Умная проверка решений
 *
 * Порядок проверки:
 * 1. Реальная компиляция и запуск (Piston API → Wandbox fallback)
 * 2. Проверка вывода программы vs expected
 * 3. Проверка codeContains (только в реальном коде, не в комментариях/строках)
 */

window.SmartChecker = {

    // ── Вспомогательные методы ──────────────────────────────────────────

    /**
     * Убирает комментарии и строковые литералы,
     * чтобы ключевые слова в них не засчитывались.
     */
    stripCommentsAndStrings(code) {
        let result = '';
        let i = 0;
        const len = code.length;
        while (i < len) {
            if (code[i] === '/' && code[i + 1] === '/') {
                while (i < len && code[i] !== '\n') i++;
                result += ' '; continue;
            }
            if (code[i] === '/' && code[i + 1] === '*') {
                i += 2;
                while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i++;
                i += 2; result += ' '; continue;
            }
            if (code[i] === '"') {
                i++;
                while (i < len && !(code[i] === '"' && code[i - 1] !== '\\')) i++;
                i++; result += '""'; continue;
            }
            if (code[i] === "'") {
                i++;
                while (i < len && !(code[i] === "'" && code[i - 1] !== '\\')) i++;
                i++; result += "''"; continue;
            }
            result += code[i]; i++;
        }
        return result;
    },

    containsPattern(rawCode, pattern) {
        const cleanCode = this.stripCommentsAndStrings(rawCode);
        try {
            return new RegExp(pattern, 'i').test(cleanCode);
        } catch (e) {
            return cleanCode.includes(pattern.replace(/\\\\/g, '\\').replace(/\\/g, ''));
        }
    },

    normalizeOutput(str) {
        return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    },

    outputMatches(actual, expected) {
        const a = this.normalizeOutput(actual);
        const e = this.normalizeOutput(expected);
        return a === e || a.toLowerCase().includes(e.toLowerCase()) ||
               a.replace(/\s+/g, '') === e.replace(/\s+/g, '');
    },

    // ── Компиляторы ─────────────────────────────────────────────────────

    /**
     * Запуск через Piston API (emkc.org), таймаут 8 с.
     * Возвращает { output, compileError, runtimeError } или бросает исключение.
     */
    async runViaPiston(pistonFiles) {
        // Версия Java
        let javaVersion = '15.0.2';
        try {
            const ctrl = new AbortController();
            const tid  = setTimeout(() => ctrl.abort(), 5000);
            const res  = await fetch('https://emkc.org/api/v2/piston/runtimes', { signal: ctrl.signal });
            clearTimeout(tid);
            if (res.ok) {
                const rt = await res.json();
                const jv = rt.find(r => r.language === 'java');
                if (jv) javaVersion = jv.version;
            }
        } catch { /* используем дефолтную */ }

        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 8000);
        let response;
        try {
            response = await fetch('https://emkc.org/api/v2/piston/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: ctrl.signal,
                body: JSON.stringify({ language: 'java', version: javaVersion, files: pistonFiles })
            });
        } finally {
            clearTimeout(tid);
        }

        if (response.status === 429) throw new Error('RATE_LIMIT');
        if (!response.ok)           throw new Error(`HTTP_${response.status}`);

        const data = await response.json();
        if (data.compile && data.compile.code !== 0) {
            return { compileError: true, output: (data.compile.output || data.compile.stderr || '').trim() };
        }
        if (data.run) {
            const out = (data.run.output || '').trim();
            if (data.run.code !== 0 && data.run.stderr) {
                return { runtimeError: true, output: (data.run.output || data.run.stderr || '').trim() };
            }
            return { output: out };
        }
        return { output: '' };
    },

    /**
     * Запуск через Wandbox (wandbox.org) — японский сервис, таймаут 12 с.
     * Используется как fallback когда Piston недоступен.
     */
    async runViaWandbox(mainCode) {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 12000);
        let response;
        try {
            response = await fetch('https://wandbox.org/api/compile.json', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: ctrl.signal,
                body: JSON.stringify({
                    compiler: 'openjdk-head',
                    code: mainCode,
                    options: '',
                    'compiler-option-raw': ''
                })
            });
        } finally {
            clearTimeout(tid);
        }

        if (!response.ok) throw new Error(`Wandbox HTTP ${response.status}`);

        const data = await response.json();

        // Ошибка компиляции
        if (data.status !== '0' && data.compiler_error) {
            return { compileError: true, output: (data.compiler_error || '').trim() };
        }
        // Ошибка выполнения
        if (data.status !== '0' && data.program_error) {
            return { runtimeError: true, output: (data.program_error || '').trim() };
        }
        return { output: (data.program_output || '').trim() };
    },

    // ── Главная функция ──────────────────────────────────────────────────

    async check(task, filesObj) {
        const result   = { success: false, message: '', detail: '' };
        const allCode  = Object.values(filesObj).join('\n');
        const mainCode = filesObj['Main.java'] || allCode;

        const pistonFiles = Object.keys(filesObj).map(name => ({ name, content: filesObj[name] }));

        let runResult = null;
        let usedCompiler = '';

        // Пробуем Piston → если не вышло, пробуем Wandbox
        try {
            runResult    = await this.runViaPiston(pistonFiles);
            usedCompiler = 'Piston';
        } catch (pistonErr) {
            console.warn('[SmartChecker] Piston недоступен:', pistonErr.message, '→ пробуем Wandbox');
            try {
                runResult    = await this.runViaWandbox(mainCode);
                usedCompiler = 'Wandbox';
            } catch (wandboxErr) {
                console.error('[SmartChecker] Wandbox тоже недоступен:', wandboxErr.message);
                result.message = '⚠️ Оба сервера компиляции недоступны';
                result.detail  = `Piston: ${pistonErr.message}\nWandbox: ${wandboxErr.message}\n\nПопробуйте через несколько минут.`;
                return result;
            }
        }

        // ── Ошибка компиляции ──────────────────────────────────────────
        if (runResult.compileError) {
            result.message = '✗ Ошибка компиляции — код не является валидным Java';
            result.detail  = runResult.output.split('\n').filter(l => l.trim()).slice(0, 8).join('\n');
            return result;
        }

        // ── Ошибка выполнения ──────────────────────────────────────────
        if (runResult.runtimeError) {
            result.message = '✗ Ошибка во время выполнения программы';
            result.detail  = runResult.output.split('\n').filter(l => l.trim()).slice(0, 5).join('\n');
            return result;
        }

        // ── Проверка вывода ────────────────────────────────────────────
        if (!this.outputMatches(runResult.output, task.expected)) {
            result.message = '✗ Программа скомпилировалась, но вывод неверный';
            result.detail  = `Ожидалось: "${task.expected}"\nПолучено:  "${runResult.output || '(пустой вывод)'}"`;
            return result;
        }

        // ── Проверка конструкций кода (не в комментариях/строках) ─────
        if (task.codeContains && task.codeContains.length > 0) {
            for (const pattern of task.codeContains) {
                if (!this.containsPattern(allCode, pattern)) {
                    const human = pattern.replace(/\\\\/g, '').replace(/\\/g, '').trim();
                    result.message = '✗ Вывод верный, но нужная конструкция не используется';
                    result.detail  = `Необходимо использовать: <code>${human}</code>\nУбедитесь, что элемент языка применён в коде, а не упомянут в комментарии.`;
                    return result;
                }
            }
        }

        // ── Всё прошло ────────────────────────────────────────────────
        result.success = true;
        result.message = '✓ Решение принято! Отличная работа!';
        result.detail  = runResult.output ? `Вывод: "${runResult.output}" (via ${usedCompiler})` : '';
        return result;
    }
};
