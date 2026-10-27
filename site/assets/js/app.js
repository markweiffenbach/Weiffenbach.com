import { deriveKey, decrypt, rememberKey, storedKey, forgetKey } from './crypto.js';
import { columns, hbars, dataTable, esc, fmt } from './charts.js';
import { TripMap } from './map.js';

const $ = (s) => document.querySelector(s);
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const CONTINENT_ORDER = ['Europa', 'Asien', 'Nordamerika', 'Südamerika', 'Afrika', 'Ozeanien', 'Antarktis', 'Sonstige'];
const EARTH_NM = 21600; // Erdumfang in Seemeilen
const PREFS = 'wb-prefs';

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const fmtDate = (d, opts = { day: '2-digit', month: '2-digit', year: 'numeric' }) => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', opts);
const year = (d) => +d.slice(0, 4);
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const plural = (n, one, many) => `${fmt.format(n)} ${n === 1 ? one : many}`;
const flag = (a2) => (a2 && /^[A-Z]{2}$/.test(a2) ? String.fromCodePoint(...[...a2].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🏳️');

function nmBetween(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return (2 * 6371 * Math.asin(Math.sqrt(h))) / 1.852;
}

function readPrefs() { try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch { return {}; } }
function writePrefs(p) { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* egal */ } }

// ======================= Zugang =======================
let blob = null;

const INSECURE_MSG = 'Der private Bereich braucht eine sichere Verbindung (https). Sie wird gerade eingerichtet – bitte später erneut versuchen.';

// Ohne https sperrt der Browser die Verschlüsselungsfunktionen (crypto.subtle). Dann auf https wechseln,
// sobald das Zertifikat erreichbar ist.
async function ensureSecure() {
  if (window.isSecureContext && window.crypto?.subtle) return true;
  if (location.protocol === 'http:') {
    const https = `https://${location.host}${location.pathname}${location.search}${location.hash}`;
    try {
      await fetch(`https://${location.host}/robots.txt`, { mode: 'no-cors', cache: 'no-store' });
      location.replace(https);
      return false;
    } catch { /* Zertifikat noch nicht da */ }
  }
  $('#gate-msg').textContent = INSECURE_MSG;
  return false;
}

async function init() {
  $('#year').textContent = now.getFullYear();
  applyTheme(readPrefs().theme);
  $('#gate-form').addEventListener('submit', onLogin);
  if (!(await ensureSecure())) return;
  try {
    const res = await fetch('data/data.enc.json', { cache: 'no-cache' });
    if (res.ok) blob = await res.json();
  } catch { /* offline */ }
  if (blob) {
    const key = await storedKey();
    if (key) {
      try { start(await decrypt(blob, key)); return; } catch { forgetKey(); }
    }
  }
}

async function onLogin(ev) {
  ev.preventDefault();
  const msg = $('#gate-msg'), btn = $('#gate-submit');
  msg.textContent = '';
  if (!window.crypto?.subtle) { msg.textContent = INSECURE_MSG; return; }
  if (!blob) { msg.textContent = 'Der private Bereich ist gerade nicht verfügbar.'; return; }
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const key = await deriveKey($('#pw').value, blob.iterations);
    const data = await decrypt(blob, key);
    await rememberKey(key, $('#remember').checked);
    start(data);
  } catch (err) {
    // Nur ein fehlgeschlagenes Entschlüsseln (OperationError) bedeutet ein falsches Passwort
    msg.textContent = err?.name === 'OperationError' ? 'Das Passwort stimmt leider nicht.' : `Technischer Fehler: ${err?.message || err}`;
    const gate = $('#gate');
    gate.classList.remove('shake'); void gate.offsetWidth; gate.classList.add('shake');
    $('#pw').select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Öffnen';
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// ======================= Daten =======================
let DATA, map;
const state = { from: null, to: null, line: '', region: '', planned: false, search: '', selected: null, logAll: false };

function start(data) {
  DATA = prepare(data);
  $('#gate').hidden = true;
  $('#app').hidden = false;
  document.title = 'Schiffsurlaube · Weiffenbach';

  const years = [...new Set(DATA.cruises.map((c) => year(c.start)))].sort();
  const prefs = readPrefs();
  Object.assign(state, { from: years[0], to: years.at(-1) }, prefs.filters || {});
  if (!years.includes(state.from)) state.from = years[0];
  if (!years.includes(state.to)) state.to = years.at(-1);

  bind('firstYear', years[0]);
  bind('generated', fmtDate(DATA.generated.slice(0, 10)));
  setupFilters(years);
  setupChrome();
  renderNext();
  map = new TripMap('map', { onSelectCruise: selectCruise });
  render();
}

function prepare(data) {
  const cruises = data.cruises.map((c) => ({
    ...c,
    planned: c.start > TODAY,
    onboard: c.start <= TODAY && TODAY <= c.end,
    stops: [],
  }));
  const byId = new Map(cruises.map((c) => [c.id, c]));
  const stops = data.stops.filter((s) => s.lat != null && s.lng != null).map((s) => ({ ...s, cruise: s.cruise != null ? byId.get(s.cruise) : null }));
  for (const s of stops) if (s.cruise) s.cruise.stops.push(s);
  for (const c of cruises) {
    c.legs = c.stops.filter((s) => s.type !== 'Landaufenthalt');
    c.nm = c.legs.reduce((sum, s, i) => (i ? sum + nmBetween(c.legs[i - 1], s) : 0), 0);
    c.portNames = [...new Set(c.legs.filter((s) => s.type === 'Hafen').map((s) => s.port))];
  }
  return { generated: data.generated, cruises, stops, countries: data.countries || {} };
}

function filtered() {
  const all = state.line === '' && state.region === '';
  const cruises = DATA.cruises.filter((c) => {
    const y = year(c.start);
    return y >= state.from && y <= state.to && (state.planned || !c.planned)
      && (!state.line || c.line === state.line) && (!state.region || c.region === state.region);
  });
  const ids = new Set(cruises.map((c) => c.id));
  const stops = DATA.stops.filter((s) => {
    if (s.cruise) return ids.has(s.cruise.id);
    const y = year(s.d);
    return all && y >= state.from && y <= state.to && (state.planned || s.d <= TODAY);
  });

  // Häfen mit Besuchen (ein Besuch = eine Reise bzw. ein Landaufenthalt pro Monat)
  const ports = new Map();
  for (const s of stops) {
    let p = ports.get(s.port);
    if (!p) ports.set(s.port, (p = { port: s.port, country: s.country, lat: s.lat, lng: s.lng, visits: [], keys: new Set() }));
    const key = s.cruise ? `c${s.cruise.id}` : `l${s.d.slice(0, 7)}`;
    if (!p.keys.has(key)) { p.keys.add(key); p.visits.push(s); }
  }
  const portList = [...ports.values()];
  const harbour = portList.map((p) => ({ ...p, visits: p.visits.filter((v) => v.type === 'Hafen') })).filter((p) => p.visits.length);

  const countryVisits = new Map();
  const countries = new Map();
  for (const p of harbour) {
    const meta = DATA.countries[p.country] || {};
    let c = countries.get(p.country);
    if (!c) countries.set(p.country, (c = { name: p.country, a2: meta.a2, k: new Set(), visits: 0, first: '9999', ports: new Set() }));
    c.visits += p.visits.length;
    c.ports.add(p.port);
    for (const v of p.visits) { c.k.add(v.k); if (v.d < c.first) c.first = v.d; }
    if (meta.n) countryVisits.set(meta.n, (countryVisits.get(meta.n) || 0) + p.visits.length);
  }

  const ys = cruises.map((c) => year(c.start));
  return {
    cruises, stops, ports: portList, harbour, countries: [...countries.values()], countryVisits,
    yearSpan: { first: Math.min(...ys), last: Math.max(...ys) },
  };
}

// ======================= Oberfläche =======================
function bind(name, value) { document.querySelectorAll(`[data-bind="${name}"]`).forEach((n) => { n.textContent = value; }); }

function setupFilters(years) {
  const fill = (sel, opts, val) => {
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    sel.value = val;
  };
  const lines = [...new Set(DATA.cruises.map((c) => c.line))].sort((a, b) => a.localeCompare(b, 'de'));
  const regions = [...new Set(DATA.cruises.map((c) => c.region))].sort((a, b) => a.localeCompare(b, 'de'));
  fill($('#f-from'), years.map((y) => [y, y]), state.from);
  fill($('#f-to'), years.map((y) => [y, y]), state.to);
  fill($('#f-line'), [['', 'Alle'], ...lines.map((l) => [l, l])], state.line);
  fill($('#f-region'), [['', 'Alle'], ...regions.map((r) => [r, r])], state.region);
  $('#f-planned').checked = state.planned;

  const update = () => {
    state.from = +$('#f-from').value;
    state.to = +$('#f-to').value;
    if (state.from > state.to) [state.from, state.to] = [state.to, state.from];
    $('#f-from').value = state.from; $('#f-to').value = state.to;
    state.line = $('#f-line').value;
    state.region = $('#f-region').value;
    state.planned = $('#f-planned').checked;
    const p = readPrefs();
    p.filters = { from: state.from, to: state.to, line: state.line, region: state.region, planned: state.planned };
    writePrefs(p);
    render();
  };
  for (const id of ['#f-from', '#f-to', '#f-line', '#f-region', '#f-planned']) $(id).addEventListener('change', update);
  $('#f-reset').addEventListener('click', () => {
    $('#f-from').value = years[0]; $('#f-to').value = years.at(-1);
    $('#f-line').value = ''; $('#f-region').value = ''; $('#f-planned').checked = false;
    update();
  });
}

function setupChrome() {
  $('#logout').addEventListener('click', () => { forgetKey(); location.reload(); });
  $('#theme-btn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = dark ? 'light' : 'dark';
    applyTheme(theme);
    const p = readPrefs(); p.theme = theme; writePrefs(p);
    render();
  });
  document.querySelectorAll('.chip[data-layer]').forEach((b) => b.addEventListener('click', () => {
    const on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
    map.toggle(b.dataset.layer, on);
  }));
  document.querySelectorAll('[data-chart] .tbl-btn').forEach((b) => b.addEventListener('click', () => {
    const card = b.closest('[data-chart]');
    card.classList.toggle('as-table');
    b.textContent = card.classList.contains('as-table') ? 'Diagramm' : 'Tabelle';
    render();
  }));
  $('#log-more').addEventListener('click', () => { state.logAll = !state.logAll; renderLog(current); });
  $('#log-search').addEventListener('input', (e) => { state.search = e.target.value.trim().toLowerCase(); renderLog(current); });
}

function selectCruise(id) {
  state.selected = state.selected === id ? null : id;
  map.select(state.selected);
  document.querySelectorAll('.trip').forEach((t) => t.classList.toggle('active', +t.dataset.id === state.selected));
}

let current;
function render() {
  current = filtered();
  if (state.selected != null && !current.cruises.some((c) => c.id === state.selected)) state.selected = null;
  renderKpis(current);
  renderCharts(current);
  renderFacts(current);
  renderFlags(current);
  renderLog(current);
  const legendFirst = current.yearSpan.first, legendLast = current.yearSpan.last;
  $('#map-sub').textContent = current.cruises.length
    ? `${plural(current.harbour.length, 'Hafen', 'Häfen')} in ${plural(current.countries.length, 'Land', 'Ländern')} · ${plural(current.cruises.length, 'Reise', 'Reisen')}`
    : 'Keine Reisen im aktuellen Filter';
  $('#map-legend').innerHTML = `
    <span class="key"><span class="ramp" style="background:linear-gradient(90deg,var(--seq-3),var(--seq-6))"></span>Routen ${Number.isFinite(legendFirst) ? `${legendFirst} → ${legendLast}` : ''}</span>
    ${state.planned ? '<span class="key"><span class="line dash"></span>geplant</span>' : ''}
    <span class="key"><span class="dot"></span><span class="dot big"></span>Hafen (Größe = Besuche)</span>
    <span class="key"><span class="dot" style="background:var(--seq-3)"></span>Landaufenthalt</span>
    <span class="key"><span class="swatch" style="background:var(--seq-2)"></span><span class="swatch" style="background:var(--seq-5)"></span>besuchte Länder (Farbe = Hafenbesuche)</span>`;
  map.render(current);
}

function renderKpis(m) {
  const done = m.cruises.filter((c) => !c.planned);
  const planned = m.cruises.length - done.length;
  const nights = m.cruises.reduce((s, c) => s + c.nights, 0);
  const nm = m.cruises.reduce((s, c) => s + c.nm, 0);
  const continents = new Set(m.countries.flatMap((c) => [...c.k]));
  bind('nights', fmt.format(nights));
  const y = Math.floor(nights / 365), mo = Math.round((nights % 365) / 30.44);
  bind('nightsHuman', nights
    ? `≈ ${y ? plural(y, 'Jahr', 'Jahre') : ''}${y && mo ? ' und ' : ''}${mo ? plural(mo, 'Monat', 'Monate') : ''} auf See · ${plural(m.cruises.length, 'Reise', 'Reisen')}`
    : 'Keine Reisen im aktuellen Filter');
  const tiles = [
    ['Kreuzfahrten', m.cruises.length, planned ? `davon ${planned} geplant` : `${state.from}–${state.to}`],
    ['Häfen', m.harbour.length, `${fmt.format(m.harbour.reduce((s, p) => s + p.visits.length, 0))} Hafenbesuche`],
    ['Länder', m.countries.length, ''],
    ['Kontinente', continents.size, ''],
    ['Schiffe', new Set(m.cruises.map((c) => c.ship)).size, ''],
    ['Reedereien', new Set(m.cruises.map((c) => c.line)).size, ''],
    ['Seemeilen', Math.round(nm), `≈ ${(nm / EARTH_NM).toLocaleString('de-DE', { maximumFractionDigits: 1 })}× um die Erde`],
  ];
  $('#kpis').innerHTML = tiles.map(([l, v, n]) => `<div class="kpi"><p class="kpi-label">${l}</p><p class="kpi-value">${fmt.format(v)}</p>${n ? `<p class="kpi-note">${n}</p>` : ''}</div>`).join('');
}

function renderNext() {
  const card = $('#next-card');
  const on = DATA.cruises.find((c) => c.onboard);
  if (on) {
    const total = on.nights || 1, gone = dayDiff(on.start, TODAY);
    card.innerHTML = `<p class="next-kicker">Gerade an Bord</p><p class="next-title">${esc(on.ship)}</p><p class="next-route">${esc(on.route)}</p>
      <div class="next-count"><b>Tag ${gone + 1}</b><span>von ${total + 1}</span></div><div class="next-bar"><i style="width:${(gone / total) * 100}%"></i></div>`;
    return;
  }
  const next = DATA.cruises.filter((c) => c.planned).sort((a, b) => a.start.localeCompare(b.start))[0];
  if (!next) { card.innerHTML = ''; return; }
  const last = DATA.cruises.filter((c) => c.end < TODAY).sort((a, b) => b.end.localeCompare(a.end))[0];
  const left = dayDiff(TODAY, next.start);
  const span = last ? dayDiff(last.end, next.start) : left;
  const later = DATA.cruises.filter((c) => c.planned).length - 1;
  card.innerHTML = `<p class="next-kicker">Nächste Reise</p><p class="next-title">${esc(next.ship)}</p><p class="next-route">${esc(next.route)} · ab ${fmtDate(next.start)}</p>
    <div class="next-count"><b>${left === 1 ? 'Morgen' : fmt.format(left)}</b><span>${left === 1 ? 'geht es los' : 'Tage bis zum Ablegen'}</span></div>
    <div class="next-bar" title="Vorfreude seit der letzten Reise"><i style="width:${span ? Math.max(2, 100 - (left / span) * 100) : 100}%"></i></div>
    ${later > 0 ? `<p class="next-route" style="margin-top:10px">und ${plural(later, 'weitere Reise', 'weitere Reisen')} geplant</p>` : ''}`;
}

const isTable = (name) => document.querySelector(`[data-chart="${name}"]`).classList.contains('as-table');
function chartOrTable(name, container, draw, cols, rows) {
  if (isTable(name)) dataTable(container, cols, rows); else draw();
}

function group(list, keyFn) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

function renderCharts(m) {
  // Jahre
  const byYear = group(m.cruises, (c) => year(c.start));
  const ys = [];
  for (let y = m.yearSpan.first; y <= m.yearSpan.last; y++) ys.push(y);
  const yearRows = Number.isFinite(m.yearSpan.first) ? ys.map((y) => {
    const list = byYear.get(y) || [];
    const value = list.reduce((s, c) => s + c.nights, 0);
    const plannedPart = list.filter((c) => c.planned).reduce((s, c) => s + c.nights, 0);
    return { label: String(y), year: y, value, plannedPart, count: list.length,
      tip: `<b>${y}</b>${list.length ? list.map((c) => `${esc(c.ship)} · ${c.nights} N.${c.planned ? ' (geplant)' : ''}`).join('<br>') : '<span class="muted">keine Reise</span>'}` };
  }) : [];
  const avg = m.cruises.length ? m.cruises.reduce((s, c) => s + c.nights, 0) / Math.max(1, ys.length) : 0;
  $('#years-sub').textContent = yearRows.length ? `Ø ${avg.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Nächte pro Jahr${state.planned ? ' · blasser Anteil = geplant' : ''}` : '';
  chartOrTable('years', $('#c-years'), () => columns($('#c-years'), yearRows, { height: 240, aria: 'Nächte an Bord pro Jahr' }),
    [{ key: 'label', label: 'Jahr' }, { key: 'count', label: 'Reisen', num: true }, { key: 'value', label: 'Nächte', num: true }], yearRows);

  // Reedereien, Fahrtgebiete, Schiffe
  const nightsBy = (keyFn, subFn) => [...group(m.cruises, keyFn)].map(([k, list]) => {
    const value = list.reduce((s, c) => s + c.nights, 0);
    return { label: k, value, count: list.length, sub: subFn ? subFn(list) : plural(list.length, 'Reise', 'Reisen'),
      tip: `<b>${esc(k)}</b>${plural(value, 'Nacht', 'Nächte')} · ${plural(list.length, 'Reise', 'Reisen')}<br><span class="muted">${[...new Set(list.map((c) => year(c.start)))].join(', ')}</span>` };
  }).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'de'));
  const cols3 = (l) => [{ key: 'label', label: l }, { key: 'count', label: 'Reisen', num: true }, { key: 'value', label: 'Nächte', num: true }];

  const lineRows = nightsBy((c) => c.line);
  chartOrTable('lines', $('#c-lines'), () => hbars($('#c-lines'), lineRows, { limit: 10 }), cols3('Reederei'), lineRows);
  const regionRows = nightsBy((c) => c.region);
  chartOrTable('regions', $('#c-regions'), () => hbars($('#c-regions'), regionRows, { limit: 10 }), cols3('Fahrtgebiet'), regionRows);
  const shipRows = nightsBy((c) => c.ship, (list) => `${list[0].line} · ${plural(list.length, 'Reise', 'Reisen')}`);
  chartOrTable('ships', $('#c-ships'), () => hbars($('#c-ships'), shipRows, { limit: 12 }),
    [{ key: 'label', label: 'Schiff' }, { key: 'sub', label: 'Reederei · Reisen' }, { key: 'value', label: 'Nächte', num: true }], shipRows);

  // Häfen
  const portRows = m.harbour.map((p) => ({
    label: p.port, sub: p.country, value: p.visits.length, country: p.country,
    tip: `<b>${esc(p.port)}</b>${esc(p.country)}<br><span class="muted">${p.visits.map((v) => year(v.d)).join(', ')}</span>`,
  })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'de'));
  chartOrTable('ports', $('#c-ports'), () => hbars($('#c-ports'), portRows, { limit: 10 }),
    [{ key: 'label', label: 'Hafen' }, { key: 'country', label: 'Land' }, { key: 'value', label: 'Besuche', num: true }], portRows);

  // Länder
  const countryRows = m.countries.map((c) => ({
    label: `${flag(c.a2)} ${c.name}`, name: c.name, value: c.visits, ports: c.ports.size, sub: plural(c.ports.size, 'Hafen', 'Häfen'),
    tip: `<b>${esc(c.name)}</b>${plural(c.visits, 'Hafenbesuch', 'Hafenbesuche')}<br><span class="muted">${[...c.ports].map(esc).join(' · ')}</span>`,
  })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'de'));
  chartOrTable('countries', $('#c-countries'), () => hbars($('#c-countries'), countryRows, { limit: 10 }),
    [{ key: 'name', label: 'Land' }, { key: 'ports', label: 'Häfen', num: true }, { key: 'value', label: 'Hafenbesuche', num: true }], countryRows);

  // Monate (jede Nacht an Bord zählt für ihren Kalendermonat)
  const months = Array.from({ length: 12 }, () => 0);
  for (const c of m.cruises) {
    const d = new Date(c.start + 'T12:00:00Z');
    for (let i = 0; i < c.nights; i++) { months[d.getUTCMonth()]++; d.setUTCDate(d.getUTCDate() + 1); }
  }
  const monthRows = months.map((v, i) => ({ label: MONTHS[i], value: v, tip: `<b>${MONTHS[i]}</b>${plural(v, 'Nacht', 'Nächte')} an Bord` }));
  chartOrTable('months', $('#c-months'), () => columns($('#c-months'), monthRows, { height: 220, labelEvery: 1, aria: 'Nächte an Bord je Monat' }),
    [{ key: 'label', label: 'Monat' }, { key: 'value', label: 'Nächte', num: true }], monthRows);

  // Kontinente
  const cont = new Map();
  for (const c of m.countries) for (const k of c.k) { if (!cont.has(k)) cont.set(k, []); cont.get(k).push(c.name); }
  const contRows = [...cont].map(([k, list]) => ({ label: k, value: list.length, tip: `<b>${esc(k)}</b>${list.sort((a, b) => a.localeCompare(b, 'de')).map(esc).join(', ')}` }))
    .sort((a, b) => b.value - a.value || CONTINENT_ORDER.indexOf(a.label) - CONTINENT_ORDER.indexOf(b.label));
  chartOrTable('continents', $('#c-continents'), () => hbars($('#c-continents'), contRows),
    [{ key: 'label', label: 'Kontinent' }, { key: 'value', label: 'Länder', num: true }], contRows);
}

function renderFacts(m) {
  const el = $('#facts');
  if (!m.cruises.length) { el.innerHTML = '<p class="empty">Keine Reisen im aktuellen Filter.</p>'; return; }
  const by = (arr, f) => arr.reduce((a, b) => (f(b) > f(a) ? b : a));
  const longest = by(m.cruises, (c) => c.nights);
  const farthest = by(m.cruises, (c) => c.nm);
  const pts = m.stops.filter((s) => s.cruise && s.type !== 'Landaufenthalt');
  const north = pts.length ? by(pts, (s) => s.lat) : null;
  const south = pts.length ? by(pts, (s) => -s.lat) : null;
  const topPort = m.harbour.length ? by(m.harbour, (p) => p.visits.length) : null;
  const ships = [...group(m.cruises, (c) => c.ship)].map(([k, l]) => [k, l.reduce((s, c) => s + c.nights, 0), l.length]);
  const favShip = by(ships, (s) => s[1]);
  const first = m.cruises[0];
  const years = [...group(m.cruises, (c) => year(c.start))].map(([y, l]) => [y, l.reduce((s, c) => s + c.nights, 0), l.length]);
  const bestYear = by(years, (y) => y[1]);
  const totalNm = m.cruises.reduce((s, c) => s + c.nm, 0);
  // Neue Häfen der letzten gefahrenen Reise im Filter
  const done = m.cruises.filter((c) => !c.planned);
  const lastTrip = done.at(-1);
  let newPorts = null;
  if (lastTrip) {
    const before = new Set(DATA.cruises.filter((c) => c.start < lastTrip.start).flatMap((c) => c.portNames));
    newPorts = lastTrip.portNames.filter((p) => !before.has(p));
  }
  const facts = [
    ['Längste Reise', plural(longest.nights, 'Nacht', 'Nächte'), `${longest.ship} · ${longest.route} (${year(longest.start)})`],
    ['Weiteste Reise', `${fmt.format(Math.round(farthest.nm))} sm`, `${farthest.ship} · ${farthest.route} (${year(farthest.start)})`],
    ['Gesamtstrecke', `${fmt.format(Math.round(totalNm))} sm`, `≈ ${fmt.format(Math.round(totalNm * 1.852))} km · ${(totalNm / EARTH_NM).toLocaleString('de-DE', { maximumFractionDigits: 1 })}× um die Erde`],
    north && ['Am weitesten im Norden', north.port, `${north.lat.toFixed(1).replace('.', ',')}° N · ${north.country}`],
    south && ['Am weitesten im Süden', south.port, `${Math.abs(south.lat).toFixed(1).replace('.', ',')}° ${south.lat < 0 ? 'S' : 'N'} · ${south.country}`],
    topPort && ['Meistbesuchter Hafen', topPort.port, `${plural(topPort.visits.length, 'Besuch', 'Besuche')} · ${topPort.country}`],
    ['Lieblingsschiff', favShip[0], `${plural(favShip[1], 'Nacht', 'Nächte')} auf ${plural(favShip[2], 'Reise', 'Reisen')}`],
    ['Rekordjahr', String(bestYear[0]), `${plural(bestYear[1], 'Nacht', 'Nächte')} auf ${plural(bestYear[2], 'Reise', 'Reisen')}`],
    ['Erste Reise', `${MONTHS[+first.start.slice(5, 7) - 1]} ${year(first.start)}`, `${first.ship} · ${first.route}`],
    ['Ø Reisedauer', `${(m.cruises.reduce((s, c) => s + c.nights, 0) / m.cruises.length).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Nächte`,
      `Ø ${(m.cruises.reduce((s, c) => s + c.portNames.length, 0) / m.cruises.length).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Häfen pro Reise`],
    newPorts && ['Zuletzt neu entdeckt', plural(newPorts.length, 'neuer Hafen', 'neue Häfen'), newPorts.length ? newPorts.slice(0, 4).join(', ') + (newPorts.length > 4 ? ' …' : '') : `${lastTrip.ship}, ${year(lastTrip.start)}`],
  ].filter(Boolean);
  el.innerHTML = facts.map(([l, v, n]) => `<div class="fact"><p class="fact-label">${esc(l)}</p><p class="fact-value">${esc(v)}</p><p class="fact-note">${esc(n)}</p></div>`).join('');
}

function renderFlags(m) {
  const groups = new Map();
  for (const c of m.countries) {
    const k = [...c.k][0] || 'Sonstige';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  $('#flags-sub').textContent = `${plural(m.countries.length, 'Land', 'Länder')} auf ${plural(groups.size, 'Kontinent', 'Kontinenten')}, in der Reihenfolge des ersten Besuchs`;
  $('#flags').innerHTML = [...groups].sort((a, b) => CONTINENT_ORDER.indexOf(a[0]) - CONTINENT_ORDER.indexOf(b[0])).map(([k, list]) => `
    <div class="flag-group"><h3>${esc(k)} <span>· ${list.length}</span></h3><div class="flag-list">
    ${list.sort((a, b) => a.first.localeCompare(b.first)).map((c) => `<span class="flag" title="${esc(c.name)}: ${plural(c.visits, 'Hafenbesuch', 'Hafenbesuche')}, zuerst ${year(c.first)}"><span class="fl" aria-hidden="true">${flag(c.a2)}</span>${esc(c.name)} <small>${year(c.first)}</small></span>`).join('')}
    </div></div>`).join('') || '<p class="empty">Keine Länder im aktuellen Filter.</p>';
}

function renderLog(m) {
  const q = state.search;
  const list = m.cruises.filter((c) => !q || [c.ship, c.line, c.route, c.region, c.captain || '', ...c.stops.map((s) => `${s.port} ${s.country}`)].join(' ').toLowerCase().includes(q));
  const LOG_LIMIT = 12;
  const shown = q || state.logAll ? list.slice().reverse() : list.slice().reverse().slice(0, LOG_LIMIT);
  const byYear = group(shown, (c) => year(c.start));
  $('#log').innerHTML = [...byYear].map(([y, trips]) => `<li class="log-year">${y}</li>` + trips.map((c) => `
    <li class="trip${state.selected === c.id ? ' active' : ''}" data-id="${c.id}" tabindex="0" role="button" aria-label="${esc(c.ship)}, ${esc(c.route)} auf der Karte zeigen">
      <span class="trip-date">${fmtDate(c.start, { day: '2-digit', month: '2-digit' })} – ${fmtDate(c.end, { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
      <span><span class="trip-title">${esc(c.ship)}<small>${esc(c.line)}</small>${c.planned ? '<span class="badge">geplant</span>' : ''}${c.onboard ? '<span class="badge">an Bord</span>' : ''}</span><br><span class="trip-route">${esc(c.route)}${c.captain ? ` · Kapitän ${esc(c.captain)}` : ''}</span></span>
      <span class="trip-meta"><b>${c.nights}</b> Nächte<br>${fmt.format(Math.round(c.nm))} sm</span>
      <span class="trip-ports">${c.portNames.map(esc).join(' · ') || '–'}</span>
    </li>`).join('')).join('') || '<li class="empty">Keine passende Reise.</li>';
  const moreBtn = $('#log-more');
  moreBtn.hidden = !!q || list.length <= LOG_LIMIT;
  moreBtn.textContent = state.logAll ? 'Weniger anzeigen' : `Alle ${list.length} Reisen anzeigen`;
  document.querySelectorAll('.trip').forEach((t) => {
    const go = () => { selectCruise(+t.dataset.id); if (state.selected != null) $('.card-map').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    t.addEventListener('click', go);
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

init();
