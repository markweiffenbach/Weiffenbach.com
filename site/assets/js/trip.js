// Detailansicht einer Reise (Seitenpanel) mit Tagesverlauf, Schiffsdaten und verschlüsselten Fotos.
import { esc, fmt } from './charts.js';
import { decryptBytes } from './crypto.js';

const $ = (s) => document.querySelector(s);
const DAY = 86400000;
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);
const fmtDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const plural = (n, one, many) => `${fmt.format(n)} ${n === 1 ? one : many}`;

// ---------- Fotos: laden, entschlüsseln, als Blob-URL bereitstellen ----------
let photoKey = null;
const urls = new Map();
export function setPhotoKey(key) { photoKey = key; }

function photoURL(name) {
  if (!urls.has(name)) {
    urls.set(name, fetch(`photos/${name}.bin`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((buf) => decryptBytes(buf, photoKey))
      .then((plain) => URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }))));
  }
  return urls.get(name);
}

const lazy = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    lazy.unobserve(e.target);
    load(e.target);
  }
}, { rootMargin: '200px' }) : null;

function load(img) {
  photoURL(img.dataset.photo).then((u) => { img.src = u; img.classList.add('ready'); })
    .catch(() => img.closest('.thumb')?.classList.add('broken'));
}

// ---------- Panel ----------
let ctx = null; // { cruises, countries, onShowMap }
let current = null;

export function initTripPanel(context) {
  ctx = context;
  $('#trip-panel').addEventListener('click', (e) => { if (e.target.id === 'trip-panel') closeTrip(); });
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
  document.addEventListener('keydown', (e) => {
    if (!$('#lightbox').hidden) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowRight') stepLightbox(1);
      if (e.key === 'ArrowLeft') stepLightbox(-1);
    } else if (!$('#trip-panel').hidden && e.key === 'Escape') closeTrip();
  });
}

export function openTrip(c) {
  current = c;
  const panel = $('#trip-panel');
  panel.querySelector('.panel-body').innerHTML = render(c);
  panel.hidden = false;
  document.documentElement.classList.add('no-scroll');
  panel.querySelector('.panel-body').scrollTop = 0;
  panel.querySelector('[data-act="close"]').focus();
  for (const img of panel.querySelectorAll('img[data-photo]')) lazy ? lazy.observe(img) : load(img);
  panel.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b)));
  panel.querySelectorAll('.thumb').forEach((t) => t.addEventListener('click', () => openLightbox(+t.dataset.index)));
}

export function closeTrip() {
  $('#trip-panel').hidden = true;
  document.documentElement.classList.remove('no-scroll');
}

function act(b) {
  const a = b.dataset.act;
  if (a === 'close') closeTrip();
  if (a === 'map') { closeTrip(); ctx.onShowMap(current.id); }
  if (a === 'prev' || a === 'next') {
    const list = ctx.cruises;
    const i = list.indexOf(current) + (a === 'next' ? 1 : -1);
    if (list[i]) openTrip(list[i]);
  }
}

function render(c) {
  const list = ctx.cruises, i = list.indexOf(c);
  const ship = c.shipInfo;
  const year = +c.start.slice(0, 4);
  const badges = [
    c.planned && 'geplant', c.onboard && 'an Bord', c.cross.equator && 'Äquator', c.cross.dateline && 'Datumsgrenze',
    c.cross.arctic && 'Polarkreis',
  ].filter(Boolean);

  const stats = [
    [fmtDate(c.start) + ' – ' + fmtDate(c.end), 'Reisezeit'],
    [plural(c.nights, 'Nacht', 'Nächte'), `${plural(c.seaDays, 'Seetag', 'Seetage')}`],
    [plural(c.portNames.length, 'Hafen', 'Häfen'), c.newPorts.length ? `${fmt.format(c.newPorts.length)} davon zum ersten Mal` : 'alle schon bekannt'],
    [`${fmt.format(Math.round(c.nm))} sm`, `≈ ${fmt.format(Math.round(c.nm * 1.852))} km`],
  ];

  const shipHtml = ship ? `<section class="tp-ship">
      <h3>${esc(c.ship)}</h3>
      <dl>
        ${ship.built ? `<div><dt>In Dienst seit</dt><dd>${ship.built}${year >= ship.built ? ` <small>(bei der Reise ${year === ship.built ? 'brandneu' : plural(year - ship.built, 'Jahr', 'Jahre') + ' alt'})</small>` : ''}</dd></div>` : ''}
        ${ship.gt ? `<div><dt>Vermessung</dt><dd>${fmt.format(ship.gt)} BRZ</dd></div>` : ''}
        ${ship.length ? `<div><dt>Länge</dt><dd>${fmt.format(ship.length)} m</dd></div>` : ''}
        ${ship.pax ? `<div><dt>Passagiere</dt><dd>${fmt.format(ship.pax)}</dd></div>` : ''}
        <div><dt>Reederei</dt><dd>${esc(c.line)}</dd></div>
      </dl>
      ${ship.note ? `<p class="tp-note">${esc(ship.note)}</p>` : ''}
    </section>` : '';

  // Tagesverlauf mit Fotos
  const photos = c.photos;
  const seenNew = new Set();
  const days = [];
  for (let n = 0; n <= c.nights; n++) {
    const d = addDays(c.start, n);
    const legs = c.legs.filter((s) => s.d === d);
    const dayPhotos = photos.map((p, idx) => ({ p, idx })).filter((x) => x.p.d === d);
    const places = legs.map((s) => {
      const meta = ctx.countries[s.country] || {};
      const isNew = s.type === 'Hafen' && c.newPorts.includes(s.port) && !seenNew.has(s.port);
      if (isNew) seenNew.add(s.port);
      return `<span class="tp-place">${s.type === 'Passage' ? '<span class="tp-pass">Passage</span> ' : ''}${esc(s.port)}
        <small>${meta.a2 ? flagEmoji(meta.a2) + ' ' : ''}${esc(s.country)}</small>${isNew ? '<span class="badge">neu</span>' : ''}</span>`;
    }).join('');
    const label = places || `<span class="tp-sea">${n === 0 ? 'Einschiffung' : n === c.nights ? 'Ausschiffung' : 'Auf See'}</span>`;
    const thumbs = dayPhotos.map(({ p, idx }) => `<button class="thumb" type="button" data-index="${idx}" aria-label="Foto vom ${fmtDate(p.d)} öffnen">
        <img data-photo="${p.t}" alt=""></button>`).join('');
    days.push(`<li class="tp-day${legs.length ? '' : ' sea'}">
        <span class="tp-dot" aria-hidden="true"></span>
        <div class="tp-dayhead"><b>Tag ${n + 1}</b> <span>${fmtDay(d)}</span></div>
        <div class="tp-places">${label}</div>
        ${thumbs ? `<div class="tp-thumbs">${thumbs}</div>` : ''}
      </li>`);
  }

  return `
    <header class="tp-head">
      <div>
        <p class="tp-kicker">${year} · ${esc(c.region)}</p>
        <h2 id="tp-title">${esc(c.ship)}</h2>
        <p class="tp-route">${esc(c.route)}</p>
        ${badges.length ? `<p class="tp-badges">${badges.map((b) => `<span class="badge">${b}</span>`).join('')}</p>` : ''}
      </div>
      <button class="icon-btn tp-close" type="button" data-act="close" aria-label="Schließen">✕</button>
    </header>
    <div class="tp-stats">${stats.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>
    <div class="tp-actions">
      <button class="text-btn" type="button" data-act="map">Auf der Karte zeigen</button>
      <span class="tp-nav">
        <button class="text-btn" type="button" data-act="prev" ${i <= 0 ? 'disabled' : ''}>‹ Vorherige</button>
        <button class="text-btn" type="button" data-act="next" ${i >= list.length - 1 ? 'disabled' : ''}>Nächste ›</button>
      </span>
    </div>
    ${shipHtml}
    <section>
      <h3>Reiseverlauf${photos.length ? ` <small>· ${plural(photos.length, 'Foto', 'Fotos')}</small>` : ''}</h3>
      <ol class="tp-days">${days.join('')}</ol>
    </section>`;
}

function flagEmoji(a2) {
  return /^[A-Z]{2}$/.test(a2) ? String.fromCodePoint(...[...a2].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : '';
}

// ---------- Großansicht ----------
let lbIndex = 0;
function openLightbox(index) {
  lbIndex = index;
  $('#lightbox').hidden = false;
  showLightbox();
}
function closeLightbox() { $('#lightbox').hidden = true; }
function stepLightbox(dir) {
  const n = current.photos.length;
  lbIndex = (lbIndex + dir + n) % n;
  showLightbox();
}
function showLightbox() {
  const p = current.photos[lbIndex];
  const box = $('#lightbox');
  const img = box.querySelector('img');
  img.removeAttribute('src');
  img.classList.remove('ready');
  box.querySelector('.lb-caption').textContent =
    `${p.port || 'Auf See'} · ${fmtDay(p.d)}${p.time ? `, ${p.time} Uhr` : ''} · ${lbIndex + 1}/${current.photos.length}`;
  photoURL(p.l).then((u) => { if (current.photos[lbIndex] === p) { img.src = u; img.classList.add('ready'); } });
  box.querySelector('[data-lb="prev"]').onclick = () => stepLightbox(-1);
  box.querySelector('[data-lb="next"]').onclick = () => stepLightbox(1);
  box.querySelector('[data-lb="close"]').onclick = closeLightbox;
}
