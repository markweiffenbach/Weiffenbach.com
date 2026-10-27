// Schlanke SVG/HTML-Diagramme: Säulen und horizontale Balken, mit Tooltip und Tabellenansicht.
const NS = 'http://www.w3.org/2000/svg';
export const fmt = new Intl.NumberFormat('de-DE');

const tip = () => document.getElementById('tooltip');
export function showTip(html, ev) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  moveTip(ev);
}
export function moveTip(ev) {
  const t = tip();
  const pad = 14;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
export function hideTip() { tip().hidden = true; }

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

// Runde Achsenschritte (ganzzahlig), z. B. 0/20/40/60
function niceScale(v, count = 4) {
  const raw = Math.max(v, 1) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].find((m) => m * p >= raw) * p);
  return { step, top: Math.ceil(Math.max(v, 1) / step) * step };
}

// Säule mit 4px gerundetem Kopf, eckig an der Grundlinie
function colPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const observers = new WeakMap();
function onResize(container, draw) {
  observers.get(container)?.disconnect();
  let last = 0;
  const ro = new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w && w !== last) { last = w; draw(w); }
  });
  ro.observe(container);
  observers.set(container, ro);
}

/**
 * Säulendiagramm. rows: [{label, value, plannedPart?, tip}]
 * opts: {height, labelEvery}
 */
export function columns(container, rows, opts = {}) {
  container.innerHTML = '';
  if (!rows.length || rows.every((r) => !r.value)) { container.innerHTML = '<p class="empty">Keine Daten im aktuellen Filter.</p>'; return; }
  const H = opts.height || 240;
  const draw = (W) => {
    container.innerHTML = '';
    const m = { t: 18, r: 4, b: 26, l: 34 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const { step, top: max } = niceScale(Math.max(...rows.map((r) => r.value)));
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': opts.aria || '' }, container);
    for (let i = 0; i <= max / step; i++) {
      const v = step * i, y = m.t + ih - (v / max) * ih;
      el('line', { class: i ? 'grid-line' : 'base-line', x1: m.l, x2: W - m.r, y1: y, y2: y }, svg);
      const t = el('text', { class: 'tick', x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, svg);
      t.textContent = fmt.format(Math.round(v));
    }
    const band = iw / rows.length;
    const bw = Math.max(2, Math.min(24, band * 0.7));
    const every = opts.labelEvery || Math.ceil(rows.length / Math.max(1, Math.floor(iw / 44)));
    const maxRow = rows.reduce((a, b) => (b.value > a.value ? b : a));
    rows.forEach((r, i) => {
      const cx = m.l + band * i + band / 2;
      const h = (r.value / max) * ih;
      const g = el('g', { class: 'col' }, svg);
      // Geplanter Anteil (heller) sitzt mit 2px Abstand auf dem gefahrenen Anteil
      const hp = ((r.plannedPart || 0) / max) * ih;
      const hd = h - hp;
      if (hd > 0) el('path', { class: 'bar', d: hp > 0 ? `M${cx - bw / 2},${m.t + ih}V${m.t + ih - hd}H${cx + bw / 2}V${m.t + ih}Z` : colPath(cx - bw / 2, m.t + ih - h, bw, h) }, g);
      if (hp > 0) el('path', { class: 'bar planned', d: colPath(cx - bw / 2, m.t + ih - h, bw, Math.max(1, hp - (hd > 0 ? 2 : 0))) }, g);
      const hit = el('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ih }, g);
      hit.addEventListener('mouseenter', (ev) => showTip(r.tip, ev));
      hit.addEventListener('mousemove', moveTip);
      hit.addEventListener('mouseleave', hideTip);
      if ((rows.length - 1 - i) % every === 0) { // vom Ende her beschriften, damit das letzte Label passt
        const t = el('text', { class: 'tick', x: cx, y: H - 8, 'text-anchor': 'middle' }, svg);
        t.textContent = r.label;
      }
      if (r === maxRow && r.value) {
        const t = el('text', { class: 'val', x: cx, y: m.t + ih - h - 6, 'text-anchor': 'middle' }, svg);
        t.textContent = fmt.format(r.value);
      }
    });
  };
  onResize(container, draw);
}

/**
 * Horizontale Balken (HTML). rows: [{label, sub?, value, valueLabel?, tip}]
 * opts: {limit}
 */
export function hbars(container, rows, opts = {}) {
  container.innerHTML = '';
  observers.get(container)?.disconnect();
  if (!rows.length) { container.innerHTML = '<p class="empty">Keine Daten im aktuellen Filter.</p>'; return; }
  const limit = opts.limit || rows.length;
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  const wrap = document.createElement('div');
  wrap.className = 'hbars';
  const render = (n) => {
    wrap.innerHTML = '';
    for (const r of rows.slice(0, n)) {
      const row = document.createElement('div');
      row.className = 'hrow';
      row.innerHTML = `<span class="hlabel" title="${esc(r.label)}">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>
        <span class="htrack"><span class="hbar" style="width:calc((100% - 56px) * ${(r.value / max).toFixed(4)})"></span><span class="hval">${r.valueLabel ?? fmt.format(r.value)}</span></span>`;
      row.addEventListener('mouseenter', (ev) => showTip(r.tip, ev));
      row.addEventListener('mousemove', moveTip);
      row.addEventListener('mouseleave', hideTip);
      wrap.appendChild(row);
    }
  };
  render(limit);
  container.appendChild(wrap);
  if (rows.length > limit) {
    const b = document.createElement('button');
    b.className = 'text-btn more';
    b.type = 'button';
    b.textContent = `Alle ${rows.length} anzeigen`;
    b.addEventListener('click', () => {
      const all = b.dataset.all !== '1';
      render(all ? rows.length : limit);
      b.dataset.all = all ? '1' : '';
      b.textContent = all ? 'Weniger anzeigen' : `Alle ${rows.length} anzeigen`;
    });
    container.appendChild(b);
  }
}

/** Tabellenansicht. cols: [{key, label, num?}] */
export function dataTable(container, cols, rows) {
  observers.get(container)?.disconnect();
  container.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.num ? fmt.format(r[c.key]) : esc(String(r[c.key] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
