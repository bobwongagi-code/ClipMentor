import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {setTimeout as sleep} from 'node:timers/promises';
const hash=v=>createHash('sha256').update(v).digest('hex');
const data=Buffer.alloc(1024*1024,71),sha256=hash(data);
if(process.argv[2]==='worker') {
 const {prepareR2Video}=await import('./video-media.ts');
 const root=process.argv[3],role=process.argv[4],directory=join(root,'state'),object=join(root,'object');
 let entered=false;
 const store={identity:'offline-crash-store',
  head:async()=>{if(!entered){entered=true;process.send({event:'entered',role});await new Promise(r=>process.once('message',r));}
   try{const b=await readFile(object);return {bytes:b.length,etag:hash(b)};}catch(e){if(e.code==='ENOENT')return null;throw e;}},
  pending:async()=>[],
  create:async()=>{await appendFile(join(root,'creates'),'create\n');return 'upload';},
  list:async()=>[],part:async(_k,_u,n,stream)=>{const chunks=[];for await(const c of stream)chunks.push(c);const b=Buffer.concat(chunks);await writeFile(join(root,'part-'+n),b);return hash(b);},
  complete:async(_k,_u,parts)=>{const chunks=[];for(const p of parts)chunks.push(await readFile(join(root,'part-'+p.number)));await writeFile(object,Buffer.concat(chunks));},
  get:async()=>Readable.from([await readFile(object)]),sign:async()=> 'https://example.invalid/original.mp4'};
 process.send({event:'started',role});
 try {const result=await prepareR2Video({file:join(root,'input.mp4'),sha256,directory,namespace:'one-runtime',store,signal:AbortSignal.timeout(role==='cancel'?500:15_000)});process.send({event:'done',role,reused:result.receipt.reused,sha256:result.sha256});}
 catch(e){process.send({event:'error',role,error:e.message});}
 process.disconnect();
} else {
 const root=await mkdtemp(join(tmpdir(),'clipmentor-media-crash-'));await writeFile(join(root,'input.mp4'),data);
 const scope=hash('one-runtime'),key=`clipmentor-video-v1/${scope}/${sha256}.mp4`,identity=hash(JSON.stringify(['offline-crash-store',key]));
 await mkdir(join(root,'state'));await writeFile(join(root,'state',identity+'.lock'),'');await writeFile(join(root,'state',identity+'.lock.sqlite'),'');
 const events=[],children=[];
 const spawn=role=>{const child=fork(new URL(import.meta.url),['worker',root,role],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});children.push(child);child.on('message',m=>events.push({...m,child}));child.stderr.on('data',()=>{});return child;};
 const wait=async test=>{const until=Date.now()+10_000;while(!test()){if(Date.now()>until)throw Error('probe timed out: '+JSON.stringify(events.map(({child,...v})=>v)));await sleep(10);}};
 const by=(event,role)=>events.find(e=>e.event===event&&e.role===role);
 try {
  const owner=spawn('owner');await wait(()=>by('entered','owner'));
  const cancel=spawn('cancel');await wait(()=>by('error','cancel'));assert.match(by('error','cancel').error,/aborted/);assert.ok(!by('entered','cancel'));
  const a=spawn('A'),b=spawn('B');await wait(()=>by('started','A')&&by('started','B'));await sleep(400);
  assert.equal(events.filter(e=>e.event==='entered').length,1,'waiters entered while owner held lock');
  owner.kill('SIGKILL');await wait(()=>events.filter(e=>e.event==='entered').length===2);await sleep(250);
  assert.equal(events.filter(e=>e.event==='entered').length,2,'two waiters entered concurrently after owner crash');
  const first=events.find(e=>e.event==='entered'&&e.role!=='owner');first.child.send('release');
  await wait(()=>by('done',first.role));await wait(()=>events.filter(e=>e.event==='entered').length===3);
  const second=events.find(e=>e.event==='entered'&&!['owner',first.role].includes(e.role));second.child.send('release');await wait(()=>by('done',second.role));
  assert.equal((await readFile(join(root,'creates'),'utf8')).trim().split('\n').length,1);assert.deepEqual(await readFile(join(root,'object')),data);
  assert.equal(by('done',first.role).reused,false);assert.equal(by('done',second.role).reused,true);
  assert.equal(events.filter(e=>e.event==='error').length,1);
  console.log(JSON.stringify({PASS:true,preexisting_empty_legacy_and_sqlite_locks_recovered:true,cancelled_waiter_entered:false,waiters_entered_while_owner_alive:0,concurrent_entries_after_crash:1,multipart_creates:1,first_reused:false,second_reused:true,object_sha256:hash(await readFile(join(root,'object'))),events:events.map(({child,...v})=>v)}));
 } finally {for(const c of children)if(c.exitCode===null)c.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
}
