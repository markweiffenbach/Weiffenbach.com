import { deriveKey, decrypt, rememberKey, storedKey, forgetKey } from './crypto.js';
import { columns, hbars, dataTable, esc, fmt } from './charts.js';
import { TripMap, greatCircle, unwrap } from './map.js';
import { initTripPanel, openTrip, setPhotoKey } from './trip.js';
import { initArchive, showArchive } from './archive.js';
import { seasOf } from './seas.js';
import { utc } from './diary.js';

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
      try { start(await decrypt(blob, key), key); return; } catch { forgetKey(); }
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
    start(data, key);
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

function start(data, key) {
  setPhotoKey(key);
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
  map = new TripMap('map', { onSelectCruise: selectCruise, onOpenTrip: (id) => openTrip(DATA.cruises[id]), onOpenPort: showPort });
  initTripPanel({
    cruises: DATA.cruises, countries: DATA.countries,
    onShowMap: (id) => {
      if (location.hash) { history.pushState(null, '', location.pathname + location.search); route(); }
      state.selected = null; selectCruise(id); $('.card-map').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    onShowPort: showPort,
  });
  render();
  initArchive({ data: DATA, onOpenTrip: (id) => openTrip(DATA.cruises[id]) });
  window.addEventListener('hashchange', route);
  route();
}

// Zwei Ansichten: Übersicht (ohne Hash) und Hafen-Archiv (#hafen, #hafen/<Hafen>)
function route() {
  const m = location.hash.match(/^#hafen(?:\/(.+))?$/);
  const view = m ? 'archive' : 'dash';
  const changed = $('#app').dataset.view !== view;
  $('#app').dataset.view = view;
  if (m) showArchive(m[1] ? decodeURIComponent(m[1]) : null);
  else if (changed) { window.scrollTo(0, 0); map.map.invalidateSize(); }
}
function showPort(port) {
  const hash = `#hafen/${encodeURIComponent(port)}`;
  if (location.hash === hash) route(); else location.hash = hash;
}

function prepare(data) {
  const cruises = data.cruises.map((c) => ({
    ...c,
    planned: c.start > TODAY,
    onboard: c.start <= TODAY && TODAY <= c.end,
    stops: [],
    missed: [],
    diary: [],
  }));
  const byId = new Map(cruises.map((c) => [c.id, c]));
  const stops = data.stops.filter((s) => s.lat != null && s.lng != null).map((s) => ({ ...s, cruise: s.cruise != null ? byId.get(s.cruise) : null }));
  for (const s of stops) if (s.cruise) s.cruise.stops.push(s);
  const missed = (data.missed || []).map((x) => ({ ...x, cruise: byId.get(x.cruise) })).filter((x) => x.cruise);
  for (const x of missed) x.cruise.missed.push(x);
  const diary = (data.diary || []).map((e) => ({ ...e, cruise: e.cruise != null ? byId.get(e.cruise) : null }));
  for (const e of diary) if (e.cruise) e.cruise.diary.push(e);
  const travel = (data.travel || []).map((t) => ({ ...t, cruise: t.cruise != null ? byId.get(t.cruise) : null }));
  for (const c of cruises) { c.travel = travel.filter((t) => t.cruise === c); c.aboard = []; }
  for (const o of data.onboard || []) byId.get(o.cruise)?.aboard.push(o);
  for (const c of cruises) {
    // Route über das Datum bilden: Am Wechseltag gehört der Hafen zu beiden Reisen (Aus- und Einschiffung)
    c.legs = stops.filter((s) => s.type !== 'Landaufenthalt' && s.cruise && c.start <= s.d && s.d <= c.end);
    c.nm = c.legs.reduce((sum, s, i) => (i ? sum + nmBetween(c.legs[i - 1], s) : 0), 0);
    c.portNames = [...new Set(c.legs.filter((s) => s.type === 'Hafen').map((s) => s.port))];
    c.countryNames = [...new Set(c.legs.filter((s) => s.type === 'Hafen').map((s) => s.country))];
    // Seetage: Tage an Bord (Nächte + 1) ohne Hafentage
    const portDays = new Set(c.legs.filter((s) => s.type === 'Hafen').map((s) => s.d)).size;
    c.seaDays = Math.max(0, c.nights + 1 - portDays);
    c.cross = crossings(c.legs);
    c.shipInfo = data.ships?.[c.ship] || null;
    c.photos = (data.photos || []).filter((p) => p.cruise === c.id);
    c.firstCalls = c.legs.filter((s) => s.first);
    c.seas = c.legs.length ? seasOf(c.legs) : [];
    c.tz = zones(c.legs);
    c.flightKm = c.travel.reduce((sum, t) => sum + (t.km || 0), 0);
  }
  // Erstbesuche: Häfen und Länder, die auf dieser Reise zum ersten Mal angelaufen wurden
  const seenPorts = new Set(), seenCountries = new Set();
  for (const c of cruises) {
    c.newPorts = c.portNames.filter((p) => !seenPorts.has(p));
    c.newCountries = c.countryNames.filter((p) => !seenCountries.has(p));
    c.portNames.forEach((p) => seenPorts.add(p));
    c.countryNames.forEach((p) => seenCountries.add(p));
  }
  return { generated: data.generated, cruises, stops, missed, diary, travel, countries: data.countries || {}, ships: data.ships || {} };
}

// Zeitzonen entlang der Reise (UTC-Versatz der Häfen, aus dem Wetterarchiv): Umstellungen und Spanne
function zones(legs) {
  const list = legs.filter((s) => s.tz != null).map((s) => s.tz);
  let changes = 0, hours = 0;
  for (let i = 1; i < list.length; i++) if (list[i] !== list[i - 1]) { changes++; hours += Math.abs(list[i] - list[i - 1]); }
  return { list, changes, hours, min: list.length ? Math.min(...list) : null, max: list.length ? Math.max(...list) : null };
}

// Überquerungen von Äquator, Wendekreisen, Polarkreis und Datumsgrenze entlang der (Großkreis-)Route
const TROPIC = 23.44, POLAR = 66.56;
function crossings(legs) {
  const out = { equator: 0, cancer: 0, capricorn: 0, arctic: 0, dateline: 0 };
  if (legs.length < 2) return out;
  let path = [];
  for (let i = 1; i < legs.length; i++) {
    const seg = greatCircle([legs[i - 1].lat, legs[i - 1].lng], [legs[i].lat, legs[i].lng]);
    path = path.concat(i > 1 ? seg.slice(1) : seg);
  }
  path = unwrap(path);
  const side = (v, line) => (v > line ? 1 : v < line ? -1 : 0);
  for (let i = 1; i < path.length; i++) {
    const [la0, lo0] = path[i - 1], [la1, lo1] = path[i];
    for (const [key, line] of [['equator', 0], ['cancer', TROPIC], ['capricorn', -TROPIC], ['arctic', POLAR]]) {
      const a = side(la0, line), b = side(la1, line);
      if (a && b && a !== b) out[key]++;
    }
    if (Math.floor((lo0 + 180) / 360) !== Math.floor((lo1 + 180) / 360)) out.dateline++;
  }
  return out;
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
    cruises, stops, missed: DATA.missed.filter((x) => ids.has(x.cruise.id)), ports: portList, harbour, countries: [...countries.values()], countryVisits,
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
  renderMissed(current);
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
  const seaDays = m.cruises.reduce((s, c) => s + c.seaDays, 0);
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
    ['Seetage', seaDays, nights ? `${Math.round((seaDays / (nights + m.cruises.length)) * 100)} % der Tage an Bord` : ''],
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
  const shipRows = nightsBy((c) => c.ship, (list) => {
    const i = list[0].shipInfo;
    return `${list[0].line} · ${plural(list.length, 'Reise', 'Reisen')}${i?.gt ? ` · ${fmt.format(i.gt)} BRZ` : ''}`;
  }).map((r) => {
    const i = DATA.ships[r.label];
    if (!i) return r;
    const facts = [i.built && `in Dienst seit ${i.built}`, i.gt && `${fmt.format(i.gt)} BRZ`, i.length && `${fmt.format(i.length)} m lang`,
      i.pax && `${fmt.format(i.pax)} Passagiere`].filter(Boolean).join(' · ');
    return { ...r, built: i.built ? String(i.built) : '', gt: i.gt || 0,
      tip: `${r.tip}<br><span class="muted">${facts}${i.note ? ` (${esc(i.note)})` : ''}</span>` };
  });
  chartOrTable('ships', $('#c-ships'), () => hbars($('#c-ships'), shipRows, { limit: 12 }),
    [{ key: 'label', label: 'Schiff' }, { key: 'sub', label: 'Reederei · Reisen · Größe' }, { key: 'built', label: 'In Dienst seit' },
      { key: 'value', label: 'Nächte', num: true }], shipRows);

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
    ...extraFacts(m),
    newPorts && ['Zuletzt neu entdeckt', plural(newPorts.length, 'neuer Hafen', 'neue Häfen'), newPorts.length ? newPorts.slice(0, 4).join(', ') + (newPorts.length > 4 ? ' …' : '') : `${lastTrip.ship}, ${year(lastTrip.start)}`],
  ].filter(Boolean);
  el.innerHTML = facts.map(([l, v, n]) => `<div class="fact"><p class="fact-label">${esc(l)}</p><p class="fact-value">${esc(v)}</p><p class="fact-note">${esc(n)}</p></div>`).join('');
}

function extraFacts(m) {
  const out = [];
  const sum = (key) => m.cruises.reduce((s, c) => s + c.cross[key], 0);
  const which = (key) => m.cruises.filter((c) => c.cross[key]).map((c) => `${c.ship} ${year(c.start)}`);
  const eq = sum('equator');
  if (eq) out.push(['Äquator überquert', `${eq}×`, which('equator').join(', ')]);
  const dl = sum('dateline');
  if (dl) out.push(['Datumsgrenze überquert', `${dl}×`, which('dateline').join(', ')]);
  const tr = sum('cancer') + sum('capricorn');
  if (tr) out.push(['Wendekreise überquert', `${tr}×`, `Krebs ${sum('cancer')}× · Steinbock ${sum('capricorn')}×`]);
  const ar = sum('arctic');
  if (ar) out.push(['Polarkreis überquert', `${ar}×`, which('arctic').join(', ')]);
  // Erstanläufe: das Schiff lief den Hafen auf unserer Reise zum ersten Mal an
  const firsts = m.cruises.flatMap((c) => c.firstCalls.map((s) => `${s.port} (${c.ship} ${year(s.d)})`));
  if (firsts.length) out.push(['Erstanläufe miterlebt', `${firsts.length}×`, firsts.join(', ')]);
  const best = m.cruises.reduce((a, b) => (b.newPorts.length > (a?.newPorts.length ?? -1) ? b : a), null);
  if (best?.newPorts.length) {
    out.push(['Meiste Erstbesuche', plural(best.newPorts.length, 'neuer Hafen', 'neue Häfen'),
      `${best.ship} ${year(best.start)}${best.newCountries.length ? ` · ${plural(best.newCountries.length, 'neues Land', 'neue Länder')}` : ''}`]);
  }
  // Wetter an den Hafentagen
  const wx = m.stops.filter((s) => s.wx && s.type === 'Hafen' && s.cruise);
  if (wx.length) {
    const hot = wx.reduce((a, b) => (b.wx.hi > a.wx.hi ? b : a));
    const cold = wx.reduce((a, b) => (b.wx.hi < a.wx.hi ? b : a));
    const wet = wx.reduce((a, b) => ((b.wx.rain ?? 0) > (a.wx.rain ?? 0) ? b : a));
    const deg = (v) => `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C`;
    out.push(['Wärmster Landgang', `${deg(hot.wx.hi)}`, `${hot.port} · ${fmtDate(hot.d)} (${hot.cruise.ship})`]);
    if (cold !== hot) out.push(['Kältester Landgang', `${deg(cold.wx.hi)}`, `${cold.port} · ${fmtDate(cold.d)} (${cold.cruise.ship})`]);
    if (wet.wx.rain > 1) out.push(['Nassester Landgang', `${wet.wx.rain.toLocaleString('de-DE', { maximumFractionDigits: 1 })} mm Regen`, `${wet.port} · ${fmtDate(wet.d)} (${wet.cruise.ship})`]);
  }
  // Zeitzonen und Meere
  const tz = m.cruises.filter((c) => c.tz.changes).reduce((a, b) => (b.tz.hours > (a?.tz.hours ?? -1) ? b : a), null);
  if (tz) out.push(['Meiste Zeitumstellungen', `Uhr ${plural(tz.tz.hours, 'Stunde', 'Stunden')} verstellt`, `${tz.ship} ${year(tz.start)} · ${plural(tz.tz.changes, 'Umstellung', 'Umstellungen')} zwischen ${utc(tz.tz.min)} und ${utc(tz.tz.max)}`]);
  const seas = new Map();
  for (const c of m.cruises.filter((x) => !x.planned)) for (const n of c.seas) seas.set(n, (seas.get(n) || 0) + 1);
  if (seas.size) {
    const top = [...seas].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, k]) => `${n} ${k}×`);
    out.push(['Befahrene Meere', plural(seas.size, 'Meer', 'Meere'), `inkl. Ozeane, grob nach Route · am häufigsten: ${top.join(', ')}`]);
  }
  const flights = m.cruises.flatMap((c) => c.travel.filter((t) => t.km));
  if (flights.length) {
    const kmSum = flights.reduce((s, t) => s + t.km, 0);
    out.push(['Geflogen', `${fmt.format(kmSum)} km`, `${plural(flights.length, 'Flug', 'Flüge')} zu und von den Schiffen · ≈ ${(kmSum / 40075).toLocaleString('de-DE', { maximumFractionDigits: 1 })}× um die Erde`]);
  }
  const sea = m.cruises.reduce((a, b) => (b.seaDays > (a?.seaDays ?? -1) ? b : a), null);
  if (sea) out.push(['Meiste Seetage', plural(sea.seaDays, 'Seetag', 'Seetage'), `${sea.ship} · ${sea.route} (${year(sea.start)})`]);
  const withShip = m.cruises.filter((c) => c.shipInfo?.gt);
  if (withShip.length) {
    const big = withShip.reduce((a, b) => (b.shipInfo.gt > a.shipInfo.gt ? b : a));
    const small = withShip.reduce((a, b) => (b.shipInfo.gt < a.shipInfo.gt ? b : a));
    out.push(['Größtes Schiff', big.ship, `${fmt.format(big.shipInfo.gt)} BRZ · ${fmt.format(big.shipInfo.pax || 0)} Passagiere`]);
    if (small.ship !== big.ship) out.push(['Kleinstes Schiff', small.ship, `${fmt.format(small.shipInfo.gt)} BRZ · ${fmt.format(small.shipInfo.pax || 0)} Passagiere`]);
  }
  const aged = m.cruises.filter((c) => c.shipInfo?.built);
  if (aged.length) {
    const avg = aged.reduce((s, c) => s + (year(c.start) - c.shipInfo.built), 0) / aged.length;
    const newest = aged.reduce((a, b) => (year(b.start) - b.shipInfo.built < year(a.start) - a.shipInfo.built ? b : a));
    out.push(['Ø Schiffsalter', `${avg.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Jahre`,
      `zur Reisezeit · am neuesten: ${newest.ship} ${year(newest.start)}${year(newest.start) <= newest.shipInfo.built ? ' im Jahr der Indienststellung'
        : ` (${plural(year(newest.start) - newest.shipInfo.built, 'Jahr', 'Jahre')} alt)`}`]);
  }
  return out;
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

// Geplante, aber nicht angelaufene Häfen
const REASON_ORDER = ['Wetter', 'Gesundheit', 'Technik', 'Streik', 'Sicherheit', 'Behörden', 'unbekannt'];
function renderMissed(m) {
  const list = m.missed;
  const done = m.cruises.filter((c) => !c.planned);
  const calls = done.reduce((s, c) => s + c.portNames.length, 0);
  const affected = new Set(list.map((x) => x.cruise.id)).size;
  $('#missed-sub').textContent = 'Laut Fahrplan geplant, aber nicht angelaufen – zählen nicht als besucht';
  if (!list.length) {
    $('#missed').innerHTML = `<p class="empty">Im aktuellen Filter ist kein geplanter Hafen ausgefallen.</p>`;
    return;
  }
  const share = calls + list.length ? (list.length / (calls + list.length)) * 100 : 0;
  const reasons = [...group(list, (x) => x.reason)].map(([k, l]) => ({
    label: k, value: l.length, tip: `<b>${esc(k)}</b>${l.map((x) => `${esc(x.port)} · ${esc(x.cruise.ship)} ${year(x.d)}`).join('<br>')}`,
  })).sort((a, b) => b.value - a.value || REASON_ORDER.indexOf(a.label) - REASON_ORDER.indexOf(b.label));
  const unsure = list.filter((x) => !x.sure).length;
  $('#missed').innerHTML = `
    <div class="missed-sum">
      <div class="missed-kpis">
        <div><b>${fmt.format(list.length)}</b><span>${list.length === 1 ? 'Hafen ausgefallen' : 'Häfen ausgefallen'}</span></div>
        <div><b>${share.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %</b><span>der geplanten Anläufe</span></div>
        <div><b>${fmt.format(affected)}</b><span>von ${plural(done.length, 'Reise', 'Reisen')} betroffen</span></div>
      </div>
      <h3>Gründe</h3>
      <div id="c-missed"></div>
    </div>
    <div class="table-wrap missed-list"><table class="data">
      <thead><tr><th>Datum</th><th>Hafen</th><th>Reise</th><th>Grund</th><th>Details</th></tr></thead>
      <tbody>${list.slice().reverse().map((x) => {
        const meta = DATA.countries[x.country] || {};
        return `<tr>
          <td class="nowrap">${fmtDate(x.d)}</td>
          <td><b>${esc(x.port)}</b><br><small>${flag(meta.a2)} ${esc(x.country)}</small></td>
          <td><button class="link-btn" type="button" data-trip="${x.cruise.id}">${esc(x.cruise.ship)}</button><br><small>${esc(x.cruise.route)}</small></td>
          <td><span class="badge warn">${esc(x.reason)}</span>${x.when ? `<br><small>${esc(x.when)}</small>` : ''}</td>
          <td class="missed-note">${x.sure ? '' : '<span class="badge">wahrscheinlich</span> '}${esc(x.note)}${x.src ? ` <a href="${esc(x.src)}" target="_blank" rel="noopener noreferrer">Quelle ↗</a>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    ${unsure ? `<p class="missed-foot">„wahrscheinlich“: aus Reiseberichten erschlossen, nicht offiziell bestätigt (${fmt.format(unsure)} von ${fmt.format(list.length)}).</p>` : ''}`;
  hbars($('#c-missed'), reasons);
  document.querySelectorAll('#missed [data-trip]').forEach((b) => b.addEventListener('click', () => openTrip(DATA.cruises[+b.dataset.trip])));
}

function renderLog(m) {
  const q = state.search;
  const list = m.cruises.filter((c) => !q || [c.ship, c.line, c.route, c.region, ...c.stops.map((s) => `${s.port} ${s.country}`), ...c.missed.map((x) => x.port)].join(' ').toLowerCase().includes(q));
  const LOG_LIMIT = 12;
  const shown = q || state.logAll ? list.slice().reverse() : list.slice().reverse().slice(0, LOG_LIMIT);
  const byYear = group(shown, (c) => year(c.start));
  $('#log').innerHTML = [...byYear].map(([y, trips]) => `<li class="log-year">${y}</li>` + trips.map((c) => `
    <li class="trip${state.selected === c.id ? ' active' : ''}" data-id="${c.id}" tabindex="0" role="button" aria-label="Details zu ${esc(c.ship)}, ${esc(c.route)}">
      <span class="trip-date">${fmtDate(c.start, { day: '2-digit', month: '2-digit' })} – ${fmtDate(c.end, { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
      <span><span class="trip-title">${esc(c.ship)}<small>${esc(c.line)}</small>${c.planned ? '<span class="badge">geplant</span>' : ''}${c.onboard ? '<span class="badge">an Bord</span>' : ''}${c.cross.equator ? '<span class="badge">Äquator</span>' : ''}${c.cross.dateline ? '<span class="badge">Datumsgrenze</span>' : ''}${c.newPorts.length ? `<span class="badge">${plural(c.newPorts.length, 'neuer Hafen', 'neue Häfen')}</span>` : ''}${c.missed.length ? `<span class="badge warn">${fmt.format(c.missed.length)} ausgefallen</span>` : ''}${c.firstCalls.length ? `<span class="badge first">${plural(c.firstCalls.length, 'Erstanlauf', 'Erstanläufe')}</span>` : ''}${c.photos.length ? `<span class="badge">${plural(c.photos.length, 'Foto', 'Fotos')}</span>` : ''}</span><br><span class="trip-route">${esc(c.route)}</span></span>
      <span class="trip-meta"><b>${c.nights}</b> Nächte<br>${plural(c.seaDays, 'Seetag', 'Seetage')} · ${fmt.format(Math.round(c.nm))} sm</span>
      <span class="trip-ports">${c.portNames.map((p) => (c.newPorts.includes(p) ? `<b>${esc(p)}</b>` : esc(p))).join(' · ') || '–'}</span>
    </li>`).join('')).join('') || '<li class="empty">Keine passende Reise.</li>';
  const moreBtn = $('#log-more');
  moreBtn.hidden = !!q || list.length <= LOG_LIMIT;
  moreBtn.textContent = state.logAll ? 'Weniger anzeigen' : `Alle ${list.length} Reisen anzeigen`;
  document.querySelectorAll('.trip').forEach((t) => {
    const go = () => openTrip(DATA.cruises[+t.dataset.id]);
    t.addEventListener('click', go);
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

init();
