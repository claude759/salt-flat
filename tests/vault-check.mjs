// Checks the Logins & Contacts page (vault.html): the browser-side encryption and the search model.
// Run: node tests/vault-check.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../vault.html', import.meta.url), 'utf8');
const block = (a, b) => html.split(a)[1].split(b)[0];
const MIN_PASS = 12;
const VC = new Function('MIN_PASS', `${block('/* ===== VAULT CRYPTO START ===== */', '/* ===== VAULT CRYPTO END ===== */')}; return VC;`)(MIN_PASS);
const SEARCH = new Function(`${block('/* ===== SEARCH MODEL START ===== */', '/* ===== SEARCH MODEL END ===== */')}; return SEARCH;`)();
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const PASS = 'orbit lantern cactus velvet 42';
const { meta, key } = await VC.create(PASS);

await ok('vault key is wrapped with a fresh salt and 600k PBKDF2 rounds', () => {
  assert.equal(meta.kdf_iter, 600000);
  assert.equal(Buffer.from(meta.kdf_salt, 'base64').length, 16);
  assert.equal(Buffer.from(meta.wrap_iv, 'base64').length, 12);
  assert.equal(Buffer.from(meta.wrapped_key, 'base64').length, 48);            // 32-byte key + 16-byte tag
  assert.equal(JSON.stringify(meta).includes(PASS), false);
});

const secret = { u: 'ap@wizardtrees.com', p: 'S3cret!pa$$ wörd', x: 'PIN 4471\nmother maiden name: n/a' };
const id = '6f1f0b55-0000-4000-8000-000000000001';
const sealed = await VC.seal(key, id, secret);

await ok('a sealed login holds no plain text', () => {
  const raw = Buffer.from(sealed.secret_ct, 'base64').toString('latin1');
  for (const v of [secret.u, secret.p, 'PIN 4471']) assert.equal(raw.includes(v), false);
  assert.equal(Buffer.from(sealed.secret_iv, 'base64').length, 12);
});

await ok('the right passphrase opens the vault and the login', async () => {
  const k2 = await VC.unlock(PASS, meta);
  assert.deepEqual(await VC.open(k2, id, sealed.secret_iv, sealed.secret_ct), secret);
});

await ok('a wrong passphrase is refused', async () => {
  await assert.rejects(VC.unlock('orbit lantern cactus velvet 43', meta), /wrong-passphrase/);
  await assert.rejects(VC.unlock('', meta), /wrong-passphrase/);
});

await ok('a login copied onto another entry will not open', async () => {
  await assert.rejects(VC.open(key, '6f1f0b55-0000-4000-8000-000000000002', sealed.secret_iv, sealed.secret_ct));
});

await ok('a tampered login will not open', async () => {
  const ct = Buffer.from(sealed.secret_ct, 'base64'); ct[3] ^= 1;
  await assert.rejects(VC.open(key, id, sealed.secret_iv, ct.toString('base64')));
});

await ok('the same login sealed twice looks different', async () => {
  const again = await VC.seal(key, id, secret);
  assert.notEqual(again.secret_iv, sealed.secret_iv);
  assert.notEqual(again.secret_ct, sealed.secret_ct);
});

await ok('changing the passphrase keeps saved logins and retires the old passphrase', async () => {
  const NEW = 'harbor juniper anvil saffron 7';
  const meta2 = await VC.rewrap(PASS, NEW, meta);
  assert.notEqual(meta2.kdf_salt, meta.kdf_salt);
  const k3 = await VC.unlock(NEW, meta2);
  assert.deepEqual(await VC.open(k3, id, sealed.secret_iv, sealed.secret_ct), secret);
  await assert.rejects(VC.unlock(PASS, meta2), /wrong-passphrase/);
  await assert.rejects(VC.rewrap('not it at all, sorry', NEW, meta), /wrong-passphrase/);
});

await ok('passphrases in other Unicode forms still match', async () => {
  const { meta: m } = await VC.create('café plein air 12345');
  await VC.unlock('café plein air 12345', m);
});

await ok('generated passwords are long and varied', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = VC.password(20);
    assert.equal(p.length, 20);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
  const all = Array.from({ length: 400 }, () => VC.password(20)).join('');
  assert.ok(/[A-Z]/.test(all) && /[a-z]/.test(all) && /\d/.test(all) && /[^A-Za-z0-9]/.test(all));
  assert.ok(!/[0O1lI]/.test(all), 'look-alike characters are left out');
});

await ok('strength meter turns away short or plain passphrases', () => {
  assert.ok(VC.strength('password') < 2);
  assert.ok(VC.strength('wizardtrees1') < 2);
  assert.ok(VC.strength('Slane2026!!xx') < 2);
  assert.ok(VC.strength('aaaaaaaaaaaa') < 2);
  assert.ok(VC.strength(PASS) >= 3);
});

const CO = { slane: { name: 'Slane Inc', short: 'Slane' }, wtny: { name: 'Wizard Trees NY LLC', short: 'WT NY' } };
const entry = {
  name: 'Republic Services', category: 'Waste & Garbage', companies: ['slane', 'wtny'], url: 'https://www.republicservices.com/login',
  account_no: '3-0412-7781', notes: 'Pickup Tue and Fri',
  contacts: [{ name: 'Dana Ruiz', role: 'Account rep', phone: '(818) 555-0142', email: 'druiz@example.com' }],
};
const hay = SEARCH.haystack(entry, CO);
const find = q => SEARCH.matches(hay, SEARCH.tokens(q));

await ok('search finds an entry by name, kind, company, site, account, contact and phone', () => {
  for (const q of ['republic', 'garbage', 'slane', 'wt ny', 'republicservices.com', '0412', 'dana', 'account rep',
    '8185550142', '555-0142', 'druiz@', 'pickup fri', 'REPUBLIC waste']) assert.ok(find(q), q);
});
await ok('search needs every word to match', () => {
  assert.equal(find('republic imperial'), false);
  assert.equal(find('legal'), false);
});
await ok('search never looks inside logins', () => {
  assert.equal(JSON.stringify(SEARCH.haystack({ ...entry, secret_ct: 'abc', secret_iv: 'def' }, CO)).includes('abc'), false);
});
await ok('an entry named for the search ranks above one that only mentions it', () => {
  const t = SEARCH.tokens('waste');
  assert.ok(SEARCH.score({ name: 'Waste Management', category: 'Waste & Garbage' }, t) > SEARCH.score({ name: 'Republic Services', category: 'Waste & Garbage' }, t));
});
await ok('website hosts drop the www', () => {
  assert.equal(SEARCH.hostOf('https://www.republicservices.com/login'), 'republicservices.com');
  assert.equal(SEARCH.hostOf('not a url'), '');
});

// spreadsheet import
const K = new Function(`const COMPANIES = ${block('const COMPANIES = ', 'const IDLE_LOCK_MS')}; return { COMPANIES, CATEGORIES };`)();
const IMPORT = new Function('COMPANIES', 'CATEGORIES', `${block('/* ===== IMPORT MODEL START ===== */', '/* ===== IMPORT MODEL END ===== */')}; return IMPORT;`)(K.COMPANIES, K.CATEGORIES);
const sheet = (text, opts = {}) => {
  const { rows } = IMPORT.parseTable(text), head = IMPORT.looksLikeHeader(rows[0]), map = IMPORT.guessMap(rows, head);
  return { rows, head, map, ...IMPORT.build(rows, head, map, { companies: [], category: 'Other', cats: [], ...opts }) };
};

await ok('CSV and pasted cells read the same, quotes, commas and line breaks included', () => {
  const csv = '﻿Name,Notes\r\n"Republic, Inc.","Pickup ""Tue""\nand Fri"\r\n\r\nWM,\r\n';
  assert.deepEqual(IMPORT.parseTable(csv).rows, [['Name', 'Notes'], ['Republic, Inc.', 'Pickup "Tue"\nand Fri'], ['WM', '']]);
  assert.deepEqual(IMPORT.parseTable('Name\tPhone\nWM\t718-555-0199\n').rows, [['Name', 'Phone'], ['WM', '718-555-0199']]);
  assert.deepEqual(IMPORT.parseTable('Name;Phone\nWM;718\n').rows, [['Name', 'Phone'], ['WM', '718']]);
  assert.throws(() => IMPORT.parseTable('a\n'.repeat(IMPORT.MAX_ROWS + 5)), /too-many-rows/);
});
await ok('company names are read the way people write them', () => {
  const co = s => IMPORT.parseCompanies(s);
  assert.deepEqual(co('Slane, Filifera').codes, ['filifera', 'slane']);
  assert.deepEqual(co('Waf & Gus').codes, ['waf']);
  assert.deepEqual(co('Wizard Trees NY LLC').codes, ['wtny']);
  assert.deepEqual(co('Slane and WT NY').codes, ['slane', 'wtny']);
  assert.deepEqual(co('Imperial Project LLC / WTMERCH').codes, ['imperial', 'wtmerch']);
  assert.equal(co('All').codes.length, 7);
  assert.deepEqual(co('Wizard Trees'), { codes: [], unknown: ['wizard trees'] });
});
await ok('kinds in the sheet map onto ours, and anything else becomes a new kind', () => {
  const k = s => IMPORT.matchCategory(s, ['Cultivation']).cat;
  assert.equal(k('garbage'), 'Waste & Garbage'); assert.equal(k('Attorney'), 'Legal'); assert.equal(k('IT'), 'Software & IT');
  assert.equal(k('accounting'), 'Accounting & Tax'); assert.equal(k('pest control'), 'Facilities & Maintenance');
  assert.equal(k('cultivation'), 'Cultivation'); assert.equal(k('legal'), 'Legal');
  assert.deepEqual(IMPORT.matchCategory('Florists', []), { cat: 'Florists', isNew: true });
});
await ok('columns are matched by heading, and by what is in them when the heading says nothing', () => {
  const a = sheet('Vendor,Company,Kind,Website,Account #,Contact,Title,Phone,E-mail,Notes,Username,Password,Fax\nX,Slane,Legal,x.com,1,A,B,818-555-0100,a@x.com,n,u,p,1');
  assert.deepEqual(a.map, ['name', 'companies', 'category', 'url', 'account_no', 'c1_name', 'c1_role', 'c1_phone', 'c1_email', 'notes', 'u', 'p', 'notes']);
  assert.deepEqual(sheet('Company\tName\tPhone\nAcme Plumbing\tJoe\t555-123-4567').map, ['name', 'c1_name', 'c1_phone'], 'a vendor Company column + person Name');
  assert.deepEqual(sheet('Name,Phone\nCity of LA,311-555-1234').map, ['name', 'c1_phone']);
  const noHead = sheet('Republic,Slane,dana@x.com,818 555 0142\nWM,All,front@wm.com,718 555 0199');
  assert.equal(noHead.head, false);
  assert.deepEqual(noHead.map, ['name', 'companies', 'c1_email', 'c1_phone']);
  assert.deepEqual(sheet('Vendor,Contact 1 Name,Contact 1 Phone,Contact 2 Name,Contact 2 Phone\nX,Ann,111-222-3333,Bob,444-555-6666').groups[0].contacts,
    [{ name: 'Ann', phone: '111-222-3333' }, { name: 'Bob', phone: '444-555-6666' }]);
  assert.deepEqual(sheet('Vendor,Phone,Phone 2\nY,111-222-3333,999-888-7777').groups[0].contacts, [{ phone: '111-222-3333, 999-888-7777' }]);
});
await ok('one row can be shared by several companies', () => {
  const g = sheet('Vendor,Companies,Username,Password\nQuickBooks,"Slane, Imperial, WT NY",ap@x.com,pw').groups;
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].companies, ['slane', 'imperial', 'wtny']);
  assert.deepEqual(g[0].login, { u: 'ap@x.com', p: 'pw', x: '' });
});
await ok('rows for the same vendor become one entry with all the contacts', () => {
  const r = sheet('Vendor,Company,Contact,Phone\nRepublic,Slane,Dana,818-555-0142\nRepublic,Slane,Joe,818-555-0100\n,,Ann,818-555-0101\nRepublic,WT NY,Kim,718-555-0000', { companies: ['slane'] });
  assert.equal(r.groups.length, 2, 'Slane and WT NY stay apart');
  assert.deepEqual(r.groups[0].contacts.map(c => c.name), ['Dana', 'Joe', 'Ann'], 'a nameless row joins the entry above');
  assert.deepEqual(r.groups[0].carried, [4]);
});
await ok('different account numbers or logins under one name stay separate entries', () => {
  assert.equal(sheet('Vendor,Account #\nLADWP,111\nLADWP,222\nLADWP,', { companies: ['slane'] }).groups.length, 2);
  assert.equal(sheet('Vendor,Username,Password\nAmex,a,1\nAmex,b,2', { companies: ['slane'] }).groups.length, 2);
});
await ok('rows that cannot be placed are reported, not guessed', () => {
  const r = sheet('Vendor,Companies,Kind\nX,Wizard Trees,Legal\n,Slane,Legal');
  assert.equal(r.groups[0].companies.length, 0);
  assert.match(r.groups[0].warn[0], /“wizard trees” is not one of our companies/);
  assert.deepEqual(r.skipped, [{ line: 3, why: 'it has no name' }]);
  assert.equal(IMPORT.plan(r.groups, [])[0].status, 'blocked');
});
await ok('websites are tidied, and text that is not a website goes to notes', () => {
  const g = sheet('Vendor,Website\nX,republicservices.com\nY,see email', { companies: ['slane'] }).groups;
  assert.equal(g[0].url, 'https://republicservices.com/');
  assert.equal(g[1].url, null); assert.deepEqual(g[1].notes, ['Website: see email']);
});
await ok('passwords never land in plain fields', () => {
  const r = sheet('Vendor,Notes,Password,PIN\nX,call first,hunter2-secret,4471', { companies: ['slane'] });
  assert.equal(JSON.stringify({ ...r.groups[0], login: null }).includes('hunter2'), false);
  assert.equal(JSON.stringify({ ...r.groups[0], login: null }).includes('4471'), false);
  assert.deepEqual(r.groups[0].login, { u: '', p: 'hunter2-secret', x: '4471' });
});
await ok('importing again adds only what is new and never overwrites', () => {
  const text = 'Vendor,Company,Account #,Contact,Phone,Notes,Password\nRepublic,Slane,3-0412,Dana,818-555-0142,Tue pickup,pw1\nRepublic,Slane,,Joe,818-555-0100,,';
  const groups = sheet(text).groups;
  const existing = [{ id: 'e1', name: 'republic', companies: ['slane'], account_no: '3-0412', url: 'https://keep.me/', notes: 'Tue pickup',
    contacts: [{ name: 'Dana', phone: '(818) 555-0142', email: 'd@x.com' }], secret_ct: 'sealed', secret_iv: 'iv' }];
  const [p] = IMPORT.plan(groups, existing);
  assert.equal(p.status, 'update');
  assert.equal(p.added, 1);
  assert.deepEqual(Object.keys(p.ch), ['contacts']);
  assert.deepEqual(p.ch.contacts[0], existing[0].contacts[0], 'the saved contact is unchanged');
  assert.equal(p.login, null); assert.equal(p.keptLogin, true);
  assert.equal(existing[0].contacts.length, 1, 'the loaded entry is not touched until saved');
  const again = IMPORT.plan(groups, [{ ...existing[0], contacts: p.ch.contacts }]);
  assert.equal(again[0].status, 'same');
  const noLogin = IMPORT.plan(groups, [{ ...existing[0], contacts: p.ch.contacts, secret_ct: null, secret_iv: null }])[0];
  assert.equal(noLogin.status, 'update'); assert.deepEqual(noLogin.login, { u: '', p: 'pw1', x: '' });
  const other = IMPORT.plan(groups, [{ ...existing[0], companies: ['wtny'] }])[0];
  assert.equal(other.status, 'new'); assert.equal(other.other, true);
});

// page-level guards
await ok('the page pins its database library with an integrity hash', () => {
  assert.match(html, /supabase-js@\d+\.\d+\.\d+\/dist\/umd\/supabase\.js" integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"/);
});
await ok('the page only talks to its own database and Google sign-in', () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src https:\/\/dhiqhgtmelxwelyoowle\.supabase\.co wss:\/\/dhiqhgtmelxwelyoowle\.supabase\.co https:\/\/accounts\.google\.com\/gsi\/;/);
});
await ok('nothing secret is kept in browser storage', () => {
  assert.equal(/localStorage|sessionStorage|indexedDB/.test(block("<script>\n'use strict';", '</script>')), false);
});
await ok('the stand-in test database only works on localhost', () => {
  assert.match(html, /const DB = \(LOCAL && window\.__vaultTestDB\) \|\| SUPA_DB;/);
  assert.match(html, /const LOCAL = \/\^\(localhost\|127\\\.0\\\.0\\\.1\)\$\/\.test\(location\.hostname\);/);
});

console.log(`\n${n} checks passed`);
