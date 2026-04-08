// ══════════════════════════════════════════════════════════════
//  Wizard Trees — AR Collections · Google Apps Script Backend
//
//  SETUP INSTRUCTIONS (one-time):
//  ─────────────────────────────
//  1. Go to https://script.google.com and click "New project"
//  2. Delete any existing code and paste this entire file in
//  3. Click Deploy → New deployment
//       Type:              Web app
//       Execute as:        Me
//       Who has access:    Anyone with Google account
//  4. Click Deploy → copy the Web App URL it gives you
//  5. Open wizard-trees-ar.html in a text editor, find the line:
//         const SCRIPT_URL = 'YOUR_APPS_SCRIPT_URL_HERE';
//     and replace YOUR_APPS_SCRIPT_URL_HERE with your URL
//  6. Save the HTML file and reopen it in your browser
//
//  The script will automatically create a Google Sheet called
//  "Wizard Trees AR" in your Drive on first login.
//  To add/remove team users, open that sheet → Users tab.
//
//  DEFAULT LOGIN (change after first sign-in):
//    Username: admin
//    Password: wizardtrees
// ══════════════════════════════════════════════════════════════

const SHEET_NAME = 'Wizard Trees AR';

// Column definitions (order must match appendRow calls below)
const COLS = {
  users:    ['username', 'password'],
  contacts: ['company', 'email', 'name', 'repEmail', 'phone', 'region'],
  reps:     ['name', 'email'],
  sent:     ['id', 'sentAt', 'sentBy', 'to', 'cc', 'subject', 'body', 'source', 'tone']
};

// ── Spreadsheet bootstrap ─────────────────────────────────────

function getOrCreateSpreadsheet() {
  const files = DriveApp.getFilesByName(SHEET_NAME);
  if (files.hasNext()) {
    return SpreadsheetApp.open(files.next());
  }
  const ss = SpreadsheetApp.create(SHEET_NAME);
  bootstrapSheets(ss);
  return ss;
}

function bootstrapSheets(ss) {
  // Rename the default sheet to Users and add a default admin account
  const usersSheet = ss.getSheets()[0];
  usersSheet.setName('Users');
  usersSheet.appendRow(['username', 'password']);
  usersSheet.appendRow(['admin', 'wizardtrees']);
  usersSheet.getRange('A1:B1').setFontWeight('bold');

  // Create Contacts, Reps, and Sent sheets with header rows
  ['Contacts', 'Reps', 'Sent'].forEach(function(name) {
    const sheet = ss.insertSheet(name);
    const headers = COLS[name.toLowerCase()];
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  });
}

function getTab(tabName) {
  return getOrCreateSpreadsheet().getSheetByName(tabName);
}

// Convert a sheet's rows into an array of plain objects using the column list
function sheetToObjects(sheet, cols) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return []; // header row only — nothing to return
  const headers = data[0].map(function(h) { return h.toString().toLowerCase().trim(); });
  return data.slice(1)
    .map(function(row) {
      const obj = {};
      cols.forEach(function(col) {
        const idx = headers.indexOf(col.toLowerCase());
        obj[col] = idx >= 0 ? row[idx].toString() : '';
      });
      return obj;
    })
    .filter(function(row) {
      // Drop completely empty rows
      return Object.values(row).some(function(v) { return v !== ''; });
    });
}

// ── Response helpers ──────────────────────────────────────────

function jsonOk(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, data: data || null }))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonErr(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Entry points ──────────────────────────────────────────────

function doGet(e) {
  // Handy for checking the script is live — visit the URL in a browser
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, message: 'Wizard Trees AR script is running.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const action = e.parameter.action;
    if (!action) return jsonErr('Missing action parameter');

    switch (action) {
      case 'login':         return handleLogin(e.parameter);
      case 'getContacts':   return handleGetContacts();
      case 'getReps':       return handleGetReps();
      case 'getSent':       return handleGetSent();
      case 'addContact':    return handleAddContact(e.parameter);
      case 'deleteContact': return handleDeleteContact(e.parameter);
      case 'updateContact': return handleUpdateContact(e.parameter);
      case 'addRep':        return handleAddRep(e.parameter);
      case 'deleteRep':     return handleDeleteRep(e.parameter);
      case 'addSent':       return handleAddSent(e.parameter);
      case 'sendEmail':     return handleSendEmail(e.parameter);
      default:              return jsonErr('Unknown action: ' + action);
    }
  } catch (ex) {
    return jsonErr(ex.message);
  }
}

// ── Auth ──────────────────────────────────────────────────────

function handleLogin(params) {
  const username = (params.username || '').toLowerCase().trim();
  const password = (params.password || '');
  if (!username || !password) return jsonErr('Username and password are required');

  const sheet = getTab('Users');
  const users = sheetToObjects(sheet, COLS.users);
  const match = users.find(function(u) {
    return u.username.toLowerCase() === username && u.password === password;
  });

  if (!match) return jsonErr('Invalid credentials');
  return jsonOk({ username: match.username });
}

// ── Contacts ──────────────────────────────────────────────────

function handleGetContacts() {
  return jsonOk(sheetToObjects(getTab('Contacts'), COLS.contacts));
}

function handleAddContact(params) {
  getTab('Contacts').appendRow([
    params.company  || '',
    params.email    || '',
    params.name     || '',
    params.repEmail || '',
    params.phone    || '',
    params.region   || ''
  ]);
  return jsonOk(null);
}

function handleDeleteContact(params) {
  const sheet = getTab('Contacts');
  const data   = sheet.getDataRange().getValues();
  const headers = data[0].map(function(h) { return h.toString().toLowerCase(); });
  const emailCol = headers.indexOf('email');

  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][emailCol] === params.email) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  return jsonOk(null);
}

function handleUpdateContact(params) {
  const sheet  = getTab('Contacts');
  const data   = sheet.getDataRange().getValues();
  const headers = data[0].map(function(h) { return h.toString().toLowerCase(); });
  const emailCol = headers.indexOf('email');

  for (var i = 1; i < data.length; i++) {
    if (data[i][emailCol] === params.oldEmail) {
      sheet.getRange(i + 1, 1, 1, COLS.contacts.length).setValues([[
        params.company  || '',
        params.email    || '',
        params.name     || '',
        params.repEmail || '',
        params.phone    || '',
        params.region   || ''
      ]]);
      break;
    }
  }
  return jsonOk(null);
}

// ── Reps ──────────────────────────────────────────────────────

function handleGetReps() {
  return jsonOk(sheetToObjects(getTab('Reps'), COLS.reps));
}

function handleAddRep(params) {
  const sheet    = getTab('Reps');
  const existing = sheetToObjects(sheet, COLS.reps);
  // Silently skip if this email already exists
  if (existing.find(function(r) { return r.email === params.email; })) return jsonOk(null);
  sheet.appendRow([params.name || '', params.email || '']);
  return jsonOk(null);
}

function handleDeleteRep(params) {
  const sheet  = getTab('Reps');
  const data   = sheet.getDataRange().getValues();
  const headers = data[0].map(function(h) { return h.toString().toLowerCase(); });
  const emailCol = headers.indexOf('email');

  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][emailCol] === params.email) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  return jsonOk(null);
}

// ── Send email ────────────────────────────────────────────────

function handleSendEmail(params) {
  const to      = params.to      || '';
  const subject = params.subject || '';
  const body    = params.body    || '';
  const cc      = params.cc      || '';
  const from    = params.from    || 'ar@wizardtrees.com';

  if (!to || !subject || !body) return jsonErr('Missing required fields: to, subject, body');

  // Build options — only include cc if non-empty (empty string causes "Invalid argument")
  const options = { name: 'Wizard Trees Accounts Receivable' };
  if (cc) options.cc = cc;

  // Attempt to send with the requested 'from' alias; fall back to account default if not verified
  try {
    GmailApp.sendEmail(to, subject, body, Object.assign({ from: from }, options));
  } catch(ex) {
    GmailApp.sendEmail(to, subject, body, options);
  }

  return jsonOk(null);
}

// ── Sent log ──────────────────────────────────────────────────

function handleGetSent() {
  const rows = sheetToObjects(getTab('Sent'), COLS.sent);
  // Return newest first (the app prepends with unshift, so newest is at top)
  return jsonOk(rows.reverse());
}

function handleAddSent(params) {
  getTab('Sent').appendRow([
    params.id      || Date.now().toString(),
    params.sentAt  || new Date().toISOString(),
    params.sentBy  || '',
    params.to      || '',
    params.cc      || '',
    params.subject || '',
    params.body    || '',
    params.source  || '',
    params.tone    || ''
  ]);
  return jsonOk(null);
}
