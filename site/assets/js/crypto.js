// Entschlüsselt data/data.enc.json im Browser. Parameter müssen zu scripts/build-data.mjs passen.
const SALT = 'weiffenbach.com/schiffsurlaube/v1';
const STORE = 'wb-key';
const enc = new TextEncoder();

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

// Gleiche Normalisierung wie im Build: Leerzeichen am Rand ignorieren, Unicode einheitlich (NFC)
export const normalizePassword = (pw) => pw.trim().normalize('NFC');

export async function deriveKey(password, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizePassword(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
}

export async function decrypt(blob, key) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function rememberKey(key, persistent) {
  const raw = toB64(await crypto.subtle.exportKey('raw', key));
  try {
    (persistent ? localStorage : sessionStorage).setItem(STORE, raw);
  } catch { /* Speicher gesperrt – dann eben ohne Merken */ }
}

export async function storedKey() {
  let raw = null;
  try { raw = sessionStorage.getItem(STORE) || localStorage.getItem(STORE); } catch { return null; }
  if (!raw) return null;
  return crypto.subtle.importKey('raw', fromB64(raw), { name: 'AES-GCM' }, true, ['decrypt']);
}

export function forgetKey() {
  try { sessionStorage.removeItem(STORE); localStorage.removeItem(STORE); } catch { /* egal */ }
}
