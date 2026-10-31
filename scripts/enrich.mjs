// Anreicherung beim Build: Wetter am Hafentag und Zeitzone des Hafens (Open-Meteo, historisches Archiv).
// Ergebnisse landen in einem Cache, damit jeder Tag nur einmal abgefragt wird.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { webcrypto as crypto, createHash } from 'node:crypto';

const FILE = 'build-cache.enc';

// AES-GCM mit dem Seiten-Schlüssel: 12 Byte IV + Chiffretext. Neues Passwort → Cache wird neu aufgebaut.
export async function loadCache(dir, key) {
  try {
    const buf = await readFile(path.join(dir, FILE));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { return {}; }
}

export async function saveCache(dir, cache, key) {
  await mkdir(dir, { recursive: true });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(cache)));
  await writeFile(path.join(dir, FILE), Buffer.concat([Buffer.from(iv), Buffer.from(ct)]));
}

/** Ergänzt an jedem vergangenen Hafentag s.wx (Wetter) und s.tz (UTC-Versatz in Stunden). */
export async function addWeather(stops, cache) {
  cache.wx ||= {};
  // Das Archiv liegt einige Tage hinter dem heutigen Datum zurück
  const limit = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  let fetched = 0, failed = 0, streak = 0;
  for (const s of stops) {
    if (s.lat == null || s.lng == null || s.d > limit || s.type === 'Passage') continue;
    const key = `${s.lat.toFixed(2)},${s.lng.toFixed(2)},${s.d}`;
    if (!cache.wx[key] && streak < 5) { // nach fünf Fehlschlägen in Folge ist der Dienst nicht erreichbar
      const got = await fetchDay(s.lat, s.lng, s.d);
      if (got) { cache.wx[key] = got; fetched++; streak = 0; } else { failed++; streak++; }
    }
    const w = cache.wx[key];
    if (w) Object.assign(s, { wx: w.wx, tz: w.tz });
  }
  return { fetched, failed };
}

async function fetchDay(lat, lng, d) {
  const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${d}&end_date=${d}`
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code&timezone=auto';
  try {
    await new Promise((r) => setTimeout(r, 120));
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const j = await res.json();
    const v = (k) => j.daily?.[k]?.[0] ?? null;
    if (v('temperature_2m_max') == null) return null;
    return {
      wx: { hi: round(v('temperature_2m_max')), lo: round(v('temperature_2m_min')), rain: round(v('precipitation_sum')),
        wind: Math.round(v('wind_speed_10m_max') ?? 0), code: v('weather_code') },
      tz: Math.round((j.utc_offset_seconds / 3600) * 4) / 4,
    };
  } catch { return null; }
}

const round = (x) => (x == null ? null : Math.round(x * 10) / 10);

// ---------- Schiffsbilder aus Wikipedia ----------
const UA = { 'User-Agent': 'weiffenbach.com-build/1.0 (private travel log)' };
const SHIPLIKE = /ship|schiff|cruise|kreuzfahrt|vessel|liner/i;

async function getJSON(u) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, 250 + attempt * 1500));
      const res = await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status >= 500) continue; // gedrosselt: kurz warten und erneut
      return res.ok ? await res.json() : null;
    } catch { /* erneut versuchen */ }
  }
  return null;
}

// Artikel-Zusammenfassung mit Vorschaubild; nur Treffer, die nach Schiff aussehen
async function summary(lang, title) {
  const j = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
  if (!j || j.type === 'disambiguation') return null;
  if (!SHIPLIKE.test(`${j.description || ''} ${j.extract || ''}`)) return null;
  let thumb = j.thumbnail?.source || j.originalimage?.source;
  if (!thumb) {
    // manche Artikel liefern das Bild nur über die Seitenbilder-Abfrage
    const q = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=640&titles=${encodeURIComponent(j.title)}`);
    thumb = Object.values(q?.query?.pages || {})[0]?.thumbnail?.source;
  }
  return thumb ? { thumb, page: j.content_urls?.desktop?.page || '', title: j.title } : null;
}

async function search(lang, name) {
  const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const q = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(name)}`);
  for (const hit of q?.query?.search || []) {
    const t = hit.title.toLowerCase();
    if (!words.every((w) => t.includes(w))) continue;
    const s = await summary(lang, hit.title);
    if (s) return s;
  }
  return null;
}

// bestimmtes Foto aus Wikimedia Commons („File:…“ / „Datei:…“), z. B. eines aus früherer Bemalung
async function commonsFile(file) {
  const title = `File:${file.trim()}`;
  const q = await getJSON(`https://commons.wikimedia.org/w/api.php?action=query&format=json&redirects=1&prop=imageinfo&iiprop=url&iiurlwidth=640&titles=${encodeURIComponent(title)}`);
  const info = Object.values(q?.query?.pages || {})[0]?.imageinfo?.[0];
  return info ? { thumb: info.thumburl || info.url, page: info.descriptionurl || '' } : null;
}

async function findShipImage(name, override) {
  const file = override.match(/^(?:commons:)?(?:File|Datei):(.+)$/i);
  if (file) {
    // fest vorgegebenes Foto; ohne Rückfall auf die Suche, sonst käme das aktuelle Bild zurück
    const img = await commonsFile(file[1]);
    if (!img) return null;
    const article = await findShipImage(name, '');
    return { ...img, page: article?.page || img.page };
  }
  const tries = [];
  if (override) {
    const m = override.match(/^(de|en):(.+)$/);
    tries.push(m ? [m[1], m[2]] : ['de', override]);
  }
  tries.push(['en', name], ['de', name], ['en', `${name} (ship)`], ['de', `${name} (Schiff)`], ['en', `MS ${name}`]);
  for (const [lang, title] of tries) {
    const s = await summary(lang, title);
    if (s) return s;
  }
  return (await search('en', name)) || (await search('de', name));
}

/**
 * Lädt zu jedem Schiff ein Wikipedia-Bild, legt es verschlüsselt unter <outDir>/photos ab und ergänzt
 * ship.img (Dateiname) und ship.wiki (Artikel). Bilder werden im Cache gehalten, Fehlschläge eine Woche lang nicht wiederholt.
 */
export async function addShipImages(ships, cache, { key, keyId, outDir, encryptBytes, offline = false }) {
  cache.shipImg ||= {};
  let fetched = 0, missing = 0;
  await mkdir(path.join(outDir, 'photos'), { recursive: true });
  for (const [name, ship] of Object.entries(ships)) {
    const want = ship.imgSrc || '';
    let c = cache.shipImg[name];
    const stale = !c || c.src !== want || c.v !== 2 || (c.fail && Date.now() - c.fail > 7 * 86400000);
    if (stale && !offline) {
      const s = await findShipImage(name, want);
      let bytes = null;
      if (s) {
        try {
          const url = s.thumb.replace(/\/\d+px-/, '/640px-');
          let res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
          if (!res.ok) res = await fetch(s.thumb, { headers: UA, signal: AbortSignal.timeout(20000) });
          if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
        } catch { /* nächster Lauf */ }
      }
      c = cache.shipImg[name] = bytes ? { v: 2, src: want, page: s.page, data: bytes.toString('base64') } : { v: 2, src: want, fail: Date.now() };
      if (bytes) fetched++;
    }
    delete ship.imgSrc;
    if (!c?.data) { missing++; continue; }
    const file = createHash('sha256').update(`${keyId}:ship:${name}:${c.page}:${c.src}`).digest('hex').slice(0, 32);
    await writeFile(path.join(outDir, 'photos', `${file}.bin`), await encryptBytes(Buffer.from(c.data, 'base64'), key));
    ship.img = file;
    ship.wiki = c.page;
  }
  return { fetched, missing };
}
