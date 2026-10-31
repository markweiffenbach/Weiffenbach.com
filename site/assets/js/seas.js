// Grobe Zuordnung von Positionen zu Meeren und Ozeanen über Rechtecke (Breite/Länge).
// Reihenfolge zählt: spezielle Nebenmeere zuerst, danach die Ozeane als Rückfall.
import { greatCircle } from './map.js';

// [Name, Breite von, Breite bis, Länge von, Länge bis]
const BOXES = [
  ['Skagerrak & Kattegat', 56, 60, 7, 12.5],
  ['Ostsee', 53.9, 60.5, 9.5, 30.5],
  ['Ostsee', 60.5, 66, 17, 26],
  ['Irische See', 52, 55, -6.3, -2.8],
  ['Ärmelkanal', 48.3, 51.1, -6, 2],
  ['Nordsee', 51, 61, -4.5, 10.2],
  ['Europäisches Nordmeer', 61, 72, -10, 20],
  ['Barentssee', 69, 80, 20, 60],
  ['Grönlandsee', 72, 82, -20, 20],
  ['Golf von Biskaya', 43.2, 48.3, -10, 0],
  ['Ligurisches Meer', 42.9, 44.6, 7, 10.6],
  ['Adria', 42, 46, 12.2, 19.5],
  ['Adria', 40.3, 42, 15.5, 19.8],
  ['Ionisches Meer', 36, 38, 15.05, 22.5],
  ['Ionisches Meer', 38, 40.3, 15.6, 22.5],
  ['Tyrrhenisches Meer', 38, 42.9, 8.8, 16],
  ['Marmarameer', 40.2, 41.2, 26.5, 30],
  ['Schwarzes Meer', 40.9, 47, 27.4, 42],
  ['Ägäis', 35, 41, 22.5, 28.3],
  ['Levantinisches Meer', 30, 37, 28.3, 36.5],
  ['Mittelmeer', 30, 46.5, -5.6, 36.5],
  ['Rotes Meer', 12.5, 30, 32, 43.5],
  ['Golf von Aden', 10.5, 15, 43, 51.5],
  ['Persischer Golf', 23, 30.5, 47.5, 56.5],
  ['Golf von Oman', 22, 26.5, 56.5, 61],
  ['Arabisches Meer', 5, 25, 51.5, 77],
  ['Golf von Bengalen', 5, 23, 80, 95],
  ['Straße von Malakka', 1, 6, 98, 104],
  ['Andamanensee', 5, 16, 95, 99.5],
  ['Golf von Thailand', 6, 14, 99, 105],
  ['Südchinesisches Meer', 0, 23, 104, 121],
  ['Javasee', -8, -2.5, 105.5, 119],
  ['Gelbes Meer', 32, 41, 117, 127],
  ['Ostchinesisches Meer', 24, 32, 117, 131],
  ['Ostchinesisches Meer', 32, 33.5, 117, 129.5],
  ['Seto-Binnenmeer', 33.5, 34.8, 130.9, 135.4],
  ['Nordpazifik', 30, 35.7, 135.4, 142],
  ['Nordpazifik', 35.7, 41, 140.9, 146],
  ['Japanisches Meer', 33.5, 52, 127.5, 142],
  ['Korallenmeer', -30, -9, 142, 165],
  ['Tasmansee', -48, -30, 147, 173],
  ['Golf von Mexiko', 21.5, 31, -98, -81.5],
  ['Karibik', 9, 15, -83.8, -59.4],
  ['Karibik', 15, 22, -89, -59.4],
  ['Sankt-Lorenz-Golf', 45.5, 52, -74, -58],
  ['Golf von Alaska', 54, 61, -155, -130],
  ['Beagle-Kanal', -55.2, -54.6, -70, -66],
  ['Drakestraße', -62, -55.5, -70, -56],
];

const norm = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;

/** Meer bzw. Ozean einer Position (grob). */
export function seaAt(lat, lng) {
  const x = norm(lng);
  for (const [name, a, b, c, d] of BOXES) if (lat >= a && lat <= b && x >= c && x <= d) return name;
  if (lat < -60) return 'Südpolarmeer';
  if (lat > 66) return 'Nordpolarmeer';
  if (lat >= 0) {
    const pacific = x < -100 || x > 100 || (lat < 9 && x < -77.5) || (lat < 32 && x < -83.8);
    if (pacific) return 'Nordpazifik';
    if (x >= 20 && lat < 30) return 'Indischer Ozean';
    return 'Nordatlantik';
  }
  if (x >= -68 && x < 20) return 'Südatlantik';
  if (x >= 20 && x < 147 && !(lat > -10 && x > 100)) return 'Indischer Ozean';
  return 'Südpazifik';
}

/** Befahrene Meere einer Reise in der Reihenfolge der ersten Durchfahrt. */
export function seasOf(legs) {
  const pts = [];
  for (let i = 0; i < legs.length; i++) {
    if (!i) { pts.push([legs[0].lat, legs[0].lng]); continue; }
    pts.push(...greatCircle([legs[i - 1].lat, legs[i - 1].lng], [legs[i].lat, legs[i].lng]).slice(1));
  }
  return [...new Set(pts.map(([la, lo]) => seaAt(la, lo)))];
}
