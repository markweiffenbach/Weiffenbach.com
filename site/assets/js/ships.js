// Schiffsübersicht: jedes Schiff mit Bild, Steckbrief und unseren Reisen darauf (Ansicht #schiffe).
import { esc, fmt } from './charts.js';
import { photoURL } from './trip.js';
import { linkHtml } from './diary.js';

const $ = (s) => document.querySelector(s);
const plural = (n, one, many) => `${fmt.format(n)} ${n === 1 ? one : many}`;
const year = (d) => +d.slice(0, 4);
const num1 = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
export const shipSlug = (name) => 'schiff-' + encodeURIComponent(name).replace(/[^A-Za-z0-9]/g, '_');

let ctx = null; // { data, onOpenTrip }
let ships = [];
const ui = { sort: 'nights', line: '' };

function collect(data) {
  const byShip = new Map();
  for (const c of data.cruises) {
    if (!byShip.has(c.ship)) byShip.set(c.ship, []);
    byShip.get(c.ship).push(c);
  }
  const list = [...byShip].map(([name, trips]) => {
    trips.sort((a, b) => a.start.localeCompare(b.start));
    const done = trips.filter((c) => !c.planned);
    const info = data.ships[name] || {};
    return {
      name, info, trips, done,
      line: trips.at(-1).line,
      nights: done.reduce((s, c) => s + c.nights, 0),
      plannedNights: trips.filter((c) => c.planned).reduce((s, c) => s + c.nights, 0),
      seaDays: done.reduce((s, c) => s + c.seaDays, 0),
      nm: done.reduce((s, c) => s + c.nm, 0),
      ports: new Set(done.flatMap((c) => c.portNames)).size,
      countries: new Set(done.flatMap((c) => c.countryNames)).size,
      firstCalls: done.reduce((s, c) => s + c.firstCalls.length, 0),
      last: (done.at(-1) || trips.at(-1)).start,
    };
  });
  const fav = list.reduce((a, b) => (b.nights > (a?.nights ?? -1) ? b : a), null);
  if (fav) fav.favorite = true;
  return list;
}

const lazy = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    lazy.unobserve(e.target);
    loadImg(e.target);
  }
}, { rootMargin: '300px' }) : null;
function loadImg(img) {
  photoURL(img.dataset.photo).then((u) => { img.src = u; img.classList.add('ready'); })
    .catch(() => img.closest('.ship-img')?.classList.add('broken'));
}

export function initShips(context) {
  ctx = context;
  ships = collect(ctx.data);
  const done = ships.filter((s) => s.done.length);
  const nights = done.reduce((s, x) => s + x.nights, 0);
  document.querySelectorAll('[data-bind="shipCount"]').forEach((n) => { n.textContent = fmt.format(done.length); });
  document.querySelectorAll('[data-bind="shipSub"]').forEach((n) => {
    n.textContent = `Schiffe von ${plural(new Set(done.map((s) => s.line)).size, 'Reederei', 'Reedereien')} · Ø ${num1(nights / Math.max(1, done.length))} Nächte pro Schiff`;
  });
  const lines = [...new Set(ships.map((s) => s.line))].sort((a, b) => a.localeCompare(b, 'de'));
  $('#s-line').innerHTML = `<option value="">Alle</option>${lines.map((l) => `<option>${esc(l)}</option>`).join('')}`;
  $('#s-line').addEventListener('change', (e) => { ui.line = e.target.value; render(); });
  $('#s-sort').addEventListener('change', (e) => { ui.sort = e.target.value; render(); });
  $('#s-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-trip]');
    if (b) ctx.onOpenTrip(+b.dataset.trip);
  });
  render();
}

/** Ansicht zeigen; mit name wird dieses Schiff angesprungen. */
export function showShips(name) {
  if (name) {
    if (ui.line && !ships.some((s) => s.name === name && s.line === ui.line)) { ui.line = ''; $('#s-line').value = ''; render(); }
    const el = document.getElementById(shipSlug(name));
    if (el) {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
      requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
      return;
    }
  }
  window.scrollTo(0, 0);
}

function sorted() {
  const list = ships.filter((s) => !ui.line || s.line === ui.line);
  const byName = (a, b) => a.name.localeCompare(b.name, 'de');
  const cmp = {
    nights: (a, b) => b.nights - a.nights || b.plannedNights - a.plannedNights || byName(a, b),
    trips: (a, b) => b.trips.length - a.trips.length || b.nights - a.nights || byName(a, b),
    last: (a, b) => b.last.localeCompare(a.last) || byName(a, b),
    gt: (a, b) => (b.info.gt || 0) - (a.info.gt || 0) || byName(a, b),
    built: (a, b) => (b.info.built || 0) - (a.info.built || 0) || byName(a, b),
    name: byName,
  }[ui.sort] || byName;
  return list.sort(cmp);
}

function render() {
  const list = sorted();
  $('#s-count').textContent = list.length === ships.length ? plural(list.length, 'Schiff', 'Schiffe') : `${fmt.format(list.length)} von ${plural(ships.length, 'Schiff', 'Schiffen')}`;
  $('#s-list').innerHTML = list.map(cardHtml).join('') || '<p class="empty">Kein passendes Schiff.</p>';
  for (const img of document.querySelectorAll('#s-list img[data-photo]')) lazy ? lazy.observe(img) : loadImg(img);
}

const shipIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15c2 0 2-1.6 4.5-1.6S9.5 15 12 15s2-1.6 4.5-1.6S18.5 15 21 15M5 11l1.2-4h11.6L19 11M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function cardHtml(s) {
  const i = s.info;
  const badges = [
    s.favorite && '<span class="badge">Lieblingsschiff</span>',
    !s.done.length && '<span class="badge">geplant</span>',
    s.done.length && s.trips.length > s.done.length && '<span class="badge">wieder geplant</span>',
  ].filter(Boolean).join('');
  const stats = [
    [s.done.length ? plural(s.done.length, 'Reise', 'Reisen') : plural(s.trips.length, 'Reise', 'Reisen'), s.done.length ? (s.trips.length > s.done.length ? `+ ${fmt.format(s.trips.length - s.done.length)} geplant` : 'gefahren') : 'geplant'],
    [fmt.format(s.done.length ? s.nights : s.plannedNights), s.done.length ? 'Nächte an Bord' : 'Nächte geplant'],
    [plural(s.ports, 'Hafen', 'Häfen'), `in ${plural(s.countries, 'Land', 'Ländern')}`],
    [`${fmt.format(Math.round(s.nm))} sm`, `${plural(s.seaDays, 'Seetag', 'Seetage')}`],
  ];
  const age = i.built ? year(s.trips[0].start) - i.built : null;
  const facts = [
    i.built && ['In Dienst seit', `${i.built}${age != null && age >= 0 ? ` <small>(bei der ersten Reise ${age ? plural(age, 'Jahr', 'Jahre') + ' alt' : 'brandneu'})</small>` : ''}`],
    i.gt && ['Vermessung', `${fmt.format(i.gt)} BRZ`],
    i.length && ['Länge', `${fmt.format(i.length)} m`],
    i.pax && ['Passagiere', fmt.format(i.pax)],
    i.yard && ['Werft', esc(i.yard)],
    i.cls && ['Klasse', esc(i.cls)],
  ].filter(Boolean);
  const trips = s.trips.map((c) => `<button class="ship-trip${c.planned ? ' planned' : ''}" type="button" data-trip="${c.id}">
      <b>${c.start.slice(8, 10)}.${c.start.slice(5, 7)}.${year(c.start)}</b> ${esc(c.route)} <small>${plural(c.nights, 'Nacht', 'Nächte')}${c.planned ? ' · geplant' : ''}</small></button>`).join('');
  const sisters = i.sisters && i.sisters !== '–' ? i.sisters : '';
  const links = [i.wiki && linkHtml(i.wiki, 'Wikipedia'),
    linkHtml(`https://www.google.com/search?q=${encodeURIComponent(`${s.name} Deckplan`)}`, 'Deckplan suchen')].filter(Boolean).join('');
  return `<article class="ship-card" id="${shipSlug(s.name)}">
      <div class="ship-img">${i.img ? `<img data-photo="${esc(i.img)}" alt="${esc(s.name)}">` : ''}<span class="ship-ph">${shipIcon}</span>
        ${i.img && i.wiki ? '<span class="ship-credit">Foto: Wikimedia Commons</span>' : ''}</div>
      <div class="ship-body">
        <h3>${esc(s.name)}${badges}</h3>
        <p class="ship-line">${esc(s.line)}${i.note ? ` · ${esc(i.note)}` : ''}</p>
        <div class="ship-stats">${stats.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>
        ${facts.length ? `<dl class="ship-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
        ${sisters ? `<p class="ship-sisters"><b>Schwesterschiffe:</b> ${esc(sisters)}</p>` : ''}
        ${s.firstCalls ? `<p class="ship-sisters"><span class="badge first">${plural(s.firstCalls, 'Erstanlauf', 'Erstanläufe')}</span> mit uns an Bord</p>` : ''}
        <h4 class="arch-h">Unsere Reisen</h4>
        <div class="ship-trips">${trips}</div>
        <p class="ship-links">${links}</p>
      </div>
    </article>`;
}
