# weiffenbach.com

Homepage mit passwortgeschütztem Dashboard „Schiffsurlaube“. Die Daten kommen aus dem Google Sheet
**Schiffsurlaube**, die Seite läuft kostenlos auf GitHub Pages.

- **Ohne Passwort** sehen Besucher nur eine neutrale Startseite.
- **Mit Passwort** öffnet sich das Dashboard: Weltkarte mit Routen und Häfen, Kennzahlen, Diagramme,
  Länder-Sammlung, Rekorde (auch Tender, Liegezeiten und Nächte im Hafen), ausgefallene Häfen, Logbuch aller Reisen
  und „Heute vor X Jahren“ (welche Reise an diesem Kalendertag lief, sonst der nächste solche Tag im kommenden Monat).
  Kacheln, Rekorde, Diagrammbalken und Länder-Flaggen sind anklickbar und führen zur passenden Reise, zum Hafen, zum
  Schiff, ins Hafen-Archiv oder setzen den Filter (z. B. Jahr, Reederei, Fahrtgebiet).
- Die Reisedaten liegen **nur verschlüsselt** auf dem Server (AES-256-GCM, Schlüssel per PBKDF2 aus dem Passwort abgeleitet).
  Ohne Passwort lassen sie sich nicht lesen, auch nicht im Quelltext.

## So funktioniert's

```
Google Sheet ──(täglich / auf Knopfdruck)──► GitHub Action ──► verschlüsselte Daten ──► www.weiffenbach.com
 Kreuzfahrten, Stopps, …                      scripts/build-data.mjs                        site/
```

Neue Reise eintragen: im Sheet eine Zeile in **Kreuzfahrten** und die Hafentage in **Stopps** ergänzen.
Alles andere (Nächte, Seetage, Zuordnung der Häfen, Erstbesuche, Äquator- und Datumsgrenzen-Überquerungen,
Auswertung, Koordinaten neuer Häfen) passiert automatisch. Für ein neues Schiff im Tab **Schiffe** eine Zeile
mit Baujahr, BRZ, Länge und Passagieren ergänzen.

Ist ein geplanter Hafen ausgefallen (z. B. wegen Sturm), gehört er **nicht** in **Stopps**, sondern in den Tab
**Ausgefallen**: Datum laut Fahrplan, Hafen, Land, Grund (Auswahlliste) und optional Zeitpunkt, Status („bestätigt“ oder
„wahrscheinlich“), Details und Quelle (Link). Die Homepage zeigt diese Häfen in einer eigenen Statistik, im Reiseverlauf
durchgestrichen und auf der Karte gestrichelt. Steht ein Hafen versehentlich in beiden Tabs, meldet der Build das.
In der optionalen Spalte „Ersatz“ steht der Hafen, der stattdessen angelaufen wurde (wie in „Stopps“ geschrieben); ohne
Eintrag nimmt der Build einen anderen Hafen derselben Reise am selben Tag.

Lief das Schiff einen Hafen auf unserer Reise zum ersten Mal an (Erstanlauf), steht in **Stopps** in der Spalte
„Erstanlauf“ ein „ja“ (oder „wahrscheinlich“, wenn nicht eindeutig belegt) und in „Erstanlauf Quelle“ optional ein Link.
Die Homepage kennzeichnet diese Häfen im Reiseverlauf, im Logbuch, im Hafen-Archiv, auf der Karte und in den Fakten.

Was wir in einem Hafen gemacht haben, steht im Tab **Tagebuch**: Datum, Hafen, Titel, Text und optional Tipps, Links
(mehrere durch Leerzeichen getrennt) und Art (Auswahlliste). Die Spalte „Reise“ füllt sich von selbst. Die Einträge
erscheinen in der Reise-Detailansicht beim jeweiligen Tag neben den Fotos; Vor- und Nachprogramm an Land (bis zu
10 Tage vor bzw. nach der Reise) unter „Vorher an Land“ bzw. „Danach an Land“. Zusätzlich gibt es das
**Hafen-Archiv** (Knopf oben rechts oder `…/#hafen`): alle Häfen mit unseren Besuchen, Aktivitäten, Tipps, eigenen Links
sowie Links zu Wikipedia, Wikivoyage, Google Maps und Ausflugsangeboten. Buchungs- oder Ticketnummern gehören nicht
ins Tagebuch.
Weitere optionale Tabs reichern die Reisen an:

- **Hafenzeiten**: Datum, Hafen, Ankunft, Abfahrt (Ortszeit) und Tender („ja“, wenn ausgebootet wurde). Erscheint als
  Liegezeit am Hafentag, im Reiseverlauf und im Hafen-Archiv.
- **Anreise**: Datum, Art (Flug, Zug, Auto, Transfer, Hotel …), Von, Nach, Anbieter (Airline, Hotelname) und Hinweis.
  Bei Hotels steht der Ort unter „Von“. Für Flüge berechnet der Build die Flugkilometer.
- **An Bord**: Datum, Art (Restaurant, Show, Spa …), Name und Hinweis, z. B. gebuchte Restaurants und Shows.

Dazu kommen in **Kreuzfahrten** die Spalten „Mitreisende“ und „Kabine“ sowie in **Schiffe** „Werft“, „Klasse“,
„Schwesterschiffe“ und „Bild“.

Die **Schiffsübersicht** (Knopf „Schiffe“ oder `…/#schiffe`) zeigt jedes Schiff mit Foto, Steckbrief, unseren Reisen,
Nächten, Häfen und Seemeilen darauf. Das Foto holt der Build aus Wikipedia (Artikel mit dem Schiffsnamen) und legt es
verschlüsselt ab. Passt das Bild nicht, trägt man in „Bild“ den Artikel ein, z. B. `de:Mein Schiff 1 (Schiff, 2018)`
oder `en:Royal Princess (2013)`. Ein bestimmtes Foto aus Wikimedia Commons (etwa aus der Zeit vor einem
Reedereiwechsel) wählt man mit `File:<Dateiname>`, z. B. `File:AIDAaura.jpg`. Preise, Buchungs- und Ticketnummern gehören in keinen dieser Tabs.

Automatisch ergänzt der Build für vergangene Hafentage das Wetter (Höchst-/Tiefstwert, Regen, Wind) und die Zeitzone
aus dem historischen Archiv von [Open-Meteo](https://open-meteo.com). Daraus entstehen Fakten wie der wärmste und der
kälteste Landgang und die Zeitumstellungen je Reise. Die befahrenen Meere ermittelt die Seite grob aus der Route.
Im Hafen-Archiv stehen zu jedem Land Währung, Sprache, Steckdosentyp und Zeitzone (aus `scripts/countryinfo.json`).
Wetter und Koordinaten landen verschlüsselt im Build-Cache, damit jeder Tag nur einmal abgefragt wird.

Die Homepage übernimmt die Änderungen jede Nacht. Sofort geht es über GitHub → **Actions** →
„Homepage aktualisieren“ → **Run workflow** (oder über das optionale Menü im Sheet, siehe unten).

## Einmalige Einrichtung

### 1. Sheet veröffentlichen (nur die Daten-Tabs)

Im Sheet: **Datei → Freigeben → Im Web veröffentlichen**
1. Unter „Veröffentlichte Inhalte und Einstellungen“ statt „Gesamtes Dokument“ nur **Kreuzfahrten**, **Stopps**, **Schiffe**,
   **Ausgefallen**, **Tagebuch**, **Hafenzeiten**, **Anreise** und **An Bord** auswählen (alle außer „Kreuzfahrten“ und
   „Stopps“ sind optional: ohne sie fehlen nur die jeweiligen Angaben auf der Homepage).
2. Format: **Kommagetrennte Werte (.csv)** → **Veröffentlichen**.
3. Den angezeigten Link kopieren (beginnt mit `https://docs.google.com/spreadsheets/d/e/2PACX-…`).

Hinweis: Wer genau diesen langen Link kennt, kann diese Tabs lesen. Er ist nicht zu erraten und steht nur
als Secret bei GitHub, also genauso privat wie bisher der Link zur Google-Maps-Karte.

### 2. Secrets bei GitHub hinterlegen

Repository → **Settings → Secrets and variables → Actions → New repository secret**

| Name | Inhalt |
|---|---|
| `SHEET_PUBLISH_URL` | der Link aus Schritt 1 |
| `SITE_PASSWORD` | das Passwort für den privaten Bereich (gern lang, z. B. ein kurzer Satz) |

Passwort ändern = Secret ändern und den Workflow einmal laufen lassen. Wer „angemeldet bleiben“ gewählt hatte,
muss danach das neue Passwort eingeben.

### 3. GitHub Pages einschalten

Repository → **Settings → Pages**
- **Source:** GitHub Actions
- **Custom domain:** `www.weiffenbach.com` → Save, danach **Enforce HTTPS** anhaken (sobald verfügbar)

### 4. Domain auf GitHub zeigen lassen

Beim Domain-Anbieter von weiffenbach.com (DNS-Einstellungen):

| Typ | Name | Wert |
|---|---|---|
| CNAME | `www` | `markweiffenbach.github.io` |
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |

Die A-Einträge sorgen dafür, dass auch `weiffenbach.com` ohne „www“ funktioniert. Bisherige A/CNAME-Einträge für
`@` und `www` vorher entfernen. Die Umstellung kann bis zu 24 Stunden dauern.

### 5. Starten

Nach dem Merge auf `main` läuft der Workflow automatisch. Danach täglich um 04:17 UTC.

## Fotos in der Reise-Detailansicht

Ein Klick auf eine Reise im Logbuch öffnet die Detailansicht mit dem Verlauf Tag für Tag. Fotos erscheinen dort
automatisch beim passenden Hafentag: Zugeordnet wird über das **Aufnahmedatum** (EXIF), ersatzweise über ein Datum im
Dateinamen (z. B. `IMG_20250324_101500.jpg`). Die Bilder werden beim Bauen verkleinert und mit dem Passwort
verschlüsselt; ohne Passwort sind sie nicht zu sehen.

**Fotos hinzufügen:** Lieblingsfotos in den Drive-Ordner **„Schiffsurlaube Fotos“** legen (neben dem Sheet).
Unterordner sind erlaubt, z. B. einer pro Reise – die Ordnerstruktur spielt für die Zuordnung keine Rolle.
Aus Google Fotos: Fotos auswählen → Herunterladen → im Drive-Ordner hochladen (am Handy: Teilen → „In Drive speichern“).
Fotos löschen = Datei aus dem Ordner entfernen.

**Einmalige Einrichtung (ca. 10 Minuten)** – GitHub braucht einen eigenen, nur lesenden Zugang zu diesem einen Ordner:

1. [console.cloud.google.com](https://console.cloud.google.com) → oben „Projekt auswählen“ → **Neues Projekt** (z. B. `weiffenbach-fotos`).
2. **APIs & Dienste → Bibliothek** → „Google Drive API“ → **Aktivieren**.
3. **IAM & Verwaltung → Dienstkonten → Dienstkonto erstellen** (Name z. B. `homepage-fotos`, keine Rollen nötig).
4. Das Dienstkonto öffnen → **Schlüssel → Schlüssel hinzufügen → Neuen Schlüssel erstellen → JSON**. Eine Datei wird heruntergeladen.
5. In Google Drive den Ordner „Schiffsurlaube Fotos“ → **Teilen** → die E-Mail-Adresse des Dienstkontos
   (endet auf `…iam.gserviceaccount.com`) als **Betrachter** hinzufügen.
6. GitHub → Settings → Secrets and variables → Actions → zwei neue Secrets:
   - `GDRIVE_SERVICE_ACCOUNT`: der **komplette Inhalt** der JSON-Datei aus Schritt 4
   - `PHOTO_FOLDER_ID`: die ID des Ordners (der Teil der Ordner-Adresse nach `/folders/`)
7. Die JSON-Datei danach auf dem Computer löschen.

Ohne diese Secrets läuft alles wie bisher, nur ohne Fotos. Bereits verarbeitete Fotos werden zwischengespeichert,
damit die nächtlichen Läufe schnell bleiben.

## Optional: Menü „Homepage“ im Sheet (Aktualisieren und Sicherung)

Siehe Anleitung oben in [`tools/apps-script.gs`](tools/apps-script.gs): Code in **Erweiterungen → Apps Script**
einfügen. Das Menü bietet
- **Jetzt aktualisieren**: baut die Homepage sofort neu (braucht einen GitHub-Token als Skripteigenschaft),
- **Sicherung jetzt anlegen** und **Wöchentliche Sicherung einrichten**: legt eine Kopie des Sheets im Drive-Ordner
  „Schiffsurlaube – Sicherungen“ ab, auf Wunsch jeden Sonntag automatisch; die letzten 26 Kopien bleiben erhalten.

## Struktur

| Pfad | Inhalt |
|---|---|
| `site/` | die Homepage (HTML, CSS, JavaScript, Karte) |
| `site/assets/vendor/` | Leaflet 1.9.4 und topojson-client 3.1.0 (lokal, kein fremdes CDN) |
| `site/assets/geo/` | Ländergrenzen aus Natural Earth (world-atlas 2.0.2) |
| `scripts/build-data.mjs` | liest das Sheet, prüft die Daten, ergänzt Koordinaten, verschlüsselt |
| `scripts/photos.mjs` | holt Fotos aus Google Drive, ordnet sie den Stopps zu, verschlüsselt sie |
| `scripts/enrich.mjs` | Wetter und Zeitzone der Hafentage (Open-Meteo), Schiffsbilder (Wikipedia), verschlüsselter Build-Cache |
| `scripts/countries.de.json` | deutsche Ländernamen → ISO-Code und Kontinent |
| `scripts/countryinfo.json` | Währung, Sprache und Steckdosentyp je Land (ISO-Code) |
| `site/assets/js/seas.js` | grobe Zuordnung der Route zu Meeren und Ozeanen |
| `site/assets/js/ships.js` | Schiffsübersicht |
| `.github/workflows/deploy.yml` | Build und Veröffentlichung |

## Lokal testen

```bash
SHEET_PUBLISH_URL='…' SITE_PASSWORD='test' node scripts/build-data.mjs --out _site
cp -r site/* _site/ && cd _site && python3 -m http.server 8000
# → http://localhost:8000
```

Das Build-Skript schreibt nur Zeilennummern in die Logs, keine Reisedaten (die Logs öffentlicher Repos sind einsehbar).
