// Pure-logic tests for the Distro Hours app. No network, no DOM.
// These mirror the algorithms in ../../index.html (client) and schema.sql
// (server trigger) — if you change one, change both. Run: node logic.test.mjs
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); pass++; } catch(e){ fail++; console.error('✗', name, '\n   ', e.message); } }

/* ---- copies of the pure functions under test ------------------------------ */
function computeHours(cin,cout,breakMin){
  if(!cin||!cout) return null;
  const [ih,im]=cin.split(':').map(Number), [oh,om]=cout.split(':').map(Number);
  if([ih,im,oh,om].some(x=>isNaN(x))) return null;
  let mins=(oh*60+om)-(ih*60+im); if(mins<0) mins+=24*60;
  let h=(mins-(Number(breakMin)||0))/60; if(h<0) h=0;
  return Math.round(h*100)/100;
}
const computeTotal=(hours,rate)=> (hours==null||rate==null||isNaN(rate))?null:Math.round(hours*rate*100)/100;
function parseBreak(s){
  if(s==null) return 0; s=String(s).trim(); if(!s) return 0;
  if(/^\d+$/.test(s)) return Math.min(+s,1440);
  const m=s.replace(/[–—]/g,'-').match(/^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/);
  if(!m) return 0;
  let a=(+m[1])*60+(+(m[2]||0)), b=(+m[3])*60+(+(m[4]||0));
  if(b<=a) b+=12*60;
  const diff=b-a; return (diff>0&&diff<=1440)?diff:0;
}
function lev(a,b){ a=a||'';b=b||''; const m=a.length,n=b.length; if(!m)return n; if(!n)return m;
  const d=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]); for(let j=0;j<=n;j++)d[0][j]=j;
  for(let i=1;i<=m;i++)for(let j=1;j<=n;j++){ const c=a[i-1].toLowerCase()===b[j-1].toLowerCase()?0:1;
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+c); } return d[m][n]; }
function matchEmployee(employees,last,first){
  const L=(last||'').trim().toLowerCase(), F=(first||'').trim().toLowerCase();
  if(!L&&!F) return null; let best=null;
  for(const e of employees){ if(e.active===false) continue;
    const el=(e.last||'').toLowerCase(), ef=(e.first||'').toLowerCase();
    const aliases=(e.aliases||[]).map(a=>a.toLowerCase()); let s;
    if(L && (el===L || aliases.includes(L))) s = ef&&F ? (ef===F?0:0.5) : 0;
    else{ const dl=L&&el?lev(L,el)/Math.max(L.length,el.length):(L?1:0);
      const df=F&&ef?lev(F,ef)/Math.max(F.length,ef.length):0; s=dl*0.7+df*0.3; }
    if(best===null||s<best.score) best={emp:e,score:s}; }
  return (best&&best.score<=0.34)?best:null;
}
const domainOK=email=> !!email && email.toLowerCase().endsWith('@wizardtrees.com');
function csvCell(v){ v=String(v??''); if(/^[=+\-@\t\r]/.test(v)) v="'"+v; return /[",\r\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }
function sheetCell(v){ if(typeof v!=='string') return v; return /^[=+\-@\t\r]/.test(v) ? "'"+v : v; }
const LOCAL_HOSTS=['localhost','127.0.0.1','0.0.0.0','::1','[::1]'];
const demoHostOK=h=> LOCAL_HOSTS.includes(h||'');

/* ---- hours math ----------------------------------------------------------- */
t('8:00–5:00 with 60m lunch = 8.0h', ()=> assert.equal(computeHours('08:00','17:00',60), 8));
t('8:00–5:15 with 60m lunch = 8.25h', ()=> assert.equal(computeHours('08:00','17:15',60), 8.25));
t('9:00–17:15 with 60m lunch = 7.25h', ()=> assert.equal(computeHours('09:00','17:15',60), 7.25));
t('8:00–11:30 no break = 3.5h', ()=> assert.equal(computeHours('08:00','11:30',0), 3.5));
t('8:00–5:18 with 60m = 8.3h (Delgado)', ()=> assert.equal(computeHours('08:00','17:18',60), 8.3));
t('overnight 22:00–06:00 no break = 8h', ()=> assert.equal(computeHours('22:00','06:00',0), 8));
t('missing clock_out → null', ()=> assert.equal(computeHours('08:00','',60), null));
t('break longer than shift clamps to 0', ()=> assert.equal(computeHours('08:00','09:00',120), 0));

/* ---- total ---------------------------------------------------------------- */
t('8.3h @ $25 = 207.50', ()=> assert.equal(computeTotal(8.3,25), 207.5));
t('7.25h @ $20 = 145.00', ()=> assert.equal(computeTotal(7.25,20), 145));
t('null hours → null total', ()=> assert.equal(computeTotal(null,20), null));

/* ---- break parsing -------------------------------------------------------- */
t('"12-1" → 60', ()=> assert.equal(parseBreak('12-1'), 60));
t('"12–1" en-dash → 60', ()=> assert.equal(parseBreak('12–1'), 60));
t('"12-12:30" → 30', ()=> assert.equal(parseBreak('12-12:30'), 30));
t('"30" → 30', ()=> assert.equal(parseBreak('30'), 30));
t('blank → 0', ()=> assert.equal(parseBreak(''), 0));
t('"1-1:45" → 45', ()=> assert.equal(parseBreak('1-1:45'), 45));

/* ---- fuzzy name matching -------------------------------------------------- */
const ROSTER=[
  {last:'Andrade',first:'Maria',aliases:['Andvade']},
  {last:'Zuluago',first:'Andres',aliases:['Zuluogo']},
  {last:'Diaz',first:'Oscar',aliases:[]},
  {last:'Nguyen',first:'Thanh',aliases:[]},
];
t('exact match Diaz Oscar', ()=> assert.equal(matchEmployee(ROSTER,'Diaz','Oscar').emp.last,'Diaz'));
t('alias Andvade → Andrade', ()=> assert.equal(matchEmployee(ROSTER,'Andvade','Maria').emp.last,'Andrade'));
t('OCR typo Zuluogo → Zuluago', ()=> assert.equal(matchEmployee(ROSTER,'Zuluogo','Andres').emp.last,'Zuluago'));
t('close typo Nguen → Nguyen', ()=> assert.equal(matchEmployee(ROSTER,'Nguen','Thanh').emp.last,'Nguyen'));
t('unknown name → no match', ()=> assert.equal(matchEmployee(ROSTER,'Ortega','Lucia'), null));

/* ---- domain gate ---------------------------------------------------------- */
t('gianni@wizardtrees.com allowed', ()=> assert.equal(domainOK('gianni@wizardtrees.com'), true));
t('CASE Gianni@WizardTrees.com allowed', ()=> assert.equal(domainOK('Gianni@WizardTrees.com'), true));
t('gmail.com blocked', ()=> assert.equal(domainOK('someone@gmail.com'), false));
t('lookalike wizardtrees.com.evil.com blocked', ()=> assert.equal(domainOK('x@wizardtrees.com.evil.com'), false));
t('empty blocked', ()=> assert.equal(domainOK(''), false));

/* ---- CSV / XLSX injection guard ------------------------------------------- */
t('formula cell is quoted+prefixed', ()=> assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)"));
t('comma cell quoted', ()=> assert.equal(csvCell('a,b'), '"a,b"'));
t('plain cell untouched', ()=> assert.equal(csvCell('Filifera'), 'Filifera'));
t('xlsx: =HYPERLINK defused', ()=> assert.equal(sheetCell('=HYPERLINK("http://x")'), "'=HYPERLINK(\"http://x\")"));
t('xlsx: @cmd defused', ()=> assert.equal(sheetCell('@SUM(1)'), "'@SUM(1)"));
t('xlsx: plain name untouched', ()=> assert.equal(sheetCell('Andrade'), 'Andrade'));
t('xlsx: numbers pass through', ()=> assert.equal(sheetCell(160), 160));

/* ---- demo-mode host gate (end-anchored) ----------------------------------- */
t('demo host: localhost allowed', ()=> assert.equal(demoHostOK('localhost'), true));
t('demo host: 127.0.0.1 allowed', ()=> assert.equal(demoHostOK('127.0.0.1'), true));
t('demo host: localhost.evil.com blocked', ()=> assert.equal(demoHostOK('localhost.evil.com'), false));
t('demo host: 127.evil.com blocked', ()=> assert.equal(demoHostOK('127.evil.com'), false));
t('demo host: prod pages domain blocked', ()=> assert.equal(demoHostOK('claude759.github.io'), false));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
