import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../order-tracker.html',import.meta.url),'utf8');
const source=html.split('<script>')[1].split('/* ---------- wiring ---------- */')[0];
const now=new Date(2026,8,10,12).getTime();
const defaultGeneral={mode:'config',invoice_no:'default_nonvape'};
function fixture({wire='120',header='Payment 1\n4th September 2026',vape='40',general='60'}={}){
  return {cols:[{i:0,header:'Invoice No.'},{i:1,header:'Paid to Date'},{i:2,header:'Due'},{i:3,header:'Not yet due'}],
    payCols:[{i:4,header}],totals:[['','','','',wire]],
    rows:[{src:10,type:'Vapes (AIO)',date:now,c:['V1',vape,'60','0',vape]},
          {src:11,type:'Labels & stickers',date:now,c:['G1',general,'40','0',general]}]};
}
function app(asc=[],model=fixture()){
  const context=vm.createContext({console,location:{hash:'#ca-payments'},localStorage:{getItem:()=>null}});
  vm.runInContext(source,context);
  const api=vm.runInContext('({state,recentPaymentsData,hashPage})',context);
  api.state.asc=asc;api.state.data.ca=model;api.state.data.ny=fixture({wire:'20',vape:'0',general:'20'});
  return api;
}
const bucket=(invoice_no,amount,payment_key='Payment 1')=>({state:'ca',mode:'bucket',invoice_no,amount,payment_key});

test('uses one full wire including its unapplied remainder, not invoice-row cash totals',()=>{
  const d=app().recentPaymentsData('ca',now);
  assert.equal(d.payments.length,1);
  const p=d.payments[0];
  assert.equal(p.amount,120);assert.equal(p.vape,40);assert.equal(p.general,80);
  assert.equal(p.dateLabel,'4 Sep 2026');assert.equal(p.dateNote,'');
});
test('keeps wire-only payments and labels amount fallback when the total is missing',()=>{
  const p=app([],fixture({vape:'0',general:'0'})).recentPaymentsData('ca',now).payments[0];
  assert.equal(p.amount,120);assert.equal(p.general,120);
  const fallback=app([],fixture({wire:''})).recentPaymentsData('ca',now).payments[0];
  assert.equal(fallback.amount,100);assert.equal(fallback.fallback,true);
});
test('default general allocation honors linked vape credit without counting it as more cash',()=>{
  const d=app([defaultGeneral,bucket('__vape__',30)]).recentPaymentsData('ca',now);
  assert.equal(d.payments.length,1);assert.equal(d.payments[0].vape,30);assert.equal(d.payments[0].general,90);
});
test('account-only allocations do not invent payment dates or additional cash',()=>{
  const d=app([defaultGeneral,bucket('__vape__',70,'__bucket__')]).recentPaymentsData('ca',now);
  assert.equal(d.payments.length,1);assert.equal(d.payments[0].vape,0);assert.equal(d.payments[0].defaulted,true);
  assert.equal(d.unlinked.length,1);assert.equal(d.unlinked[0].amount,70);assert.equal(d.unlinked[0].account,'Vapes');
});
test('valid invoice moves shift the account split and conserve the full wire',()=>{
  const move={state:'ca',mode:'move',payment_key:'Payment 1',invoice_no:'V1',source_invoice:'G1',amount:20};
  const p=app([move]).recentPaymentsData('ca',now).payments[0];
  assert.equal(p.vape,60);assert.equal(p.general,60);assert.equal(p.amount,120);
});
test('restatement follows current adjustments and flags negative allocation rather than clamping it',()=>{
  const replace={state:'ca',mode:'replace',payment_key:'Payment 1',invoice_no:'V1',amount:20};
  const p=app([defaultGeneral,replace]).recentPaymentsData('ca',now).payments[0];
  assert.equal(p.vape,-20);assert.ok(p.issues.length>0);assert.equal(p.amount,120);
});
test('missing invoice references and over-allocation are visible review issues',()=>{
  const missing=app([bucket('MISSING',30)]).recentPaymentsData('ca',now).payments[0];
  assert.ok(missing.issues.some(i=>i.includes('no longer')));
  const excess=app([bucket('__vape__',200)]).recentPaymentsData('ca',now).payments[0];
  assert.ok(excess.issues.some(i=>i.includes('outside')));
});
test('undated supplier columns stay undated; inferred years are disclosed',()=>{
  const undated=app([],fixture({header:'Payment 1'})).recentPaymentsData('ca',now).payments[0];
  assert.equal(undated.date,null);assert.equal(undated.dateLabel,'Date not provided');
  const estimated=app([],fixture({header:'Payment 1\n4th September'})).recentPaymentsData('ca',now).payments[0];
  assert.match(estimated.dateNote,/estimated/);assert.equal(estimated.dateLabel,'4 Sep 2026');
});
test('pending real payments preserve paid date, account and possible posting warning',()=>{
  const pending={id:'p',state:'ca',mode:'payment',invoice_no:'__vape__',amount:25,paid_on:'2026-09-09',sheet_paid_at_entry:50};
  const d=app([pending]).recentPaymentsData('ca',now);
  assert.equal(d.payments.length,2);
  const p=d.payments[0];assert.equal(p.pending,true);assert.equal(p.vape,25);assert.equal(p.dateLabel,'9 Sep 2026');assert.equal(p.risk,true);
});
test('recorded date is not represented as a missing payment date; states remain separate',()=>{
  const pending={id:'p',state:'ca',mode:'payment',invoice_no:'__nonvape__',amount:25,created_at:'2026-09-09T20:00:00Z'};
  const a=app([pending]), p=a.recentPaymentsData('ca',now).payments.find(p=>p.pending);
  assert.equal(p.date,null);assert.ok(p.notes.some(n=>n.includes('Recorded')));
  const ny=a.recentPaymentsData('ny',now);assert.equal(ny.payments.length,1);assert.equal(ny.payments[0].amount,20);
  assert.equal(a.hashPage(),'ca-payments');
});
test('malformed and impossible paid_on dates never borrow the entry date or silently roll forward',()=>{
  for(const paid_on of ['not-a-date','2026-02-30']){
    const pending={id:'bad-date',state:'ca',mode:'payment',invoice_no:'__vape__',amount:25,paid_on,created_at:'2026-09-09T20:00:00Z'};
    const p=app([pending]).recentPaymentsData('ca',now).payments.find(p=>p.pending);
    assert.equal(p.date,null);assert.equal(p.dateLabel,'Date not provided');
    assert.ok(p.notes.some(n=>n.includes('Recorded')));
  }
});
