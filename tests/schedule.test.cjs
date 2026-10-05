const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../templates/schedule.js'), 'utf8');
function engine(iso, schedules, shifts = []) {
    let now = Date.parse(iso);
    const context = { Date: class extends Date { static now() { return now; } } };
    vm.createContext(context); vm.runInContext(source, context);
    const api = context.createScheduleEngine({ schedules, shifts, server_time: now, utc_offset: -360 });
    return { api, tick(ms) { now += ms; } };
}
const program = overrides => ({ id: 'a', mode: 'moment', start: '08:00', seconds: 600,
    days: ['0'], media: { file: 'seat.jpg', version: '1' }, priority: 10, ...overrides });
test('Aviso usa hora de planta, interrumpe solo durante duración y no recupera vencidos', () => {
    const h = engine('2026-10-05T13:59:59Z', [program()]);
    assert.equal(h.api.evaluate().notice, null);
    h.tick(1000);
    const id = h.api.evaluate().notice.id;
    h.tick(599000);
    assert.equal(h.api.evaluate().notice.id, id);
    h.tick(1000);
    assert.equal(h.api.evaluate().notice, null);
});
test('Intervalo nocturno corresponde al día de inicio', () => {
    const h = engine('2026-10-06T07:00:00Z', [program({ mode: 'window', start: '22:00', end: '02:00' })]);
    assert.equal(h.api.evaluate().normal.length, 1);
    h.tick(3600000);
    assert.equal(h.api.evaluate().normal.length, 0);
});
test('Turno limita la programación y también cruza medianoche', () => {
    const h = engine('2026-10-06T07:00:00Z', [program({ mode: 'window', start: '22:00', end: '03:00', shift: 1 })],
        [{ id: 1, start: '22:00', end: '02:00', days: ['0'] }]);
    assert.equal(h.api.evaluate().normal.length, 1);
    h.tick(3600000);
    assert.equal(h.api.evaluate().normal.length, 0);
});
test('Ley Silla tiene prioridad y un aviso puede durar hasta el día siguiente', () => {
    const h = engine('2026-10-06T06:02:00Z', [program({ start: '23:59', seconds: 600 }),
        program({ id: 'seat', start: '23:59', seconds: 600, priority: 100 })]);
    assert.match(h.api.evaluate().notice.id, /^seat:/);
});
test('Configuración actualizada cancela programas y reloj se sincroniza con servidor', () => {
    const h = engine('2026-10-05T14:00:00Z', [program()]);
    assert.ok(h.api.evaluate().notice);
    h.api.update({ server_time: Date.parse('2026-10-05T15:00:00Z') });
    assert.equal(h.api.evaluate().notice, null);
    h.api.update({ schedules: [] });
    assert.equal(h.api.evaluate().normal.length, 0);
});
