// Almacenamiento de archivos completos; no mantiene la lista entera en RAM.
function createCarouselCache(name, report) {
    var MAX_BYTES = 32 * 1024 * 1024;
    var MAX_FILE = 8 * 1024 * 1024;
    var MAX_FILES = 24;
    var db = null;
    var keys = {};
    var rejected = {};
    var enabled = false;
    var opening = true;
    var busy = false;
    var requested = null;
    var objectUrls = window.URL || window.webkitURL;
    var api = { ready: false, supported: false, count: 0 };

    function notify(message) {
        api.count = Object.keys(keys).length;
        report(message, api.count);
    }
    function disable() {
        enabled = false;
        opening = false;
        api.ready = true;
        api.supported = false;
        keys = {};
        if (db) { db.close(); db = null; }
        notify('Almacenamiento local no disponible');
    }
    // Cada operación tiene límite, incluso si el navegador no devuelve eventos.
    function transaction(mode, work, done) {
        if (!enabled) { done(false); return; }
        var tx;
        var finished = false;
        var timer = setTimeout(function () {
            finish(false);
            try { tx.abort(); } catch (error) {}
        }, 3000);
        function finish(ok) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            done(ok);
        }
        try {
            tx = db.transaction('files', mode);
            tx.oncomplete = function () { finish(true); };
            tx.onerror = tx.onabort = function () { finish(false); };
            work(tx.objectStore('files'));
        } catch (error) { finish(false); }
    }
    function source(entry) {
        if (entry.url) return entry.url + (entry.url.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(entry.version);
        return '/static/' + entry.file.split('/').map(encodeURIComponent).join('/') +
               '?v=' + encodeURIComponent(entry.version);
    }
    api.has = function (entry) { return keys[entry.file] === entry.version; };
    api.reject = function (entry) {
        rejected[entry.file] = entry.version;
        delete keys[entry.file];
        notify('Copia local no reproducible');
    };
    api.resolve = function (entry, done) {
        if (!enabled || !api.has(entry)) { done(null); return; }
        var row;
        transaction('readonly', function (store) {
            store.get(entry.file).onsuccess = function (event) { row = event.target.result; };
        }, function (ok) {
            var result = null;
            if (ok && row && row.version === entry.version) {
                try { result = objectUrls.createObjectURL(row.blob); } catch (error) {}
            }
            if (!result) { delete keys[entry.file]; notify('Preparando contenido'); }
            done(result);
        });
    };
    api.revoke = function (url) {
        if (url) { try { objectUrls.revokeObjectURL(url); } catch (error) {} }
    };

    function download(entry, done) {
        var xhr = new XMLHttpRequest();
        var finished = false;
        var timer = setTimeout(function () { finish(null); xhr.abort(); }, 30000);
        function finish(blob, skip) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            xhr.onload = xhr.onerror = xhr.onabort = xhr.onprogress = null;
            done(blob, skip);
        }
        xhr.onerror = xhr.onabort = function () { finish(null); };
        xhr.onprogress = function (event) {
            if (event.loaded > MAX_FILE || (event.lengthComputable && event.total > MAX_FILE)) {
                finish(null);
                xhr.abort();
            }
        };
        xhr.onload = function () {
            var blob = xhr.response;
            finish(xhr.status === 200 && blob && blob.size === entry.size &&
                   blob.size <= MAX_FILE ? blob : null, xhr.status === 200 || xhr.status === 404);
        };
        try {
            xhr.open('GET', source(entry), true);
            xhr.responseType = 'blob';
            if (xhr.responseType !== 'blob') { finish(null); return; }
            xhr.send();
        } catch (error) { finish(null); }
    }

    function run() {
        if (!enabled || busy || !requested) return;
        busy = true;
        var list = requested;
        var selected = [];
        var allowed = {};
        var bytes = 0;
        for (var n = 0; n < list.length; n++) {
            var entry = list[n];
            if (rejected[entry.file] === entry.version) continue;
            if (typeof entry.size !== 'number' || entry.size <= 0 || entry.size > MAX_FILE ||
                bytes + entry.size > MAX_BYTES || selected.length >= MAX_FILES) continue;
            selected.push(entry);
            allowed[entry.file] = entry.version;
            bytes += entry.size;
        }
        var retained = {};
        // Limpiar versiones anteriores antes de descargar; cuota acotada.
        transaction('readwrite', function (store) {
            store.openCursor().onsuccess = function (event) {
                var cursor = event.target.result;
                if (!cursor) return;
                var row = cursor.value;
                if (allowed[row.file] !== row.version) cursor.delete();
                else retained[row.file] = row.version;
                cursor.continue();
            };
        }, function (ok) {
            if (!ok) { busy = false; disable(); return; }
            keys = retained;
            api.ready = true;
            notify('Preparando contenido');
            step(0);
        });
        function finish() {
            busy = false;
            notify(api.count === selected.length && api.count ? 'Contenido guardado' : 'Guardado parcial');
            if (requested !== list) run();
        }
        function step(index) {
            if (!enabled || requested !== list || index >= selected.length) { finish(); return; }
            var entry = selected[index];
            if (api.has(entry)) { step(index + 1); return; }
            download(entry, function (blob, skip) {
                if (!blob) {
                    if (skip) setTimeout(function () { step(index + 1); }, 500);
                    else finish();
                    return;
                }
                if (requested !== list) { finish(); return; }
                transaction('readwrite', function (store) {
                    store.put({ file: entry.file, version: entry.version, blob: blob });
                }, function (ok) {
                    if (!ok) { busy = false; disable(); return; }
                    keys[entry.file] = entry.version;
                    notify('Preparando contenido');
                    // Dar tiempo al reproductor entre descargas completas.
                    setTimeout(function () { step(index + 1); }, 500);
                });
            });
        }
    }
    api.sync = function (list) { requested = list; if (!opening) run(); };
    try {
        if (!window.indexedDB || !objectUrls || !objectUrls.createObjectURL ||
            !objectUrls.revokeObjectURL) { disable(); return api; }
        var timer = setTimeout(disable, 5000);
        var request = window.indexedDB.open('opticast-v1:' + name, 1);
        request.onupgradeneeded = function (event) {
            event.target.result.createObjectStore('files', { keyPath: 'file' });
        };
        request.onerror = request.onblocked = function () { clearTimeout(timer); disable(); };
        request.onsuccess = function (event) {
            clearTimeout(timer);
            if (!opening) { event.target.result.close(); return; }
            db = event.target.result;
            db.onversionchange = disable;
            opening = false;
            enabled = api.supported = true;
            run();
        };
    } catch (error) { disable(); }
    return api;
}
