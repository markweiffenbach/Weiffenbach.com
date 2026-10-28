// Hafen-Archiv: alle Häfen mit unseren Besuchen, Reisetagebuch, Tipps und weiterführenden Links (Ansicht #hafen).
import { esc, fmt } from './charts.js';
import { entryHtml, fmtDate, flagEmoji, linkHtml } from './diary.js';

const $ = (s) => document.querySelector(s);
const plural = (n, one, many) => `${fmt.format(n)} ${n === 1 ? one : many}`;
const CONTINENT_ORDER = ['Europa', 'Asien', 'Nordamerika', 'Südamerika', 'Afrika', 'Ozeanien', 'Antarktis', 'Sonstige'];

let ctx = null; // { data, onOpenTrip }
let places = [];
const ui = { q: '', k: '', sort: 'name', onlyDiary: false };

// Besuche je Ort zusammenführen: ein Besuch = eine Reise (inkl. Vor-/Nachprogramm) bzw. ein Landaufenthalt pro Monat
function collect(data) {
  const byPort = new Map();
  const get = (port, country) => {
    let p = byPort.get(port);
    if (!p) byPort.set(port, (p = { port, country: '', k: '', lat: null, lng: null, visits: [], missed: [] }));
    if (!p.country && country) p.country = country;
    return p;
  };
  const visit = (p, key, init) => {
    let v = p.visits.find((x) => x.key === key);
    if (!v) p.visits.push((v = { key, days: new Set(), types: new Set(), entries: [], ...init }));
    return v;
  };
  for (const s of data.stops) {
    const p = get(s.port, s.country);
    if (p.lat == null) Object.assign(p, { lat: s.lat, lng: s.lng, k: s.k });
    const v = visit(p, s.cruise ? `c${s.cruise.id}` : `l${s.d.slice(0, 7)}`, { d: s.d, cruise: s.cruise });
    v.days.add(s.d);
    v.types.add(s.type);
  }
  for (const e of data.diary) {
    if (!e.port) continue;
    const p = get(e.port, e.country);
    if (p.lat == null && e.lat != null) Object.assign(p, { lat: e.lat, lng: e.lng });
    const v = visit(p, e.cruise ? `c${e.cruise.id}` : `l${e.d.slice(0, 7)}`, { d: e.d, cruise: e.cruise });
    v.days.add(e.d);
    if (e.phase) v.types.add(e.phase === 'vor' ? 'Vorprogramm' : 'Nachprogramm');
    if (e.d < v.d) v.d = e.d;
    v.entries.push(e);
  }
  for (const x of data.missed) get(x.port, x.country).missed.push(x);

  return [...byPort.values()].map((p) => {
    p.visits.sort((a, b) => a.d.localeCompare(b.d));
    for (const v of p.visits) v.entries.sort((a, b) => a.d.localeCompare(b.d));
    const done = p.visits.filter((v) => !v.cruise?.planned);
    const meta = data.countries[p.country] || {};
    return {
      ...p, a2: meta.a2, k: p.k || meta.k || 'Sonstige',
      done: done.length, last: done.at(-1)?.d || '', planned: p.visits.some((v) => v.cruise?.planned),
      entries: p.visits.reduce((n, v) => n + v.entries.length, 0),
      arts: [...new Set(p.visits.flatMap((v) => v.entries.map((e) => e.art)).filter(Boolean))],
      text: [p.port, p.country, ...p.visits.flatMap((v) => [v.cruise?.ship, ...v.entries.flatMap((e) => [e.place, e.title, e.text, e.tips, e.art])]),
        ...p.missed.map((x) => x.note)].filter(Boolean).join(' ').toLowerCase(),
    };
  });
}

export function initArchive(context) {
  ctx = context;
  places = collect(ctx.data);
  const visited = places.filter((p) => p.done);
  const entries = ctx.data.diary.length;
  document.querySelectorAll('[data-bind="archivePorts"]').forEach((n) => { n.textContent = fmt.format(visited.length); });
  document.querySelectorAll('[data-bind="archiveSub"]').forEach((n) => {
    n.textContent = `besuchte Orte in ${plural(new Set(visited.map((p) => p.country).filter(Boolean)).size, 'Land', 'Ländern')} · ${plural(entries, 'Tagebucheintrag', 'Tagebucheinträge')}`;
  });
  const ks = CONTINENT_ORDER.filter((k) => places.some((p) => p.k === k));
  $('#a-k').innerHTML = `<option value="">Alle</option>${ks.map((k) => `<option>${esc(k)}</option>`).join('')}`;
  $('#a-q').addEventListener('input', (e) => { ui.q = e.target.value.trim().toLowerCase(); render(); });
  $('#a-k').addEventListener('change', (e) => { ui.k = e.target.value; render(); });
  $('#a-sort').addEventListener('change', (e) => { ui.sort = e.target.value; render(); });
  $('#a-diary').addEventListener('change', (e) => { ui.onlyDiary = e.target.checked; render(); });
  $('#a-list').addEventListener('toggle', onToggle, true);
  $('#a-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-trip]');
    if (b) ctx.onOpenTrip(+b.dataset.trip);
  });
  render();
}

/** Ansicht zeigen; mit port wird dieser Hafen geöffnet und angesprungen. */
export function showArchive(port) {
  if (port) {
    const p = places.find((x) => x.port === port);
    if (p && !visible().includes(p)) {
      Object.assign(ui, { q: '', k: '', onlyDiary: false });
      $('#a-q').value = ''; $('#a-k').value = ''; $('#a-diary').checked = false;
      render();
    }
    const el = document.getElementById(slug(port));
    if (el) {
      el.open = true;
      requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
      return;
    }
  }
  window.scrollTo(0, 0);
}

const slug = (port) => 'hafen-' + encodeURIComponent(port).replace(/[^A-Za-z0-9]/g, '_');

function visible() {
  const q = ui.q;
  const list = places.filter((p) => (!ui.k || p.k === ui.k) && (!ui.onlyDiary || p.entries) && (!q || p.text.includes(q)));
  const byName = (a, b) => a.port.localeCompare(b.port, 'de');
  if (ui.sort === 'last') list.sort((a, b) => b.last.localeCompare(a.last) || byName(a, b));
  else if (ui.sort === 'visits') list.sort((a, b) => b.done - a.done || b.entries - a.entries || byName(a, b));
  else list.sort(byName);
  return list;
}

function render() {
  const list = visible();
  $('#a-count').textContent = list.length === places.length ? `${plural(list.length, 'Ort', 'Orte')}` : `${fmt.format(list.length)} von ${plural(places.length, 'Ort', 'Orten')}`;
  // Bei wenigen Treffern gleich aufklappen
  const open = ui.q && list.length <= 3;
  $('#a-list').innerHTML = list.map((p) => summaryHtml(p, open)).join('') || '<p class="empty">Kein passender Hafen.</p>';
}

function summaryHtml(p, open) {
  const meta = [
    p.done ? plural(p.done, 'Besuch', 'Besuche') : '',
    p.last ? `zuletzt ${p.last.slice(0, 4)}` : '',
    p.entries ? plural(p.entries, 'Eintrag', 'Einträge') : '',
  ].filter(Boolean).join(' · ');
  const badges = [
    !p.done && p.planned && '<span class="badge">geplant</span>',
    p.done && p.planned && '<span class="badge">wieder geplant</span>',
    p.missed.length && `<span class="badge warn">${p.done ? `${fmt.format(p.missed.length)}× ausgefallen` : 'ausgefallen'}</span>`,
  ].filter(Boolean).join('');
  return `<details class="arch-port" id="${slug(p.port)}" data-port="${esc(p.port)}"${open ? ' open' : ''}>
      <summary>
        <span class="arch-name">${esc(p.port)}${badges}<small>${p.a2 ? flagEmoji(p.a2) + ' ' : ''}${esc(p.country || 'Land unbekannt')}</small></span>
        <span class="arch-meta">${meta}${p.arts.length ? `<span class="arch-arts">${p.arts.slice(0, 3).map(esc).join(' · ')}</span>` : ''}</span>
      </summary>
      <div class="arch-body">${open ? bodyHtml(p) : ''}</div>
    </details>`;
}

// Inhalt erst beim Aufklappen erzeugen, damit die Liste schnell bleibt
function onToggle(e) {
  const d = e.target;
  if (!d.matches?.('details.arch-port')) return;
  const p = places.find((x) => x.port === d.dataset.port);
  const body = d.querySelector('.arch-body');
  if (d.open && p && !body.innerHTML.trim()) body.innerHTML = bodyHtml(p);
  const hash = d.open ? `#hafen/${encodeURIComponent(p.port)}` : '#hafen';
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function bodyHtml(p) {
  const visits = p.visits.map((v) => {
    const c = v.cruise;
    const days = [...v.days].sort();
    const type = v.types.has('Hafen') ? '' : [...v.types].join(' / ');
    const when = days.length > 1 && days.at(-1) !== days[0] ? `${fmtDate(days[0])} – ${fmtDate(days.at(-1))}` : fmtDate(days[0]);
    return `<li class="arch-visit">
        <p class="arch-vhead"><span class="arch-when">${when}</span>
          ${c ? `<button class="link-btn" type="button" data-trip="${c.id}">${esc(c.ship)}</button> <small>${esc(c.route)}</small>` : '<span>an Land</span>'}
          ${type ? `<span class="badge">${esc(type)}</span>` : ''}${c?.planned ? '<span class="badge">geplant</span>' : ''}</p>
        ${v.entries.length ? `<div class="tp-diary">${v.entries.map((e) => entryHtml(e, { date: days.length > 1, port: !!e.place })).join('')}</div>`
          : `<p class="arch-none">${c?.planned ? 'Noch nichts geplant – Ideen im Tab „Tagebuch“ eintragen.' : 'Kein Tagebucheintrag.'}</p>`}
      </li>`;
  }).join('');
  const missed = p.missed.map((x) => `<li class="arch-visit">
      <p class="arch-vhead"><span class="arch-when">${fmtDate(x.d)}</span> <span>${esc(x.cruise.ship)}</span> <span class="badge warn">ausgefallen · ${esc(x.reason)}</span></p>
      ${x.note ? `<p class="arch-none">${esc(x.note)}</p>` : ''}</li>`).join('');

  // Eigene Links aus dem Tagebuch und allgemeine Nachschlagequellen
  const own = [...new Set(p.visits.flatMap((v) => v.entries.flatMap((e) => e.links)))];
  const name = p.port, q = encodeURIComponent(name);
  const geo = p.lat != null ? `${p.lat},${p.lng}` : encodeURIComponent(`${name} ${p.country}`);
  const general = [
    [`https://de.wikipedia.org/w/index.php?search=${q}&go=Artikel`, 'Wikipedia'],
    [`https://de.wikivoyage.org/w/index.php?search=${q}&go=Artikel`, 'Wikivoyage'],
    [`https://www.google.com/maps/search/?api=1&query=${geo}`, 'Google Maps'],
    [`https://www.getyourguide.de/s/?q=${q}`, 'Ausflüge (GetYourGuide)'],
  ];
  return `
    ${visits ? `<ol class="arch-visits">${visits}</ol>` : ''}
    ${missed ? `<h4 class="arch-h">Nicht angelaufen</h4><ol class="arch-visits">${missed}</ol>` : ''}
    <div class="arch-links">
      ${own.length ? `<div><h4 class="arch-h">Unsere Links</h4><p>${own.map((u) => linkHtml(u)).join('')}</p></div>` : ''}
      <div><h4 class="arch-h">Mehr Informationen</h4><p>${general.map(([u, l]) => linkHtml(u, l)).join('')}</p></div>
    </div>`;
}
