/* Patrimoine — tableau de bord personnel (PWA)
 * Données : un fichier JSON dans un gist GitHub secret, lu et écrit
 * par l'appli (saisie manuelle) et par le script de synchro IBKR.
 */
'use strict';

const GIST_FILE = 'patrimoine.json';
const KEY_SETTINGS = 'patrimoine.settings';
const KEY_CACHE = 'patrimoine.cache';
const KEY_UI = 'patrimoine.ui';
const STALE_DAYS = 45;
const PALETTE = ['#1f5c46', '#c2703d', '#3b6ea5', '#8a5a9e', '#b8913a', '#4f8f8b', '#a3485a', '#6b7a3a'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- Stockage local (protégé : peut échouer en navigation privée) ---------- */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

let settings = store.get(KEY_SETTINGS, { token: '', gistId: '' });
let ui = store.get(KEY_UI, { range: 365, private: false });
let data = store.get(KEY_CACHE, null);

const isGistMode = () => Boolean(settings.token && settings.gistId);

/* ---------- Dates et formats ---------- */
const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => toISO(new Date());
const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

const eur0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat('fr-FR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const pct0 = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const dateShort = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' });

const fmtEur = v => eur0.format(v);
const fmtSigned = v => (v > 0 ? '+' : v < 0 ? '−' : '') + eur0.format(Math.abs(v));
const fmtDate = iso => dateFmt.format(parseISO(iso));
function fmtRelative(iso) {
  const n = daysBetween(iso, today());
  if (n <= 0) return "aujourd'hui";
  if (n === 1) return 'hier';
  if (n < 30) return `il y a ${n} j`;
  return `le ${fmtDate(iso)}`;
}
function parseAmount(raw) {
  const s = String(raw).replace(/[\s  €]/g, '').replace(',', '.');
  if (s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
}
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'compte';

/* ---------- Modèle de données ---------- */
function defaultData() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    accounts: [
      { id: 'pea-boursorama', name: 'PEA Boursorama', color: PALETTE[0], source: 'manual' },
      { id: 'ibkr', name: 'Interactive Brokers', color: PALETTE[2], source: 'ibkr' },
      { id: 'livrets', name: 'Livrets', color: PALETTE[4], source: 'manual' },
      { id: 'compte-courant', name: 'Compte courant', color: PALETTE[5], source: 'manual' },
      { id: 'epargne-salariale', name: 'Épargne salariale', color: PALETTE[1], source: 'manual' },
    ],
    entries: [],
  };
}

function normalize(d) {
  if (!d || typeof d !== 'object') throw new Error('Fichier illisible');
  if (!Array.isArray(d.accounts) || !Array.isArray(d.entries)) throw new Error('Format inattendu (accounts / entries manquants)');
  d.entries = d.entries.filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number.isFinite(e.value));
  return d;
}

function upsert(d, date, account, value, source = 'manual') {
  const i = d.entries.findIndex(e => e.date === date && e.account === account);
  const entry = { date, account, value, source };
  if (i >= 0) d.entries[i] = entry; else d.entries.push(entry);
}

const activeAccounts = d => d.accounts.filter(a => !a.archivedAt);
const accountById = (d, id) => d.accounts.find(a => a.id === id);

/** Série du total : chaque compte garde sa dernière valeur connue jusqu'à la suivante. */
function totalSeries(d) {
  const archived = Object.fromEntries(d.accounts.filter(a => a.archivedAt).map(a => [a.id, a.archivedAt]));
  const known = new Set(d.accounts.map(a => a.id));
  const entries = d.entries.filter(e => known.has(e.account)).sort((a, b) => a.date.localeCompare(b.date));
  const dates = [...new Set(entries.map(e => e.date))];
  const archiveDates = Object.values(archived);
  const allDates = [...new Set([...dates, ...archiveDates])].sort();
  const last = {};
  const series = [];
  let i = 0;
  for (const date of allDates) {
    while (i < entries.length && entries[i].date <= date) { last[entries[i].account] = entries[i].value; i++; }
    let total = 0;
    for (const [id, v] of Object.entries(last)) if (!(archived[id] && archived[id] <= date)) total += v;
    series.push({ date, value: Math.round(total * 100) / 100 });
  }
  return series;
}

function valueAt(series, date) {
  let v = null;
  for (const p of series) { if (p.date <= date) v = p.value; else break; }
  return v;
}

function accountHistory(d, id) {
  return d.entries.filter(e => e.account === id).sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------- GitHub Gist ---------- */
class SyncError extends Error {}

async function gh(path, options = {}) {
  let res;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      ...options,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${settings.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new SyncError('Hors ligne : impossible de joindre GitHub');
  }
  if (res.status === 401) throw new SyncError('Token GitHub invalide ou expiré');
  if (res.status === 403) throw new SyncError('Accès refusé : le token doit avoir le droit « gist »');
  if (res.status === 404) throw new SyncError('Gist introuvable : vérifie son ID');
  if (!res.ok) throw new SyncError(`Erreur GitHub (${res.status})`);
  return res.json();
}

async function gistLoad() {
  const gist = await gh(`/gists/${encodeURIComponent(settings.gistId)}`);
  const file = gist.files?.[GIST_FILE];
  if (!file) throw new SyncError(`Le gist ne contient pas de fichier ${GIST_FILE}`);
  let content = file.content;
  if (file.truncated) content = await (await fetch(file.raw_url, { cache: 'no-store' })).text();
  return normalize(JSON.parse(content));
}

async function gistSave(d) {
  await gh(`/gists/${encodeURIComponent(settings.gistId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(d, null, 1) } } }),
  });
}

async function gistCreate(d) {
  const gist = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: 'Patrimoine — données du tableau de bord',
      public: false,
      files: { [GIST_FILE]: { content: JSON.stringify(d, null, 1) } },
    }),
  });
  return gist.id;
}

/* ---------- État de synchro ---------- */
function setSync(state, label) {
  const el = $('#syncStatus');
  el.dataset.state = state;
  el.title = label || {
    ok: 'Synchronisé', busy: 'Synchronisation…', offline: 'Hors ligne (dernières données connues)',
    error: 'Erreur de synchronisation', local: 'Données sur cet appareil uniquement', idle: '',
  }[state];
}

async function refresh({ silent = false } = {}) {
  if (!isGistMode()) { setSync(data ? 'local' : 'idle'); return; }
  setSync('busy');
  try {
    data = await gistLoad();
    store.set(KEY_CACHE, data);
    setSync('ok');
    render();
  } catch (err) {
    const offline = err.message.startsWith('Hors ligne');
    setSync(offline ? 'offline' : 'error', err.message);
    if (!silent) toast(err.message);
  }
}

/** Applique une modification sur la version la plus récente, puis enregistre. */
async function mutate(fn, okMessage) {
  if (isGistMode()) {
    setSync('busy');
    try {
      const fresh = await gistLoad();
      fn(fresh);
      fresh.updatedAt = new Date().toISOString();
      await gistSave(fresh);
      data = fresh;
      store.set(KEY_CACHE, data);
      setSync('ok');
    } catch (err) {
      setSync(err.message.startsWith('Hors ligne') ? 'offline' : 'error', err.message);
      toast(`Non enregistré — ${err.message}`);
      return false;
    }
  } else {
    fn(data);
    data.updatedAt = new Date().toISOString();
    store.set(KEY_CACHE, data);
    setSync('local');
  }
  render();
  if (okMessage) toast(okMessage);
  return true;
}

/* ---------- Rendu ---------- */
function render() {
  const has = Boolean(data);
  $('#welcome').hidden = has;
  $('#dashboard').hidden = !has;
  $('#fab').hidden = !has;
  document.body.classList.toggle('private', Boolean(ui.private));
  $('#btnPrivacy').setAttribute('aria-pressed', String(Boolean(ui.private)));
  if (!has) return;

  const series = totalSeries(data);
  renderHero(series);
  renderChart(series);
  renderAllocation();
  renderAccounts();
}

function setDelta(el, from, to, label) {
  if (from == null || to == null || from === 0) { el.hidden = true; return; }
  const diff = to - from;
  el.hidden = false;
  el.className = 'delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '');
  const rel = from !== 0 ? ` (${pct.format(diff / Math.abs(from))})` : '';
  el.innerHTML = `<span class="money">${fmtSigned(diff)}</span>${rel} <span class="muted">${label}</span>`;
}

function renderHero(series) {
  const now = series.length ? series[series.length - 1].value : 0;
  $('#total').textContent = fmtEur(now);
  const t = today();
  setDelta($('#deltaMonth'), valueAt(series, addDays(t, -30)), now, 'sur 1 mois');
  // Point de départ : premier jour où chaque compte actif a déjà une valeur
  // (sinon l'arrivée d'un compte ressemblerait à un gain)
  const starts = activeAccounts(data).map(a => accountHistory(data, a.id)[0]?.date).filter(Boolean);
  const startDate = starts.length ? starts.sort()[starts.length - 1] : null;
  const startValue = startDate && startDate < addDays(t, -30) ? valueAt(series, startDate) : null;
  setDelta($('#deltaStart'), startValue, now, startDate ? `depuis ${dateShort.format(parseISO(startDate))}` : '');
  const lastDate = data.entries.reduce((m, e) => (e.date > m ? e.date : m), '');
  $('#lastUpdate').textContent = lastDate ? `Dernière valeur saisie ${fmtRelative(lastDate)}` : 'Aucune valeur pour l’instant : appuie sur « Mettre à jour ».';
}

/* Graphique SVG fait main (aucune dépendance, fonctionne hors ligne) */
function renderChart(series) {
  const box = $('#chart');
  const range = Number(ui.range);
  $$('.seg button').forEach(b => b.setAttribute('aria-selected', String(Number(b.dataset.range) === range)));

  const t = today();
  let pts = series.slice();
  if (range > 0 && pts.length) {
    const start = addDays(t, -range);
    const before = valueAt(series, start);
    pts = pts.filter(p => p.date > start);
    if (before != null) pts.unshift({ date: start, value: before });
  }
  if (pts.length && pts[pts.length - 1].date < t) pts.push({ date: t, value: pts[pts.length - 1].value });

  const W = Math.max(box.clientWidth, 280), H = box.clientHeight || 200;
  const padL = 4, padR = 4, padT = 12, padB = 22;
  if (pts.length < 2) {
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">Pas encore assez de points pour tracer une courbe</text></svg>`;
    $('#chartReadout').textContent = '';
    return;
  }

  const t0 = parseISO(pts[0].date).getTime(), t1 = parseISO(pts[pts.length - 1].date).getTime();
  let lo = Math.min(...pts.map(p => p.value)), hi = Math.max(...pts.map(p => p.value));
  const span = hi - lo || Math.max(hi * 0.05, 100);
  lo -= span * 0.12; hi += span * 0.12;
  const x = ms => padL + (W - padL - padR) * ((ms - t0) / (t1 - t0 || 1));
  const y = v => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const xy = pts.map(p => [x(parseISO(p.date).getTime()), y(p.value)]);

  const line = xy.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join('');
  const area = `${line}L${xy[xy.length - 1][0].toFixed(1)},${H - padB}L${xy[0][0].toFixed(1)},${H - padB}Z`;
  const grid = [0.25, 0.5, 0.75].map(f => {
    const v = lo + (hi - lo) * f, yy = y(v).toFixed(1);
    return `<line class="grid" x1="0" x2="${W}" y1="${yy}" y2="${yy}"/><text class="axis money" x="2" y="${yy - 4}">${compact.format(v)} €</text>`;
  }).join('');
  const lbl = iso => dateShort.format(parseISO(iso));

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du total">
      <defs><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/>
        <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      <text class="axis" x="${padL}" y="${H - 4}">${lbl(pts[0].date)}</text>
      <text class="axis" x="${W - padR}" y="${H - 4}" text-anchor="end">${lbl(pts[pts.length - 1].date)}</text>
      <line class="cursor" y1="${padT}" y2="${H - padB}" visibility="hidden"/>
      <circle class="dot" r="5" visibility="hidden"/>
    </svg>`;

  const first = pts[0].value, lastV = pts[pts.length - 1].value;
  const periodText = () => {
    const diff = lastV - first;
    const rel = first ? ` (${pct.format(diff / Math.abs(first))})` : '';
    return `Sur la période : <strong class="money">${fmtSigned(diff)}</strong>${rel}`;
  };
  const readout = $('#chartReadout');
  readout.innerHTML = periodText();

  const svg = $('svg', box), cursor = $('.cursor', svg), dot = $('.dot', svg);
  const show = evt => {
    const r = svg.getBoundingClientRect();
    const px = (evt.clientX - r.left) * (W / r.width);
    let best = 0;
    xy.forEach(([a], i) => { if (Math.abs(a - px) < Math.abs(xy[best][0] - px)) best = i; });
    const [a, b] = xy[best];
    cursor.setAttribute('x1', a); cursor.setAttribute('x2', a); cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', a); dot.setAttribute('cy', b); dot.setAttribute('visibility', 'visible');
    readout.innerHTML = `${fmtDate(pts[best].date)} : <strong class="money">${fmtEur(pts[best].value)}</strong>`;
  };
  const hide = () => {
    cursor.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
    readout.innerHTML = periodText();
  };
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') setTimeout(hide, 1500); });
}

function latestValues() {
  return activeAccounts(data).map(a => {
    const h = accountHistory(data, a.id);
    const last = h[h.length - 1], prev = h[h.length - 2];
    return { account: a, last, prev, value: last ? last.value : 0 };
  });
}

function renderAllocation() {
  const rows = latestValues().filter(r => r.value > 0).sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const bar = $('#allocBar'), list = $('#allocList');
  if (!total) { bar.innerHTML = ''; list.innerHTML = '<li class="muted">Aucune valeur saisie.</li>'; return; }
  bar.innerHTML = rows.map(r => `<span style="flex:${r.value};background:${r.account.color}"></span>`).join('');
  list.innerHTML = rows.map(r => `
    <li><span class="swatch" style="background:${r.account.color}"></span>
      <span>${esc(r.account.name)}</span>
      <span class="money">${fmtEur(r.value)}</span>
      <span class="pct">${pct0.format(r.value / total)}</span></li>`).join('');
}

function renderAccounts() {
  const ul = $('#accounts');
  ul.innerHTML = latestValues().map(({ account: a, last, prev }) => {
    let meta = 'Aucune valeur', stale = false, chg = '';
    if (last) {
      meta = `Mis à jour ${fmtRelative(last.date)}`;
      stale = a.source !== 'ibkr' && daysBetween(last.date, today()) > STALE_DAYS;
      if (prev) {
        const d = last.value - prev.value;
        chg = `<div class="chg ${d > 0 ? 'up' : d < 0 ? 'down' : ''}"><span class="money">${fmtSigned(d)}</span></div>`;
      }
    }
    return `<li><button class="account" data-account="${esc(a.id)}">
      <span class="stripe" style="background:${a.color}"></span>
      <span><span class="name">${esc(a.name)}${a.source === 'ibkr' ? '<span class="badge">Auto</span>' : ''}</span>
        <span class="meta${stale ? ' stale' : ''}">${meta}</span></span>
      <span class="right"><div class="value money">${last ? fmtEur(last.value) : '—'}</div>${chg}</span>
    </button></li>`;
  }).join('');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------- Feuille : mise à jour ---------- */
function openUpdate() {
  const form = $('#formUpdate');
  form.date.value = today();
  const rows = latestValues().sort((a, b) => (a.account.source === 'ibkr') - (b.account.source === 'ibkr'));
  $('#updateFields').innerHTML = rows.map(({ account: a, last }) => `
    <label class="update-row">
      <span class="lbl"><span class="swatch" style="background:${a.color}"></span>
        <span>${esc(a.name)}<small>${a.source === 'ibkr' ? 'Synchro auto · facultatif' : last ? `Dernier : ${eur2.format(last.value)}` : 'Première saisie'}</small></span></span>
      <input name="acc:${esc(a.id)}" inputmode="decimal" autocomplete="off" placeholder="${last ? eur0.format(last.value) : '0 €'}">
    </label>`).join('');
  $('#sheetUpdate').showModal();
  const firstInput = $('#updateFields input');
  if (firstInput && matchMedia('(pointer: fine)').matches) firstInput.focus();
}

$('#formUpdate').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const date = form.date.value;
  const values = [];
  for (const input of $$('#updateFields input')) {
    const v = parseAmount(input.value);
    if (v === null) continue;
    if (Number.isNaN(v)) { input.focus(); toast('Montant non reconnu'); return; }
    values.push([input.name.slice(4), v]);
  }
  if (!values.length) { toast('Aucune valeur saisie'); return; }
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  const ok = await mutate(d => values.forEach(([id, v]) => upsert(d, date, id, v, 'manual')),
    `${values.length} valeur${values.length > 1 ? 's' : ''} enregistrée${values.length > 1 ? 's' : ''}`);
  btn.disabled = false;
  if (ok) $('#sheetUpdate').close();
});

/* ---------- Feuille : compte ---------- */
let currentAccount = null;

function openAccount(id) {
  const a = accountById(data, id);
  if (!a) return;
  currentAccount = id;
  const form = $('#formAccount');
  $('#accTitle').textContent = a.name;
  form.name.value = a.name;
  $('#accColors').innerHTML = PALETTE.map(c =>
    `<button type="button" style="background:${c}" data-color="${c}" aria-label="Couleur ${c}" aria-pressed="${c === a.color}"></button>`).join('');
  renderHistory();
  $('#sheetAccount').showModal();
}

function renderHistory() {
  const h = accountHistory(data, currentAccount).reverse();
  $('#accHistory').innerHTML = h.length ? h.map(e => `
    <li><span>${fmtDate(e.date)}${e.source === 'ibkr' ? ' <span class="badge">Auto</span>' : ''}</span>
      <span class="v money">${eur2.format(e.value)}</span>
      <button type="button" data-del="${e.date}" aria-label="Supprimer la valeur du ${fmtDate(e.date)}">Suppr.</button></li>`).join('')
    : '<li class="empty">Aucune valeur</li>';
}

$('#accColors').addEventListener('click', async e => {
  const color = e.target.dataset.color;
  if (!color) return;
  $$('#accColors button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
  const id = currentAccount;
  await mutate(d => { const a = accountById(d, id); if (a) a.color = color; });
});

$('#accHistory').addEventListener('click', async e => {
  const date = e.target.dataset.del;
  if (!date || !confirm(`Supprimer la valeur du ${fmtDate(date)} ?`)) return;
  const id = currentAccount;
  await mutate(d => { d.entries = d.entries.filter(x => !(x.account === id && x.date === date)); }, 'Valeur supprimée');
  renderHistory();
});

$('#btnArchive').addEventListener('click', async () => {
  const id = currentAccount;
  const a = accountById(data, id);
  if (!confirm(`Archiver « ${a.name} » ? Il ne comptera plus dans le total à partir d'aujourd'hui (l'historique est conservé).`)) return;
  const ok = await mutate(d => { const x = accountById(d, id); if (x) x.archivedAt = today(); }, 'Compte archivé');
  if (ok) $('#sheetAccount').close();
});

$('#sheetAccount').addEventListener('close', async () => {
  const id = currentAccount;
  const name = $('#formAccount').name.value.trim();
  const a = data && accountById(data, id);
  if (a && name && name !== a.name) await mutate(d => { const x = accountById(d, id); if (x) x.name = name; }, 'Compte renommé');
});

/* ---------- Feuille : réglages ---------- */
function openSettings() {
  const form = $('#formSettings');
  form.token.value = settings.token || '';
  form.gistId.value = settings.gistId || '';
  setSettingsMsg('');
  renderSettingsAccounts();
  $('#sheetSettings').showModal();
}

function setSettingsMsg(msg, kind = '') {
  const el = $('#settingsMsg');
  el.textContent = msg;
  el.className = 'small ' + kind;
}

function renderSettingsAccounts() {
  const ul = $('#settingsAccounts');
  if (!data) { ul.innerHTML = '<li class="muted">Configure d’abord la synchronisation.</li>'; return; }
  ul.innerHTML = data.accounts.map(a => `
    <li><span class="lbl"><span class="swatch" style="background:${a.color}"></span>${esc(a.name)}
      ${a.source === 'ibkr' ? '<span class="badge">Auto</span>' : ''}${a.archivedAt ? ' <span class="muted small">archivé</span>' : ''}</span>
      ${a.archivedAt ? `<button type="button" data-restore="${esc(a.id)}">Réactiver</button>` : ''}</li>`).join('');
}

$('#settingsAccounts').addEventListener('click', async e => {
  const id = e.target.dataset.restore;
  if (!id) return;
  await mutate(d => { const a = accountById(d, id); if (a) delete a.archivedAt; }, 'Compte réactivé');
  renderSettingsAccounts();
});

$('#btnAddAccount').addEventListener('click', async () => {
  const input = $('#newAccountName');
  const name = input.value.trim();
  if (!name) return;
  if (!data) { toast('Configure d’abord la synchronisation'); return; }
  await mutate(d => {
    let id = slug(name), n = 2;
    while (accountById(d, id)) id = `${slug(name)}-${n++}`;
    d.accounts.push({ id, name, color: PALETTE[d.accounts.length % PALETTE.length], source: 'manual' });
  }, 'Compte ajouté');
  input.value = '';
  renderSettingsAccounts();
});

$('#btnTest').addEventListener('click', async () => {
  const form = $('#formSettings');
  const token = form.token.value.trim(), gistId = form.gistId.value.trim();
  if (!token) { setSettingsMsg('Colle d’abord ton token GitHub.', 'err'); return; }
  const prev = settings;
  settings = { token, gistId };
  setSettingsMsg('Connexion…');
  try {
    if (!gistId) {
      const start = data && !data.demo ? data : defaultData();
      settings.gistId = await gistCreate(start);
      form.gistId.value = settings.gistId;
      data = start;
      setSettingsMsg('Gist créé ✓ Note son ID pour la synchro IBKR.', 'ok');
    } else {
      data = await gistLoad();
      setSettingsMsg('Connecté ✓', 'ok');
    }
    store.set(KEY_SETTINGS, settings);
    store.set(KEY_CACHE, data);
    setSync('ok');
    render();
    renderSettingsAccounts();
  } catch (err) {
    settings = prev;
    setSettingsMsg(err.message, 'err');
  }
});

$('#btnExport').addEventListener('click', () => {
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `patrimoine-${today()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#fileImport').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const imported = normalize(JSON.parse(await file.text()));
    if (!confirm(`Remplacer toutes les données par ce fichier (${imported.entries.length} valeurs) ?`)) return;
    if (!data) data = defaultData();
    await mutate(d => { d.accounts = imported.accounts; d.entries = imported.entries; delete d.demo; }, 'Données importées');
    renderSettingsAccounts();
  } catch (err) {
    toast(`Import impossible : ${err.message}`);
  }
});

$('#btnReset').addEventListener('click', () => {
  if (!confirm('Effacer le token et les données de cet appareil ? (Le gist sur GitHub n’est pas touché.)')) return;
  store.del(KEY_SETTINGS); store.del(KEY_CACHE);
  settings = { token: '', gistId: '' };
  data = null;
  $('#sheetSettings').close();
  setSync('idle');
  render();
});

/* ---------- Données de démonstration (mode local uniquement) ---------- */
function demoData() {
  const d = defaultData();
  d.demo = true;
  const t = today();
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  let pea = 18000, ibkr = 9500, liv = 12000, cc = 2400, es = 3100;
  for (let m = 18; m >= 0; m--) {
    const date = addDays(t, -m * 30 - 3);
    pea = pea * (1 + (rnd() - 0.42) * 0.05) + 300;
    liv = liv + 150 + (rnd() - 0.5) * 300;
    cc = 1800 + rnd() * 1400;
    es = es * (1 + (rnd() - 0.45) * 0.04) + 120;
    [['pea-boursorama', pea], ['livrets', liv], ['compte-courant', cc], ['epargne-salariale', es]]
      .forEach(([id, v]) => upsert(d, date, id, Math.round(v * 100) / 100));
  }
  for (let w = 78; w >= 0; w--) {
    ibkr = ibkr * (1 + (rnd() - 0.45) * 0.03) + (w % 4 === 0 ? 200 : 0);
    upsert(d, addDays(t, -w * 7 - 1), 'ibkr', Math.round(ibkr * 100) / 100, 'ibkr');
  }
  return d;
}

$('#btnDemo').addEventListener('click', () => {
  data = demoData();
  store.set(KEY_CACHE, data);
  setSync('local');
  render();
  toast('Données fictives — Réglages › Effacer pour repartir de zéro');
});

/* ---------- Événements généraux ---------- */
$('#fab').addEventListener('click', openUpdate);
$('#btnSettings').addEventListener('click', openSettings);
$$('[data-open="settings"]').forEach(b => b.addEventListener('click', openSettings));
$('#btnRefresh').addEventListener('click', () => (isGistMode() ? refresh() : toast('Mode local : rien à synchroniser')));
$('#btnPrivacy').addEventListener('click', () => {
  ui.private = !ui.private;
  store.set(KEY_UI, ui);
  render();
});
$('.seg').addEventListener('click', e => {
  if (!e.target.dataset.range) return;
  ui.range = Number(e.target.dataset.range);
  store.set(KEY_UI, ui);
  renderChart(totalSeries(data));
});
$('#accounts').addEventListener('click', e => {
  const btn = e.target.closest('[data-account]');
  if (btn) openAccount(btn.dataset.account);
});
$$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
// Fermer une feuille en touchant le fond
$$('dialog.sheet').forEach(dlg => dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }));

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => data && renderChart(totalSeries(data)), 150);
});
// Recharge les données quand on revient sur l'appli
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isGistMode()) refresh({ silent: true });
});

/* ---------- Démarrage ---------- */
if (data) { try { data = normalize(data); } catch { data = null; } }
setSync(isGistMode() ? 'busy' : data ? 'local' : 'idle');
render();
if (isGistMode()) refresh();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
