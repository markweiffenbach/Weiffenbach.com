// Gemeinsame Darstellung von Tagebucheinträgen (Reise-Detailansicht und Hafen-Archiv).
import { esc } from './charts.js';

export const fmtDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
export const fmtDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
export const flagEmoji = (a2) => (/^[A-Z]{2}$/.test(a2 || '') ? String.fromCodePoint(...[...a2].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : '');

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'Link'; } };
export const linkHtml = (u, label = host(u)) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;

/** Kennzeichen „Erstanlauf“: das Schiff lief den Hafen auf dieser Reise zum ersten Mal an. */
export function firstCallBadge(s, ship) {
  if (!s.first) return '';
  const sure = s.first === 'ja';
  const title = `Erstanlauf der ${ship} in ${s.port}${sure ? '' : ' (wahrscheinlich)'}`;
  const label = sure ? 'Erstanlauf' : 'Erstanlauf?';
  return s.firstSrc
    ? `<a class="badge first" href="${esc(s.firstSrc)}" target="_blank" rel="noopener noreferrer" title="${esc(title)} – Quelle öffnen">${label} ↗</a>`
    : `<span class="badge first" title="${esc(title)}">${label}</span>`;
}

/** UTC-Versatz als Text: 1 → „UTC+1“, 5.5 → „UTC+5:30“ */
export function utc(h) {
  if (h == null) return '';
  const sign = h < 0 ? '−' : '+', a = Math.abs(h), m = Math.round((a % 1) * 60);
  return `UTC${h ? sign + Math.floor(a) + (m ? ':' + String(m).padStart(2, '0') : '') : ''}`;
}

// Wettercodes der WMO → Symbol und Beschreibung
function weather(code) {
  if (code == null) return ['', ''];
  if (code === 0) return ['☀️', 'sonnig'];
  if (code <= 2) return ['🌤️', 'heiter bis wolkig'];
  if (code === 3) return ['☁️', 'bedeckt'];
  if (code <= 48) return ['🌫️', 'Nebel'];
  if (code <= 57) return ['🌦️', 'Nieselregen'];
  if (code <= 67) return ['🌧️', 'Regen'];
  if (code <= 77) return ['❄️', 'Schnee'];
  if (code <= 82) return ['🌦️', 'Schauer'];
  if (code <= 86) return ['🌨️', 'Schneeschauer'];
  return ['⛈️', 'Gewitter'];
}
const num = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 1 });

/** Liegezeit, Tender und Wetter eines Hafentags als kleine Chips. */
export function stopDetails(s) {
  const out = [];
  if (s.arr || s.dep) {
    let dur = '';
    if (s.arr && s.dep) {
      const [h1, m1] = s.arr.split(':').map(Number), [h2, m2] = s.dep.split(':').map(Number);
      const min = (h2 * 60 + m2) - (h1 * 60 + m1);
      if (min > 0) dur = ` · ${num(Math.round(min / 30) / 2)} h`;
    }
    const when = s.arr && s.dep ? `${s.arr}–${s.dep}` : s.arr ? `an ${s.arr}` : `ab ${s.dep}`;
    out.push(`<span class="chip-info" title="Liegezeit (Ortszeit)">🕘 ${when}${dur}</span>`);
  }
  if (s.tender) out.push('<span class="chip-info" title="Ausbooten mit Tenderbooten">⛴️ Tender</span>');
  if (s.wx) {
    const [icon, text] = weather(s.wx.code);
    const rain = s.wx.rain >= 0.5 ? ` · ${num(s.wx.rain)} mm` : '';
    out.push(`<span class="chip-info" title="${esc(`Wetter: ${text}, ${num(s.wx.hi)} °C / ${num(s.wx.lo)} °C, Wind bis ${s.wx.wind} km/h`)}">${icon} ${Math.round(s.wx.hi)}°/${Math.round(s.wx.lo)}°${rain}</span>`);
  }
  return out.length ? `<span class="chips-info">${out.join('')}</span>` : '';
}

/** Symbol zu Art (Flug, Hotel, Restaurant, Show …) */
export function kindIcon(kind) {
  const k = (kind || '').toLowerCase();
  const icons = [[/flug/, '✈️'], [/zug|bahn/, '🚆'], [/bus|transfer|shuttle/, '🚌'], [/auto|mietwagen|taxi|pkw/, '🚗'], [/fähre|faehre/, '⛴️'],
    [/hotel|unterkunft|übernacht/, '🏨'], [/restaurant|essen|dinner|steak|sushi|bistro|grill/, '🍽️'], [/show|theater|musical|konzert|kino/, '🎭'],
    [/spa|massage|wellness|sauna/, '💆'], [/bar|wein|tasting|cocktail/, '🍷'], [/ausflug|tour/, '🧭']];
  return (icons.find(([r]) => r.test(k)) || [null, '•'])[1];
}

/** opts: date (Datum zeigen), port (Ort voranstellen), archive (Knopf zum Hafen-Archiv) */
export function entryHtml(e, { date = false, port = false, archive = false } = {}) {
  const foot = [...e.links.map((u) => linkHtml(u)),
    archive && e.port ? `<button class="link-btn" type="button" data-port="${esc(e.port)}">Hafen-Archiv: ${esc(e.port)} ›</button>` : ''].filter(Boolean);
  return `<article class="entry">
      ${date || (port && e.port) ? `<p class="entry-meta">${[date && fmtDay(e.d), port && esc(e.place || e.port)].filter(Boolean).join(' · ')}</p>` : ''}
      <h4>${esc(e.title || e.port || 'Tagebuch')}${e.art ? ` <span class="badge">${esc(e.art)}</span>` : ''}</h4>
      ${e.text ? `<p>${esc(e.text)}</p>` : ''}
      ${e.tips ? `<p class="entry-tip"><b>Tipp</b> ${esc(e.tips)}</p>` : ''}
      ${foot.length ? `<p class="entry-links">${foot.join('')}</p>` : ''}
    </article>`;
}
