import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDelimited } from '../src/parser.js';
import { validateInput, analyzeImport, importPlan, requestFor, hash } from '../src/model.js';
import { step, exportTable } from '../src/engine.js';
import { mockApi, CONFIG, ROOM_CODE, id } from '../src/mock.js';
const example=JSON.parse(await readFile(new URL('../examples/import.json',import.meta.url),'utf8'));
const input=text=>({...structuredClone(example),text});
const records=(text,delimiter=',')=>{const result=parseDelimited(text,delimiter);assert.equal(result.status,'valid',JSON.stringify(result));return result.records;};

test('quoted delimiters, doubled quotes and exact embedded LF/CRLF survive decoding',()=>{
  assert.deepEqual(records('a,"b,c","d""e"\r\n"x\ny","z\r\nw",tail'),[['a','b,c','d"e'],['x\ny','z\r\nw','tail']]);
  assert.deepEqual(records('a;"b;c";d',';'),[['a','b;c','d']]);
  assert.deepEqual(records('a\t"b\tc"\td','\t'),[['a','b\tc','d']]);
});
test('empty cells, blank records and final separators have explicit behavior',()=>{
  for(const text of ['a','a\n','a\r\n'])assert.deepEqual(records(text),[['a']]);
  assert.deepEqual(records('\n\n'),[[''],['']]);assert.deepEqual(records(','),[['','']]);assert.deepEqual(records('a,\n'),[['a','']]);
  assert.deepEqual(records('""'),[['']]);assert.deepEqual(records('a\n\n'),[['a'],['']]);
});
test('spaces, Unicode, numeric-looking and formula-looking cells remain exact strings',()=>{
  assert.deepEqual(records('  x  ,001,=1+2,é,🐦,\t'),[['  x  ','001','=1+2','é','🐦','\t']]);
});
test('malformed quotes and every bare CR produce syntax failures without partial records',()=>{
  const cases=[['a"b','quote-in-unquoted-cell'],['"a"x','after-closing-quote'],['"a" ','after-closing-quote'],['"a','unterminated-quote'],['"""','unterminated-quote'],['a\rb','bare-cr'],['"a\rb"','bare-cr']];
  for(const [text,code] of cases){const r=parseDelimited(text,',');assert.equal(r.status,'invalid');assert.equal(r.diagnostic.code,code);assert(Number.isInteger(r.diagnostic.offset));assert.equal('records' in r,false);}
});
test('parser limits reject excess records, columns, decoded cell length and unsupported text',()=>{
  assert.equal(records('x'.repeat(2048))[0][0].length,2048);assert.equal(parseDelimited('x'.repeat(2049),',').diagnostic.code,'cell-limit');
  assert.equal(records(Array(32).fill('x').join(','))[0].length,32);assert.equal(parseDelimited(Array(33).fill('x').join(','),',').diagnostic.code,'column-limit');
  assert.equal(records(Array(256).fill('x').join('\n')).length,256);assert.equal(parseDelimited(Array(257).fill('x').join('\n'),',').diagnostic.code,'record-limit');
  for(const text of ['', '\uFEFFa','\ud800','a\0b','x'.repeat(32769)])assert.equal(parseDelimited(text,',').status,'invalid');
  assert.equal(parseDelimited('a','|').status,'invalid');
});
test('rectangular tables, duplicate header labels and header-only imports are explicit',()=>{
  const r=analyzeImport(input('same,same,\n1,2,3'),'a');assert.deepEqual(r.table.header,['same','same','']);assert.deepEqual(r.table.rows,[['1','2','3']]);
  assert.deepEqual(analyzeImport(input('h1,h2'),'a').table,{header:['h1','h2'],rows:[]});
  const bad=analyzeImport(input('h1,h2\nx'),'a');assert.equal(bad.status,'invalid');assert.equal(bad.table,null);assert.deepEqual(bad.diagnostic,{code:'unequal-width',record:2,expectedCells:2,actualCells:1});
  assert.equal(importPlan(input('h1,h2\nx'),'a').status,'invalid');assert.equal(importPlan(example,'unknown').analysis,null);assert.throws(()=>importPlan(example,'unsupported'));
});
test('presets canonicalize without modifying text or inferring a dialect',()=>{
  assert.equal(hash(validateInput(example)),hash(validateInput({...example,presets:example.presets.toReversed()})));
  assert.equal(validateInput(example).text,example.text);assert.equal(analyzeImport(example,'a').rowCount,2);assert.equal(analyzeImport(example,'b').rowCount,3);
  const request=requestFor(example,CONFIG,'dialect',id(90));assert(!request.prompt.includes('Blue, folded'));assert.match(request.prompt,/header=yes/);assert.equal(request.options.length,3);
});
test('invalid input schemas and duplicate semantic presets are rejected',()=>{
  for(const mutate of [x=>{x.extra=true;},x=>{x.presets[0].id='unknown';},x=>{x.presets[1]={...x.presets[0],id:'c'};},x=>{x.presets[0].header='yes';},x=>{x.presets[0].delimiter='|';},x=>{x.text='\uFEFFh';},x=>{x.text='';},x=>{x.text='\ud800';},x=>{x.presets.length=3;}]){const x=structuredClone(example);mutate(x);assert.throws(()=>validateInput(x));}
});
test('oversized combined prompt fails before state or any API operation',async t=>{
  const x=structuredClone(example);x.importId='x'.repeat(40);x.title='T'.repeat(40);x.context='C'.repeat(80);x.presets=[['a',',',true],['b',',',false],['c',';',true]].map(([id,delimiter,header])=>({id,label:'L'.repeat(26),reference:'R'.repeat(40),delimiter,header}));
  const directory=await mkdtemp(join(tmpdir(),'import-preflight-'));t.after(()=>rm(directory,{recursive:true,force:true}));const now=()=> '2026-01-01T09:00:00.000Z',api=mockApi(now);
  await assert.rejects(step({client:api.client,directory,input:x,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now}),/prompt exceeds/);assert.equal(api.calls.length,0);await assert.rejects(readFile(join(directory,'state.json')),{code:'ENOENT'});
});
test('known choice plus malformed source produces diagnostics and refuses export',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'import-syntax-'));t.after(()=>rm(directory,{recursive:true,force:true}));const now=()=> '2026-01-01T09:00:00.000Z',api=mockApi(now),source=input('h1,h2\n"unfinished');
  const args={client:api.client,directory,input:source,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now};await step(args);api.answer(id(1),'a');const result=await step(args);assert.equal(result.status,'invalid');assert.equal(result.analysis.table,null);await assert.rejects(exportTable(directory,source));assert.equal(api.calls.filter(x=>x.method==='POST').length,1);
});
test('independent serializer round-trips 1200 generated tables across all delimiters and endings',()=>{
  const cells=['','a','  x  ','comma,value','semi;value','tab\tvalue','line\nfeed','carriage\r\nline','"quoted"','é','🐦','=SUM(A1:A2)'];let cases=0;
  const encode=(table,delimiter,newline)=>table.map(row=>row.map(cell=>'"'+cell.replaceAll('"','""')+'"').join(delimiter)).join(newline);
  for(const delimiter of [',',';','\t'])for(const newline of ['\n','\r\n'])for(let seed=0;seed<200;seed++){
    const width=1+seed%7,height=1+seed%5,table=Array.from({length:height},(_,r)=>Array.from({length:width},(_,c)=>cells[(seed+r*3+c*5)%cells.length]));
    assert.deepEqual(records(encode(table,delimiter,newline)+(seed%2?newline:''),delimiter),table);cases++;
  }assert.equal(cases,1200);
});
