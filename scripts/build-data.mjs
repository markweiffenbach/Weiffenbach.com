#!/usr/bin/env node
// Liest die Tabs „Kreuzfahrten“ und „Stopps“ aus dem Google Sheet, prüft und ergänzt die Daten
// und schreibt sie AES-verschlüsselt nach <out>/data/data.enc.json.
//
// Umgebungsvariablen:
//   SHEET_PUBLISH_URL  Link aus „Datei → Freigeben → Im Web veröffentlichen“ (CSV)
//   SITE_PASSWORD      Passwort für die Homepage
//   GID_KREUZFAHRTEN   optional, Standard 1100
//   GID_STOPPS         optional, Standard 1200
// Optionen:
//   --out <dir>        Zielordner (Standard: _site)
//   --from-json <file> lokale Testdaten statt Sheet ({cruises, stops} im Seed-Format)
//   --plain            zusätzlich unverschlüsselte data.json schreiben (nur lokal!)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { webcrypto as crypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = opt('--out') || '_site';
const FROM_JSON = opt('--from-json');
const PLAIN = args.includes('--plain');

// Muss mit site/assets/js/crypto.js übereinstimmen
const KDF = { salt: 'weiffenbach.com/schiffsurlaube/v1', iterations: 310000 };

const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn('⚠ ' + msg); };

// ---------- CSV ----------
function parseCSV(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function table(rows, required, tab) {
  const head = rows[0].map((h) => h.trim());
  const idx = {};
  for (const name of required) {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`Spalte „${name}“ fehlt im Tab „${tab}“ (gefunden: ${head.join(', ')})`);
    idx[name] = i;
  }
  return rows.slice(1).map((r, n) => {
    const o = { _row: n + 2 };
    for (const [k, i] of Object.entries(idx)) o[k] = (r[i] ?? '').trim();
    return o;
  });
}

// ---------- Werte ----------
function parseDate(s) {
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return iso(y, +m[2], +m[1]);
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // US-Format aus englischem Sheet
  if (m) return iso(+m[3], +m[1], +m[2]);
  if (/^\d{5}$/.test(s)) { // Seriennummer
    const d = new Date(Date.UTC(1899, 11, 30) + +s * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}
function iso(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}
function parseNum(s) {
  if (!s) return null;
  const t = s.replace(/\s/g, '');
  const n = Number(t.includes(',') && !t.includes('.') ? t.replace(',', '.') : t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ---------- Quelle ----------
// Akzeptiert jeden Google-Sheets-Link: „Im Web veröffentlichen“ (…/d/e/2PACX…/pub, pubhtml, pub?output=csv)
// oder den normalen Link (…/d/<id>/edit, dann muss „Jeder mit dem Link“ lesen dürfen).
function csvUrl(link, gid) {
  const u = new URL(link.trim());
  if (u.hostname !== 'docs.google.com') return Object.assign(u, { search: `?gid=${gid}&single=true&output=csv` });
  const pub = u.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)/);
  if (pub) return new URL(`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?gid=${gid}&single=true&output=csv`);
  const id = u.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (id) return new URL(`https://docs.google.com/spreadsheets/d/${id[1]}/export?format=csv&gid=${gid}`);
  throw new Error('SHEET_PUBLISH_URL ist kein Google-Sheets-Link.');
}

async function fetchCSV(gid, tab) {
  const link = process.env.SHEET_PUBLISH_URL;
  if (!link) throw new Error('SHEET_PUBLISH_URL ist nicht gesetzt (GitHub → Settings → Secrets and variables → Actions).');
  const u = csvUrl(link, gid);
  const kind = u.pathname.includes('/d/e/') ? 'veröffentlichter Link' : 'Freigabe-Link';
  const res = await fetch(u, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Tab „${tab}“ (${kind}): Abruf fehlgeschlagen (HTTP ${res.status}). Ist der Tab im Web veröffentlicht?`);
  const text = await res.text();
  if (text.trimStart().startsWith('<')) {
    const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '?';
    throw new Error(`Tab „${tab}“ (${kind}) lieferte eine Webseite statt CSV (Seitentitel: „${title.trim()}“). `
      + `Bitte im Sheet unter „Datei → Freigeben → Im Web veröffentlichen“ prüfen, dass „${tab}“ ausgewählt und veröffentlicht ist.`);
  }
  return parseCSV(text);
}

async function loadSource() {
  if (FROM_JSON) {
    const seed = JSON.parse(await readFile(FROM_JSON, 'utf8'));
    return {
      cruises: seed.cruises.map((c, i) => ({ _row: i + 2, Start: c.start, Ende: c.ende, Schiff: c.schiff, Reederei: c.reederei,
        Route: c.route, Fahrtgebiet: c.gebiet, Bemerkung: c.notiz || '' })),
      stops: seed.stops.map((s, i) => ({ _row: i + 2, Datum: s.datum, Hafen: s.hafen, Land: s.land, Art: s.typ,
        Breite: String(s.lat), 'Länge': String(s.lng) })),
    };
  }
  const [k, s] = await Promise.all([
    fetchCSV(process.env.GID_KREUZFAHRTEN || '1100', 'Kreuzfahrten'),
    fetchCSV(process.env.GID_STOPPS || '1200', 'Stopps'),
  ]);
  return {
    cruises: table(k, ['Start', 'Ende', 'Schiff', 'Reederei', 'Route', 'Fahrtgebiet', 'Bemerkung'], 'Kreuzfahrten'),
    stops: table(s, ['Datum', 'Hafen', 'Land', 'Art', 'Breite', 'Länge'], 'Stopps'),
  };
}

// ---------- Geocoding für neue Häfen ----------
async function geocode(port, country) {
  const q = `${port.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim()}, ${country}`;
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=de&q=${encodeURIComponent(q)}`;
  try {
    await new Promise((r) => setTimeout(r, 1100)); // Nutzungsrichtlinie: max. 1 Anfrage/Sekunde
    const res = await fetch(u, { headers: { 'User-Agent': 'weiffenbach.com-build/1.0 (GitHub Actions)' } });
    if (!res.ok) return null;
    const [hit] = await res.json();
    return hit ? { lat: +(+hit.lat).toFixed(3), lng: +(+hit.lon).toFixed(3) } : null;
  } catch { return null; }
}

// ---------- Aufbereitung ----------
async function build() {
  const src = await loadSource();
  const countryTable = JSON.parse(await readFile(path.join(here, 'countries.de.json'), 'utf8'));

  const cruises = [];
  for (const r of src.cruises) {
    if (!r.Start && !r.Schiff) continue;
    const start = parseDate(r.Start), end = parseDate(r.Ende);
    if (!start || !end) { warn(`Kreuzfahrten, Zeile ${r._row}: Start oder Ende ist kein gültiges Datum – Zeile übersprungen.`); continue; }
    if (end < start) { warn(`Kreuzfahrten, Zeile ${r._row}: Ende liegt vor Start – Zeile übersprungen.`); continue; }
    cruises.push({ start, end, nights: days(start, end), ship: r.Schiff || 'Unbekannt', line: r.Reederei || 'Unbekannt',
      route: r.Route || '', region: r.Fahrtgebiet || 'Sonstige', note: r.Bemerkung || '' });
  }
  cruises.sort((a, b) => a.start.localeCompare(b.start));
  cruises.forEach((c, i) => { c.id = i; });

  const findCruise = (d) => {
    let hit = null;
    for (const c of cruises) if (c.start <= d && d <= c.end) hit = c; // bei Wechseltag zählt die neue Reise
    return hit;
  };

  const coordsByPort = new Map();
  const rawStops = [];
  for (const r of src.stops) {
    if (!r.Datum && !r.Hafen) continue;
    const d = parseDate(r.Datum);
    if (!d) { warn(`Stopps, Zeile ${r._row}: Datum ungültig – Zeile übersprungen.`); continue; }
    if (!r.Hafen) { warn(`Stopps, Zeile ${r._row}: Hafen fehlt – Zeile übersprungen.`); continue; }
    const lat = parseNum(r.Breite), lng = parseNum(r['Länge']);
    const s = { d, port: r.Hafen, country: r.Land, art: r.Art, lat, lng, _row: r._row };
    if (lat != null && lng != null && !coordsByPort.has(s.port)) coordsByPort.set(s.port, { lat, lng });
    rawStops.push(s);
  }

  // Land und Koordinaten von gleichnamigen Häfen übernehmen, sonst nachschlagen
  const countryByPort = new Map(rawStops.filter((s) => s.country).map((s) => [s.port, s.country]));
  for (const s of rawStops) {
    if (!s.country) s.country = countryByPort.get(s.port) || '';
    if (s.lat == null || s.lng == null) {
      if (!coordsByPort.has(s.port)) {
        const g = await geocode(s.port, s.country);
        coordsByPort.set(s.port, g);
        if (g) console.log(`ℹ Stopps, Zeile ${s._row}: Koordinaten automatisch ermittelt.`);
        else warn(`Stopps, Zeile ${s._row}: keine Koordinaten gefunden – bitte Breite/Länge im Sheet eintragen.`);
      }
      const c = coordsByPort.get(s.port);
      if (c) { s.lat = c.lat; s.lng = c.lng; }
    }
  }

  const countries = {};
  const stops = rawStops.sort((a, b) => a.d.localeCompare(b.d)).map((s) => {
    const c = findCruise(s.d);
    const art = /^pass/i.test(s.art) ? 'Passage' : /^land/i.test(s.art) ? 'Landaufenthalt' : /^hafen/i.test(s.art) ? 'Hafen'
      : (c ? 'Hafen' : 'Landaufenthalt');
    const meta = countryTable[s.country];
    if (!meta) warn(`Stopps, Zeile ${s._row}: Land „${s.country || '(leer)'}“ unbekannt – wird als „Sonstige“ gezählt.`);
    else countries[s.country] = { a2: meta.a2, n: meta.n, k: meta.k };
    let k = meta ? meta.k : 'Sonstige';
    if (meta?.a2 === 'RU' && s.lng > 60) k = 'Asien';
    if (meta?.a2 === 'TR' && s.lat > 40.9 && s.lng < 29.2) k = 'Europa';
    return { d: s.d, port: s.port, country: s.country || 'Unbekannt', type: art, lat: s.lat, lng: s.lng, k,
      cruise: c && art !== 'Landaufenthalt' ? c.id : null };
  });

  return { generated: new Date().toISOString(), cruises, stops, countries, warnings: warnings.length };
}

// ---------- Verschlüsselung ----------
const b64 = (buf) => Buffer.from(buf).toString('base64');
async function encrypt(obj, password) {
  const enc = new TextEncoder();
  // Gleiche Normalisierung wie site/assets/js/crypto.js (z. B. Zeilenumbruch aus dem Secret entfernen)
  const base = await crypto.subtle.importKey('raw', enc.encode(password.trim().normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(KDF.salt), iterations: KDF.iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations: KDF.iterations, iv: b64(iv), ct: b64(ct) };
}

const data = await build();
const password = process.env.SITE_PASSWORD;
if (!password) throw new Error('SITE_PASSWORD ist nicht gesetzt.');
if (password.trim().length < 10) warn('SITE_PASSWORD ist kürzer als 10 Zeichen – ein längeres Passwort schützt deutlich besser.');

await mkdir(path.join(OUT, 'data'), { recursive: true });
await writeFile(path.join(OUT, 'data', 'data.enc.json'), JSON.stringify(await encrypt(data, password)));
if (PLAIN) await writeFile(path.join(OUT, 'data', 'data.json'), JSON.stringify(data, null, 1));

console.log(`✓ ${data.cruises.length} Reisen, ${data.stops.length} Stopps verschlüsselt geschrieben (${warnings.length} Hinweise).`);
