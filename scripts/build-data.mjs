#!/usr/bin/env node
// Liest die Tabs „Kreuzfahrten“, „Stopps“, „Schiffe“, „Ausgefallen“, „Tagebuch“, „Hafenzeiten“, „Anreise“ und „An Bord“
// aus dem Google Sheet, prüft und ergänzt die Daten
// und schreibt sie AES-verschlüsselt nach <out>/data/data.enc.json.
//
// Umgebungsvariablen:
//   SHEET_PUBLISH_URL  Link aus „Datei → Freigeben → Im Web veröffentlichen“ (CSV)
//   SITE_PASSWORD      Passwort für die Homepage
//   GID_KREUZFAHRTEN   optional, Standard 1100
//   GID_STOPPS         optional, Standard 1200
//   GID_SCHIFFE        optional, Standard 1500
//   GID_AUSGEFALLEN    optional, Standard 1600
//   GID_TAGEBUCH       optional, Standard 1700
//   GID_HAFENZEITEN    optional, Standard 1800
//   GID_ANREISE        optional, Standard 1900
//   GID_ANBORD         optional, Standard 2000
// Optionen:
//   --out <dir>        Zielordner (Standard: _site)
//   --from-json <file> lokale Testdaten statt Sheet ({cruises, stops, ships?, missed?, diary?, times?, travel?, onboard?} im Seed-Format)
//   --plain            zusätzlich unverschlüsselte data.json schreiben (nur lokal!)
//   --photos-dir <dir> lokale Testfotos statt Google Drive (siehe scripts/photos.mjs)
//   --photo-cache <d>  Cache-Ordner für verschlüsselte Fotos, Wetter und Koordinaten (Standard: .photo-cache)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { webcrypto as crypto, createHash } from 'node:crypto';
import { collectPhotos, collectLocalPhotos, encryptBytes } from './photos.mjs';
import { loadCache, saveCache, addWeather, addShipImages } from './enrich.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = opt('--out') || '_site';
const FROM_JSON = opt('--from-json');
const PLAIN = args.includes('--plain');
const PHOTOS_DIR = opt('--photos-dir'); // nur lokal: Ordner mit manifest.json statt Google Drive
const CACHE_DIR = opt('--photo-cache') || '.photo-cache';
let cache = {}; // Wetter und Koordinaten aus früheren Läufen

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

function table(rows, required, tab, optional = []) {
  const head = rows[0].map((h) => h.trim());
  const idx = {};
  for (const name of required) {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`Spalte „${name}“ fehlt im Tab „${tab}“ (gefunden: ${head.join(', ')})`);
    idx[name] = i;
  }
  for (const name of optional) if (head.includes(name)) idx[name] = head.indexOf(name);
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
// Uhrzeit aus „08:00 Uhr“, „8:00 a. m.“, „17.00“ → „08:00“
function clock(s) {
  const m = String(s || '').match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return '';
  let h = +m[1];
  if (/p\.?\s?m/i.test(s) && h < 12) h += 12;
  if (/a\.?\s?m/i.test(s) && h === 12) h = 0;
  return h < 24 && +m[2] < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : '';
}
const yes = (v) => /^(ja|x|1|true|wahr)/i.test(String(v || '').trim());
function km(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
// Hafennamen vergleichen: gleiche Schreibweise oder gemeinsames markantes Wort („Yokohama (Tokio)“ ~ „Tokio“)
const GENERIC = new Set(['port', 'porto', 'puerto', 'san', 'santa', 'santo', 'saint', 'sankt', 'bay', 'isla', 'ilha', 'island', 'grand', 'grande', 'new', 'city']);
const words = (p) => p.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
const findStop = (stops, d, port) => {
  const w = words(port);
  return stops.find((s) => s.d === d && s.port === port) || stops.find((s) => s.d === d && words(s.port).some((x) => w.includes(x)));
};

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
        Route: c.route, Fahrtgebiet: c.gebiet, Bemerkung: c.notiz || '', Mitreisende: c.mitreisende || '', Kabine: c.kabine || '' })),
      stops: seed.stops.map((s, i) => ({ _row: i + 2, Datum: s.datum, Hafen: s.hafen, Land: s.land, Art: s.typ,
        Breite: String(s.lat), 'Länge': String(s.lng), Erstanlauf: s.erstanlauf || '', 'Erstanlauf Quelle': s.erstanlaufQuelle || '' })),
      ships: (seed.ships || []).map((x, i) => ({ _row: i + 2, ...x })),
      missed: (seed.missed || []).map((m, i) => ({ _row: i + 2, Datum: m.datum, Hafen: m.hafen, Land: m.land, Grund: m.grund,
        Zeitpunkt: m.zeitpunkt || '', Status: m.status || '', Details: m.details || '', Quelle: m.quelle || '',
        Breite: m.lat != null ? String(m.lat) : '', 'Länge': m.lng != null ? String(m.lng) : '' })),
      diary: (seed.diary || []).map((e, i) => ({ _row: i + 2, Datum: e.datum, Hafen: e.hafen || '', Titel: e.titel || '',
        Tagebuch: e.text || '', Tipps: e.tipps || '', Links: e.links || '', Art: e.art || '' })),
      times: (seed.times || []).map((t, i) => ({ _row: i + 2, Datum: t.datum, Hafen: t.hafen, Ankunft: t.ankunft || '', Abfahrt: t.abfahrt || '', Tender: t.tender || '' })),
      travel: (seed.travel || []).map((t, i) => ({ _row: i + 2, Datum: t.datum, Art: t.art, Von: t.von || '', Nach: t.nach || '', Anbieter: t.anbieter || '', Hinweis: t.hinweis || '' })),
      onboard: (seed.onboard || []).map((t, i) => ({ _row: i + 2, Datum: t.datum, Art: t.art, Name: t.name, Hinweis: t.hinweis || '' })),
    };
  }
  const [k, s] = await Promise.all([
    fetchCSV(process.env.GID_KREUZFAHRTEN || '1100', 'Kreuzfahrten'),
    fetchCSV(process.env.GID_STOPPS || '1200', 'Stopps'),
  ]);
  // Schiffsdaten sind optional: fehlt der Tab in der Veröffentlichung, läuft der Build ohne sie
  let ships = [];
  try {
    ships = table(await fetchCSV(process.env.GID_SCHIFFE || '1500', 'Schiffe'),
      ['Schiff', 'Indienststellung', 'BRZ', 'Länge (m)', 'Passagiere'], 'Schiffe', ['Hinweis', 'Werft', 'Klasse', 'Schwesterschiffe', 'Bild']);
  } catch (e) {
    warn(`Schiffsdaten nicht verfügbar (${e.message.split('.')[0]}) – Seite wird ohne sie gebaut.`);
  }
  // Ebenso optional: geplante, aber nicht angelaufene Häfen
  let missed = [];
  try {
    missed = table(await fetchCSV(process.env.GID_AUSGEFALLEN || '1600', 'Ausgefallen'), ['Datum', 'Hafen', 'Land', 'Grund'], 'Ausgefallen',
      ['Zeitpunkt', 'Status', 'Details', 'Quelle', 'Breite', 'Länge']);
  } catch (e) {
    warn(`Ausgefallene Häfen nicht verfügbar (${e.message.split('.')[0]}) – Seite wird ohne sie gebaut.`);
  }
  // Ebenso optional: Reisetagebuch (was wir in den Häfen gemacht haben)
  let diary = [];
  try {
    diary = table(await fetchCSV(process.env.GID_TAGEBUCH || '1700', 'Tagebuch'), ['Datum', 'Hafen', 'Titel', 'Tagebuch'], 'Tagebuch',
      ['Tipps', 'Links', 'Art']);
  } catch (e) {
    warn(`Reisetagebuch nicht verfügbar (${e.message.split('.')[0]}) – Seite wird ohne es gebaut.`);
  }
  // Ebenso optional: Liegezeiten, Anreise & Unterkünfte, Buchungen an Bord
  const optional = async (gid, tab, required, opt) => {
    try { return table(await fetchCSV(gid, tab), required, tab, opt); } catch (e) {
      warn(`Tab „${tab}“ nicht verfügbar (${e.message.split('.')[0]}) – Seite wird ohne ihn gebaut.`);
      return [];
    }
  };
  const times = await optional(process.env.GID_HAFENZEITEN || '1800', 'Hafenzeiten', ['Datum', 'Hafen'], ['Ankunft', 'Abfahrt', 'Tender']);
  const travel = await optional(process.env.GID_ANREISE || '1900', 'Anreise', ['Datum', 'Art'], ['Von', 'Nach', 'Anbieter', 'Hinweis']);
  const onboard = await optional(process.env.GID_ANBORD || '2000', 'An Bord', ['Datum', 'Art', 'Name'], ['Hinweis']);
  return {
    cruises: table(k, ['Start', 'Ende', 'Schiff', 'Reederei', 'Route', 'Fahrtgebiet', 'Bemerkung'], 'Kreuzfahrten', ['Mitreisende', 'Kabine']),
    stops: table(s, ['Datum', 'Hafen', 'Land', 'Art', 'Breite', 'Länge'], 'Stopps', ['Erstanlauf', 'Erstanlauf Quelle']),
    ships,
    missed,
    diary,
    times,
    travel,
    onboard,
  };
}

// ---------- Geocoding für neue Häfen ----------
async function geocode(port, country) {
  const q = [port.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim(), country].filter(Boolean).join(', ');
  cache.geo ||= {};
  if (cache.geo[q]) return cache.geo[q];
  const g = await geocodeOnline(q);
  if (g) cache.geo[q] = g;
  return g;
}
async function geocodeOnline(q) {
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&accept-language=de&q=${encodeURIComponent(q)}`;
  try {
    await new Promise((r) => setTimeout(r, 1100)); // Nutzungsrichtlinie: max. 1 Anfrage/Sekunde
    const res = await fetch(u, { headers: { 'User-Agent': 'weiffenbach.com-build/1.0 (GitHub Actions)' } });
    if (!res.ok) return null;
    const [hit] = await res.json();
    return hit ? { lat: +(+hit.lat).toFixed(3), lng: +(+hit.lon).toFixed(3), a2: (hit.address?.country_code || '').toUpperCase() } : null;
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
      route: r.Route || '', region: r.Fahrtgebiet || 'Sonstige', note: r.Bemerkung || '',
      companions: r.Mitreisende || '', cabin: r.Kabine || '' });
  }
  cruises.sort((a, b) => a.start.localeCompare(b.start));
  cruises.forEach((c, i) => { c.id = i; });

  const findCruise = (d) => {
    let hit = null;
    for (const c of cruises) if (c.start <= d && d <= c.end) hit = c; // bei Wechseltag zählt die neue Reise
    return hit;
  };
  // Reise eines Datums, auch für Vor- und Nachprogramm bis 10 Tage vor bzw. nach der Reise
  const NEAR = 10;
  const nearCruise = (d) => {
    const c = findCruise(d);
    if (c) return { c, phase: '' };
    const near = cruises.map((x) => (d < x.start ? { c: x, gap: days(d, x.start), phase: 'vor' } : { c: x, gap: days(x.end, d), phase: 'nach' }))
      .filter((n) => n.gap <= NEAR).sort((a, b) => a.gap - b.gap)[0];
    return near || { c: null, phase: '' };
  };

  const coordsByPort = new Map();
  const rawStops = [];
  for (const r of src.stops) {
    if (!r.Datum && !r.Hafen) continue;
    const d = parseDate(r.Datum);
    if (!d) { warn(`Stopps, Zeile ${r._row}: Datum ungültig – Zeile übersprungen.`); continue; }
    if (!r.Hafen) { warn(`Stopps, Zeile ${r._row}: Hafen fehlt – Zeile übersprungen.`); continue; }
    const lat = parseNum(r.Breite), lng = parseNum(r['Länge']);
    // Erstanlauf: das Schiff lief den Hafen auf dieser Reise zum ersten Mal an („ja“ oder „wahrscheinlich“)
    const first = /wahrsch|vermut/i.test(r.Erstanlauf || '') ? 'wahrscheinlich' : /^(ja|x|1|true)/i.test((r.Erstanlauf || '').trim()) ? 'ja' : '';
    const firstSrc = /^https?:\/\//i.test(r['Erstanlauf Quelle'] || '') ? r['Erstanlauf Quelle'] : '';
    const s = { d, port: r.Hafen, country: r.Land, art: r.Art, lat, lng, first, firstSrc, _row: r._row };
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
      cruise: c && art !== 'Landaufenthalt' ? c.id : null, ...(s.first && c ? { first: s.first, firstSrc: s.firstSrc } : {}) };
  });

  const ships = {};
  for (const r of src.ships) {
    if (!r.Schiff) continue;
    // Ganzzahlen kommen im deutschen Sheet mit Tausenderpunkt („42.289“)
    const int = (v) => { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
    ships[r.Schiff] = { built: int(r.Indienststellung), gt: int(r.BRZ), length: parseNum(r['Länge (m)']),
      pax: int(r.Passagiere), note: r.Hinweis || '', yard: r.Werft || '', cls: r.Klasse || '', sisters: r.Schwesterschiffe || '', imgSrc: r.Bild || '' };
  }
  for (const name of new Set(cruises.map((c) => c.ship))) {
    if (src.ships.length && !ships[name]) warn(`Schiffe: „${name}“ fehlt im Tab „Schiffe“ – bitte Zeile ergänzen.`);
  }

  // Ausgefallene Häfen: zählen nicht als besucht, werden aber der geplanten Reise zugeordnet
  const missed = [];
  for (const r of src.missed) {
    if (!r.Datum && !r.Hafen) continue;
    const d = parseDate(r.Datum);
    if (!d || !r.Hafen) { warn(`Ausgefallen, Zeile ${r._row}: Datum oder Hafen fehlt – Zeile übersprungen.`); continue; }
    const c = findCruise(d);
    if (!c) { warn(`Ausgefallen, Zeile ${r._row}: Datum liegt in keiner Reise – Zeile übersprungen.`); continue; }
    if (stops.some((s) => s.cruise === c.id && s.port === r.Hafen)) {
      warn(`Ausgefallen, Zeile ${r._row}: Der Hafen steht für dieselbe Reise auch in „Stopps“ – dort bitte entfernen, wenn er ausgefallen ist.`);
    }
    const country = r.Land || countryByPort.get(r.Hafen) || '';
    let lat = parseNum(r.Breite), lng = parseNum(r['Länge']);
    if (lat == null || lng == null) {
      if (!coordsByPort.has(r.Hafen)) coordsByPort.set(r.Hafen, await geocode(r.Hafen, country));
      ({ lat = null, lng = null } = coordsByPort.get(r.Hafen) || {});
    }
    const meta = countryTable[country];
    if (meta) countries[country] = { a2: meta.a2, n: meta.n, k: meta.k };
    else warn(`Ausgefallen, Zeile ${r._row}: Land „${country || '(leer)'}“ unbekannt.`);
    missed.push({ d, port: r.Hafen, country, reason: r.Grund || 'unbekannt', when: r.Zeitpunkt || '',
      sure: !/wahrscheinlich|unsicher|vermut/i.test(r.Status || ''), note: r.Details || '',
      src: /^https?:\/\//i.test(r.Quelle || '') ? r.Quelle : '', lat, lng, cruise: c.id });
  }
  missed.sort((a, b) => a.d.localeCompare(b.d));

  // Reisetagebuch: Einträge an Reisetagen gehören zur Reise, Vor- und Nachprogramm (bis 10 Tage davor/danach) ebenso
  const countryByA2 = new Map(Object.entries(countryTable).map(([name, m]) => [m.a2, name]));
  const knownPorts = new Set([...stops.map((s) => s.port), ...missed.map((x) => x.port)]);
  const placeInfo = new Map(); // Orte nur aus dem Tagebuch (z. B. Vorprogramm in Las Vegas)
  const diary = [];
  for (const r of src.diary) {
    if (!r.Datum && !r.Titel && !r.Tagebuch) continue;
    const d = parseDate(r.Datum);
    if (!d) { warn(`Tagebuch, Zeile ${r._row}: Datum ungültig – Zeile übersprungen.`); continue; }
    if (!r.Titel && !r.Tagebuch) { warn(`Tagebuch, Zeile ${r._row}: Titel und Text fehlen – Zeile übersprungen.`); continue; }
    const { c, phase } = nearCruise(d);
    // Hafenname wie in „Stopps“, damit das Hafen-Archiv die Besuche zusammenführt (z. B. „Yokohama (Tokio)“ → „Tokio“)
    let port = r.Hafen;
    const same = port && findStop(stops, d, port);
    if (same) port = same.port;
    else if (port && !knownPorts.has(port)) {
      if (!placeInfo.has(port)) {
        const g = await geocode(port, '');
        const country = g && countryByA2.get(g.a2);
        placeInfo.set(port, g ? { lat: g.lat, lng: g.lng, country: country || '' } : null);
        if (country) countries[country] = { a2: countryTable[country].a2, n: countryTable[country].n, k: countryTable[country].k };
        if (!g) console.log(`ℹ Tagebuch, Zeile ${r._row}: Ort nicht in „Stopps“ und nicht automatisch gefunden.`);
      }
    }
    const info = placeInfo.get(port);
    const links = (r.Links || '').split(/\s+/).filter((u) => /^https?:\/\/\S+$/i.test(u));
    diary.push({ d, port, place: port !== r.Hafen ? r.Hafen : '', title: r.Titel || '', text: r.Tagebuch || '', tips: r.Tipps || '',
      links, art: r.Art || '', cruise: c ? c.id : null, phase,
      ...(info ? { country: info.country, lat: info.lat, lng: info.lng } : {}) });
  }
  diary.sort((a, b) => a.d.localeCompare(b.d));

  // Liegezeiten und Tender am jeweiligen Hafentag
  let timed = 0;
  for (const r of src.times) {
    if (!r.Datum && !r.Hafen) continue;
    const d = parseDate(r.Datum);
    const s = d && r.Hafen && findStop(stops, d, r.Hafen);
    if (!s) { warn(`Hafenzeiten, Zeile ${r._row}: kein passender Stopp am selben Tag – Zeile übersprungen.`); continue; }
    const arr = clock(r.Ankunft), dep = clock(r.Abfahrt);
    if (arr) s.arr = arr;
    if (dep) s.dep = dep;
    if (yes(r.Tender)) s.tender = true;
    timed++;
  }

  // Anreise & Unterkünfte (Flug, Zug, Hotel …) und Buchungen an Bord (Restaurants, Shows …)
  const travel = [];
  for (const r of src.travel) {
    if (!r.Datum && !r.Art) continue;
    const d = parseDate(r.Datum);
    if (!d || !r.Art) { warn(`Anreise, Zeile ${r._row}: Datum oder Art fehlt – Zeile übersprungen.`); continue; }
    const { c } = nearCruise(d);
    const item = { d, kind: r.Art, from: r.Von || '', to: r.Nach || '', by: r.Anbieter || '', note: r.Hinweis || '', cruise: c ? c.id : null };
    if (/flug/i.test(r.Art) && item.from && item.to) {
      const a = await geocode(item.from, ''), b = await geocode(item.to, '');
      if (a && b) item.km = Math.round(km(a, b));
    }
    travel.push(item);
  }
  travel.sort((a, b) => a.d.localeCompare(b.d));
  const onboard = [];
  for (const r of src.onboard) {
    if (!r.Datum && !r.Name) continue;
    const d = parseDate(r.Datum);
    const c = d && findCruise(d);
    if (!c || !r.Name) { warn(`An Bord, Zeile ${r._row}: Datum liegt in keiner Reise oder Name fehlt – Zeile übersprungen.`); continue; }
    onboard.push({ d, kind: r.Art || '', name: r.Name, note: r.Hinweis || '', cruise: c.id });
  }
  onboard.sort((a, b) => a.d.localeCompare(b.d));

  // Wetter und Zeitzone der vergangenen Hafentage
  const wx = await addWeather(stops, cache);
  console.log(`ℹ Wetter: ${wx.fetched} Tage neu abgefragt${wx.failed ? `, ${wx.failed} nicht verfügbar` : ''}.`);

  // Länder-Kurzinfos (Währung, Sprache, Steckdose)
  const info = JSON.parse(await readFile(path.join(here, 'countryinfo.json'), 'utf8'));
  for (const c of Object.values(countries)) if (info[c.a2]) Object.assign(c, info[c.a2]);

  console.log(`ℹ ${timed} Hafenzeiten, ${travel.length} Anreise-Einträge, ${onboard.length} Buchungen an Bord.`);
  return { generated: new Date().toISOString(), cruises, stops, missed, diary, travel, onboard, countries, ships, warnings: warnings.length };
}

// ---------- Verschlüsselung ----------
const b64 = (buf) => Buffer.from(buf).toString('base64');
async function deriveKey(password) {
  const enc = new TextEncoder();
  // Gleiche Normalisierung wie site/assets/js/crypto.js (z. B. Zeilenumbruch aus dem Secret entfernen)
  const base = await crypto.subtle.importKey('raw', enc.encode(password.trim().normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(KDF.salt), iterations: KDF.iterations },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function encrypt(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations: KDF.iterations, iv: b64(iv), ct: b64(ct) };
}

const password = process.env.SITE_PASSWORD;
if (!password) throw new Error('SITE_PASSWORD ist nicht gesetzt.');
if (password.trim().length < 10) warn('SITE_PASSWORD ist kürzer als 10 Zeichen – ein längeres Passwort schützt deutlich besser.');
const key = await deriveKey(password);
// Der Cache enthält Orte und Daten der Reisen und liegt daher ebenfalls verschlüsselt vor
cache = await loadCache(CACHE_DIR, key);
const data = await build();
// Kennung des Schlüssels für Foto-Dateinamen und Cache (verrät nichts über das Passwort)
const keyId = createHash('sha256').update(Buffer.from(await crypto.subtle.exportKey('raw', key))).digest('hex').slice(0, 16);

// Schiffsbilder (Wikipedia), verschlüsselt wie die Fotos
{
  const si = await addShipImages(data.ships, cache, { key, keyId, outDir: OUT, encryptBytes, offline: !!FROM_JSON });
  console.log(`ℹ Schiffsbilder: ${si.fetched} neu geladen, ${si.missing} ohne Bild.`);
}
await saveCache(CACHE_DIR, cache, key);

const photoArgs = { key, keyId, cruises: data.cruises, stops: data.stops, outDir: OUT, warn };
data.photos = PHOTOS_DIR
  ? await collectLocalPhotos({ ...photoArgs, dir: PHOTOS_DIR })
  : await collectPhotos({ ...photoArgs, cacheDir: CACHE_DIR });

await mkdir(path.join(OUT, 'data'), { recursive: true });
await writeFile(path.join(OUT, 'data', 'data.enc.json'), JSON.stringify(await encrypt(data, key)));
if (PLAIN) await writeFile(path.join(OUT, 'data', 'data.json'), JSON.stringify(data, null, 1));

console.log(`✓ ${data.cruises.length} Reisen, ${data.stops.length} Stopps, ${data.missed.length} ausgefallene Häfen, ${data.diary.length} Tagebucheinträge, ${data.photos.length} Fotos verschlüsselt geschrieben (${warnings.length} Hinweise).`);
