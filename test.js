'use strict';
// node test.js
const assert = require('node:assert');
const s = require('./server');

assert.ok(s.checkPassword('secret', s.hashPassword('secret')));
assert.ok(!s.checkPassword('autre', s.hashPassword('secret')));
assert.ok(!s.checkPassword('x', 'pas-un-hash'));

assert.strictEqual(s.unsign(s.sign('fiouf', 'k'.repeat(16)), 'k'.repeat(16)), 'fiouf');
assert.strictEqual(s.unsign('fiouf.deadbeef', 'k'.repeat(16)), null);
assert.strictEqual(s.unsign(s.sign('fiouf', 'a'.repeat(16)), 'b'.repeat(16)), null);

const { monday, sunday } = s.weekBounds(new Date('2026-10-29T12:00:00'));
assert.strictEqual(s.isoDay(monday), '2026-10-26');
assert.strictEqual(s.isoDay(sunday), '2026-11-01');
assert.strictEqual(s.isoDay(s.weekBounds(new Date('2026-11-01T12:00:00')).monday), '2026-10-26');

assert.strictEqual(s.cleanTitle("S1 - Sortie longue E 60'"), "Sortie longue E 60'");
assert.strictEqual(s.cleanTitle('MARA-B1-2 Sortie longue 10 km'), 'Sortie longue 10 km');
assert.strictEqual(s.cleanTitle('Nantes Course à pied'), 'Nantes Course à pied');
assert.strictEqual(s.planSummary('Footing facile, FC ≤146.\n- 5km Z2 HR'), 'Footing facile, FC ≤146.');

assert.deepStrictEqual(s.effortSplit([942, 1832, 480, 131, 0, 0, 0]), { facile: 82, soutenu: 14, dur: 4 });
assert.strictEqual(s.effortSplit(null), null);

const cards = s.matchWeek(
  [{ id: 1, start_date_local: '2026-10-27T00:00:00' }, { id: 2, start_date_local: '2026-11-01T00:00:00' }],
  [{ id: 'a', paired_event_id: 1, start_date_local: '2026-10-27T20:41:19' }, { id: 'b', start_date_local: '2026-10-25T18:00:00' }],
);
assert.deepStrictEqual(cards.map((c) => [c.day, c.ev?.id ?? null, c.act?.id ?? null]),
  [['2026-10-25', null, 'b'], ['2026-10-27', 1, 'a'], ['2026-11-01', 2, null]]);

const out = JSON.stringify({ result: 'Voici :\n{"note": 7, "resume": "Bien", "bien": "b", "ameliorer": "a", "prochaine": "p"}' });
assert.strictEqual(s.parseAnalysis(out).note, 7);
assert.throws(() => s.parseAnalysis(JSON.stringify({ result: '{"note": 12}' })));
assert.throws(() => s.parseAnalysis(JSON.stringify({ result: 'pas de json' })));

console.log('ok');
