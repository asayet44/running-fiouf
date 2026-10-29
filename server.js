'use strict';
// App running : un front par coureur au-dessus d'intervals.icu, avis du coach via Claude Code.
// Aucune dépendance : node server.js
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3000;
const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, 'users.json');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SECRET = process.env.SESSION_SECRET || '';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const RUNNERS_DIR = process.env.RUNNERS_DIR || path.join(__dirname, 'runners'); // dossiers des projets coach
const SIGNUP_CODE = process.env.SIGNUP_CODE || ''; // vide = création de compte libre

// ---------- utilitaires purs (testés dans test.js) ----------

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}

function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(value, secret = SECRET) {
  return `${value}.${crypto.createHmac('sha256', secret).update(value).digest('hex')}`;
}

function unsign(signed, secret = SECRET) {
  const i = String(signed).lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const a = Buffer.from(sign(value, secret));
  const b = Buffer.from(signed);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? value : null;
}

const isoDay = (d) => d.toLocaleDateString('sv-SE'); // YYYY-MM-DD en heure locale

function weekBounds(today = new Date()) {
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { monday, sunday };
}

// "S1 - Sortie longue E 60'" / "MARA-B1-2 Sortie longue" -> "Sortie longue ..."
const cleanTitle = (name) => String(name || 'Séance').replace(/^(?=\S*\d)[A-Z0-9-]+(\s+-)?\s+/, '');

// Première ligne de la description du plan, sans les étapes "- 10km Z2 HR".
const planSummary = (desc) => String(desc || '').split('\n').find((l) => l.trim() && !l.trim().startsWith('-')) || '';

// Zones FC intervals.icu (Z1..Z7) -> facile / soutenu / dur en %.
function effortSplit(zoneTimes) {
  const z = zoneTimes || [];
  const total = z.reduce((s, v) => s + (v || 0), 0);
  if (!total) return null;
  const pct = (v) => Math.round((100 * v) / total);
  const facile = pct((z[0] || 0) + (z[1] || 0));
  const soutenu = pct(z[2] || 0);
  return { facile, soutenu, dur: Math.max(0, 100 - facile - soutenu) };
}

// Associe chaque séance prévue à l'activité réalisée (appairage intervals.icu, sinon même jour).
function matchWeek(events, activities) {
  const used = new Set();
  const cards = events.map((ev) => {
    const day = ev.start_date_local.slice(0, 10);
    const act = activities.find((a) => !used.has(a.id) && a.paired_event_id === ev.id)
      || activities.find((a) => !used.has(a.id) && a.start_date_local.slice(0, 10) === day);
    if (act) used.add(act.id);
    return { day, ev, act };
  });
  for (const act of activities) {
    if (!used.has(act.id)) cards.push({ day: act.start_date_local.slice(0, 10), ev: null, act });
  }
  return cards.sort((a, b) => a.day.localeCompare(b.day));
}

// Extrait le JSON renvoyé par `claude -p --output-format json`.
function parseAnalysis(stdout) {
  const text = JSON.parse(stdout).result || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Réponse de Claude sans JSON');
  const a = JSON.parse(m[0]);
  const note = Math.round(Number(a.note));
  if (!(note >= 0 && note <= 10)) throw new Error('Note invalide');
  const str = (v) => String(v || '').slice(0, 2000);
  return { note, resume: str(a.resume), bien: str(a.bien), ameliorer: str(a.ameliorer), prochaine: str(a.prochaine) };
}

// ---------- paramètres et zones ----------

const PARAM_KEYS = ['fcMax', 'fcSeuil', 'fcRepos', 'allureSeuil', 'vo2max', 'zones'];
const ZONE_NAMES = ['Récupération', 'Endurance facile', 'Tempo', 'Seuil', 'VO2max', 'Anaérobie', 'Sprint'];

// Valeur saisie à la main si présente, sinon celle d'intervals.icu.
const mergeParams = (auto, manual = {}) => Object.fromEntries(PARAM_KEYS.map((k) => [k, manual[k] ?? auto[k] ?? null]));

// "4:55" (min/km) -> m/s
function parsePace(s) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(s).trim());
  return m ? 1000 / (Number(m[1]) * 60 + Number(m[2])) : null;
}

// Bornes FC de la zone n (1..7) à partir des plafonds de zones intervals.icu.
function zoneRange(zones, n) {
  if (!zones || !zones[n - 1]) return '';
  return n === 1 ? `moins de ${zones[0]} bpm` : `${zones[n - 2] + 1} – ${zones[n - 1]} bpm`;
}

const secs = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : duration(s));

// Étapes d'une séance prévue (workout_doc intervals.icu) -> lignes lisibles.
function stepLines(steps, zones, depth = 0) {
  return (steps || []).flatMap((s) => {
    const label = String(s.text || '').split('\n')[0].trim();
    if (s.reps) return [{ depth, text: `${s.reps} fois${label ? ` : ${label}` : ''}` }, ...stepLines(s.steps, zones, depth + 1)];
    const amount = s.distance ? `${km(s.distance)} km` : s.duration ? secs(s.duration) : '';
    let zone = null; let target = '';
    if (s.hr?.units === 'hr_zone') { zone = s.hr.value; target = `${ZONE_NAMES[zone - 1] || `Zone ${zone}`} · ${zoneRange(zones, zone)}`; }
    else if (s.pace?.units === 'pace_zone') { zone = s.pace.value; target = `Allure zone ${zone}`; }
    return [{ depth, zone, text: [amount, target, label].filter(Boolean).join(' · ') }];
  });
}

// Ajoute un relevé daté à l'historique s'il a changé (un seul par jour).
function nextHistory(history, params, day) {
  const entry = { date: day, ...Object.fromEntries(PARAM_KEYS.filter((k) => k !== 'zones').map((k) => [k, params[k]])) };
  const last = history[history.length - 1];
  const same = last && PARAM_KEYS.every((k) => k === 'zones' || last[k] === entry[k]);
  if (same) return history;
  return last?.date === day ? [...history.slice(0, -1), entry] : [...history, entry];
}

// Streams intervals.icu ({time, distance, ...}) -> temps intermédiaires par km.
// Temps de déplacement = pas de temps où l'on avance à plus de 0,5 m/s.
function kmSplits({ time, distance, heartrate, altitude }) {
  if (!time?.length || !distance?.length) return [];
  const splits = [];
  let start = 0;
  let moving = 0;
  const close = (end) => {
    const hr = heartrate?.slice(start, end + 1).filter(Boolean) || [];
    splits.push({
      dist: distance[end] - distance[start], moving,
      elev: altitude ? Math.round(altitude[end] - altitude[start]) : null,
      hr: hr.length ? Math.round(hr.reduce((s, x) => s + x, 0) / hr.length) : null,
    });
  };
  for (let i = 1; i < time.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt > 0 && (distance[i] - distance[i - 1]) / dt > 0.5) moving += dt;
    if (distance[i] >= (splits.length + 1) * 1000) { close(i); start = i; moving = 0; }
  }
  if (distance.at(-1) - distance[start] >= 50) close(time.length - 1);
  return splits;
}

// Courbe allure / distance en SVG, ligne pointillée = allure moyenne (s/km).
function paceChart({ distance, velocity_smooth: v }, avgPace) {
  if (!distance?.length || !v?.length) return '';
  const total = distance.at(-1);
  const n = 120;
  const sums = Array.from({ length: n }, () => [0, 0]);
  distance.forEach((d, i) => { if (v[i] > 0.5) { const b = sums[Math.min(n - 1, Math.floor((d / total) * n))]; b[0] += v[i]; b[1]++; } });
  const pts = sums.map(([s, c], i) => c && [((i + 0.5) / n) * total, Math.min(720, Math.max(180, 1000 / (s / c)))]).filter(Boolean);
  if (pts.length < 2) return '';
  const ys = pts.map((p) => p[1]);
  const lo = Math.floor(Math.min(...ys) / 30) * 30;
  const hi = Math.ceil(Math.max(...ys) / 30) * 30 || lo + 30;
  const W = 340, H = 140, x = (d) => (d / total) * W, y = (s) => ((s - lo) / Math.max(30, hi - lo)) * H; // rapide en haut
  const line = pts.map(([d, s]) => `${x(d).toFixed(1)},${y(s).toFixed(1)}`).join(' ');
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const ay = y(Math.min(hi, Math.max(lo, avgPace)));
  return `<svg viewBox="-34 -8 ${W + 40} ${H + 30}" width="100%" role="img" aria-label="Allure au fil de la sortie, moyenne ${mmss(avgPace)} par km" style="font:11px Manrope,system-ui,sans-serif">
<polygon points="0,${H} ${line} ${W},${H}" fill="#C2410C" opacity=".12"/><polyline points="${line}" fill="none" stroke="#C2410C" stroke-width="2" stroke-linejoin="round"/>
<line x1="0" x2="${W}" y1="${ay}" y2="${ay}" stroke="#17181B" stroke-dasharray="4 4"/>
<text x="-6" y="4" text-anchor="end" fill="#55585F">${mmss(lo)}</text><text x="-6" y="${H}" text-anchor="end" fill="#55585F">${mmss(hi)}</text>
<text x="0" y="${H + 18}" fill="#55585F">0 km</text><text x="${W}" y="${H + 18}" text-anchor="end" fill="#55585F">${km(total)} km</text></svg>`;
}

// Activités -> totaux des `count` dernières semaines (lundi -> dimanche), la plus récente en dernier.
function weeklyTotals(acts, lastMonday, count = 12) {
  const weeks = Array.from({ length: count }, (_, i) => {
    const monday = new Date(lastMonday);
    monday.setDate(lastMonday.getDate() - 7 * (count - 1 - i));
    return { monday: isoDay(monday), dist: 0, time: 0, elev: 0, runs: 0 };
  });
  for (const a of acts) {
    const w = weeks.findLast((wk) => wk.monday <= a.start_date_local.slice(0, 10));
    if (!w) continue;
    w.dist += a.distance || 0; w.time += a.moving_time || 0; w.elev += a.total_elevation_gain || 0; w.runs++;
  }
  return weeks;
}

// Semaines d'affilée avec au moins une sortie ; la semaine en cours ne casse pas la série tant qu'elle est vide.
function weekStreak(weeks) {
  let i = weeks.length - 1;
  if (!weeks[i]?.runs) i--;
  let n = 0;
  while (i >= 0 && weeks[i].runs) { n++; i--; }
  return n;
}

// ---------- formats ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const km = (m) => ((m || 0) / 1000).toFixed(1).replace('.', ',');
const duration = (s) => {
  const min = Math.round((s || 0) / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
};
const pace = (speed) => {
  if (!speed) return '–';
  const s = Math.round(1000 / speed);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const dayLabel = (iso, opts = { weekday: 'long', day: 'numeric' }) => {
  const s = new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', opts);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// ---------- données ----------

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

function saveUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

function projectChoices() {
  try {
    return fs.readdirSync(RUNNERS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch { return []; }
}

async function icu(user, p) {
  const res = await fetch(`https://intervals.icu/api/v1${p}`, {
    headers: { Authorization: `Basic ${Buffer.from(`API_KEY:${user.apiKey}`).toString('base64')}` },
  });
  if (!res.ok) throw new Error(`intervals.icu ${res.status} sur ${p}`);
  return res.json();
}

// Courbes de la sortie, rangées par type ; latlng arrive en deux tableaux (data = lat, data2 = lng).
async function streams(user, actId) {
  const list = await icu(user, `/activity/${encodeURIComponent(actId)}/streams.json?types=time,distance,velocity_smooth,heartrate,altitude,latlng`).catch(() => []);
  const out = {};
  for (const st of Array.isArray(list) ? list : []) {
    out[st.type] = st.type === 'latlng' && st.data2 ? st.data.map((lat, i) => [lat, st.data2[i]]) : st.data;
  }
  return out;
}

const analysisFile = (user, actId) => path.join(DATA_DIR, user.id, `${String(actId).replace(/[^\w-]/g, '')}.json`);

function readAnalysis(user, actId) {
  try { return JSON.parse(fs.readFileSync(analysisFile(user, actId), 'utf8')); } catch { return null; }
}

function recentAnalyses(user, n = 3) {
  const dir = path.join(DATA_DIR, user.id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== HISTORY_FILE)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
}

const HISTORY_FILE = 'parametres.json';
const historyFile = (user) => path.join(DATA_DIR, user.id, HISTORY_FILE);
const readHistory = (user) => { try { return JSON.parse(fs.readFileSync(historyFile(user), 'utf8')); } catch { return []; } };

// Paramètres relevés par intervals.icu : dernière sortie course (zones, seuil, FC max) et wellness (FC repos, VO2max).
async function autoParams(user) {
  const from = new Date(); from.setDate(from.getDate() - 60);
  const q = `oldest=${isoDay(from)}&newest=${isoDay(new Date())}`;
  const [acts, wellness] = await Promise.all([
    icu(user, `/athlete/${user.athleteId}/activities?${q}`),
    icu(user, `/athlete/${user.athleteId}/wellness?${q}`),
  ]);
  const run = acts.filter((a) => /Run/.test(a.type)).sort((a, b) => b.start_date_local.localeCompare(a.start_date_local))[0] || {};
  const w = [...wellness].sort((a, b) => String(b.id).localeCompare(String(a.id)));
  const last = (k) => w.find((x) => x[k] != null)?.[k] ?? null;
  return {
    fcMax: run.athlete_max_hr ?? null, fcSeuil: run.lthr ?? null, fcRepos: last('restingHR') ?? run.icu_resting_hr ?? null,
    allureSeuil: run.threshold_pace ?? null, vo2max: last('vo2max'), zones: run.icu_hr_zones ?? null,
  };
}

async function currentParams(user) {
  const auto = await autoParams(user).catch(() => ({}));
  const params = mergeParams(auto, user.params);
  const history = nextHistory(readHistory(user), params, isoDay(new Date()));
  fs.mkdirSync(path.join(DATA_DIR, user.id), { recursive: true });
  fs.writeFileSync(historyFile(user), JSON.stringify(history, null, 2));
  return { params, auto, history };
}

function updateUser(id, patch) {
  const users = loadUsers();
  const u = users.find((x) => x.id === id);
  Object.assign(u, patch);
  saveUsers(users);
}

const contextFile = (user) => path.join(user.dir, 'CONTEXTE.md');
const readContext = (user) => { try { return fs.readFileSync(contextFile(user), 'utf8'); } catch { return ''; } };

const running = new Set();

async function analyse(user, act, planned) {
  const today = isoDay(new Date());
  const in7 = new Date(); in7.setDate(in7.getDate() + 7);
  const [upcoming, { params }] = await Promise.all([
    icu(user, `/athlete/${user.athleteId}/events?oldest=${today}&newest=${isoDay(in7)}&category=WORKOUT`),
    currentParams(user),
  ]);
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  const prompt = [
    `Tu es le coach running de ${user.name}, qui prépare ${user.objectif || 'un marathon'}.`,
    'Analyse la séance réalisée ci-dessous en la comparant à ce qui était prévu.',
    'Tiens compte des notes de ce projet, du contexte du coureur et de tes derniers avis pour suivre sa progression.',
    'Écris en français simple, en tutoyant, sans jargon (pas de "Z2", "CTL", "TSB"), 1 à 3 phrases par rubrique.',
    'Réponds UNIQUEMENT par un objet JSON : {"note": entier de 0 à 10, "resume": "...", "bien": "...", "ameliorer": "...", "prochaine": "conseil pour la prochaine séance prévue"}',
    '',
    '## Séance réalisée',
    JSON.stringify(pick(act, ['start_date_local', 'name', 'distance', 'moving_time', 'average_speed', 'average_heartrate', 'max_heartrate',
      'average_cadence', 'total_elevation_gain', 'icu_hr_zones', 'icu_hr_zone_times', 'interval_summary', 'compliance', 'icu_rpe', 'feel'])),
    '## Séance prévue',
    planned ? JSON.stringify(pick(planned, ['name', 'description', 'moving_time', 'distance'])) : 'Aucune (sortie libre).',
    '## Prochaines séances prévues',
    JSON.stringify(upcoming.map((e) => pick(e, ['start_date_local', 'name', 'description']))),
    '## Paramètres du coureur (FC en bpm, allure seuil en m/s, zones = plafonds FC Z1..Z7)',
    JSON.stringify(params),
    '## Contexte donné par le coureur',
    readContext(user) || '(vide)',
    '## Tes derniers avis',
    JSON.stringify(recentAnalyses(user)),
  ].join('\n');

  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(CLAUDE_BIN,
      ['-p', '--model', 'opus', '--effort', 'medium', '--output-format', 'json', '--tools', '', '--no-session-persistence'],
      { cwd: user.dir, timeout: 5 * 60_000, maxBuffer: 10_000_000 },
      (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out)));
    child.stdin.end(prompt);
  });
  const result = { ...parseAnalysis(stdout), date: new Date().toISOString(), activityId: act.id };
  fs.mkdirSync(path.join(DATA_DIR, user.id), { recursive: true });
  fs.writeFileSync(analysisFile(user, act.id), JSON.stringify(result, null, 2));
  return result;
}

// ---------- pages ----------

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#F6F5F2;color:#17181B;font:16px/1.4 Manrope,system-ui,sans-serif}
a{color:inherit;text-decoration:none}main{max-width:480px;margin:0 auto;padding:24px 20px 110px;display:flex;flex-direction:column;gap:18px}
h1{margin:0;font-size:30px;font-weight:800;letter-spacing:-.5px}h2{margin:4px 0 0;font-size:18px;font-weight:800}p{margin:0}
.muted{color:#55585F;font-size:14px}.card{background:#fff;border-radius:20px;padding:18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 1px 2px rgba(23,24,27,.06)}
.card.todo{background:transparent;border:2px dashed #DAD6CE;box-shadow:none}.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.chip{font-size:13px;font-weight:700;padding:4px 10px;border-radius:999px;background:#ECE9E3;color:#55585F;white-space:nowrap}.chip.ok{background:#E3F2E8;color:#1D7A46}
.title{font-size:18px;font-weight:700}.stats{display:flex;gap:18px;font-size:15px}.today{background:#FDEBDD;border-radius:20px;padding:16px 18px}
.today b{display:block;font-size:13px;color:#9A3412}.dark{background:#17181B;color:#fff;border-radius:22px;padding:20px;display:flex;flex-direction:column;gap:14px}
.dark .muted{color:#C8C9CC}.big{font-size:30px;font-weight:800}.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.v{font-size:22px;font-weight:800}
.bar{height:8px;border-radius:4px;background:#3A3C42}.bar i{display:block;height:8px;border-radius:4px;background:#F28A4B}
.effort{display:flex;height:14px;border-radius:7px;overflow:hidden;gap:2px}.k{font-size:13px;font-weight:800}
.btn{min-height:50px;border:0;border-radius:14px;background:#C2410C;color:#fff;font:700 16px Manrope,system-ui,sans-serif;padding:0 20px;cursor:pointer}
.btn.ghost{background:transparent;border:1px solid #DAD6CE;color:#55585F}input,textarea{width:100%;border:1px solid #DAD6CE;border-radius:14px;padding:14px;font:16px Manrope,system-ui,sans-serif;background:#fff}
label{font-size:14px;font-weight:600}.link{background:none;border:0;padding:12px 0;min-height:44px;color:#C8C9CC;font:600 12px Manrope,system-ui,sans-serif;text-decoration:underline;cursor:pointer;white-space:nowrap}
.step{display:flex;gap:10px;align-items:center;font-size:15px}.dot{width:12px;height:12px;border-radius:6px;flex:none}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:6px 4px;text-align:left;border-top:1px solid #ECE9E3}th{color:#55585F;font-weight:600}
.pf{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.pf label{display:flex;flex-direction:column;gap:4px}.pf span{font-size:12px;color:#55585F;font-weight:400}nav{position:fixed;bottom:0;left:0;right:0;display:grid;grid-template-columns:repeat(5,1fr);background:#fff;border-top:1px solid #E7E4DE;padding:6px 4px 18px}
nav a,nav span{min-height:50px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:11px;color:#55585F}
nav span{opacity:.5}nav a[aria-current]{color:#C2410C;font-weight:700}.err{background:#FDE2E2;color:#8A1C1C;border-radius:14px;padding:12px 14px}`;

const ICONS = {
  semaine: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  progres: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
  nutrition: '<path d="M12 7c-3-2-8-1-8 5 0 5 4 9 8 9s8-4 8-9c0-6-5-7-8-5zM12 7c0-2 1-4 3-4"/>',
  muscu: '<path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/>',
  profil: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
};
const icon = (k) => `<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`;

function nav(current) {
  const link = (k, href, label) => `<a href="${href}"${current === k ? ' aria-current="page"' : ''}>${icon(k)}${label}</a>`;
  const soon = (k, label) => `<span aria-disabled="true" title="Bientôt">${icon(k)}${label}</span>`;
  return `<nav aria-label="Navigation">${link('semaine', '/semaine', 'Semaine')}${link('progres', '/progres', 'Progrès')}${soon('nutrition', 'Nutrition')}${soon('muscu', 'Muscu')}${link('profil', '/profil', 'Profil')}</nav>`;
}

const page = (title, body, current, head = '') => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style>${head}</head><body><main>${body}</main>${current ? nav(current) : ''}</body></html>`;

function loginPage(error) {
  return page('Connexion', `<div style="margin-top:12vh;display:flex;flex-direction:column;gap:8px">
<h1>Marathon 2027</h1><p class="muted">Ton plan, tes séances et l'avis de ton coach.</p></div>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/login" style="display:flex;flex-direction:column;gap:14px">
<label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" required>
<label for="pwd">Mot de passe</label><input id="pwd" name="password" type="password" autocomplete="current-password" required>
<button class="btn" type="submit">Se connecter</button></form>
<a href="/inscription" class="btn ghost" style="display:flex;align-items:center;justify-content:center">Première fois ? Créer mon compte</a>`);
}

function signupPage(error, v = new URLSearchParams()) {
  const projects = projectChoices();
  return page('Créer mon compte', `<div style="display:flex;flex-direction:column;gap:8px"><h1>Créer mon compte</h1>
<p class="muted">Une seule fois : ensuite tu te connectes avec ton e-mail et ton mot de passe.</p></div>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/inscription" style="display:flex;flex-direction:column;gap:14px">
<label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(v.get('email'))}">
<label for="pwd">Mot de passe (8 caractères minimum)</label><input id="pwd" name="password" type="password" autocomplete="new-password" minlength="8" required>
<label for="key">Clé API intervals.icu</label><input id="key" name="apiKey" autocomplete="off" required value="${esc(v.get('apiKey'))}">
<p class="muted">Sur intervals.icu : Settings, tout en bas « Developer Settings », puis « API Key ». Copie-la ici.</p>
<label for="obj">Mon objectif</label><input id="obj" name="objectif" value="${esc(v.get('objectif') ?? 'Marathon · avril 2027')}">
${projects.length ? `<label for="proj">Mon projet coach</label><select id="proj" name="projet" style="height:52px;border:1px solid #DAD6CE;border-radius:14px;padding:0 12px;font:16px Manrope,system-ui,sans-serif;background:#fff">
<option value="">Aucun</option>${projects.map((p) => `<option${v.get('projet') === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
<p class="muted">Le dossier où Claude garde tes notes de coureur.</p>` : ''}
${SIGNUP_CODE ? `<label for="code">Code d'invitation</label><input id="code" name="code" autocomplete="off" required>` : ''}
<button class="btn" type="submit">Créer mon compte</button></form>
<a href="/login" class="muted" style="text-align:center;min-height:44px">J'ai déjà un compte</a>`);
}

// Vérifie la clé auprès d'intervals.icu (athlète 0 = celui de la clé) et crée le compte.
async function signup(f) {
  const email = String(f.get('email') || '').trim().toLowerCase();
  const password = String(f.get('password') || '');
  const apiKey = String(f.get('apiKey') || '').trim();
  const projet = String(f.get('projet') || '');
  if (SIGNUP_CODE && f.get('code') !== SIGNUP_CODE) return { error: "Code d'invitation incorrect." };
  if (!/^\S+@\S+\.\S+$/.test(email)) return { error: 'E-mail invalide.' };
  if (password.length < 8) return { error: 'Mot de passe trop court (8 caractères minimum).' };
  if (projet && !projectChoices().includes(projet)) return { error: 'Projet inconnu.' };
  const users = loadUsers();
  if (users.some((u) => u.email === email)) return { error: 'Un compte existe déjà avec cet e-mail.' };

  let athlete;
  try { athlete = await icu({ apiKey }, '/athlete/0'); } catch { return { error: "intervals.icu refuse cette clé API. Vérifie-la et réessaie." }; }
  if (users.some((u) => u.athleteId === athlete.id)) return { error: 'Ce compte intervals.icu a déjà un compte dans l\'app.' };

  const id = String(athlete.id).replace(/[^\w-]/g, '');
  const dir = projet ? path.join(RUNNERS_DIR, projet) : path.join(DATA_DIR, 'runners', id);
  fs.mkdirSync(dir, { recursive: true });
  const user = {
    id, name: String(athlete.firstname || athlete.name || email.split('@')[0]).trim(), email,
    password: hashPassword(password), athleteId: athlete.id, apiKey, dir, objectif: String(f.get('objectif') || '').slice(0, 200),
  };
  saveUsers([...users, user]);
  return { user };
}

async function weekPage(user) {
  const { monday, sunday } = weekBounds();
  const today = isoDay(new Date());
  const q = `oldest=${isoDay(monday)}&newest=${isoDay(sunday)}`;
  const [events, acts] = await Promise.all([
    icu(user, `/athlete/${user.athleteId}/events?${q}&category=WORKOUT`),
    icu(user, `/athlete/${user.athleteId}/activities?${q}`),
  ]);
  const runs = acts.filter((a) => /Run/.test(a.type));
  const cards = matchWeek(events, runs);

  const planned = cards.filter((c) => c.ev && c.day <= today);
  const done = planned.filter((c) => c.act).length;
  const notes = runs.map((a) => readAnalysis(user, a.id)?.note).filter((n) => n != null);
  const avg = notes.length ? (notes.reduce((s, n) => s + n, 0) / notes.length).toFixed(1).replace('.', ',') : '–';
  const doneKm = runs.reduce((s, a) => s + (a.distance || 0), 0);
  const plannedKm = events.reduce((s, e) => s + (e.distance || 0), 0);
  const time = runs.reduce((s, a) => s + (a.moving_time || 0), 0);
  const todayCard = cards.find((c) => c.day === today && c.ev);

  const cardHtml = cards.map(({ day, ev, act }) => {
    const title = esc(cleanTitle(ev ? ev.name : act.name));
    if (!act) {
      return `<a class="card todo" href="/prevu/${encodeURIComponent(ev.id)}"><div class="row"><span class="muted">${dayLabel(day)}</span><span class="chip">${day < today ? 'Manquée' : 'À venir'}</span></div>
<span class="title">${title}</span><span class="muted">${esc(planSummary(ev.description))}</span></a>`;
    }
    const a = readAnalysis(user, act.id);
    return `<a class="card" href="/seance/${encodeURIComponent(act.id)}"><div class="row"><span class="muted">${dayLabel(day)}</span>
<span class="chip ok">Fait${a ? ` · ${a.note}/10` : ''}</span></div><span class="title">${title}</span>
${ev ? `<span class="muted">${esc(planSummary(ev.description))}</span>` : ''}
<div class="stats"><span><b>${km(act.distance)}</b> km</span><span><b>${duration(act.moving_time)}</b></span><span><b>${pace(act.average_speed)}</b> /km</span></div></a>`;
  }).join('\n');

  const pct = plannedKm ? Math.min(100, Math.round((100 * doneKm) / plannedKm)) : 0;
  return page('Ma semaine', `<div><p class="muted">Semaine du ${dayLabel(isoDay(monday), { day: 'numeric', month: 'short' })} au ${dayLabel(isoDay(sunday), { day: 'numeric', month: 'short' })}</p>
<h1>Salut ${esc(user.name)}</h1></div>
<${todayCard ? `a href="/prevu/${encodeURIComponent(todayCard.ev.id)}"` : 'div'} class="today" style="display:block"><b>AUJOURD'HUI</b><span class="title">${todayCard ? esc(cleanTitle(todayCard.ev.name)) : 'Repos'}</span>
${todayCard ? `<p class="muted">${esc(planSummary(todayCard.ev.description))}</p>` : ''}</${todayCard ? 'a' : 'div'}>
<h2>Mes séances</h2>${cardHtml || '<p class="muted">Aucune séance prévue cette semaine.</p>'}
<section class="dark" aria-label="Bilan de la semaine"><h2 style="margin:0">Ma semaine</h2>
<div class="row"><span class="big">${km(doneKm)} km</span>${plannedKm ? `<span class="muted">sur ${km(plannedKm)} km prévus</span>` : ''}</div>
${plannedKm ? `<div class="bar" aria-hidden="true"><i style="width:${pct}%"></i></div>` : ''}
<div class="grid3"><div><div class="v">${duration(time)}</div><span class="muted">de course</span></div>
<div><div class="v">${avg}${notes.length ? '/10' : ''}</div><span class="muted">score moyen</span></div>
<div><div class="v">${done}/${planned.length}</div><span class="muted">séances faites</span></div></div></section>`, 'semaine');
}

async function sessionPage(user, actId, error) {
  const act = await icu(user, `/activity/${encodeURIComponent(actId)}`);
  if (act.icu_athlete_id !== user.athleteId) return null;
  const [planned, st] = await Promise.all([
    act.paired_event_id ? icu(user, `/athlete/${user.athleteId}/events/${act.paired_event_id}`).catch(() => null) : null,
    streams(user, act.id),
  ]);
  const a = readAnalysis(user, act.id);
  const e = effortSplit(act.icu_hr_zone_times);
  const day = act.start_date_local.slice(0, 10);

  const avis = a ? `<section class="dark" aria-label="Avis du coach"><h2 style="margin:0">L'avis du coach</h2>
<p style="font-size:17px;font-weight:700">${esc(a.resume)}</p>
<div><span class="k" style="color:#7FD3A0">CE QUI VA BIEN</span><p>${esc(a.bien)}</p></div>
<div><span class="k" style="color:#F6B07F">À AMÉLIORER</span><p>${esc(a.ameliorer)}</p></div>
<div><span class="k" style="color:#9FC1FF">POUR LA PROCHAINE</span><p>${esc(a.prochaine)}</p></div>
<form method="post" action="/seance/${encodeURIComponent(act.id)}/analyse" class="row">
<span class="muted" style="font-size:12px">Analysé par Claude avec ton profil · ${new Date(a.date).toLocaleDateString('fr-FR')}</span>
<button type="submit" class="link">Refaire l'analyse</button></form></section>`
    : `<form method="post" action="/seance/${encodeURIComponent(act.id)}/analyse" class="dark"><h2 style="margin:0">L'avis du coach</h2>
<p class="muted">Claude compare ta séance au plan, avec ton profil et ses derniers avis. Ça prend environ une minute.</p>
<button class="btn" type="submit">Demander l'avis du coach</button></form>`;

  return page(cleanTitle(planned?.name || act.name), `<a href="/semaine" class="muted" style="min-height:44px;display:flex;align-items:center">‹ Ma semaine</a>
<div style="display:flex;flex-direction:column;gap:6px"><span class="muted">${dayLabel(day, { weekday: 'long', day: 'numeric', month: 'short' })}</span>
<h1>${esc(cleanTitle(planned?.name || act.name))}</h1><span class="chip ok" style="align-self:flex-start">Fait${a ? ` · ${a.note}/10` : ''}</span></div>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<section class="card grid2" aria-label="Ce que tu as fait" style="display:grid">
<div><div class="v">${km(act.distance)} km</div><span class="muted">distance</span></div>
<div><div class="v">${duration(act.moving_time)}</div><span class="muted">${planned?.moving_time ? `prévu : ~${duration(planned.moving_time)}` : 'durée'}</span></div>
<div><div class="v">${pace(act.average_speed)}</div><span class="muted">min par km</span></div>
<div><div class="v">${act.average_heartrate ?? '–'}</div><span class="muted">battements/min en moyenne</span></div></section>
${e ? `<section class="card" aria-label="Intensité"><h2 style="margin:0;font-size:16px">Comment tu as couru</h2>
<div class="effort" role="img" aria-label="Facile ${e.facile} %, soutenu ${e.soutenu} %, dur ${e.dur} %">
<div style="width:${e.facile}%;background:#5AA87A"></div><div style="width:${e.soutenu}%;background:#F28A4B"></div><div style="width:${e.dur}%;background:#B4232C"></div></div>
<div class="stats" style="font-size:14px"><span><b>${e.facile} %</b> facile</span><span><b>${e.soutenu} %</b> soutenu</span><span><b>${e.dur} %</b> dur</span></div>
${planned ? `<p class="muted">Objectif : ${esc(planSummary(planned.description))}</p>` : ''}</section>` : ''}
${avis}
${detailed(act, st)}`, 'semaine', st.latlng?.length ? LEAFLET : '');
}

const LEAFLET = '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>';

// L'onglet repliable façon Strava : carte, résumé, temps au km, courbe d'allure.
function detailed(act, st) {
  const avg = act.distance ? act.moving_time / (act.distance / 1000) : 0;
  const splits = kmSplits(st);
  const fastest = Math.min(...splits.map((x) => x.moving / x.dist));
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const route = (st.latlng || []).filter((ll) => ll && ll[0] != null);
  const step = Math.ceil(route.length / 500);
  const coords = route.filter((_, i) => i % step === 0 || i === route.length - 1);
  const stat = (v, label) => `<div><div class="v" style="font-size:18px">${v}</div><span class="muted">${label}</span></div>`;
  return `<details class="card" id="detail"><summary style="font-weight:700;cursor:pointer;min-height:24px">Analyse détaillée</summary>
${coords.length > 1 ? `<div id="map" style="height:240px;border-radius:14px;background:#ECE9E3" role="img" aria-label="Carte du parcours"></div>
<script>document.getElementById('detail').addEventListener('toggle', function once(e) {
  if (!e.target.open || !window.L) return; e.target.removeEventListener('toggle', once);
  const map = L.map('map', { attributionControl: true, scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const line = L.polyline(${JSON.stringify(coords.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]))}, { color: '#C2410C', weight: 4 }).addTo(map);
  map.fitBounds(line.getBounds(), { padding: [16, 16] });
});</script>` : ''}
<div class="grid2">${stat(`${km(act.distance)} km`, 'distance')}${stat(`${pace(act.average_speed)} /km`, 'allure moyenne')}
${stat(duration(act.moving_time), 'durée de déplacement')}${stat(`${Math.round(act.total_elevation_gain || 0)} m`, 'dénivelé positif')}
${stat(act.calories ? `${act.calories} kcal` : '–', 'calories')}${stat(act.average_heartrate ? `${act.average_heartrate} bpm` : '–', 'FC moyenne')}</div>
${act.device_name ? `<span class="muted">Montre : ${esc(act.device_name)}</span>` : ''}
${splits.length ? `<h2 style="font-size:16px">Temps intermédiaires</h2>
<table><thead><tr><th>Km</th><th>Allure</th><th></th><th>Élév.</th><th>FC</th></tr></thead><tbody>
${splits.map((x, i) => {
  const sk = x.moving / x.dist * 1000;
  return `<tr><td>${x.dist < 990 ? km(x.dist) : i + 1}</td><td>${mmss(sk)}</td>
<td style="width:40%"><div style="height:10px;border-radius:5px;background:#F28A4B;width:${Math.round(100 * fastest * 1000 / sk)}%"></div></td>
<td>${x.elev ?? '–'}</td><td>${x.hr ?? '–'}</td></tr>`;
}).join('')}</tbody></table>` : ''}
${st.velocity_smooth ? `<h2 style="font-size:16px">Allure</h2>${paceChart(st, avg)}` : ''}
<div class="grid2">${stat(`${pace(act.average_speed)} /km`, 'allure moyenne')}${stat(duration(act.moving_time), 'durée de déplacement')}
${act.elapsed_time && act.distance ? stat(`${mmss(act.elapsed_time / (act.distance / 1000))} /km`, 'allure sur le temps écoulé') : ''}
${act.average_cadence ? stat(`${Math.round(act.average_cadence * 2)}`, 'pas par minute') : ''}</div>
${(act.interval_summary || []).map((x) => `<span class="muted">${esc(x)}</span>`).join('')}</details>`;
}

async function progressPage(user, sel) {
  const { monday } = weekBounds();
  const oldest = new Date(monday);
  oldest.setDate(monday.getDate() - 7 * 51);
  const acts = await icu(user, `/athlete/${user.athleteId}/activities?oldest=${isoDay(oldest)}&newest=${isoDay(new Date())}`);
  const year = weeklyTotals(acts.filter((a) => /Run/.test(a.type)), monday, 52);
  const streak = weekStreak(year); // shortcut: série plafonnée à 52 semaines, élargir la requête si besoin
  const weeks = year.slice(-12);
  const i = Number.isInteger(sel) && sel >= 0 && sel < 12 ? sel : 11;
  const w = weeks[i];
  const end = new Date(`${w.monday}T12:00:00`);
  end.setDate(end.getDate() + 6);
  const W = 340, H = 140, max = Math.max(5000, ...weeks.map((x) => x.dist));
  const pt = weeks.map((x, j) => [(j / 11) * W, H - (x.dist / max) * H]);
  const line = pt.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const short = (iso) => dayLabel(iso, { day: 'numeric', month: 'short' });
  const chart = `<svg viewBox="-8 -12 ${W + 16} ${H + 36}" width="100%" style="font:11px Manrope,system-ui,sans-serif" aria-label="Kilomètres par semaine">
<polygon points="0,${H} ${line} ${W},${H}" fill="#C2410C" opacity=".12"/><polyline points="${line}" fill="none" stroke="#C2410C" stroke-width="2"/>
${pt.map(([x, y], j) => `<a href="/progres?s=${j}" aria-label="Semaine du ${short(weeks[j].monday)} : ${km(weeks[j].dist)} km">
<circle cx="${x}" cy="${y}" r="14" fill="transparent"/><circle cx="${x}" cy="${y}" r="${j === i ? 6 : 4}" fill="${j === i ? '#C2410C' : '#fff'}" stroke="#C2410C" stroke-width="2"/></a>`).join('')}
<text x="0" y="${H + 20}" fill="#55585F">${short(weeks[0].monday)}</text><text x="${W}" y="${H + 20}" text-anchor="end" fill="#55585F">cette semaine</text>
<text x="0" y="-2" fill="#55585F">${km(max)} km</text></svg>`;
  return page('Progrès', `<div><p class="muted">12 dernières semaines</p><h1>Progrès</h1></div>
<section class="card" aria-label="Kilomètres par semaine">${chart}
<p class="muted">${short(w.monday)} – ${short(isoDay(end))}${i === 11 ? ' · cette semaine' : ''}</p>
<div class="grid3"><div><div class="v">${km(w.dist)} km</div><span class="muted">distance</span></div>
<div><div class="v">${duration(w.time)}</div><span class="muted">temps</span></div>
<div><div class="v">${Math.round(w.elev)} m</div><span class="muted">dénivelé</span></div></div></section>
<section class="dark" aria-label="Série"><h2 style="margin:0">Série</h2>
<div><span class="big">${streak} semaine${streak > 1 ? 's' : ''}</span><p class="muted">d'affilée avec au moins une sortie</p></div>
<p class="muted">${year.reduce((s, x) => s + x.runs, 0)} sortie(s) et ${km(year.reduce((s, x) => s + x.dist, 0))} km sur 12 mois.</p></section>`, 'progres');
}

async function plannedPage(user, eventId) {
  const ev = await icu(user, `/athlete/${user.athleteId}/events/${encodeURIComponent(eventId)}`).catch(() => null);
  if (!ev || ev.category !== 'WORKOUT') return null;
  const { params } = await currentParams(user);
  const lines = stepLines(ev.workout_doc?.steps, params.zones);
  const color = (z) => (!z ? '#C8C9CC' : z <= 2 ? '#5AA87A' : z === 3 ? '#F28A4B' : '#B4232C');
  const day = ev.start_date_local.slice(0, 10);
  return page(cleanTitle(ev.name), `<a href="/semaine" class="muted" style="min-height:44px;display:flex;align-items:center">‹ Ma semaine</a>
<div style="display:flex;flex-direction:column;gap:6px"><span class="muted">${dayLabel(day, { weekday: 'long', day: 'numeric', month: 'short' })}</span>
<h1>${esc(cleanTitle(ev.name))}</h1><span class="chip" style="align-self:flex-start">${day < isoDay(new Date()) ? 'Manquée' : 'À venir'}</span></div>
<p>${esc(planSummary(ev.description))}</p>
<section class="card grid2" aria-label="En bref" style="display:grid">
<div><div class="v">${ev.moving_time ? duration(ev.moving_time) : '–'}</div><span class="muted">durée prévue</span></div>
<div><div class="v">${ev.distance ? `${km(ev.distance)} km` : '–'}</div><span class="muted">distance prévue</span></div></section>
${lines.length ? `<section class="card" aria-label="Déroulé"><h2 style="margin:0;font-size:16px">Le déroulé</h2>
${lines.map((l) => `<div class="step" style="padding-left:${l.depth * 22}px"><span class="dot" aria-hidden="true" style="background:${color(l.zone)}"></span><span>${esc(l.text)}</span></div>`).join('')}</section>` : ''}
${params.zones ? `<section class="card" aria-label="Mes zones"><h2 style="margin:0;font-size:16px">Mes zones cardio</h2><table>
${ZONE_NAMES.map((n, i) => (params.zones[i] ? `<tr><td><span class="dot" aria-hidden="true" style="display:inline-block;background:${color(i + 1)}"></span> ${n}</td><td>${zoneRange(params.zones, i + 1)}</td></tr>` : '')).join('')}</table></section>` : ''}`, 'semaine');
}

const fmtParam = (k, v) => (v == null ? '' : k === 'allureSeuil' ? pace(v) : k === 'zones' ? v.join(', ') : String(v));
const PARAM_FIELDS = [
  ['fcMax', 'FC max', 'bpm'], ['fcSeuil', 'FC au seuil', 'bpm'], ['fcRepos', 'FC de repos', 'bpm'],
  ['allureSeuil', 'Allure seuil', 'min/km'], ['vo2max', 'VO2max', ''], ['zones', 'Zones FC (plafonds Z1 à Z7)', 'bpm'],
];

// Saisie manuelle -> surcharges validées ; champ vide = valeur d'intervals.icu.
function parseParams(f) {
  const out = {};
  for (const [k, label] of PARAM_FIELDS) {
    const raw = String(f.get(k) || '').trim();
    if (!raw) continue;
    let v;
    if (k === 'allureSeuil') v = parsePace(raw);
    else if (k === 'zones') {
      v = raw.split(/[,;\s]+/).map(Number);
      if (v.length > 7 || v.some((n, i) => !Number.isInteger(n) || n < 30 || n > 250 || (i && n <= v[i - 1]))) v = null;
    } else {
      v = Number(raw.replace(',', '.'));
      const [min, max] = k === 'vo2max' ? [10, 100] : [30, 250];
      if (!(v >= min && v <= max)) v = null;
    }
    if (v == null) return { error: `${label} : valeur invalide.` };
    out[k] = v;
  }
  return { params: out };
}

async function profilePage(user, msg, error) {
  const { params, auto, history } = await currentParams(user);
  const manual = user.params || {};
  return page('Profil', `<div style="display:flex;align-items:center;gap:14px">
<span aria-hidden="true" style="width:56px;height:56px;border-radius:28px;background:#C2410C;color:#fff;font-size:24px;font-weight:800;display:flex;align-items:center;justify-content:center">${esc(user.name.charAt(0))}</span>
<div><h1 style="font-size:26px">${esc(user.name)}</h1><span class="muted">Connecté à intervals.icu</span></div></div>
${msg ? `<p role="status" style="color:#1D7A46;font-weight:600">${esc(msg)}</p>` : ''}${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<section class="card"><span class="k muted">MON OBJECTIF</span><span class="title">${esc(user.objectif || 'Marathon · avril 2027')}</span></section>
<form method="post" action="/profil" class="card"><label for="name">Mon prénom</label>
<input id="name" name="name" required maxlength="40" value="${esc(user.name)}">
<label for="ctx" style="font-size:16px;font-weight:800;margin-top:6px">Ce que mon coach doit savoir sur moi</label>
<p class="muted">Claude relit ce texte avant chaque analyse, avec tes dernières séances et ses anciens avis.</p>
<textarea id="ctx" name="contexte" rows="8" maxlength="20000" placeholder="Blessures, contraintes, disponibilités, ce qui te motive…">${esc(readContext(user))}</textarea>
<button class="btn" type="submit" style="align-self:flex-start">Enregistrer</button></form>
<form method="post" action="/profil/parametres" class="card"><h2 style="margin:0;font-size:16px">Mes paramètres</h2>
<p class="muted">Remplis automatiquement depuis intervals.icu. Écris une valeur pour la corriger, vide le champ pour revenir à celle d'intervals.icu.</p>
<div class="pf">${PARAM_FIELDS.map(([k, label, unit]) => `<label${k === 'zones' ? ' style="grid-column:1/-1"' : ''}>${label}${unit ? ` (${unit})` : ''}
<input name="${k}" inputmode="${k === 'zones' || k === 'allureSeuil' ? 'text' : 'decimal'}" value="${esc(fmtParam(k, manual[k]))}" placeholder="${esc(fmtParam(k, auto[k]) || '–')}">
<span>${manual[k] != null ? 'corrigé à la main' : 'intervals.icu'}</span></label>`).join('')}</div>
<button class="btn" type="submit" style="align-self:flex-start">Enregistrer mes paramètres</button></form>
${history.length ? `<section class="card" aria-label="Historique"><h2 style="margin:0;font-size:16px">Ma progression</h2>
<div style="overflow-x:auto"><table><tr><th>Date</th><th>FC repos</th><th>FC seuil</th><th>Allure seuil</th><th>VO2max</th></tr>
${[...history].reverse().slice(0, 12).map((h) => `<tr><td>${new Date(`${h.date}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</td>
<td>${h.fcRepos ?? '–'}</td><td>${h.fcSeuil ?? '–'}</td><td>${h.allureSeuil ? pace(h.allureSeuil) : '–'}</td><td>${h.vo2max ?? '–'}</td></tr>`).join('')}
</table></div></section>` : ''}
<form method="post" action="/logout"><button class="btn ghost" type="submit" style="width:100%">Se déconnecter</button></form>`, 'profil');
}

// ---------- serveur ----------

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64_000) { reject(new Error('Formulaire trop gros')); req.destroy(); } });
    req.on('end', () => resolve(new URLSearchParams(body)));
  });
}

function currentUser(req) {
  const m = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '');
  const id = m && unsign(decodeURIComponent(m[1]));
  return id ? loadUsers().find((u) => u.id === id) || null : null;
}

const send = (res, status, html, headers = {}) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end(); };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/login' && req.method === 'GET') return send(res, 200, loginPage());
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const loggedIn = (user) => redirect(res, '/semaine', { 'Set-Cookie': `session=${encodeURIComponent(sign(user.id))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}` });
  if (p === '/login' && req.method === 'POST') {
    const f = await readForm(req);
    const user = loadUsers().find((u) => u.email.toLowerCase() === String(f.get('email')).trim().toLowerCase());
    if (!user || !checkPassword(String(f.get('password')), user.password)) return send(res, 401, loginPage('E-mail ou mot de passe incorrect.'));
    return loggedIn(user);
  }
  if (p === '/inscription' && req.method === 'GET') return send(res, 200, signupPage());
  if (p === '/inscription' && req.method === 'POST') {
    const f = await readForm(req);
    const { user, error } = await signup(f);
    return user ? loggedIn(user) : send(res, 400, signupPage(error, f));
  }

  const user = currentUser(req);
  if (!user) return redirect(res, '/login');

  if (p === '/logout' && req.method === 'POST') return redirect(res, '/login', { 'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  if (p === '/' || p === '/semaine') return send(res, 200, await weekPage(user));
  if (p === '/profil' && req.method === 'GET') return send(res, 200, await profilePage(user, url.searchParams.has('ok') ? 'Enregistré.' : ''));
  if (p === '/profil' && req.method === 'POST') {
    const f = await readForm(req);
    const name = String(f.get('name') || '').trim().slice(0, 40);
    if (name) updateUser(user.id, { name });
    fs.writeFileSync(contextFile(user), String(f.get('contexte') || '').slice(0, 20_000));
    return redirect(res, '/profil?ok');
  }
  if (p === '/profil/parametres' && req.method === 'POST') {
    const { params, error } = parseParams(await readForm(req));
    if (error) return send(res, 400, await profilePage(user, '', error));
    updateUser(user.id, { params });
    return redirect(res, '/profil?ok');
  }
  if (p === '/progres') return send(res, 200, await progressPage(user, url.searchParams.has('s') ? Number(url.searchParams.get('s')) : undefined));
  const pm = /^\/prevu\/(\d+)$/.exec(p);
  if (pm && req.method === 'GET') {
    const html = await plannedPage(user, pm[1]);
    return html ? send(res, 200, html) : send(res, 404, page('Introuvable', '<h1>Séance introuvable</h1>', 'semaine'));
  }

  const m = /^\/seance\/([\w-]+)(\/analyse)?$/.exec(p);
  if (m && !m[2] && req.method === 'GET') {
    const html = await sessionPage(user, m[1]);
    return html ? send(res, 200, html) : send(res, 404, page('Introuvable', '<h1>Séance introuvable</h1>', 'semaine'));
  }
  if (m && m[2] && req.method === 'POST') {
    const key = `${user.id}/${m[1]}`;
    if (!running.has(key)) {
      running.add(key);
      try {
        const act = await icu(user, `/activity/${encodeURIComponent(m[1])}`);
        if (act.icu_athlete_id !== user.athleteId) return send(res, 404, page('Introuvable', '<h1>Séance introuvable</h1>', 'semaine'));
        const planned = act.paired_event_id ? await icu(user, `/athlete/${user.athleteId}/events/${act.paired_event_id}`).catch(() => null) : null;
        await analyse(user, act, planned);
      } catch (err) {
        console.error('analyse', key, err);
        return send(res, 500, await sessionPage(user, m[1], "Le coach n'a pas pu analyser la séance. Réessaie dans un moment."));
      } finally {
        running.delete(key);
      }
    }
    return redirect(res, `/seance/${m[1]}`);
  }
  return send(res, 404, page('Introuvable', '<h1>Page introuvable</h1>', 'semaine'));
}

if (require.main === module) {
  if (process.argv[2] === 'hash') {
    console.log(hashPassword(process.argv[3] || ''));
    process.exit(0);
  }
  if (SECRET.length < 16) {
    console.error('SESSION_SECRET manquant (16 caractères minimum).');
    process.exit(1);
  }
  http.createServer((req, res) => handle(req, res).catch((err) => {
    console.error(err);
    send(res, 502, page('Erreur', '<h1>Oups</h1><p class="muted">Impossible de récupérer tes données intervals.icu pour le moment.</p><a class="btn" href="/semaine" style="display:flex;align-items:center;justify-content:center">Réessayer</a>'));
  })).listen(PORT, () => console.log(`App running sur http://localhost:${PORT}`));
}

module.exports = { kmSplits, paceChart, weeklyTotals, weekStreak, mergeParams, parsePace, zoneRange, stepLines, nextHistory, parseParams, hashPassword, checkPassword, sign, unsign, weekBounds, cleanTitle, planSummary, effortSplit, matchWeek, parseAnalysis, isoDay };
