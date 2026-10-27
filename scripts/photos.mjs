// Holt Lieblingsfotos aus einem Google-Drive-Ordner, ordnet sie über das Aufnahmedatum den Reisen und
// Stopps zu und legt sie verkleinert und verschlüsselt unter <out>/photos/ ab.
//
// Umgebungsvariablen (beide nötig, sonst wird ohne Fotos gebaut):
//   GDRIVE_SERVICE_ACCOUNT  JSON-Schlüssel eines Google-Dienstkontos (Ordner ist für dessen E-Mail freigegeben)
//   PHOTO_FOLDER_ID         ID des Drive-Ordners „Schiffsurlaube Fotos“

import { createSign, createHash, webcrypto as crypto } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, access, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const SIZES = { t: 480, l: 1600 }; // Vorschau und Großansicht (längste Seite in Pixeln)
const IMAGE_TYPES = /^image\/(jpeg|png|webp|heic|heif)$/;

async function driveToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud, iat: now, exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`;
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Anmeldung des Dienstkontos fehlgeschlagen (HTTP ${res.status})`);
  return (await res.json()).access_token;
}

async function listImages(token, folderId) {
  const out = [];
  const queue = [folderId];
  while (queue.length) {
    const parent = queue.shift();
    let pageToken = '';
    do {
      const u = new URL('https://www.googleapis.com/drive/v3/files');
      u.searchParams.set('q', `'${parent}' in parents and trashed = false`);
      u.searchParams.set('fields', 'nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, thumbnailLink, imageMediaMetadata(time))');
      u.searchParams.set('pageSize', '1000');
      u.searchParams.set('supportsAllDrives', 'true');
      u.searchParams.set('includeItemsFromAllDrives', 'true');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Drive-Ordner nicht lesbar (HTTP ${res.status}) – ist er für das Dienstkonto freigegeben?`);
      const page = await res.json();
      for (const f of page.files) {
        if (f.mimeType === 'application/vnd.google-apps.folder') queue.push(f.id);
        else if (IMAGE_TYPES.test(f.mimeType)) out.push(f);
      }
      pageToken = page.nextPageToken || '';
    } while (pageToken);
  }
  return out;
}

// Aufnahmedatum aus den EXIF-Daten, ersatzweise aus dem Dateinamen (z. B. IMG_20250324_101500.jpg)
function takenAt(f) {
  const exif = f.imageMediaMetadata?.time?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/);
  if (exif) return { d: `${exif[1]}-${exif[2]}-${exif[3]}`, t: `${exif[4]}:${exif[5]}` };
  const name = f.name.match(/(20\d{2})-?(\d{2})-?(\d{2})[_ -]?(\d{2})?(\d{2})?/);
  if (name) return { d: `${name[1]}-${name[2]}-${name[3]}`, t: name[4] ? `${name[4]}:${name[5] || '00'}` : '' };
  return null;
}

async function download(f, size, token) {
  // Drive liefert über thumbnailLink fertig verkleinerte JPEGs, auch für HEIC-Fotos vom iPhone
  if (f.thumbnailLink) {
    const res = await fetch(f.thumbnailLink.replace(/=s\d+$/, `=s${size}`), { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  }
  if (!/^image\/(jpeg|png|webp)$/.test(f.mimeType)) return null;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
}

async function encryptBytes(bytes, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return Buffer.concat([Buffer.from(iv), Buffer.from(ct)]);
}

const exists = (p) => access(p).then(() => true, () => false);

/**
 * @returns {Promise<Array<{t: string, l: string, d: string, time: string, cruise: number|null, port: string|null}>>}
 */
export async function collectPhotos({ key, keyId, cruises, stops, outDir, cacheDir, warn }) {
  const saJson = process.env.GDRIVE_SERVICE_ACCOUNT, folderId = process.env.PHOTO_FOLDER_ID;
  if (!saJson || !folderId) {
    console.log('ℹ Keine Fotos: GDRIVE_SERVICE_ACCOUNT oder PHOTO_FOLDER_ID ist nicht gesetzt.');
    return [];
  }
  let token, files;
  try {
    token = await driveToken(JSON.parse(saJson));
    files = await listImages(token, folderId.trim());
  } catch (e) {
    warn(`Fotos übersprungen: ${e.message}`);
    return [];
  }

  await mkdir(path.join(outDir, 'photos'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const photos = [];
  let undated = 0, unmatched = 0, failed = 0, cached = 0;
  const used = new Set();
  const skipped = [];
  for (const f of files) {
    const when = takenAt(f);
    if (!when) { undated++; skipped.push({ id: f.id, name: f.name, why: 'ohne Datum' }); continue; }
    const cruise = cruises.filter((c) => c.start <= when.d && when.d <= c.end).at(-1) || null;
    const sameDay = stops.filter((s) => s.d === when.d);
    const stop = sameDay.find((s) => s.type !== 'Landaufenthalt') || sameDay[0];
    if (!cruise && !stop) { unmatched++; skipped.push({ id: f.id, name: f.name, why: 'keine Reise', d: when.d }); continue; }

    const names = {};
    for (const [variant, size] of Object.entries(SIZES)) {
      // Name hängt vom Schlüssel ab: Neues Passwort ⇒ neue Dateien, der Cache wird automatisch neu befüllt
      const name = createHash('sha256').update(`${keyId}:${f.id}:${f.md5Checksum || f.modifiedTime}:${variant}`).digest('hex').slice(0, 32);
      const target = path.join(outDir, 'photos', `${name}.bin`), cachePath = path.join(cacheDir, `${name}.bin`);
      used.add(`${name}.bin`);
      if (await exists(cachePath)) { await copyFile(cachePath, target); cached++; names[variant] = name; continue; }
      const bytes = await download(f, size, token);
      if (!bytes) continue;
      const enc = await encryptBytes(bytes, key);
      await writeFile(target, enc);
      await writeFile(cachePath, enc);
      names[variant] = name;
    }
    if (!names.t || !names.l) { failed++; continue; }
    photos.push({ t: names.t, l: names.l, d: when.d, time: when.t, cruise: cruise ? cruise.id : null, port: stop ? stop.port : null });
  }
  photos.sort((a, b) => (a.d + a.time).localeCompare(b.d + b.time));
  // Cache klein halten: gelöschte Fotos und alte Passwörter entfernen
  for (const f of await readdir(cacheDir)) if (!used.has(f)) await unlink(path.join(cacheDir, f));
  if (process.env.PHOTO_REPORT) await writeFile(process.env.PHOTO_REPORT, JSON.stringify(skipped));
  console.log(`✓ ${photos.length} Fotos (${cached} Dateien aus dem Cache).`);
  if (undated) warn(`${undated} Fotos ohne Aufnahmedatum übersprungen.`);
  if (unmatched) warn(`${unmatched} Fotos passen zu keiner Reise und keinem Landaufenthalt.`);
  if (failed) warn(`${failed} Fotos konnten nicht geladen werden.`);
  return photos;
}

// Für lokale Tests: Fotos aus einem Ordner mit manifest.json [{file, d, time}]
export async function collectLocalPhotos({ dir, key, keyId, cruises, stops, outDir }) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  await mkdir(path.join(outDir, 'photos'), { recursive: true });
  const photos = [];
  for (const m of manifest) {
    const bytes = await readFile(path.join(dir, m.file));
    const cruise = cruises.filter((c) => c.start <= m.d && m.d <= c.end).at(-1) || null;
    const stop = stops.find((s) => s.d === m.d && s.type !== 'Landaufenthalt') || stops.find((s) => s.d === m.d);
    const names = {};
    for (const variant of Object.keys(SIZES)) {
      names[variant] = createHash('sha256').update(`${keyId}:${m.file}:${variant}`).digest('hex').slice(0, 32);
      await writeFile(path.join(outDir, 'photos', `${names[variant]}.bin`), await encryptBytes(bytes, key));
    }
    photos.push({ t: names.t, l: names.l, d: m.d, time: m.time || '', cruise: cruise ? cruise.id : null, port: stop ? stop.port : null });
  }
  return photos;
}
