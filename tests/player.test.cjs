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
    for (const id of ['status', 'image0', 'image1', 'video0', 'video1']) {
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
        carouselMedia: media,
        document: { getElementById: id => elements[id] },
        console: { warn() {} }, location: { reload() {} },
        Date: { now: () => now },
        setTimeout: (fn, ms) => timer(fn, ms, false),
        setInterval: (fn, ms) => timer(fn, ms, true),
        clearTimeout: id => timers.delete(id)
    });
    return {
        elements,
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
    assert.equal(p.elements.image1.src, '/static/screen/b.jpg');
    assert.equal(p.elements.video0.src, '');
    p.tick(5000);
    assert.equal(p.elements.image0.style.visibility, 'visible');
    p.event('image1', 'onload');
    assert.equal(p.elements.image1.style.visibility, 'visible');
    assert.equal(p.elements.image0.style.visibility, 'hidden');
    assert.equal(p.elements.image0.src, '/static/screen/c.jpg');
});

test('Carga agotada salta el archivo; un callback antiguo no cambia el nuevo', () => {
    const p = player(['bad.jpg', 'good.jpg']);
    const oldLoad = p.elements.image0.onload;
    p.tick(20000);
    assert.equal(p.elements.image0.src, undefined);
    p.tick(1000);
    assert.equal(p.elements.image0.src, '/static/good.jpg');
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
    assert.equal(p.elements.image0.src, '/static/b.jpg');
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
        assert.equal(p.elements.image0.src, '/static/bad.jpg');
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
    assert.equal(p.elements.image0.src, '/static/b.jpg');
});

test('Lista vacía muestra un mensaje y nombres especiales se codifican', () => {
    const empty = player([]);
    assert.equal(empty.elements.status.textContent, 'No hay contenido disponible.');
    const p = player(['screen/aviso #1.jpg']);
    assert.equal(p.elements.image0.src, '/static/screen/aviso%20%231.jpg');
});
