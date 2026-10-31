// Anreicherung beim Build: Wetter am Hafentag und Zeitzone des Hafens (Open-Meteo, historisches Archiv).
// Ergebnisse landen in einem Cache, damit jeder Tag nur einmal abgefragt wird.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { webcrypto as crypto } from 'node:crypto';

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
