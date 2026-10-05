// Evaluación local: funciona durante cortes de Wi-Fi con la programación recibida.
function createScheduleEngine(config) {
    var programs = [];
    var shifts = [];
    var clockDelta = 0;
    var offset = -360;
    function update(data) {
        if (Array.isArray(data.schedules)) programs = data.schedules;
        if (Array.isArray(data.shifts)) shifts = data.shifts;
        if (typeof data.server_time === 'number') clockDelta = data.server_time - Date.now();
        if (typeof data.utc_offset === 'number') offset = data.utc_offset;
    }
    function minute(value) {
        var pieces = value.split(':');
        return Number(pieces[0]) * 60 + Number(pieces[1]);
    }
    function period(start, end, days, local) {
        var midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
        var from = midnight + minute(start) * 60000;
        var to = midnight + minute(end) * 60000;
        var day = (local.getUTCDay() + 6) % 7;
        if (to <= from) {
            to += 86400000;
            if (local.getTime() < from) { from -= 86400000; to -= 86400000; day = (day + 6) % 7; }
        }
        return { from: from, to: to, allowed: days.indexOf(String(day)) !== -1 };
    }
    function allowedShift(program, local) {
        if (!program.shift) return true;
        for (var n = 0; n < shifts.length; n++) {
            var shift = shifts[n];
            if (String(shift.id) !== String(program.shift)) continue;
            var range = period(shift.start, shift.end, shift.days, local);
            return range.allowed && local.getTime() >= range.from && local.getTime() < range.to;
        }
        return false;
    }
    function evaluate() {
        var local = new Date(Date.now() + clockDelta + offset * 60000);
        var normal = [];
        var notices = [];
        for (var n = 0; n < programs.length; n++) {
            var p = programs[n];
            if (!allowedShift(p, local)) continue;
            if (p.mode === 'window') {
                var range = period(p.start, p.end, p.days, local);
                if (range.allowed && local.getTime() >= range.from && local.getTime() < range.to) {
                    var entry = {};
                    for (var key in p.media) if (Object.prototype.hasOwnProperty.call(p.media, key)) entry[key] = p.media[key];
                    entry.seconds = p.seconds;
                    entry.windowUntil = range.to - clockDelta - offset * 60000;
                    normal.push(entry);
                }
            } else {
                // Evaluar también ayer para avisos que atraviesan medianoche.
                for (var back = 0; back < 2; back++) {
                    var dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - back * 86400000;
                    var day = (new Date(dayStart).getUTCDay() + 6) % 7;
                    var start = dayStart + minute(p.start) * 60000;
                    var end = start + p.seconds * 1000;
                    if (p.days.indexOf(String(day)) !== -1 && local.getTime() >= start && local.getTime() < end) {
                        notices.push({ id: p.id + ':' + start, media: p.media,
                            until: end - clockDelta - offset * 60000,
                            priority: p.priority || 10 });
                    }
                }
            }
        }
        notices.sort(function (a, b) { return b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
        return { notice: notices[0] || null, normal: normal };
    }
    update(config);
    return { update: update, evaluate: evaluate };
}
