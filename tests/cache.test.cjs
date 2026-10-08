const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../templates/cache.js'), 'utf8');
const MB = 1024 * 1024;

// Persistencia y red simuladas para comprobar límites y manejo de errores.
function cacheHarness(options = {}) {
    let now = 0, id = 0;
    const timers = new Map(), rows = options.rows || new Map();
    const requests = [], reports = [], revoked = [];
    const later = (fn, ms = 0) => { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; };
    function tick(ms = 0) {
        const end = now + ms;
        for (let n = 0; n < 10000; n++) {
            const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) { now = end; return; }
            now = due[1].at; timers.delete(due[0]); due[1].fn();
        }
        throw Error('Demasiados eventos');
    }
    const db = {
        close() {}, createObjectStore() {},
        transaction() {
            const tx = { abort() { if (tx.onabort) tx.onabort(); } };
            const complete = () => later(() => { if (tx.oncomplete) tx.oncomplete(); });
            tx.objectStore = () => ({
                get(key) {
                    const r = {};
                    if (!options.hangRead) later(() => {
                        if (r.onsuccess) r.onsuccess({ target: { result: rows.get(key) } });
                        complete();
                    });
                    return r;
                },
                put(row) {
                    later(() => {
                        if (options.quota) { if (tx.onabort) tx.onabort(); }
                        else { rows.set(row.file, row); complete(); }
                    });
                },
                openCursor() {
                    const r = {}, all = [...rows.values()];
                    let pos = 0;
                    function send() {
                        const row = all[pos++];
                        r.onsuccess({ target: { result: row ? {
                            value: row, delete() { rows.delete(row.file); },
                            continue() { later(send); }
                        } : null } });
                        if (!row) complete();
                    }
                    later(send); return r;
                }
            });
            return tx;
        }
    };
    function XHR() { requests.push(this); }
    XHR.prototype.open = function (method, url) { this.url = url; };
    XHR.prototype.send = function () {};
    XHR.prototype.abort = function () { this.aborted = true; };
    const context = {
        window: {
            URL: { createObjectURL: blob => 'blob:' + blob.size, revokeObjectURL: url => revoked.push(url) },
            indexedDB: options.unsupported ? null : { open() {
                const r = {};
                if (!options.hangOpen) later(() => r.onsuccess({ target: { result: db } }));
                return r;
            } }
        }, XMLHttpRequest: XHR,
        setTimeout: later, clearTimeout: key => timers.delete(key)
    };
    vm.createContext(context); vm.runInContext(source, context);
    const cache = context.createCarouselCache('screen', (message, count) => reports.push({ message, count }));
    return { cache, rows, requests, reports, revoked, tick,
        respond(status, size) {
            const xhr = requests.at(-1);
            xhr.status = status; xhr.response = size === undefined ? null : { size };
            if (xhr.onload) xhr.onload(); tick();
        }
    };
}
const entry = (file, size = MB, version = '1') => ({ file, size, version });

test('Descargas secuenciales, máximo 24 MB por archivo y 32 MB en total', () => {
    const h = cacheHarness();
    const list = [entry('too-big.mp4', 25 * MB), entry('0.mp4', 24 * MB), entry('1.mp4', 8 * MB), entry('2.mp4', MB)];
    h.cache.sync(list); h.tick();
    assert.equal(h.requests.length, 1);
    assert.match(h.requests[0].url, /0\.mp4/);
    h.respond(200, 24 * MB); h.tick(500);
    h.respond(200, 8 * MB); h.tick(500);
    assert.equal(h.requests.length, 2);
    assert.equal(h.cache.count, 2);
    assert.equal([...h.rows.values()].reduce((s, row) => s + row.blob.size, 0), 32 * MB);
});

test('Límite de 24 archivos aunque sean pequeños', () => {
    const h = cacheHarness();
    h.cache.sync(Array.from({ length: 30 }, (_, n) => entry(n + '.jpg', 1)));
    h.tick();
    for (let n = 0; n < 24; n++) { h.respond(200, 1); h.tick(500); }
    assert.equal(h.requests.length, 24);
    assert.equal(h.cache.count, 24);
});

test('Copias persistidas se reutilizan sin descargarlas y las URLs se revocan', () => {
    const rows = new Map([['a.jpg', { ...entry('a.jpg'), blob: { size: MB } }]]);
    const h = cacheHarness({ rows });
    h.cache.sync([entry('a.jpg')]); h.tick();
    assert.equal(h.requests.length, 0);
    let url;
    h.cache.resolve(entry('a.jpg'), result => { url = result; }); h.tick();
    assert.equal(url, 'blob:' + MB);
    h.cache.revoke(url);
    assert.deepEqual(h.revoked, [url]);
});

test('Actualizaciones eliminan copias retiradas y versiones anteriores', () => {
    const h = cacheHarness({ rows: new Map([
        ['a.jpg', { ...entry('a.jpg'), blob: { size: MB } }],
        ['removed.jpg', { ...entry('removed.jpg'), blob: { size: MB } }]
    ]) });
    h.cache.sync([entry('a.jpg', MB, '2')]); h.tick();
    assert.equal(h.rows.size, 0);
    h.respond(200, MB); h.tick(500);
    assert.equal(h.rows.get('a.jpg').version, '2');
});

test('Descargas parciales y 404 se omiten; desconexiones esperan nueva sincronización', () => {
    const h = cacheHarness();
    const list = [entry('a.jpg'), entry('b.jpg'), entry('c.jpg')];
    h.cache.sync(list); h.tick();
    h.respond(200, 5); h.tick(500);
    h.respond(404); h.tick(500);
    h.tick(90000);
    assert.equal(h.requests[2].aborted, true);
    assert.equal(h.cache.count, 0);
    h.tick(120000);
    assert.equal(h.requests.length, 3);
    h.cache.sync(list); h.tick();
    assert.equal(h.requests.length, 4);
});

test('Sin soporte o sin respuesta al abrir entrega la alternativa de red', () => {
    for (const options of [{ unsupported: true }, { hangOpen: true }]) {
        const h = cacheHarness(options);
        h.cache.sync([entry('a.jpg')]); h.tick(5000);
        assert.equal(h.cache.supported, false);
        let result = 'pending';
        h.cache.resolve(entry('a.jpg'), url => { result = url; });
        assert.equal(result, null);
    }
});

test('Lecturas que no responden terminan y permiten continuar por red', () => {
    const h = cacheHarness({ hangRead: true, rows: new Map([
        ['a.jpg', { ...entry('a.jpg'), blob: { size: MB } }]
    ]) });
    h.cache.sync([entry('a.jpg')]); h.tick();
    let result = 'pending';
    h.cache.resolve(entry('a.jpg'), url => { result = url; });
    h.tick(5000);
    assert.equal(result, null);
});

test('Manifest cambiado durante descarga no guarda el archivo anterior', () => {
    const h = cacheHarness();
    h.cache.sync([entry('old.jpg')]); h.tick();
    h.cache.sync([entry('new.jpg')]);
    h.respond(200, MB);
    assert.equal(h.rows.size, 0);
    assert.match(h.requests[1].url, /new\.jpg/);
});

test('Copia rechazada no vuelve a seleccionarse hasta cambiar su versión', () => {
    const h = cacheHarness({ rows: new Map([
        ['a.jpg', { ...entry('a.jpg'), blob: { size: MB } }]
    ]) });
    h.cache.sync([entry('a.jpg')]); h.tick();
    h.cache.reject(entry('a.jpg'));
    assert.equal(h.cache.has(entry('a.jpg')), false);
    h.cache.sync([entry('a.jpg')]); h.tick();
    assert.equal(h.requests.length, 0);
    assert.equal(h.rows.size, 0);
    h.cache.sync([entry('a.jpg', MB, '2')]); h.tick();
    assert.equal(h.requests.length, 1);
});

test('Reproductor y arranque comparten una sola descarga completa', () => {
    const h = cacheHarness();
    const file = entry('video.mp4', 24 * MB);
    h.cache.sync([file]);
    let result = 'pending';
    h.cache.resolve(file, url => { result = url; });
    h.tick();
    assert.equal(h.requests.length, 1);
    assert.equal(result, 'pending');
    h.tick(60000);
    h.cache.sync([{ ...file }]);
    h.respond(200, 24 * MB);
    assert.equal(result, 'blob:' + 24 * MB);
    assert.equal(h.cache.has(file), true);
    h.tick(500);
    h.cache.sync([{ ...file }]); h.tick();
    assert.equal(h.requests.length, 1);
});

test('El archivo esperado avanza en la cola sin descargas simultáneas', () => {
    const h = cacheHarness();
    const files = ['a.jpg', 'b.jpg', 'c.jpg'].map(name => entry(name));
    h.cache.sync(files); h.tick();
    let result = 'pending';
    h.cache.resolve(files[2], url => { result = url; });
    assert.equal(h.requests.length, 1);
    h.respond(200, MB); h.tick(500);
    assert.match(h.requests[1].url, /c\.jpg/);
    h.respond(200, MB);
    assert.equal(result, 'blob:' + MB);
    h.tick(500);
    assert.match(h.requests[2].url, /b\.jpg/);
});

test('Cuota agotada conserva copias anteriores y reproduce el blob ya descargado', () => {
    const saved = entry('saved.jpg');
    const file = entry('new.mp4', 24 * MB);
    const h = cacheHarness({ quota: true, rows: new Map([
        [saved.file, { ...saved, blob: { size: MB } }]
    ]) });
    h.cache.sync([saved, file]); h.tick();
    let result;
    h.cache.resolve(file, url => { result = url; });
    h.respond(200, file.size); h.tick(500);
    assert.equal(result, 'blob:' + file.size);
    assert.equal(h.cache.supported, true);
    assert.equal(h.cache.has(saved), true);
    assert.equal(h.cache.has(file), false);
    h.cache.sync([saved, file]); h.tick();
    assert.equal(h.requests.length, 1);
});

test('Cancelar la espera no entrega callbacks viejos ni detiene el guardado', () => {
    const h = cacheHarness();
    const file = entry('a.jpg');
    h.cache.sync([file]); h.tick();
    let called = false;
    const cancel = h.cache.resolve(file, () => { called = true; });
    cancel();
    h.respond(200, MB); h.tick(500);
    assert.equal(called, false);
    assert.equal(h.cache.has(file), true);
});

test('Descarga agotada libera al reproductor y cancela la solicitud', () => {
    const h = cacheHarness();
    const file = entry('a.jpg');
    h.cache.sync([file]); h.tick();
    let result = 'pending';
    h.cache.resolve(file, url => { result = url; });
    h.tick(90000);
    assert.equal(result, null);
    assert.equal(h.requests[0].aborted, true);
});

test('Un aviso urgente cancela la descarga de fondo y obtiene prioridad', () => {
    const h = cacheHarness();
    const video = entry('video.mp4', 24 * MB), notice = entry('notice.jpg');
    h.cache.sync([video, notice]); h.tick();
    let result = 'pending';
    h.cache.resolve(notice, url => { result = url; }, true);
    assert.equal(h.requests[0].aborted, true);
    h.tick(500);
    assert.match(h.requests[1].url, /notice\.jpg/);
    h.respond(200, MB);
    assert.equal(result, 'blob:' + MB);
    h.tick(500);
    h.cache.sync([video, notice]); h.tick();
    assert.match(h.requests[2].url, /video\.mp4/);
});
