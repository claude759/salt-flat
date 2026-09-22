// node tests/ny-check.mjs : run before every push that touches the NY Packaging app.
// Exit 0 = safe to push. Any FAIL = do not push; fix first.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
const FILE = 'labor-calculator-ny.html';
const src = fs.readFileSync(FILE, 'utf8');
let bad = 0; const say = (ok, m) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + m); if (!ok) bad++; };

// 1. the file is whole: a truncated write is the one mistake that takes the whole board down
say(src.length > 150_000 && /<\/html>\s*$/i.test(src), `file is complete (${(src.length / 1024).toFixed(0)} KB, ends with </html>)`);

// 2. every inline script parses
const scripts = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const tmp = path.join(os.tmpdir(), `ny-inline-${process.pid}.js`);
fs.writeFileSync(tmp, scripts.join('\n;\n'));
try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); say(true, `${scripts.length} inline script(s) parse`); }
catch (e) { say(false, 'inline script syntax error:\n' + String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')); }
finally { fs.rmSync(tmp, { force: true }); }

// 3. every tab has its page, and every page has its tab
const markup = src.replace(/<script[\s\S]*?<\/script>/g, '');   // markup only: code comments show examples
const tabs = [...markup.matchAll(/class="tab[^"]*"[^>]*data-tab="([^"]+)"/g)].map(m => m[1]);
const views = [...markup.matchAll(/<div id="view-([^"]+)"/g)].map(m => m[1]);
const orphanTabs = tabs.filter(t => !views.includes(t)), orphanViews = views.filter(v => !tabs.includes(v));
say(!orphanTabs.length && !orphanViews.length, `tabs ↔ pages match (${tabs.join(', ')})` + (orphanTabs.length ? ` · tab with no view-: ${orphanTabs}` : '') + (orphanViews.length ? ` · view- with no tab: ${orphanViews}` : ''));

// 4. the regression tests
for (const t of ['tests/inflight-edit-race.mjs', 'tests/ny-vape-reports.mjs']) {
  try { execFileSync(process.execPath, [t, FILE], { stdio: 'pipe' }); say(true, t); }
  catch (e) { say(false, t + '\n' + String(e.stdout || '').split('\n').filter(l => /FAIL/.test(l)).slice(0, 5).join('\n')); }
}
console.log(bad ? `\n✗ ${bad} check(s) failed, do not push` : '\n✓ safe to push');
process.exit(bad ? 1 : 0);
