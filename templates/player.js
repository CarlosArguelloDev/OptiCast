(function () {
    // Sintaxis compatible con navegadores de TV antiguos.
    var media = carouselMedia;
    var IMAGE_MS = 5000;
    var LOAD_MS = 20000;
    var STALL_MS = 15000;
    var status = document.getElementById('status');
    var slots = [0, 1].map(function (n) {
        return { image: document.getElementById('image' + n),
                 video: document.getElementById('video' + n) };
    });
    var active = null;
    var pending = null;
    var index = 0;
    var failures = 0;
    var retryRound = 0;
    var advanceTimer = null;
    var retryTimer = null;
    var queuedMedia = null;
    var clearWhenEmpty = false;
    var manifestVersion = carouselVersion;
    var pollFailures = 0;
    var schedule = createScheduleEngine(carouselScheduleConfig);
    var currentNotice = null;
    var programs = carouselScheduleConfig.schedules || [];
    var overrideEntry = null;
    var resumeIndex = 0;
    var cacheMessage = 'Preparando almacenamiento';
    var cacheCount = 0;
    var offlineStatus = document.getElementById('offline-status');
    function showCacheStatus() {
        if (/[?&]estado=1(?:&|$)/.test(location.search || '')) {
            offlineStatus.style.display = 'block';
            offlineStatus.textContent = (pollFailures ? 'Servidor no disponible. ' : '') +
                cacheMessage + ': ' + cacheCount + ' archivos';
        }
    }
    var cache = createCarouselCache(carouselManifestUrl, function (message, count) {
        cacheMessage = message;
        cacheCount = count;
        showCacheStatus();
    });
    function cacheList() {
        var list = [];
        var seen = {};
        // Reservar primero espacio para avisos, incluido Ley Silla.
        programs.slice().sort(function (a, b) { return (b.priority || 10) - (a.priority || 10); }).forEach(function (p) {
            if (!seen[p.media.file]) { list.push(p.media); seen[p.media.file] = true; }
        });
        (queuedMedia || media).forEach(function (entry) {
            if (!seen[entry.file]) { list.push(entry); seen[entry.file] = true; }
        });
        return list;
    }
    cache.sync(cacheList());
    showCacheStatus();

    // Consultas pequeñas y secuenciales; nunca se recarga la página.
    function poll() {
        var xhr = new XMLHttpRequest();
        var finished = false;
        var timeout;
        function complete(ok) {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            xhr.onload = xhr.onerror = xhr.onabort = null;
            if (ok) pollFailures = 0;
            else pollFailures = Math.min(pollFailures + 1, 5);
            if (ok) cache.sync(cacheList());
            showCacheStatus();
            setTimeout(poll, ok ? 60000 : Math.min(30000 * Math.pow(2, pollFailures - 1), 300000));
        }
        xhr.onload = function () {
            if (finished) return;
            if (xhr.status === 304) { complete(true); return; }
            if (xhr.status !== 200) { complete(false); return; }
            try {
                var data = JSON.parse(xhr.responseText);
                if (!data || typeof data.version !== 'string' || !Array.isArray(data.media)) {
                    throw new Error('Lista inválida');
                }
                for (var n = 0; n < data.media.length; n++) {
                    var entry = data.media[n];
                    if (!entry || typeof entry.file !== 'string' || typeof entry.version !== 'string') {
                        throw new Error('Archivo inválido');
                    }
                }
                schedule.update(data);
                if (Array.isArray(data.schedules)) programs = data.schedules;
                clearWhenEmpty = data.clear_when_empty === true;
                // Una carpeta vacía durante una actualización no borra la pantalla.
                if ((data.media.length || data.schedules) && data.version !== manifestVersion) {
                    queuedMedia = data.media;
                    manifestVersion = data.version;
                    if (!active || active.transitioning) advance();
                }
                complete(true);
            } catch (error) { complete(false); }
        };
        xhr.onerror = xhr.onabort = function () { complete(false); };
        timeout = setTimeout(function () {
            complete(false);
            xhr.abort();
        }, 10000);
        try {
            xhr.open('GET', carouselManifestUrl, true);
            xhr.setRequestHeader('If-None-Match', '"' + manifestVersion + '"');
            xhr.send();
        } catch (error) { complete(false); }
    }
    setTimeout(poll, 60000);

    function url(file, version, entry) {
        if (entry && entry.url) return entry.url + (entry.url.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(version);
        return '/static/' + file.split('/').map(encodeURIComponent).join('/') + '?v=' + encodeURIComponent(version);
    }

    function release(slot) {
        if (slot.cancelCacheWait) slot.cancelCacheWait();
        slot.cancelCacheWait = null;
        slot.image.onload = slot.image.onerror = null;
        slot.video.onloadedmetadata = slot.video.onplaying = null;
        slot.video.onended = slot.video.onerror = null;
        slot.image.style.visibility = slot.video.style.visibility = 'hidden';
        slot.image.removeAttribute('src');
        slot.video.pause();
        slot.video.removeAttribute('src');
        slot.video.load();
        cache.revoke(slot.objectUrl);
        slot.objectUrl = null;
    }

    function fail(item, reason) {
        if (pending !== item) return;
        console.warn('No se pudo reproducir: ' + item.file + ' (' + reason + ')');
        pending = null;
        clearTimeout(item.timeout);
        release(item.slot);
        failures += 1;
        // Una vuelta completa con errores activa una pausa creciente.
        var delay = 1000;
        if (failures >= media.length) {
            failures = 0;
            delay = Math.min(30000 * Math.pow(2, retryRound), 120000);
            retryRound = Math.min(retryRound + 1, 2);
        }
        if (!active) status.textContent = 'Esperando contenido. Reintentando…';
        retryTimer = setTimeout(function () {
            retryTimer = null;
            // Si el anterior sigue en su tiempo normal, esperar a que termine.
            prepare(!active || active.transitioning);
        }, delay);
    }

    function promote(item) {
        if (pending !== item) return;
        clearTimeout(item.timeout);
        clearTimeout(advanceTimer);
        pending = null;
        var previous = active;
        active = item;
        item.element.style.visibility = 'visible';
        status.style.display = 'none';
        // El anterior sigue visible hasta que el nuevo esté listo.
        if (previous) release(previous.slot);
        failures = retryRound = 0;
        if (item.isVideo) {
            item.lastTime = item.element.currentTime;
            item.lastProgress = Date.now();
            item.element.onended = function () {
                if (active === item) advance();
            };
            item.element.onerror = function () {
                if (active === item) advance();
            };
        } else {
            advanceTimer = setTimeout(advance, item.notice ? Math.max(1, item.notice.until - Date.now()) : (item.seconds || IMAGE_MS / 1000) * 1000);
        }
        // Solo se prepara el siguiente archivo; nunca la lista completa.
        if (!currentNotice) prepare(false);
    }

    function activate(item) {
        if (pending !== item || !item.ready || !item.due || item.starting) return;
        if (!item.isVideo) { promote(item); return; }
        item.starting = true;
        clearTimeout(item.timeout);
        item.timeout = setTimeout(function () { fail(item, 'inicio agotado'); }, LOAD_MS);
        item.element.onplaying = function () { promote(item); };
        try {
            var result = item.element.play();
            // Algunos navegadores antiguos no devuelven una promesa.
            if (result && typeof result.catch === 'function') {
                result.catch(function () { fail(item, 'reproducción rechazada'); });
            }
        } catch (error) { fail(item, 'reproducción rechazada'); }
    }

    function prepare(due) {
        if (pending) return;
        var available = media.concat(schedule.evaluate().normal);
        if (!available.length && !overrideEntry) {
            if (due && clearWhenEmpty && active) {
                release(active.slot);
                active = null;
                status.textContent = 'Sin contenido para esta pantalla.';
                status.style.display = 'block';
            }
            return;
        }
        index = available.length ? index % available.length : 0;
        var slot = slots[active && active.slot === slots[0] ? 1 : 0];
        var entry = overrideEntry || available[index];
        // Un único archivo ya está reproduciéndose: no abrir otra copia en paralelo.
        if (!due && !overrideEntry && available.length === 1 && active && active.isVideo && active.file === entry.file) return;
        // Durante un corte, circular solo por las copias completas disponibles.
        // Si no hay ninguna, conservar la recuperación habitual de la fase 1.
        if (!overrideEntry && pollFailures && cache.ready && cache.count) {
            for (var attempt = 0; attempt < available.length; attempt++) {
                entry = available[index];
                if (cache.has(entry)) break;
                index = (index + 1) % available.length;
            }
        }
        var file = entry.file;
        if (!overrideEntry) index = (index + 1) % available.length;
        var isVideo = /\.(mp4|webm)$/i.test(file);
        var item = { slot: slot, file: file, isVideo: isVideo,
                     element: isVideo ? slot.video : slot.image,
                     due: due, ready: false, starting: false,
                     seconds: entry.seconds, notice: currentNotice, windowUntil: entry.windowUntil };
        pending = item;
        function ready() {
            if (pending !== item || item.ready) return;
            clearTimeout(item.timeout);
            item.ready = true;
            activate(item);
        }
        // El caché puede esperar una descarga de fondo y luego la del archivo solicitado.
        item.timeout = setTimeout(function () { fail(item, 'almacenamiento agotado'); }, 210000);
        item.element.onerror = function () {
            if (pending !== item) return;
            if (slot.objectUrl) {
                cache.reject(entry);
                cache.revoke(slot.objectUrl);
                slot.objectUrl = null;
                item.ready = item.starting = false;
                clearTimeout(item.timeout);
                item.timeout = setTimeout(function () { fail(item, 'carga agotada'); }, LOAD_MS);
                item.element.src = url(file, entry.version, entry);
                if (isVideo) item.element.load();
            } else fail(item, 'archivo o conexión');
        };
        if (isVideo) {
            item.element.muted = true;
            item.element.onloadedmetadata = ready;
        } else {
            item.element.onload = ready;
        }
        slot.cancelCacheWait = cache.resolve(entry, function (objectUrl) {
            // Una lectura vieja no debe alterar un elemento ya reutilizado.
            if (pending !== item) { cache.revoke(objectUrl); return; }
            clearTimeout(item.timeout);
            item.timeout = setTimeout(function () { fail(item, 'carga agotada'); }, LOAD_MS);
            slot.objectUrl = objectUrl;
            item.element.src = objectUrl || url(file, entry.version, entry);
            if (isVideo) item.element.load();
        }, !!item.notice);
    }

    function advance() {
        clearTimeout(advanceTimer);
        if (active) active.transitioning = true;
        if (queuedMedia) {
            if (pending) {
                var previous = pending;
                pending = null;
                clearTimeout(previous.timeout);
                release(previous.slot);
            }
            clearTimeout(retryTimer);
            retryTimer = null;
            media = queuedMedia;
            queuedMedia = null;
            // Continuar después del archivo actual si todavía está en la lista.
            index = 0;
            if (active) {
                for (var n = 0; n < media.length; n++) {
                    if (media[n].file === active.file) {
                        index = (n + 1) % media.length;
                        break;
                    }
                }
            }
            failures = retryRound = 0;
        }
        if (pending) { pending.due = true; activate(pending); }
        else if (!retryTimer) prepare(true);
    }

    function cancelPrepared() {
        if (pending) {
            var old = pending;
            pending = null;
            clearTimeout(old.timeout);
            release(old.slot);
        }
        clearTimeout(retryTimer);
        retryTimer = null;
        clearTimeout(advanceTimer);
    }

    setInterval(function () {
        var nextNotice = schedule.evaluate().notice;
        if (!nextNotice && !currentNotice) {
            if (pending && pending.windowUntil && Date.now() >= pending.windowUntil) {
                var expired = pending;
                pending = null;
                clearTimeout(expired.timeout);
                release(expired.slot);
                prepare(!!(active && active.transitioning));
            }
            if (active && active.windowUntil && Date.now() >= active.windowUntil && !active.transitioning) {
                cancelPrepared();
                active.transitioning = true;
                if (active.isVideo) active.element.pause();
                prepare(true);
            }
        }
        if ((nextNotice && nextNotice.id) === (currentNotice && currentNotice.id)) {
            if ((!active || active.transitioning) && !pending && !retryTimer) prepare(true);
            return;
        }
        if (nextNotice && !currentNotice) {
            resumeIndex = index;
            if (active) {
                for (var n = 0; n < media.length; n++) {
                    if (media[n].file === active.file) { resumeIndex = (n + 1) % media.length; break; }
                }
            }
        } else if (!nextNotice) index = resumeIndex;
        cancelPrepared();
        // Un aviso vencido no debe seguir visible mientras vuelve a cargar el carrusel.
        if (active && active.notice) {
            release(active.slot);
            active = null;
            status.textContent = 'Cargando contenido…';
            status.style.display = 'block';
        }
        if (active) {
            active.transitioning = true;
            if (active.isVideo) active.element.pause();
        }
        currentNotice = nextNotice;
        overrideEntry = nextNotice ? nextNotice.media : null;
        prepare(true);
    }, 1000);

    setInterval(function () {
        if (!active || !active.isVideo || active.transitioning) return;
        if (active.element.currentTime !== active.lastTime) {
            active.lastTime = active.element.currentTime;
            active.lastProgress = Date.now();
        } else if (Date.now() - active.lastProgress >= STALL_MS) {
            console.warn('Video detenido: ' + active.file);
            advance();
        }
    }, 1000);

    if (media.length) prepare(true);
    else status.textContent = 'No hay contenido disponible.';
}());
