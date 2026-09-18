const fs=require('fs'), vm=require('vm');
let code=fs.readFileSync(require('path').join(__dirname,'../ar-reports.html'),'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
code+=';globalThis.__t={renderChips,pistilStaleTag, pistilStale,pistilReceivedAt,buildPistilRows,buildPistilPosRows,pistilToWire,pistilFromWire,pistilPosToWire,pistilPosFromWire,pistilStockLabel,pistilUnitsLabel,pistilInventoryCell,baPistilByKey,baPistilPosByKey,setup(files){Object.assign(FILES,files);PISTIL=buildPistilRows();PISTIL_POS=buildPistilPosRows();}};';
function mkEl(){return{value:'',innerHTML:'',textContent:'',className:'',classList:{add(){},remove(){},toggle(){},contains(){return false}},dataset:{},style:{setProperty(){}},addEventListener(){},appendChild(){},click(){},querySelector(){return mkEl()},querySelectorAll(){return[]},closest(){return mkEl()},onclick:null,getAttribute(){return null},remove(){},options:[]}}
const els={};function q(s){return els[s]||(els[s]=mkEl())}
const ctx={console,document:{querySelector:q,querySelectorAll:()=>[],createElement:()=>mkEl(),addEventListener(){},getElementById:id=>q('#'+id),body:mkEl(),hidden:false},location:{search:'',href:'',hash:'',pathname:'/',origin:'x',reload(){}},navigator:{},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},addEventListener(){},history:{replaceState(){}},URL:{createObjectURL:()=>'x',revokeObjectURL(){}},Blob:function(){},fetch:()=>Promise.reject(0),setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,Date,Math,JSON,parseFloat,parseInt,isNaN,encodeURIComponent,decodeURIComponent,Set,Map,Array,Object,String,Number,RegExp,Intl,Promise,URLSearchParams,alert(){}};
ctx.window=ctx;ctx.globalThis=ctx;ctx.self=ctx;vm.createContext(ctx);vm.runInContext(code,ctx,{filename:'x'});const T=ctx.__t;

const assert=require('node:assert/strict');
const meta={'Report Date':'2026-09-18','Report received at':'2026-09-18T15:39:41.000Z','Feed source':'Pistil Next','State':'CA'};
T.setup({pistil:{count:2,data:[{...meta,Store:'Example','Product':'Unknown menu','In stock':'','Menu Counts':''},{...meta,Store:'Example','Product':'Available','In stock':'yes','Menu Counts':'5'}]},pistil_pos:{count:2,data:[{...meta,Store:'Example','Product':'Unknown POS','Units on hand':'','Avg units per day':'','Days on hand':''},{...meta,Store:'Example','Product':'Sold out','Units on hand':'0','Avg units per day':'0','Days on hand':'0'}]}});
T.renderChips();assert(els['#chips'].innerHTML.includes('Pistil'));assert((els['#chips'].innerHTML.match(/2 rows/g)||[]).length===2);
const stock=T.pistilFromWire(T.pistilToWire(T.buildPistilRows()));
const pos=T.pistilPosFromWire(T.pistilPosToWire(T.buildPistilPosRows()));
assert.equal(stock[0].items[0][2],null);assert.equal(stock[0].items[1][2],1);
assert.equal(pos[0].items[0][1],null);assert.equal(pos[0].items[1][1],0);
assert.equal(pos[0].items[0][2],null);assert.equal(pos[0].src,'Pistil Next');
assert.equal(T.pistilReceivedAt('pistil'),meta['Report received at']);
const p=Object.values(T.baPistilByKey('CA'))[0],q2=Object.values(T.baPistilPosByKey())[0];
assert.equal(p.unknown,1);assert.equal(q2.unknownUnits,1);
assert.equal(T.pistilUnitsLabel(q2),'0+ units · 1 unknown');
assert(T.pistilInventoryCell(p,q2).includes('var(--text)'));
assert.equal(T.pistilStockLabel({total:3,inStock:0,unknown:3}),'3 tracked · status unknown');
assert.equal(T.pistilUnitsLabel({units:0,skus:1,unknownUnits:0}),'0 units');
assert.equal(T.pistilUnitsLabel({units:0,skus:1,unknownUnits:1}),'Units unknown');
assert.equal(T.pistilFromWire([['Legacy','','CA','2026-09-01',[['P','',0,'','']]]])[0].items[0][2],0);
assert.equal(T.pistilPosFromWire([['Legacy','2026-09-01',[['P',7,2,4,'']]]])[0].items[0][1],7);
T.setup({pistil:{count:2,data:[{...meta,Store:'Example','Report received at':''}]}});
assert.throws(()=>T.pistilReceivedAt('pistil'),/missing/);
console.log('Pistil Next UI: unknowns, zero inventory, source/state, legacy payloads, rollups, and receipt freshness passed');
