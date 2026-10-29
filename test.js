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

// v2 : paramètres, zones, séances prévues, historique
assert.deepStrictEqual(s.mergeParams({ fcMax: 191, fcRepos: 126 }, { fcRepos: 52 }),
  { fcMax: 191, fcSeuil: null, fcRepos: 52, allureSeuil: null, vo2max: null, zones: null });
assert.strictEqual(Math.round(1000 / s.parsePace('4:55')), 295);
assert.strictEqual(s.parsePace('4:75'), null);
const zones = [148, 157, 165, 174, 179, 184, 191];
assert.strictEqual(s.zoneRange(zones, 1), 'moins de 148 bpm');
assert.strictEqual(s.zoneRange(zones, 2), '149 – 157 bpm');
const lines = s.stepLines([
  { hr: { units: 'hr_zone', value: 2 }, distance: 4000, duration: 1429 },
  { reps: 6, text: 'Lignes droites\n6x', steps: [{ hr: { units: 'hr_zone', value: 5 }, duration: 20 }, { hr: { units: 'hr_zone', value: 1 }, duration: 40 }] },
], zones);
assert.deepStrictEqual(lines.map((l) => [l.depth, l.zone ?? null, l.text]), [
  [0, 2, '4,0 km · Endurance facile · 149 – 157 bpm'],
  [0, null, '6 fois : Lignes droites'],
  [1, 5, '20 s · VO2max · 175 – 179 bpm'],
  [1, 1, '40 s · Récupération · moins de 148 bpm'],
]);
const p1 = { fcMax: 191, fcSeuil: 175, fcRepos: 52, allureSeuil: 3.4, vo2max: 46, zones };
let h = s.nextHistory([], p1, '2026-10-29');
assert.strictEqual(h.length, 1);
assert.strictEqual(s.nextHistory(h, p1, '2026-10-30'), h); // inchangé -> pas de nouvelle ligne
h = s.nextHistory(h, { ...p1, vo2max: 47 }, '2026-10-29');
assert.deepStrictEqual([h.length, h[0].vo2max], [1, 47]); // même jour -> remplacé
h = s.nextHistory(h, { ...p1, vo2max: 48 }, '2026-11-05');
assert.deepStrictEqual(h.map((e) => e.vo2max), [47, 48]);
const form = (o) => new URLSearchParams(o);
assert.deepStrictEqual(s.parseParams(form({ fcRepos: '52', allureSeuil: '4:55', zones: '148, 157, 165', vo2max: '' })).params,
  { fcRepos: 52, allureSeuil: 1000 / 295, zones: [148, 157, 165] });
assert.ok(s.parseParams(form({ zones: '157, 148' })).error);
assert.ok(s.parseParams(form({ fcMax: '400' })).error);

console.log('ok v2');

// v3 : temps au km, courbe d'allure, progrès
const time = [], distance = [], heartrate = [], altitude = [];
for (let t = 0; t <= 700; t++) { time.push(t); distance.push(Math.min(t, 600) * 3.5); heartrate.push(150); altitude.push(t < 300 ? t / 10 : 30); }
const sp = s.kmSplits({ time, distance, heartrate, altitude });
assert.deepStrictEqual(sp.map((x) => Math.round(x.dist)), [1001, 1001, 98]);
assert.strictEqual(sp[0].hr, 150);
assert.ok(sp[2].moving < 30); // l'arrêt final (100 s immobile) ne compte pas
assert.deepStrictEqual(s.kmSplits({}), []);
assert.match(s.paceChart({ distance, velocity_smooth: distance.map(() => 3.5) }, 286), /<svg/);
const weeks = s.weeklyTotals([
  { start_date_local: '2026-10-27T18:00:00', distance: 8000, moving_time: 2800, total_elevation_gain: 40 },
  { start_date_local: '2026-10-21T18:00:00', distance: 5000, moving_time: 1800 },
  { start_date_local: '2025-01-01T18:00:00', distance: 9000 },
], new Date('2026-10-26T12:00:00'), 4);
assert.deepStrictEqual(weeks.map((w) => [w.monday, w.dist]), [['2026-10-05', 0], ['2026-10-12', 0], ['2026-10-19', 5000], ['2026-10-26', 8000]]);
assert.strictEqual(s.weekStreak(weeks), 2);
assert.strictEqual(s.weekStreak([...weeks.slice(1), { runs: 0 }]), 2); // semaine en cours vide : série intacte
console.log('ok v3');
