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
//  SETUP (one-time, ~3 minutes) — do this signed in as a Google
//  account that can OPEN the tracker sheet.
//  ────────────────────────────
//  1. Go to https://script.google.com and click "New project".
//  2. Delete any code in the editor and paste THIS entire file in.
//     (Optional: rename the project "WT Labor sync" so you find it later.)
//  3. Click Deploy → New deployment.  If you see a gear icon, click it
//     and choose "Web app".
//        Description:     anything (e.g. "labor sync")
//        Execute as:      Me
//        Who has access:  Anyone            ← important: "Anyone",
//                                              NOT "Anyone with Google account",
//                                              so teammates don't need to log in.
//  4. Click Deploy. Google will ask you to authorize:
//        • "Review permissions" → pick your Google account.
//        • You'll see "Google hasn't verified this app" — this is normal
//          for your own scripts. Click "Advanced" → "Go to <project>
//          (unsafe)" → "Allow". (It only ever READS your sheet.)
//  5. Copy the "Web app" URL it shows (it ends in /exec) and send it to me,
//     OR paste it yourself into labor-calculator.html at:
//         const PROXY_URL = '';
//     between the quotes, then save/commit/push.
//
//  To sync BOTH sheets later (the Labor/Packaging sheet too), just share
//  that sheet with the same Google account and tell me — one script can
//  serve both. For now this covers Tasks, Reports, and the auto-filled
//  Labor/Packaging days (which derive from the tracker).
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
