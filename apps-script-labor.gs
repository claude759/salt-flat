// ══════════════════════════════════════════════════════════════
//  Wizard Trees — Labor Tracker · read-only sheet proxy
//
//  Lets labor-calculator.html read the "Daily Labor_Unit tracker"
//  Google Sheet WITHOUT making the sheet itself public. The script
//  runs as you (who can read the sheet) and serves the Combined tab
//  as CSV to anyone who opens the calculator page.
//
//  You only need this if you DON'T want to set the sheet's sharing
//  to "Anyone with the link: Viewer". If you're happy flipping that
//  toggle instead, skip this file entirely — the page reads the
//  sheet directly.
//
//  SETUP (one-time, ~3 minutes)
//  ────────────────────────────
//  1. Go to https://script.google.com and click "New project".
//  2. Delete any code in the editor and paste THIS entire file in.
//  3. Click Deploy → New deployment.
//        Type:            Web app
//        Execute as:      Me
//        Who has access:  Anyone            ← important: "Anyone",
//                                              NOT "Anyone with Google account",
//                                              so teammates don't need to log in.
//  4. Click Deploy, authorize when prompted, then copy the Web app URL
//     (it ends in /exec).
//  5. Open labor-calculator.html, find this line near the top of the <script>:
//         const PROXY_URL = '';
//     and paste your URL between the quotes. Save, commit, push.
// ══════════════════════════════════════════════════════════════

const LABOR_SHEET_ID = '1IUMecFlqCYFe51jBBmu5gIs-8elhlrgxdUPxP3qLFuQ';
const LABOR_TAB_NAME = 'Combined';

function doGet() {
  const ss = SpreadsheetApp.openById(LABOR_SHEET_ID);
  const sheet = ss.getSheetByName(LABOR_TAB_NAME) || ss.getSheets()[0];
  const values = sheet.getDataRange().getDisplayValues(); // formatted, like the sheet shows
  const csv = values.map(function (row) {
    return row.map(function (cell) {
      const s = String(cell == null ? '' : cell);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\r\n');
  return ContentService.createTextOutput(csv).setMimeType(ContentService.MimeType.CSV);
}
