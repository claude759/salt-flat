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
