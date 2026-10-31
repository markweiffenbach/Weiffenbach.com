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
