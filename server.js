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

const loadUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

async function icu(user, p) {
  const res = await fetch(`https://intervals.icu/api/v1${p}`, {
    headers: { Authorization: `Basic ${Buffer.from(`API_KEY:${user.apiKey}`).toString('base64')}` },
  });
  if (!res.ok) throw new Error(`intervals.icu ${res.status} sur ${p}`);
  return res.json();
}

const analysisFile = (user, actId) => path.join(DATA_DIR, user.id, `${String(actId).replace(/[^\w-]/g, '')}.json`);

function readAnalysis(user, actId) {
  try { return JSON.parse(fs.readFileSync(analysisFile(user, actId), 'utf8')); } catch { return null; }
}

function recentAnalyses(user, n = 3) {
  const dir = path.join(DATA_DIR, user.id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
}

const contextFile = (user) => path.join(user.dir, 'CONTEXTE.md');
const readContext = (user) => { try { return fs.readFileSync(contextFile(user), 'utf8'); } catch { return ''; } };

const running = new Set();

async function analyse(user, act, planned) {
  const today = isoDay(new Date());
  const in7 = new Date(); in7.setDate(in7.getDate() + 7);
  const upcoming = await icu(user, `/athlete/${user.athleteId}/events?oldest=${today}&newest=${isoDay(in7)}&category=WORKOUT`);
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
label{font-size:14px;font-weight:600}nav{position:fixed;bottom:0;left:0;right:0;display:grid;grid-template-columns:repeat(5,1fr);background:#fff;border-top:1px solid #E7E4DE;padding:6px 4px 18px}
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
  return `<nav aria-label="Navigation">${link('semaine', '/semaine', 'Semaine')}${soon('progres', 'Progrès')}${soon('nutrition', 'Nutrition')}${soon('muscu', 'Muscu')}${link('profil', '/profil', 'Profil')}</nav>`;
}

const page = (title, body, current) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><main>${body}</main>${current ? nav(current) : ''}</body></html>`;

function loginPage(error) {
  return page('Connexion', `<div style="margin-top:12vh;display:flex;flex-direction:column;gap:8px">
<h1>Marathon 2027</h1><p class="muted">Ton plan, tes séances et l'avis de ton coach.</p></div>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/login" style="display:flex;flex-direction:column;gap:14px">
<label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" required>
<label for="pwd">Mot de passe</label><input id="pwd" name="password" type="password" autocomplete="current-password" required>
<button class="btn" type="submit">Se connecter</button></form>`);
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
      return `<div class="card todo"><div class="row"><span class="muted">${dayLabel(day)}</span><span class="chip">${day < today ? 'Manquée' : 'À venir'}</span></div>
<span class="title">${title}</span><span class="muted">${esc(planSummary(ev.description))}</span></div>`;
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
<div class="today"><b>AUJOURD'HUI</b><span class="title">${todayCard ? esc(cleanTitle(todayCard.ev.name)) : 'Repos'}</span>
${todayCard ? `<p class="muted">${esc(planSummary(todayCard.ev.description))}</p>` : ''}</div>
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
  const planned = act.paired_event_id ? await icu(user, `/athlete/${user.athleteId}/events/${act.paired_event_id}`).catch(() => null) : null;
  const a = readAnalysis(user, act.id);
  const e = effortSplit(act.icu_hr_zone_times);
  const day = act.start_date_local.slice(0, 10);

  const avis = a ? `<section class="dark" aria-label="Avis du coach"><h2 style="margin:0">L'avis du coach</h2>
<p style="font-size:17px;font-weight:700">${esc(a.resume)}</p>
<div><span class="k" style="color:#7FD3A0">CE QUI VA BIEN</span><p>${esc(a.bien)}</p></div>
<div><span class="k" style="color:#F6B07F">À AMÉLIORER</span><p>${esc(a.ameliorer)}</p></div>
<div><span class="k" style="color:#9FC1FF">POUR LA PROCHAINE</span><p>${esc(a.prochaine)}</p></div>
<span class="muted" style="font-size:12px">Analysé par Claude avec ton profil · ${new Date(a.date).toLocaleDateString('fr-FR')}</span></section>`
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
<details class="card"><summary style="font-weight:700;cursor:pointer">Plus de détails</summary>
${(act.interval_summary || []).map((s) => `<span class="muted">${esc(s)}</span>`).join('')}
<span class="muted">Dénivelé + ${Math.round(act.total_elevation_gain || 0)} m · cadence ${Math.round((act.average_cadence || 0) * 2)} pas/min</span></details>`, 'semaine');
}

function profilePage(user, saved) {
  return page('Profil', `<div style="display:flex;align-items:center;gap:14px">
<span aria-hidden="true" style="width:56px;height:56px;border-radius:28px;background:#C2410C;color:#fff;font-size:24px;font-weight:800;display:flex;align-items:center;justify-content:center">${esc(user.name.charAt(0))}</span>
<div><h1 style="font-size:26px">${esc(user.name)}</h1><span class="muted">Connecté à intervals.icu</span></div></div>
<section class="card"><span class="k muted">MON OBJECTIF</span><span class="title">${esc(user.objectif || 'Marathon · avril 2027')}</span></section>
<form method="post" action="/profil" class="card"><label for="ctx" style="font-size:16px;font-weight:800">Ce que mon coach doit savoir sur moi</label>
<p class="muted">Claude relit ce texte avant chaque analyse, avec tes dernières séances et ses anciens avis.</p>
<textarea id="ctx" name="contexte" rows="8" maxlength="20000" placeholder="Blessures, contraintes, disponibilités, ce qui te motive…">${esc(readContext(user))}</textarea>
${saved ? '<p role="status" style="color:#1D7A46;font-weight:600">Enregistré.</p>' : ''}
<button class="btn" type="submit" style="align-self:flex-start">Enregistrer</button></form>
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
  if (p === '/login' && req.method === 'POST') {
    const f = await readForm(req);
    const user = loadUsers().find((u) => u.email.toLowerCase() === String(f.get('email')).trim().toLowerCase());
    if (!user || !checkPassword(String(f.get('password')), user.password)) return send(res, 401, loginPage('E-mail ou mot de passe incorrect.'));
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return redirect(res, '/semaine', { 'Set-Cookie': `session=${encodeURIComponent(sign(user.id))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}` });
  }

  const user = currentUser(req);
  if (!user) return redirect(res, '/login');

  if (p === '/logout' && req.method === 'POST') return redirect(res, '/login', { 'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  if (p === '/' || p === '/semaine') return send(res, 200, await weekPage(user));
  if (p === '/profil' && req.method === 'GET') return send(res, 200, profilePage(user, url.searchParams.has('ok')));
  if (p === '/profil' && req.method === 'POST') {
    const f = await readForm(req);
    fs.writeFileSync(contextFile(user), String(f.get('contexte') || '').slice(0, 20_000));
    return redirect(res, '/profil?ok');
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

module.exports = { hashPassword, checkPassword, sign, unsign, weekBounds, cleanTitle, planSummary, effortSplit, matchWeek, parseAnalysis, isoDay };
