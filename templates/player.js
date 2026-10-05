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

    // Se conserva por ahora; la fase 2 reemplazará esta recarga.
    setInterval(function () { location.reload(); }, 1800000);

    function url(file) {
        return '/static/' + file.split('/').map(encodeURIComponent).join('/');
    }

    function release(slot) {
        slot.image.onload = slot.image.onerror = null;
        slot.video.onloadedmetadata = slot.video.onplaying = null;
        slot.video.onended = slot.video.onerror = null;
        slot.image.style.visibility = slot.video.style.visibility = 'hidden';
        slot.image.removeAttribute('src');
        slot.video.pause();
        slot.video.removeAttribute('src');
        slot.video.load();
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
            advanceTimer = setTimeout(advance, IMAGE_MS);
        }
        // Solo se prepara el siguiente archivo; nunca la lista completa.
        prepare(false);
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
        if (!media.length || pending) return;
        var slot = slots[active && active.slot === slots[0] ? 1 : 0];
        var file = media[index];
        index = (index + 1) % media.length;
        var isVideo = /\.(mp4|webm)$/i.test(file);
        var item = { slot: slot, file: file, isVideo: isVideo,
                     element: isVideo ? slot.video : slot.image,
                     due: due, ready: false, starting: false };
        pending = item;
        function ready() {
            if (pending !== item || item.ready) return;
            clearTimeout(item.timeout);
            item.ready = true;
            activate(item);
        }
        item.timeout = setTimeout(function () { fail(item, 'carga agotada'); }, LOAD_MS);
        item.element.onerror = function () { fail(item, 'archivo o conexión'); };
        if (isVideo) {
            item.element.muted = true;
            item.element.onloadedmetadata = ready;
            item.element.src = url(file);
            item.element.load();
        } else {
            item.element.onload = ready;
            item.element.src = url(file);
        }
    }

    function advance() {
        clearTimeout(advanceTimer);
        if (active) active.transitioning = true;
        if (pending) { pending.due = true; activate(pending); }
        else if (!retryTimer) prepare(true);
    }

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
