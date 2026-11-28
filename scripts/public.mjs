// Öffentlicher Teil von weiffenbach.com: Hafen- und Schiffsführer ohne Anmeldung.
//
// Bewusst streng – keine Rückschlüsse auf uns:
//   • nur Häfen und Schiffe vergangener Reisen, ohne Jahre, Anzahl Besuche oder Reisen, ohne Namen
//   • Tagebuch nur mit „ja“ in der Spalte „Öffentlich“ und nur aus der Vergangenheit (Titel, Text, Tipps, Links, Art)
//   • Schiffsfotos nur aus Wikimedia Commons mit Urheber und Lizenz, nie Reederei-Werbebilder
import { readFile, writeFile, mkdir, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = 'https://www.weiffenbach.com';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slug = (s) => s.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const flag = (a2) => (/^[A-Z]{2}$/.test(a2 || '') ? String.fromCodePoint(...[...a2].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
const fmt = new Intl.NumberFormat('de-DE');
const ORDER = ['Europa', 'Asien', 'Nordamerika', 'Südamerika', 'Afrika', 'Ozeanien', 'Antarktis', 'Sonstige'];

// ---------- Schiffsfotos aus Wikimedia Commons ----------
const UA = { 'User-Agent': 'weiffenbach.com-build/1.0 (cruise port guide)' };
// Mit kurzer Pause und Wiederholung, sonst drosselt Wikipedia bei vielen Abfragen (HTTP 429)
async function getJSON(u) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, 250 + attempt * 1500));
      const res = await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status >= 500) continue;
      return res.ok ? await res.json() : null;
    } catch { /* erneut versuchen */ }
  }
  return null;
}
const SHIPLIKE = /ship|schiff|cruise|kreuzfahrt|vessel|liner/i;
async function articleImage(lang, title) {
  const j = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
  if (!j || j.type === 'disambiguation' || !SHIPLIKE.test(`${j.description || ''} ${j.extract || ''}`)) return null;
  const q = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages&piprop=name&titles=${encodeURIComponent(j.title)}`);
  return Object.values(q?.query?.pages || {})[0]?.pageimage || null;
}
async function commonsFileName(name, src) {
  const file = src.match(/^(?:commons:)?(?:File|Datei):(.+)$/i);
  if (file) return file[1].trim();
  const art = src.match(/^(de|en):(.+)$/);
  const tries = art ? [[art[1], art[2]]] : [];
  tries.push(['en', name], ['de', name], ['en', `${name} (ship)`], ['de', `${name} (Schiff)`]);
  for (const [lang, t] of tries) { const f = await articleImage(lang, t); if (f) return f; }
  return null;
}
const strip = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
async function shipPhoto(ship, cache, dir, offline) {
  const key = `${ship.name}|${ship.src}`;
  const file = path.join(dir, `${ship.slug}.jpg`);
  if (cache[key]?.file) { try { await access(file); return cache[key]; } catch { /* neu laden */ } }
  if (offline) return null;
  const name = await commonsFileName(ship.name, /^https?:/i.test(ship.src) ? '' : ship.src);
  if (!name) return null;
  const q = await getJSON(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1280&titles=${encodeURIComponent('File:' + name)}`);
  const info = Object.values(q?.query?.pages || {})[0]?.imageinfo?.[0];
  if (!info) return null; // nur freie Bilder aus Commons
  try {
    let res = null;
    for (let attempt = 0; attempt < 3 && !res?.ok; attempt++) {
      await new Promise((r) => setTimeout(r, 250 + attempt * 1500));
      res = await fetch(info.thumburl || info.url, { headers: UA, signal: AbortSignal.timeout(30000) }).catch(() => null);
    }
    if (!res?.ok) return null;
    await mkdir(dir, { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  } catch { return null; }
  const m = info.extmetadata || {};
  cache[key] = { file: `${ship.slug}.jpg`, author: strip(m.Artist?.value) || 'unbekannt', license: strip(m.LicenseShortName?.value) || 'siehe Quelle', page: info.descriptionurl };
  return cache[key];
}

// ---------- Seitenrahmen ----------
function page({ title, desc, canonical, body, head = '' }) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta name="theme-color" content="#0a0a0a">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b1d30'/%3E%3Ctext x='32' y='44' font-size='34' text-anchor='middle'%3E%E2%9A%93%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="/assets/css/public.css">
${head}
</head>
<body>
<header class="top"><div class="wrap top-bar">
  <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">⚓</span><span><span class="brand-title">Häfen &amp; Schiffe</span><span class="brand-sub">Landgang-Tipps auf eigene Faust</span></span></a>
  <nav class="top-nav"><a href="/haefen/">Häfen</a><a href="/schiffe/">Schiffe</a><a href="/#anmelden" class="login">Anmelden</a></nav>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="foot wrap">
  <p>Persönliche Erfahrungen von Kreuzfahrten, ohne Gewähr. Preise, Öffnungszeiten und Wege ändern sich – vor Ort prüfen.</p>
  <p>Länder: Natural Earth · Schiffsfotos: Wikimedia Commons (Urheber und Lizenz am Bild)</p>
</footer>
</body>
</html>
`;
}

/**
 * Schreibt die öffentlichen Seiten nach outDir. data: Ergebnis von build() (vor dem Verschlüsseln),
 * ships: Schiffsdaten mit Bild-Vorgabe (imgSrc), today: JJJJ-MM-TT.
 */
export async function buildPublic({ data, ships, outDir, cacheDir, today, offline = false }) {
  const countryInfo = JSON.parse(await readFile(path.join(HERE, 'countryinfo.json'), 'utf8'));
  const past = new Set(data.cruises.filter((c) => c.end < today).map((c) => c.id));

  // Häfen vergangener Reisen
  const ports = new Map();
  for (const s of data.stops) {
    if (s.type !== 'Hafen' || s.cruise == null || !past.has(s.cruise) || s.d >= today) continue;
    let p = ports.get(s.port);
    if (!p) {
      const meta = data.countries[s.country] || {};
      p = { name: s.port, slug: slug(s.port), country: s.country, a2: meta.a2 || '', k: s.k || meta.k || 'Sonstige', lat: s.lat, lng: s.lng, tender: false, entries: [] };
      ports.set(s.port, p);
    }
    if (s.tender) p.tender = true;
  }
  const seen = new Map();
  for (const p of ports.values()) { const n = seen.get(p.slug) || 0; seen.set(p.slug, n + 1); if (n) p.slug += `-${n + 1}`; }

  // Freigegebene Tipps
  let tips = 0;
  for (const e of data.diary) {
    if (!e.pub || e.d >= today || (e.cruise != null && !past.has(e.cruise))) continue;
    const p = ports.get(e.port);
    if (!p) continue;
    p.entries.push({ d: e.d, title: e.title, text: e.text, tips: e.tips, art: e.art, links: (e.links || []).filter((u) => /^https:\/\//i.test(u)) }); // d nur zum Sortieren, wird nie gezeigt
    tips++;
  }

  // Schiffe vergangener Reisen
  const shipNames = new Set(data.cruises.filter((c) => past.has(c.id)).map((c) => c.ship));
  const lineOf = new Map(data.cruises.map((c) => [c.ship, c.line]));
  const shipList = [...shipNames].filter((n) => ships[n]).map((n) => ({ name: n, slug: slug(n), line: lineOf.get(n) || '', ...ships[n], src: ships[n].imgSrc || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const photoDir = path.join(cacheDir, 'public-ships');
  const cacheFile = path.join(cacheDir, 'public-ships.json');
  const photoCache = await readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => ({}));
  let photos = 0;
  for (const s of shipList) { s.photo = await shipPhoto(s, photoCache, photoDir, offline); if (s.photo) photos++; }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(photoCache, null, 1));

  const portList = [...ports.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const countries = new Set(portList.map((p) => p.country));
  const files = new Map();
  const countryLine = (p) => `${flag(p.a2)} ${esc(p.country)}`;
  const stars = (n) => (n ? `<span class="stars" aria-label="${n} von 5 Sternen">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>` : '');
  const portCard = (p) => `<a class="card port-card" href="/hafen/${p.slug}/">
      <span class="pc-name">${esc(p.name)}</span><span class="pc-country">${countryLine(p)}</span>
      ${p.entries.length || p.tender ? `<span class="pc-meta">${p.entries.length ? `<span class="badge">${p.entries.length} ${p.entries.length === 1 ? 'Tipp' : 'Tipps'}</span>` : ''}${p.tender ? '<span class="badge">Tender</span>' : ''}</span>` : ''}
    </a>`;
  const entryHtml = (e) => `<article class="entry">
      ${e.art ? `<p class="entry-meta">${esc(e.art)}</p>` : ''}
      ${e.title ? `<h3>${esc(e.title)}</h3>` : ''}
      ${e.text ? `<p>${esc(e.text)}</p>` : ''}
      ${e.tips ? `<p class="tip"><b>Tipp</b> ${esc(e.tips)}</p>` : ''}
      ${e.links.length ? `<p class="links">${e.links.map((u) => `<a href="${esc(u)}" rel="noopener nofollow" target="_blank">${esc(new URL(u).hostname.replace(/^www\./, ''))} ↗</a>`).join('')}</p>` : ''}
    </article>`;

  for (const p of portList) {
    const info = countryInfo[p.a2] || {};
    const facts = [['Land', countryLine(p)], ['Kontinent', esc(p.k)], ['Währung', esc(info.cur || '')], ['Sprache', esc(info.lang || '')],
      ['Steckdose', info.plug ? `Typ ${esc(info.plug)}` : ''], ['Ausbooten', p.tender ? 'Tender (Ausbooten)' : 'Anleger, soweit bekannt']].filter(([, v]) => v);
    const q = encodeURIComponent(p.name.replace(/\s*\(.*\)/, ''));
    files.set(`hafen/${p.slug}/index.html`, page({
      title: `${p.name} – Landgang auf eigene Faust | Häfen & Schiffe`, canonical: `/hafen/${p.slug}/`,
      desc: `${p.name} (${p.country}) als Kreuzfahrthafen: ${p.entries.length ? p.entries.map((e) => e.title).filter(Boolean).slice(0, 3).join(', ') : 'Infos für den Landgang'}.`,
      body: `<nav class="crumbs"><a href="/haefen/">Häfen</a> › ${esc(p.name)}</nav>
      <section class="hero"><p class="kicker">${countryLine(p)}</p><h1>${esc(p.name)}</h1>
        <p class="lead">${p.entries.length ? `${p.entries.length} ${p.entries.length === 1 ? 'Tipp' : 'Tipps'} für den Landgang` : 'Infos für den Landgang – Tipps folgen.'}</p></section>
      <div class="grid-2">
        <section class="card"><h2>Auf einen Blick</h2><dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></section>
        <section class="card"><h2>Nachschlagen</h2><p class="links">
          <a href="https://de.wikivoyage.org/w/index.php?search=${q}&go=Artikel" rel="noopener" target="_blank">Wikivoyage ↗</a>
          <a href="https://de.wikipedia.org/w/index.php?search=${q}&go=Artikel" rel="noopener" target="_blank">Wikipedia ↗</a>
          <a href="https://www.openstreetmap.org/#map=13/${p.lat}/${p.lng}" rel="noopener" target="_blank">Karte ↗</a></p></section>
      </div>
      ${p.entries.length ? `<section class="card"><h2>Tipps</h2><div class="entries">${p.entries.map(entryHtml).join('')}</div></section>` : ''}`,
    }));
  }

  for (const s of shipList) {
    const facts = [['Reederei', s.line], ['In Dienst seit', s.built], ['Vermessung', s.gt && `${fmt.format(s.gt)} BRZ`], ['Länge', s.length && `${fmt.format(s.length)} m`],
      ['Passagiere', s.pax && fmt.format(s.pax)], ['Klasse', s.cls], ['Werft', s.yard], ['Früher', s.note]].filter(([, v]) => v);
    files.set(`schiff/${s.slug}/index.html`, page({
      title: `${s.name} – Erfahrungen | Häfen & Schiffe`, canonical: `/schiff/${s.slug}/`,
      desc: `${s.name}${s.line ? ` (${s.line})` : ''}: Steckbrief und Fazit nach einer Reise an Bord.`,
      body: `<nav class="crumbs"><a href="/schiffe/">Schiffe</a> › ${esc(s.name)}</nav>
      <section class="hero"><p class="kicker">${esc(s.line)}</p><h1>${esc(s.name)}</h1></section>
      ${s.photo ? `<figure class="ship-photo card"><img src="/assets/img/schiffe/${s.photo.file}" alt="${esc(s.name)}" loading="lazy">
        <figcaption>Foto: ${esc(s.photo.author)} · <a href="${esc(s.photo.page)}" rel="noopener" target="_blank">${esc(s.photo.license)}, Wikimedia Commons ↗</a></figcaption></figure>` : ''}
      <div class="grid-2">
        <section class="card"><h2>Fazit</h2>${s.rating || s.verdict ? `<p class="verdict">${stars(s.rating)}</p>${s.verdict ? `<p>${esc(s.verdict)}</p>` : ''}` : '<p class="muted">Folgt.</p>'}</section>
        <section class="card"><h2>Steckbrief</h2><dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
          ${s.sisters && s.sisters !== '–' ? `<p class="muted">Schwesterschiffe: ${esc(s.sisters)}</p>` : ''}</section>
      </div>`,
    }));
  }

  // Übersicht Häfen mit Karte und Suche
  const byK = new Map();
  for (const p of portList) { if (!byK.has(p.k)) byK.set(p.k, []); byK.get(p.k).push(p); }
  const mapData = portList.map((p) => ({ n: p.name, s: p.slug, c: p.country, la: p.lat, lo: p.lng, t: p.entries.length }));
  files.set('haefen/index.html', page({
    title: 'Häfen & Schiffe – Landgang-Tipps auf eigene Faust', canonical: '/haefen/',
    desc: `Landgang-Tipps für ${portList.length} Kreuzfahrthäfen in ${countries.size} Ländern – was man auf eigene Faust erleben kann.`,
    head: '<link rel="stylesheet" href="/assets/vendor/leaflet/leaflet.css">',
    body: `<section class="hero"><p class="kicker">Landgang auf eigene Faust</p><h1>${portList.length} Häfen in ${countries.size} Ländern</h1>
      <p class="lead">Was man in Kreuzfahrthäfen ohne Schiffsausflug unternehmen kann – mit Länderinfos und Tipps.</p>
      <input class="search" id="q" type="search" placeholder="Hafen oder Land suchen" aria-label="Hafen oder Land suchen"></section>
    <section class="card"><h2>Weltkarte</h2><div id="map" role="region" aria-label="Karte der Häfen"></div></section>
    ${[...byK.entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0])).map(([k, list]) => `<section class="continent"><h2>${esc(k)} <small>${list.length}</small></h2>
      <div class="port-grid">${list.map(portCard).join('')}</div></section>`).join('')}
    <script id="ports" type="application/json">${JSON.stringify(mapData).replace(/</g, '\\u003c')}</script>
    <script src="/assets/vendor/leaflet/leaflet.js"></script><script src="/assets/vendor/topojson-client.min.js"></script>
    <script src="/assets/js/public-map.js"></script><script src="/assets/js/public-search.js"></script>`,
  }));

  const byLine = new Map();
  for (const s of shipList) { if (!byLine.has(s.line)) byLine.set(s.line, []); byLine.get(s.line).push(s); }
  files.set('schiffe/index.html', page({
    title: 'Kreuzfahrtschiffe – Steckbrief und Fazit | Häfen & Schiffe', canonical: '/schiffe/',
    desc: `${shipList.length} Kreuzfahrtschiffe von ${byLine.size} Reedereien mit Steckbrief und Fazit.`,
    body: `<section class="hero"><p class="kicker">Schiffe</p><h1>${shipList.length} Schiffe, ${byLine.size} Reedereien</h1>
      <p class="lead">Steckbrief und ehrliches Fazit nach einer Reise an Bord.</p></section>
    ${[...byLine.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de')).map(([line, list]) => `<section class="continent"><h2>${esc(line)} <small>${list.length}</small></h2>
      <div class="ship-grid">${list.map((s) => `<a class="card ship-card" href="/schiff/${s.slug}/">
        ${s.photo ? `<img src="/assets/img/schiffe/${s.photo.file}" alt="" loading="lazy">` : '<span class="ship-ph" aria-hidden="true">🚢</span>'}
        <span class="sc-body"><span class="sc-name">${esc(s.name)}</span>${stars(s.rating)}</span></a>`).join('')}</div></section>`).join('')}`,
  }));

  for (const [rel, html] of files) {
    await mkdir(path.join(outDir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(outDir, rel), html);
  }
  const imgOut = path.join(outDir, 'assets', 'img', 'schiffe');
  await mkdir(imgOut, { recursive: true });
  for (const s of shipList) if (s.photo) await copyFile(path.join(photoDir, s.photo.file), path.join(imgOut, s.photo.file)).catch(() => {});
  // Startseite: öffentliches Dashboard in index.html einsetzen
  const indexFile = path.join(outDir, 'index.html');
  const index = await readFile(indexFile, 'utf8').catch(() => null);
  if (index?.includes('<!--PUBLIC-DASHBOARD-->')) {
    const bars = (rows) => { const max = Math.max(1, ...rows.map((r) => r.n)); return `<div class="pub-bars">${rows.map((r) => `<div class="pub-bar"><span class="pb-label">${r.label}</span>
      <span class="pb-track"><i style="width:${Math.max(2, (r.n / max) * 100)}%"></i><b>${fmt.format(r.n)}</b></span></div>`).join('')}</div>`; };
    const contRows = [...byK.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, list]) => ({ label: esc(k), n: list.length }));
    const lineRows = [...byLine.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'de')).map(([l, list]) => ({ label: esc(l), n: list.length }));
    const byCountry = new Map();
    for (const p of portList) { const c = byCountry.get(p.country) || { a2: p.a2, n: 0 }; c.n++; byCountry.set(p.country, c); }
    const latest = portList.flatMap((p) => p.entries.map((e) => ({ e, p }))).sort((a, b) => b.e.d.localeCompare(a.e.d)).slice(0, 6);
    const topShips = [...shipList].sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.photo ? 1 : 0) - (a.photo ? 1 : 0) || a.name.localeCompare(b.name, 'de')).slice(0, 8);
    const kpi = (n, label, href) => `<${href ? `a href="${href}"` : 'div'} class="pub-kpi"><b>${fmt.format(n)}</b><span>${label}</span></${href ? 'a' : 'div'}>`;
    const dash = `
    <section class="pub-hero"><p class="pub-kicker">Landgang auf eigene Faust</p><h1 id="pub-h1">Häfen &amp; Schiffe</h1>
      <p class="pub-lead">Tipps für ${fmt.format(portList.length)} Kreuzfahrthäfen in ${fmt.format(countries.size)} Ländern – und ein ehrliches Fazit zu ${fmt.format(shipList.length)} Schiffen.</p></section>
    <div class="pub-kpis">${kpi(portList.length, 'Häfen', '/haefen/')}${kpi(countries.size, 'Länder')}${kpi(byK.size, 'Kontinente')}${kpi(shipList.length, 'Schiffe', '/schiffe/')}${kpi(byLine.size, 'Reedereien', '/schiffe/')}${kpi(tips, 'Tipps', '/haefen/')}</div>
    <div class="pub-grid">
      <section class="pub-card pub-wide"><div class="pub-head"><h2>Weltkarte</h2><a href="/haefen/">Alle Häfen ›</a></div><div id="pub-map" role="region" aria-label="Karte der Häfen"></div></section>
      <section class="pub-card"><h2>Häfen nach Kontinent</h2>${bars(contRows)}</section>
      <section class="pub-card"><h2>Schiffe nach Reederei</h2>${bars(lineRows)}</section>
      ${latest.length ? `<section class="pub-card pub-wide"><div class="pub-head"><h2>Neueste Tipps</h2><a href="/haefen/">Alle Häfen ›</a></div><div class="pub-tips">${latest.map(({ e, p }) => `<a class="pub-tip" href="/hafen/${p.slug}/">
        <span class="pt-where">${flag(p.a2)} ${esc(p.name)}</span><span class="pt-title">${esc(e.title || e.tips.slice(0, 90))}</span></a>`).join('')}</div></section>` : ''}
      <section class="pub-card pub-wide"><div class="pub-head"><h2>Schiffe</h2><a href="/schiffe/">Alle Schiffe ›</a></div><div class="pub-ships">${topShips.map((s) => `<a class="pub-ship" href="/schiff/${s.slug}/">
        ${s.photo ? `<img src="/assets/img/schiffe/${s.photo.file}" alt="" loading="lazy">` : '<span class="ps-ph" aria-hidden="true">🚢</span>'}
        <span class="ps-name">${esc(s.name)}</span><span class="ps-line">${esc(s.line)} ${stars(s.rating)}</span></a>`).join('')}</div></section>
      <section class="pub-card pub-wide"><h2>Länder</h2><div class="pub-flags">${[...byCountry.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'))
        .map(([c, v]) => `<span class="pub-flag">${flag(v.a2)} ${esc(c)} <small>${v.n}</small></span>`).join('')}</div></section>
    </div>
    <script id="ports" type="application/json">${JSON.stringify(mapData).replace(/</g, '\\u003c')}</script>`;
    await writeFile(indexFile, index.replace('<!--PUBLIC-DASHBOARD-->', dash));
  }

  const urls = ['/', ...[...files.keys()].map((r) => '/' + r.replace(/index\.html$/, ''))];
  await writeFile(path.join(outDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
  return { ports: portList.length, ships: shipList.length, photos, tips, pages: files.size };
}
