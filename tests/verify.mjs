import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const html=fs.readFileSync('public/index.html','utf8');
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]);

function dom(){
 const elements=new Map();
 function getElementById(id){
  if(!elements.has(id)) elements.set(id,{
   hidden:id==='save'||id==='panel',disabled:id==='save',
   textContent:'',rows:[],
   replaceChildren(){this.rows=[];},
   insertRow(){
    const row={cells:[],insertCell(){const c={textContent:''};this.cells.push(c);return c;}};
    this.rows.push(row);return row;
   }
  });
  return elements.get(id);
 }
 return {getElementById};
}
function context(){
 const document=dom();
 const ctx=vm.createContext({
  document,TextEncoder,Blob,URL,crypto:webcrypto,
  performance:{now:()=>Number(process.hrtime.bigint())/1e6},
  setTimeout,console
 });
 return {document,ctx};
}
function crc32(buf){
 let c=0xffffffff;
 for(const b of buf){
  c^=b;
  for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);
 }
 return (~c)>>>0;
}
test('scripts integrados sin errores de sintaxis',()=>{
 assert.equal(scripts.length,3);
 scripts.forEach((s,i)=>assert.doesNotThrow(()=>new vm.Script(s),'script '+(i+1)));
});
test('Vercel sirve public sin dependencia npm ni compilación',()=>{
 const config=JSON.parse(fs.readFileSync('vercel.json','utf8'));
 assert.equal(config.framework,null);
 assert.equal(config.outputDirectory,'public');
 assert.equal(config.installCommand,undefined);
 assert.equal(config.buildCommand,undefined);
 assert.match(html,/<button id="save" hidden disabled>/);
});
test('ensayo sintético, recuperación, botón de evidencia y Excel XLSX íntegro',async()=>{
 const {ctx,document}=context();
 vm.runInContext(scripts[1],ctx,{timeout:20000});
 const proof=await vm.runInContext('experiment()',ctx,{timeout:20000});
 assert.equal(proof.registros,200000);
 assert.equal(proof.csv_identicos,true);
 assert.notEqual(proof.sha256_original,proof.sha256_modificado);
 assert.deepEqual(Array.from(proof.casos['Recuperación selectiva'].trace),['Reutilizada','Reutilizada','Ejecutada']);
 await document.getElementById('run').onclick();
 assert.equal(document.getElementById('status').textContent,'Ensayo superado.');
 assert.equal(document.getElementById('save').hidden,false);
 assert.equal(document.getElementById('save').disabled,false);
 assert.equal(document.getElementById('panel').hidden,false);
 vm.runInContext(scripts[2],ctx,{timeout:20000});
 ctx.__e=proof;
 ctx.__c={lots:100,failures:4,price:100,own:60,repeat:608,always:70,selective:70,
  grossSaving:538,clientSaving:438,margin:40,marginPercent:40,
  decisions:[{stage:'Validar',repeat:2,recover:3,save:.1,eligible:true,selected:false,baseline:8,reuse:22},
             {stage:'Calcular',repeat:150,recover:10,save:.2,eligible:true,selected:true,baseline:600,reuse:60}]};
 const workbook=vm.runInContext('zipWorkbook(workbookFiles(reportSheets(__e,__c)))',ctx,{timeout:20000});
 const buf=Buffer.from(await workbook.arrayBuffer());
 const end=buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
 assert.ok(end>=0,'ZIP debe contener EOCD');
 const total=buf.readUInt16LE(end+10);
 assert.equal(total,9);
 let cursor=buf.readUInt32LE(end+16);
 const names=[];
 for(let i=0;i<total;i++){
  assert.equal(buf.readUInt32LE(cursor),0x02014b50);
  assert.equal(buf.readUInt16LE(cursor+10),0,'ZIP sin compresión');
  const len=buf.readUInt16LE(cursor+28),extra=buf.readUInt16LE(cursor+30),comment=buf.readUInt16LE(cursor+32);
  const name=buf.toString('utf8',cursor+46,cursor+46+len);
  const off=buf.readUInt32LE(cursor+42),size=buf.readUInt32LE(cursor+20);
  assert.equal(buf.readUInt32LE(off),0x04034b50);
  const payloadStart=off+30+buf.readUInt16LE(off+26)+buf.readUInt16LE(off+28);
  const payload=buf.subarray(payloadStart,payloadStart+size);
  assert.equal(crc32(payload),buf.readUInt32LE(cursor+16),name+' CRC');
  names.push(name);
  if(name==='xl/workbook.xml'){
   const xml=payload.toString('utf8');
   for(const title of ['Resumen','Traza','Resultados CSV','Rentabilidad','Decisiones por etapa'])
    assert.ok(xml.includes('name="'+title+'"'),title);
  }
  cursor+=46+len+extra+comment;
 }
 assert.ok(names.includes('[Content_Types].xml'));
 for(let i=1;i<=5;i++)assert.ok(names.includes('xl/worksheets/sheet'+i+'.xml'));
});
