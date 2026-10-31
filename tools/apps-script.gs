/**
 * Optional: Menü „Homepage“ im Google Sheet
 *  – „Jetzt aktualisieren“ baut die Homepage sofort neu (braucht einen GitHub-Token, siehe unten).
 *  – „Sicherung jetzt anlegen“ legt eine Kopie des Sheets im Ordner „Schiffsurlaube – Sicherungen“ ab.
 *  – „Wöchentliche Sicherung einrichten“ macht das jeden Sonntag automatisch (die ältesten Kopien
 *    über 26 wandern in den Papierkorb). Die Sicherung braucht keinen Token.
 *
 * Einrichtung (einmalig):
 *  1. Im Sheet: Erweiterungen → Apps Script, den vorhandenen Code durch diesen ersetzen, speichern.
 *  2. Sheet neu laden – oben erscheint das Menü „Homepage“.
 *  3. Homepage → „Wöchentliche Sicherung einrichten“ wählen und den Zugriff einmal erlauben.
 *  Nur für „Jetzt aktualisieren“ zusätzlich:
 *  4. Auf GitHub einen Fine-grained Token anlegen (Settings → Developer settings →
 *     Personal access tokens → Fine-grained): nur Repository „Weiffenbach.com“,
 *     Berechtigung „Contents: Read and write“.
 *  5. In Apps Script: Projekteinstellungen → Skripteigenschaften →
 *     Eigenschaft GITHUB_TOKEN mit dem Token anlegen.
 */
const REPO = 'markweiffenbach/Weiffenbach.com';
const BACKUP_FOLDER = 'Schiffsurlaube – Sicherungen';
const BACKUP_PREFIX = 'Schiffsurlaube – Sicherung ';
const BACKUP_KEEP = 26;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Homepage')
    .addItem('Jetzt aktualisieren', 'homepageAktualisieren')
    .addSeparator()
    .addItem('Sicherung jetzt anlegen', 'sicherungJetzt')
    .addItem('Wöchentliche Sicherung einrichten', 'woechentlicheSicherungEinrichten')
    .addToUi();
}

function homepageAktualisieren() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  const ui = SpreadsheetApp.getUi();
  if (!token) {
    ui.alert('Bitte zuerst die Skripteigenschaft GITHUB_TOKEN anlegen (siehe Kommentar im Skript).');
    return;
  }
  const res = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ event_type: 'sheet-updated' }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() === 204) {
    SpreadsheetApp.getActive().toast('Die Homepage wird aktualisiert – in etwa 1–2 Minuten ist alles online.', 'Homepage', 8);
  } else {
    ui.alert(`GitHub hat mit Fehler ${res.getResponseCode()} geantwortet:\n${res.getContentText()}`);
  }
}

// ---------- Sicherung ----------

/** Kopie des Sheets in den Sicherungsordner legen und alte Kopien aufräumen (läuft auch ohne geöffnetes Sheet). */
function sicherungAnlegen() {
  const ss = SpreadsheetApp.getActive() || SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  const file = DriveApp.getFileById(ss.getId());
  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);
  const day = Utilities.formatDate(new Date(), 'Europe/Berlin', 'yyyy-MM-dd');
  // Am selben Tag nur eine Kopie: eine vorhandene wird ersetzt
  const same = folder.getFilesByName(BACKUP_PREFIX + day);
  while (same.hasNext()) same.next().setTrashed(true);
  file.makeCopy(BACKUP_PREFIX + day, folder);

  const copies = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf(BACKUP_PREFIX) === 0) copies.push(f);
  }
  copies.sort((a, b) => b.getName().localeCompare(a.getName())); // neueste zuerst
  copies.slice(BACKUP_KEEP).forEach((f) => f.setTrashed(true));
  return Math.min(copies.length, BACKUP_KEEP);
}

function sicherungJetzt() {
  const n = sicherungAnlegen();
  SpreadsheetApp.getActive().toast(`Sicherung angelegt – im Ordner „${BACKUP_FOLDER}“ liegen jetzt ${n}.`, 'Sicherung', 8);
}

/** Zeitgesteuerte Sicherung jeden Sonntag gegen 10 Uhr einrichten (ersetzt eine vorhandene). */
function woechentlicheSicherungEinrichten() {
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', SpreadsheetApp.getActive().getId());
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'sicherungAnlegen')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sicherungAnlegen').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(10).inTimezone('Europe/Berlin').create();
  const n = sicherungAnlegen();
  SpreadsheetApp.getUi().alert(`Wöchentliche Sicherung eingerichtet: jeden Sonntag gegen 10 Uhr, die letzten ${BACKUP_KEEP} Kopien bleiben erhalten.\n\nErste Sicherung ist angelegt (${n} im Ordner „${BACKUP_FOLDER}“).`);
}
