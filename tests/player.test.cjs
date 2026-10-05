const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../templates/player.js'), 'utf8');

// Reloj y elementos simulados para verificar fallas sin esperar minutos.
function player(media, options = {}) {
    let now = 0, nextId = 1;
    const timers = new Map();
    const elements = {};
    const requests = [];
    let reloads = 0;
    function FakeXHR() { requests.push(this); }
    FakeXHR.prototype.open = function (method, url) { this.url = url; };
    FakeXHR.prototype.setRequestHeader = function (name, value) { this.etag = value; };
    FakeXHR.prototype.send = function () {};
    FakeXHR.prototype.abort = function () { this.aborted = true; };
    for (const id of ['status', 'offline-status', 'image0', 'image1', 'video0', 'video1']) {
        elements[id] = {
            style: {}, currentTime: 0, src: '',
            removeAttribute(name) { delete this[name]; },
            pause() { this.paused = true; }, load() {},
            play() {
                this.paused = false;
                if (options.reject) return { catch(fn) { fn(new Error('blocked')); } };
                // Retorno indefinido de televisiones con navegadores antiguos.
            }
        };
    }
    function timer(fn, ms, repeat) {
        const id = nextId++;
        timers.set(id, { fn, at: now + ms, repeat: repeat ? ms : 0 });
        return id;
    }
    vm.runInNewContext(source, {
        carouselMedia: media.map(file => ({ file, version: '1' })),
        carouselVersion: 'initial', carouselManifestUrl: '/api/pantallas/screen/media',
        XMLHttpRequest: FakeXHR,
        createCarouselCache: options.cacheFactory || (() => ({
            ready: false, count: 0, sync() {}, reject() {}, has() { return false; },
            resolve(entry, done) { done(null); }, revoke() {}
        })),
        document: { getElementById: id => elements[id] },
        console: { warn() {} }, location: { reload() { reloads++; } },
        Date: { now: () => now },
        setTimeout: (fn, ms) => timer(fn, ms, false),
        setInterval: (fn, ms) => timer(fn, ms, true),
        clearTimeout: id => timers.delete(id)
    });
    return {
        elements,
        requests,
        get reloads() { return reloads; },
        respond(status, body) {
            const xhr = requests[requests.length - 1];
            xhr.status = status;
            xhr.responseText = typeof body === 'string' ? body : JSON.stringify(body);
            if (xhr.onload) xhr.onload();
        },
        event(id, name) { if (elements[id][name]) elements[id][name](); },
        tick(ms) {
            const until = now + ms;
            let iterations = 0;
            while (true) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= until)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                assert.ok(++iterations < 10000, 'Sin bucles de reintentos');
                const [id, t] = due;
                now = t.at;
                if (t.repeat) t.at += t.repeat;
                else timers.delete(id);
                t.fn();
            }
            now = until;
        }
    };
}

test('Mantiene la imagen anterior hasta cargar la siguiente y libera recursos', () => {
    const p = player(['screen/a.jpg', 'screen/b.jpg', 'screen/c.jpg']);
    p.event('image0', 'onload');
    assert.equal(p.elements.image0.style.visibility, 'visible');
    assert.equal(p.elements.image1.src, '/static/screen/b.jpg?v=1');
    assert.equal(p.elements.video0.src, '');
    p.tick(5000);
    assert.equal(p.elements.image0.style.visibility, 'visible');
    p.event('image1', 'onload');
    assert.equal(p.elements.image1.style.visibility, 'visible');
    assert.equal(p.elements.image0.style.visibility, 'hidden');
    assert.equal(p.elements.image0.src, '/static/screen/c.jpg?v=1');
});

test('Carga agotada salta el archivo; un callback antiguo no cambia el nuevo', () => {
    const p = player(['bad.jpg', 'good.jpg']);
    const oldLoad = p.elements.image0.onload;
    p.tick(20000);
    assert.equal(p.elements.image0.src, undefined);
    p.tick(1000);
    assert.equal(p.elements.image0.src, '/static/good.jpg?v=1');
    oldLoad();
    assert.notEqual(p.elements.image0.style.visibility, 'visible');
    p.event('image0', 'onload');
    assert.equal(p.elements.image0.style.visibility, 'visible');
});

test('Videos detenidos avanzan y el siguiente espera hasta reproducirse', () => {
    const p = player(['a.mp4', 'b.mp4']);
    p.event('video0', 'onloadedmetadata');
    p.event('video0', 'onplaying');
    p.event('video1', 'onloadedmetadata');
    assert.equal(p.elements.video1.paused, undefined);
    p.tick(15000);
    assert.equal(p.elements.video1.paused, false);
    assert.equal(p.elements.video0.style.visibility, 'visible');
    p.event('video1', 'onplaying');
    assert.equal(p.elements.video1.style.visibility, 'visible');
    assert.equal(p.elements.video0.paused, true);
});

test('Reproducción rechazada salta al siguiente archivo', () => {
    const p = player(['a.mp4', 'b.jpg'], { reject: true });
    p.event('video0', 'onloadedmetadata');
    assert.equal(p.elements.video0.src, undefined);
    p.tick(1000);
    assert.equal(p.elements.image0.src, '/static/b.jpg?v=1');
    p.event('image0', 'onload');
    assert.equal(p.elements.image0.style.visibility, 'visible');
});

test('Todas las cargas fallidas esperan 30, 60 y hasta 120 segundos', () => {
    const p = player(['bad.jpg']);
    for (const delay of [30000, 60000, 120000, 120000]) {
        p.event('image0', 'onerror');
        p.tick(delay - 1);
        assert.equal(p.elements.image0.src, undefined);
        p.tick(1);
        assert.equal(p.elements.image0.src, '/static/bad.jpg?v=1');
    }
});

test('Precarga fallida no interrumpe prematuramente el video actual', () => {
    const p = player(['a.mp4', 'bad.jpg', 'good.jpg']);
    p.event('video0', 'onloadedmetadata');
    p.event('video0', 'onplaying');
    p.event('image1', 'onerror');
    p.tick(1000);
    p.event('image1', 'onload');
    assert.equal(p.elements.video0.style.visibility, 'visible');
    assert.notEqual(p.elements.image1.style.visibility, 'visible');
    p.event('video0', 'onended');
    assert.equal(p.elements.image1.style.visibility, 'visible');
});

test('Video que nunca empieza también agota su espera', () => {
    const p = player(['a.mp4', 'b.jpg']);
    p.event('video0', 'onloadedmetadata');
    p.tick(20000);
    assert.equal(p.elements.video0.src, undefined);
    p.tick(1000);
    assert.equal(p.elements.image0.src, '/static/b.jpg?v=1');
});

test('Lista vacía muestra un mensaje y nombres especiales se codifican', () => {
    const empty = player([]);
    assert.equal(empty.elements.status.textContent, 'No hay contenido disponible.');
    const p = player(['screen/aviso #1.jpg']);
    assert.equal(p.elements.image0.src, '/static/screen/aviso%20%231.jpg?v=1');
});

test('Sin conexión no recarga, conserva el contenido y reintenta con pausas', () => {
    const p = player(['a.jpg']);
    p.event('image0', 'onload');
    p.tick(60000);
    assert.equal(p.requests.length, 1);
    p.tick(10000);
    assert.equal(p.requests[0].aborted, true);
    assert.equal(p.elements.image0.style.visibility, 'visible');
    p.tick(29999);
    assert.equal(p.requests.length, 1);
    p.tick(1);
    assert.equal(p.requests.length, 2);
    p.respond(503, '');
    p.tick(59999);
    assert.equal(p.requests.length, 2);
    p.tick(1);
    assert.equal(p.requests.length, 3);
    p.respond(304, '');
    p.tick(60000);
    assert.equal(p.requests.length, 4);
    p.tick(1800000);
    assert.equal(p.reloads, 0);
});

test('Cambios durante un video se aplican al terminar sin quitarlo antes', () => {
    const p = player(['a.mp4', 'old.jpg']);
    p.event('video0', 'onloadedmetadata');
    p.event('video0', 'onplaying');
    p.event('image1', 'onload');
    for (let i = 0; i < 60; i++) {
        p.elements.video0.currentTime++;
        p.tick(1000);
    }
    const oldCallback = p.elements.image1.onload;
    p.respond(200, { version: 'new', media: [{ file: 'fresh.jpg', version: '2' }] });
    assert.equal(p.elements.video0.style.visibility, 'visible');
    assert.equal(p.elements.image1.src, '/static/old.jpg?v=1');
    p.event('video0', 'onended');
    assert.equal(p.elements.image1.src, '/static/fresh.jpg?v=2');
    oldCallback();
    assert.equal(p.elements.video0.style.visibility, 'visible');
    p.event('image1', 'onload');
    assert.equal(p.elements.image1.style.visibility, 'visible');
    p.tick(60000);
    assert.equal(p.requests[1].etag, '"new"');
});

test('Respuestas vacías o inválidas y 404 conservan la lista anterior', () => {
    const p = player(['a.jpg']);
    p.event('image0', 'onload');
    p.tick(60000);
    p.respond(200, { version: 'empty', media: [] });
    assert.equal(p.elements.image0.style.visibility, 'visible');
    p.tick(60000);
    assert.equal(p.requests[1].etag, '"initial"');
    p.respond(200, '<html>Error</html>');
    p.tick(30000);
    p.respond(404, '');
    assert.equal(p.elements.image0.style.visibility, 'visible');
    assert.equal(p.reloads, 0);
});

test('Carpeta inicialmente vacía empieza al recibir archivos', () => {
    const p = player([]);
    p.tick(60000);
    p.respond(200, { version: 'new', media: [{ file: 'new.jpg', version: '2' }] });
    assert.equal(p.elements.image0.src, '/static/new.jpg?v=2');
    p.event('image0', 'onload');
    assert.equal(p.elements.image0.style.visibility, 'visible');
});

test('Copias locales se reproducen y sus URLs se liberan al cambiar', () => {
    const revoked = [];
    const p = player(['a.jpg', 'b.jpg'], { cacheFactory: () => ({
        ready: true, count: 2, sync() {}, reject() {}, has() { return true; },
        resolve(entry, done) { done('blob:' + entry.file); },
        revoke(url) { if (url) revoked.push(url); }
    }) });
    assert.equal(p.elements.image0.src, 'blob:a.jpg');
    p.event('image0', 'onload');
    p.event('image1', 'onload');
    p.tick(5000);
    assert.equal(p.elements.image1.style.visibility, 'visible');
    assert.deepEqual(revoked, ['blob:a.jpg']);
});

test('Sin conexión salta archivos no guardados y sigue con la copia local', () => {
    const p = player(['cached.jpg', 'missing.jpg'], { cacheFactory: () => ({
        ready: true, count: 1, sync() {}, reject() {}, has(entry) { return entry.file === 'cached.jpg'; },
        resolve(entry, done) { done(entry.file === 'cached.jpg' ? 'blob:cached' : null); },
        revoke() {}
    }) });
    p.event('image0', 'onload');
    p.tick(70000); // Primera consulta agotada: conexión no disponible.
    p.event('image1', 'onerror');
    p.tick(120000); // Incluye una vuelta de fallos y su espera.
    assert.equal(p.elements.image1.src, 'blob:cached');
    p.event('image1', 'onload');
    assert.equal(p.elements.image0.src, 'blob:cached');
});

test('Lecturas locales tardías se descartan y revocan su URL', () => {
    const callbacks = [];
    const revoked = [];
    const p = player(['a.jpg', 'b.jpg'], { cacheFactory: () => ({
        ready: true, count: 2, sync() {}, reject() {}, has() { return true; },
        resolve(entry, done) { callbacks.push(done); },
        revoke(url) { if (url) revoked.push(url); }
    }) });
    p.tick(21000);
    callbacks[0]('blob:stale');
    assert.deepEqual(revoked, ['blob:stale']);
    callbacks[1]('blob:current');
    assert.equal(p.elements.image0.src, 'blob:current');
});

test('Copia local no reproducible intenta el archivo por red una vez', () => {
    const rejected = [], revoked = [];
    const p = player(['a.jpg'], { cacheFactory: () => ({
        ready: true, count: 1, sync() {}, has() { return true; },
        reject(entry) { rejected.push(entry.file); },
        resolve(entry, done) { done('blob:bad'); },
        revoke(url) { if (url) revoked.push(url); }
    }) });
    p.event('image0', 'onerror');
    assert.equal(p.elements.image0.src, '/static/a.jpg?v=1');
    assert.deepEqual(rejected, ['a.jpg']);
    assert.deepEqual(revoked, ['blob:bad']);
    p.event('image0', 'onerror');
    assert.equal(p.elements.image0.src, undefined);
});
