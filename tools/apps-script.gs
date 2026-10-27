/**
 * Optional: Menü „Homepage“ im Google Sheet, das die Homepage sofort neu baut.
 *
 * Einrichtung (einmalig):
 *  1. Im Sheet: Erweiterungen → Apps Script, diesen Code einfügen, speichern.
 *  2. Auf GitHub einen Fine-grained Token anlegen (Settings → Developer settings →
 *     Personal access tokens → Fine-grained): nur Repository „Weiffenbach.com“,
 *     Berechtigung „Contents: Read and write“.
 *  3. In Apps Script: Projekteinstellungen → Skripteigenschaften →
 *     Eigenschaft GITHUB_TOKEN mit dem Token anlegen.
 *  4. Sheet neu laden – oben erscheint das Menü „Homepage“.
 */
const REPO = 'markweiffenbach/Weiffenbach.com';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Homepage')
    .addItem('Jetzt aktualisieren', 'homepageAktualisieren')
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
