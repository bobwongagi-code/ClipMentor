import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash,webcrypto} from 'node:crypto';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {runInNewContext,Script} from 'node:vm';
import {createServer} from 'node:http';import {once} from 'node:events';
import fixture from './fixtures/blueprint-review-board-20261031.json';
import type {BoardInput} from './blueprint-review-board';
import type {ProjectDoc} from '../../src/editor/types';
import {createMiniConnect} from '../../desktop/mini-connect';
const root=await mkdtemp(join(tmpdir(),'review-board-check-')),priorData=process.env.OPENCHATCUT_DATA_DIR,realFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=root;let networks=0;globalThis.fetch=async()=>{networks++;throw Error('Network forbidden');};
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),clone=<T>(v:T):T=>structuredClone(v),exec=promisify(execFile);
const tests:Array<{name:string;pass:boolean;error?:string}>=[];
const test=async(name:string,fn:()=>Promise<void>)=>{try{await fn();tests.push({name,pass:true});console.log('PASS',name);}catch(e){tests.push({name,pass:false,error:String(e)});console.error('FAIL',name,String(e));}};
const c=fixture.cases;
const input=(value:unknown,bindings?:ProjectDoc[]):BoardInput=>({value,sha256:hash(JSON.stringify(value)),hashMode:'file',assertUnchanged:async()=>{},bindings});
try{
 const {loadReviewBoardInput,planReviewBoards,renderReviewBoards,REVIEW_BOARD_FRAME_LIMIT}=await import('./blueprint-review-board');
 assert.equal((await import('../runtime-profile')).runtimeProfile().rootDir,root,'all server imports must bind to temporary storage');
 const {deliveryPictureBindings,deliverySectionsFromDoc}=await import('../../src/clipmentor/delivery-sections');
 const {extractOneFrame}=await import('../plugins/extract-frames'),{ffmpegBin}=await import('../media-binaries');
 await test('A2/A3 real v3 current pointers, exact phases and prose-only frame conflict',async()=>{
  const v=clone(c.green),before=JSON.stringify(v),result=planReviewBoards(input(v,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[]));assert.equal(result.plans.length,2);
  for(const plan of result.plans){assert.equal(plan.rows.length,13);assert.deepEqual(plan.rows.map(r=>r.stage),['opening','original','explanation','original','explanation','original','explanation','original','explanation','original','explanation','explanation','closing']);assert.equal(plan.rows.flatMap(r=>r.lines).length,8);assert.equal(plan.frame_count,35);const g1=plan.rows.find(r=>r.line_ids.includes('GM-L01'))!;assert.deepEqual(g1.range,[0,10.5]);assert.deepEqual(g1.frames.map(f=>f.frame),[0,157,314]);assert(g1.picture.includes('源帧21')&&g1.picture.includes('195'));assert(g1.notices.some(s=>/散文提到具体帧|画面说明提到指定画面/u.test(s)));assert(!g1.frames.some(f=>f.frame===21||f.frame===195));assert.deepEqual(g1.colors,['#FFD83D','#111111']);}
  const {blueprintPictureNotices}=await import('../../src/clipmentor/blueprint-picture-notices');
  const prepared=planReviewBoards(input(v,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])),{humanBoardQuestions}=await import('./blueprint-review-board-human');
  for(const plan of prepared.plans){const notices=blueprintPictureNotices(plan.rows.map(r=>({...r,location:r.key}))),reported=prepared.lint.findings.filter(f=>f.rule_id==='B10'||f.rule_id==='B11');assert(notices.length>0);assert.deepEqual(notices.map(n=>n.message),reported.map(n=>n.message));const questions=humanBoardQuestions(plan,prepared.lint);for(const notice of notices)for(const key of notice.row_keys){const row=plan.rows.find(r=>r.key===key)!;assert(questions.get(row.unit_id)?.has(notice.message));assert(row.notices.includes(notice.message));}}
  assert.equal(JSON.stringify(v),before);
 });
 await test('Shared notices remain identical for current and legacy saved plans',async()=>{
  const {blueprintPictureNotices}=await import('../../src/clipmentor/blueprint-picture-notices'),{humanBoardQuestions}=await import('./blueprint-review-board-human');
  for(const [value,materials]of [[c.green,[c.newBinding,c.existingBinding]],[c.barelyFour,undefined],[c.barelyV5,[c.barelyFour]]] as const){
   const result=planReviewBoards(input(value,materials as unknown as ProjectDoc[]));
   for(const plan of result.plans){
    const notices=blueprintPictureNotices(plan.rows.map(r=>({...r,location:r.key}))),findings=result.lint.findings.filter(f=>f.rule_id==='B10'||f.rule_id==='B11'),questions=humanBoardQuestions(plan,result.lint);
    assert.deepEqual(notices.map(n=>n.message),findings.map(f=>f.message));
    for(const notice of notices)for(const key of notice.row_keys){const row=plan.rows.find(r=>r.key===key)!;assert(questions.get(row.unit_id)?.has(notice.message));}
   }
  }
 });
 await test('Human board surfaces a likely timing overrun without upgrading the lint verdict',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');
  const prepared=planReviewBoards(input(c.green,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[]));
  const {data,lint}=prepared,board=prepared.plans[0];
  const group=lint.groups.find(g=>g.line_ids.includes('GM-L02'))!;
  const card=(overrides:Partial<typeof group>,id='group-2')=>{
   const report={...lint,groups:[{...group,...overrides}]};
   return humanReviewBoardPage(board,data,report).split('data-card="'+id+'"')[1].split('</section>')[0];
  };
  // Green Makes saved L02: point estimate above capacity, empirical lower estimate below it.
  const values={complete:true,estimated_seconds:13.731998,picture_seconds:12,empirical_lower_seconds:10.833947};
  assert.match(card(values),/口播估计约13\.7秒，画面约12秒；估算可能偏长，待配音后核对。/);
  assert.doesNotMatch(card(values,'group-1'),/估算可能偏长/);
  assert.match(card({...values,empirical_lower_seconds:12.1}),/是否偏紧？这是估算，仍以配音实测为准。/);
  for(const overrides of [
   {...values,estimated_seconds:12,empirical_lower_seconds:10},
   {...values,estimated_seconds:12.04,empirical_lower_seconds:10},
   {...values,complete:false},
   {...values,picture_seconds:null},
   {...values,estimated_seconds:null},
  ])assert.doesNotMatch(card(overrides),/估算可能偏长|是否偏紧/);
 });
 await test('A4 actual four-group middle and historical full v5 reuse retain separate source facts',async()=>{
  const four=planReviewBoards(input(c.barelyFour)).plans[0];assert.equal(four.rows.filter(r=>r.stage==='original').length,4);assert(four.reuse.some(r=>r.row_keys.some(k=>four.rows.find(v=>v.key===k)?.line_ids.includes('BT-L04'))&&r.row_keys.some(k=>four.rows.find(v=>v.key===k)?.line_ids.includes('BT-L06'))));
  // Historical v5 has a source-video invitation; the saved four-group middle
  // contains no invitation. Never fabricate one in the four-group record.
  const old=planReviewBoards(input(c.barelyV5,[c.barelyFour as unknown as ProjectDoc])).plans[0];assert(old.reuse.some(r=>{const rows=r.row_keys.map(k=>old.rows.find(v=>v.key===k)!);return rows.some(v=>v.stage==='original')&&rows.some(v=>v.line_ids.includes('BT-L01'))&&rows.some(v=>v.line_ids.includes('BT-L05'));}));
 });
 await test('Declared point ranges retain a single frame and show repeated still reuse',async()=>{
  const value=clone(c.green),i=value.clipMentorAnalysis.blueprint[0].internal_review as any;i[i.current_picture_plan].phases[1].source_range_seconds=[0.7,0.7];
  const board=planReviewBoards(input(value,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])).plans[0],still=board.rows.find(r=>r.line_ids.includes('GM-L01'))!;assert.deepEqual(still.frames.map(f=>f.frame),[21]);assert(board.reuse.some(r=>r.range[0]===0.7&&r.range[1]===0.7&&r.row_keys.includes(still.key)));
 });
 await test('R1 current candidate wins and conflicting convenience copies are rejected',async()=>{
  const v=clone(c.green);v.narration_and_captions.find(l=>l.id==='GM-L01')!.narration_ms='A stale convenience copy';assert.throws(()=>planReviewBoards(input(v,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])),/INPUT.*冲突/);
 });
 await test('A6 exact original binding geometry is reused before new audio or approval',async()=>{
  const d=c.newBinding as unknown as ProjectDoc,binding=deliveryPictureBindings(d,deliverySectionsFromDoc(d)),board=planReviewBoards(input(c.green,[d,c.existingBinding as unknown as ProjectDoc])).plans[0];
  for(const row of board.rows.filter(r=>r.crop)){const expected=binding.find(b=>'asset_id'in b&&b.asset_id===row.asset_id&&'tool_crop_px'in b)!;assert('tool_crop_px'in expected);assert.deepEqual(row.tool_crop_px,expected.tool_crop_px);}
 });
 await test('A7 missing pointers and excessive frame requests refuse before extraction/publication',async()=>{
  const v=clone(c.green),i=v.clipMentorAnalysis.blueprint[0].internal_review as any;i.current_script_candidate='missing';assert.throws(()=>planReviewBoards(input(v,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])),/INPUT/);
  const many=clone(c.green),j=many.clipMentorAnalysis.blueprint[0].internal_review as any,p=j[j.current_picture_plan];p.phases=Array.from({length:REVIEW_BOARD_FRAME_LIMIT},()=>p.phases[0]);assert.throws(()=>planReviewBoards(input(many,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])),/INPUT/);
 });
 await test('A7 malformed bindings, wrong source references and unknown variant reject',async()=>{
  assert.throws(()=>planReviewBoards(input(c.green,[c.newBinding,null] as unknown as ProjectDoc[])),/INPUT/);
  const wrong=clone(c.green),internal=wrong.clipMentorAnalysis.blueprint[0].internal_review as any;internal[internal.current_picture_plan].phases[0].source_asset_id='wrong-video';assert.throws(()=>planReviewBoards(input(wrong,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])),/INPUT/);
  assert.throws(()=>planReviewBoards(input(c.green,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[]),'missing-variant'),/INPUT/);
  const broken=join(root,'broken.json');await writeFile(broken,'{not JSON');await assert.rejects(loadReviewBoardInput(broken),/INPUT/);
 });
 // Real extraction only on temporary, explicitly synthetic source/media.
 const media=join(root,'media/uploads');await mkdir(media,{recursive:true});
 const bindings=[clone(c.newBinding),clone(c.existingBinding)] as unknown as ProjectDoc[];
 let green=clone(c.green) as unknown as Record<string,unknown>;
 for(const asset of bindings[0].assets){const path=join(media,asset.src.split('/').at(-1)!);if(asset.kind==='video')await exec(ffmpegBin(),['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x160:rate=30:duration=69.2','-c:v','libx264','-pix_fmt','yuv420p',path]);else await exec(ffmpegBin(),['-v','error','-y','-f','lavfi','-i',`testsrc=size=${asset.width}x${asset.height}:rate=1`,'-frames:v','1',path]);const original=asset.sourceContentHash!,replacement=hash(await readFile(path));green=JSON.parse(JSON.stringify(green).replaceAll(original,replacement));for(let k=0;k<bindings.length;k++)bindings[k]=JSON.parse(JSON.stringify(bindings[k]).replaceAll(original,replacement));}
 const source=bindings[0].assets.find(a=>a.kind==='video')!,sourceFile=join(media,source.src.split('/').at(-1)!);
 await test('Panel Storyboard creates a reusable local image from the bound original',async()=>{
  const {createPanelStoryboard}=await import('./production-panel-delivery');
  const project=clone(bindings[0]),signal=new AbortController().signal;
  const asset=await createPanelStoryboard(project,signal);assert(asset);
  assert.equal(asset.props?.clipmentorStoryboardSource,source.id);
  assert.equal(asset.props?.clipmentorStoryboardHash,source.sourceContentHash);
  const times=asset.props?.clipmentorStoryboardTimes as number[];
  assert.equal(times.length,3);assert(times.every((time,index)=>index===0||time>times[index-1]));
  const bytes=await readFile(join(media,asset.src.split('/').at(-1)!));
  assert(bytes.length>1000);assert.equal(hash(bytes),asset.sourceContentHash);
  project.assets.push(asset);
  assert.equal(await createPanelStoryboard(project,signal),undefined,'identical valid assets are reused');
  await assert.rejects(createPanelStoryboard(bindings[0],AbortSignal.abort(Error('fixture abort'))),/fixture abort/);
 });
 await test('A5 source request decodes exact known 30fps frame and full resolution',async()=>{
  for(const frame of [0,21,195,2075]){const actual=join(root,'actual.jpg'),reference=join(root,'reference.jpg');await extractOneFrame(sourceFile,Math.floor(frame/30*1000),actual,false);await exec(ffmpegBin(),['-v','error','-y','-i',sourceFile,'-vf','select=eq(n\\,'+frame+')','-frames:v','1','-q:v','4',reference]);assert.deepEqual(await readFile(actual),await readFile(reference));}
 });
 await test('A6 actual cropped pixels match the original-image approved margins',async()=>{
  const board=planReviewBoards(input(green,bindings)).plans[0];
  for(const [index,row]of board.rows.filter(r=>r.crop).entries()){
   const asset=bindings[0].assets.find(a=>a.id===row.asset_id)!,section=deliverySectionsFromDoc(bindings[0]).find(s=>s.picture.asset_id===row.asset_id)!,crop=section.picture.crop!;
   const width=asset.width!,height=asset.height!,expected={x:Math.round(width*crop.left),y:Math.round(height*crop.top),w:Math.round(width*(1-crop.left-crop.right)),h:Math.round(height*(1-crop.top-crop.bottom))};
   const actual=join(root,'crop-'+index+'.jpg'),reference=join(root,'reference-crop-'+index+'.jpg'),source=join(media,asset.src.split('/').at(-1)!);
   await extractOneFrame(source,0,actual,false,row.crop);await exec(ffmpegBin(),['-v','error','-y','-i',source,'-vf',`crop=${expected.w}:${expected.h}:${expected.x}:${expected.y}:exact=1`,'-frames:v','1','-q:v','4',reference]);assert.deepEqual(await readFile(actual),await readFile(reference));
  }
 });
 await test('F4 actual human-board pixels keep a second full picture with a repeated section ID',async()=>{
  const copies=clone(bindings);const ending=(doc:ProjectDoc)=>deliverySectionsFromDoc(doc).find(s=>s.kind==='creator_invitation')!;
  for(const doc of copies){const ir=(doc.clipMentorAnalysis!.blueprint[0] as any).internal_review;ir[ir.current_picture_plan].delivery_sections.find((s:any)=>s.kind==='creator_invitation').section_id='shared-invitation';}
  const ir=(copies[1].clipMentorAnalysis!.blueprint[0] as any).internal_review;ir[ir.current_picture_plan].delivery_sections.find((s:any)=>s.kind==='creator_invitation').picture.crop={left:0,top:0,right:0,bottom:0};
  const result=await renderReviewBoards({...input(green,copies),mediaDir:media},join(root,'repeated-id-human'),undefined,'human');
  assert.equal(result.artifacts.length,1);const page=await readFile(result.artifacts[0].path,'utf8'),pictures=JSON.parse(page.match(/const pictures=([\s\S]*?);let selection/)![1]);
  const section=ending(copies[1]),source=join(media,section.picture.src.split('/').at(-1)!),reference=join(root,'second-ending-full.jpg');
  await exec(ffmpegBin(),['-v','error','-y','-i',source,'-frames:v','1','-q:v','4',reference]);
  assert.deepEqual(Buffer.from(pictures.at(-1)[0].jpeg,'base64'),await readFile(reference));
  assert.notDeepEqual(Buffer.from(pictures.at(-2)[0].jpeg,'base64'),Buffer.from(pictures.at(-1)[0].jpeg,'base64'));
 });
 const candidate=join(root,'candidate.json'),materialPaths:string[]=[];await writeFile(candidate,JSON.stringify(green));for(const [index,doc]of bindings.entries()){const p=join(root,`bindings-${index}.json`);await writeFile(p,JSON.stringify(doc));materialPaths.push(p);}
 const generateInput=()=>loadReviewBoardInput(candidate,{bindings:materialPaths,mediaDir:media});let html='';
 await test('A1/A2 real generation is offline, atomic and leaves all inputs identical',async()=>{
  const before=await Promise.all([candidate,...materialPaths,sourceFile].map(async p=>hash(await readFile(p))));const result=await renderReviewBoards(await generateInput(),join(root,'boards'));assert.equal(result.artifacts.length,2);assert(result.artifacts.every(a=>a.frame_count===35));html=await readFile(result.artifacts[0].path,'utf8');assert(html.includes('data:image/jpeg;base64,'));assert(!/src=["']https?:/i.test(html));assert(html.includes('connect-src &#39;none&#39;')||html.includes("connect-src 'none'"));assert.deepEqual(await Promise.all([candidate,...materialPaths,sourceFile].map(async p=>hash(await readFile(p)))),before);assert.equal(networks,0);
 });
 await test('A7 absent or changed original refuses without any half board',async()=>{
  const empty=join(root,'refused');await assert.rejects(renderReviewBoards({...await generateInput(),mediaDir:join(root,'absent')},empty),/INPUT/);await assert.rejects(readdir(empty));const bytes=await readFile(sourceFile);await writeFile(sourceFile,'wrong bytes');try{await assert.rejects(renderReviewBoards(await generateInput(),empty),/INPUT/);await assert.rejects(readdir(empty));}finally{await writeFile(sourceFile,bytes);}
 });
 await test('A7 invalid dimensions and changed inputs leave no partial artifact',async()=>{
  const invalid=clone(bindings);invalid.forEach(d=>d.assets.forEach(a=>{if(a.kind==='video')a.width=0;}));
  const out=join(root,'invalid-dimensions');await assert.rejects(renderReviewBoards({...input(green,invalid),mediaDir:media},out),/INPUT.*尺寸/);await assert.rejects(readdir(out));
  const changed=join(root,'changed-input');await assert.rejects(renderReviewBoards({...await generateInput(),assertUnchanged:async()=>{throw Error('INPUT: changed');}},changed),/INPUT.*changed/);await assert.rejects(readdir(changed));
 });
 await test('A8 local selected file checks SHA without network, expired file is explicit',async()=>{
  const script=html.match(/<script>([\s\S]*?)<\/script>/)![1];new Script(script);let listener:(e:any)=>Promise<void>=async()=>{};const nodes=new Map<string,any>();const document={getElementById:(id:string)=>{if(!nodes.has(id))nodes.set(id,{textContent:'',className:'',addEventListener:(_n:string,fn:any)=>{listener=fn;}});return nodes.get(id);},querySelectorAll:()=>[]};runInNewContext(script,{document,crypto:webcrypto,TextDecoder,TextEncoder,Uint8Array});
  const send=async(bytes:Buffer)=>listener({target:{files:[{arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}]}});
  await send(await readFile(candidate));assert.match(nodes.get('freshness').textContent,/与此候选一致/);await send(Buffer.from(JSON.stringify({...green,status:'changed'})));assert.match(nodes.get('freshness').textContent,/已过期/);
  let release!:(v:ArrayBuffer)=>void;const slow=listener({target:{files:[{arrayBuffer:()=>new Promise<ArrayBuffer>(r=>{release=r;})}]}});await send(Buffer.from(JSON.stringify({...green,status:'newer'})));const bytes=await readFile(candidate);release(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);await slow;assert.match(nodes.get('freshness').textContent,/已过期/,'older selection must never overwrite newer result');assert.equal(networks,0);
 });
 await test('A9 generator preparation never adds board data to independent review input',async()=>{
  const {copyTeachingPacketFromDoc,buildCopyTeachingReviewRequest}=await import('../../src/clipmentor/production-gate');const d=bindings[0];const before=buildCopyTeachingReviewRequest([{case_id:'unchanged',packet:await copyTeachingPacketFromDoc(d)}]);planReviewBoards(input(d));(d as any).author_self_check={remaining_gaps:'BOARD_AUTHOR_SENTINEL'};assert.deepEqual(buildCopyTeachingReviewRequest([{case_id:'unchanged',packet:await copyTeachingPacketFromDoc(d)}]),before);
 });
 await test('H2-H6 human has one body, Chinese first, illustration boundaries and neutral warnings',async()=>{
  const {humanBoardQuestions}=await import('./blueprint-review-board-human');const prepared=planReviewBoards(input(green,bindings)),questions=humanBoardQuestions(prepared.plans[0],(await import('../../src/clipmentor/blueprint-lint')).lintBlueprint(green));
  assert([...questions.get('GM-G1')??[]].some(q=>q.includes('指定画面')));assert([...questions.get('GM-G5')??[]].some(q=>q.includes('画面说明相同')));for(const id of ['GM-G2','GM-G3','GM-G4'])assert(!questions.has(id));
  const result=await renderReviewBoards(await generateInput(),join(root,'human'),undefined,'human');assert.equal(result.artifacts.length,1);assert.equal(result.artifacts[0].frame_count,38);const page=await readFile(result.artifacts[0].path,'utf8');
  assert.equal((page.match(/data-card="group-/g)??[]).length,5);assert.equal((page.match(/class="explanation"/g)??[]).length,6);assert.equal((page.match(/class="ending"/g)??[]).length,2);assert(page.includes('<h2>片头</h2>'));assert(page.includes('版式示意，非渲染'));assert(page.includes('示意模板'));assert(!page.includes('text-shadow'));
  const visible=page.split('<footer>')[0].replace(/<style>[\s\S]*?<\/style>/g,'').replace(/<details[\s\S]*?<\/details>/g,'').replace(/<[^>]+>/g,'');assert(!/[a-f0-9]{64}|#[a-f0-9]{6}|\bf\d+\b|Reference only|tool_crop_px|asset_id|B05/iu.test(visible));assert(!/画面已匹配|审核通过|验收通过/.test(visible));assert(!/data-verdict=/.test(page));assert(!page.includes('<details id="technical"')&&!page.includes('候选业务登记'));
  for(const line of prepared.data.lines){const escaped=(t:string)=>t.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));assert(page.includes(escaped(line.text)));assert(page.includes(escaped(line.zh)));const found=page.indexOf('data-line-id="'+line.id+'"');assert(found>=0);const segment=page.slice(found,page.indexOf('</div>',found));assert(segment.indexOf('class="meaning"')<segment.indexOf('class="narration"'));}
  assert.equal(networks,0);
 });
 await test('Creator endings expose the same crop and actual uncropped evidence before freeze',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');
  const prepared=planReviewBoards(input(green,bindings));
  const first=prepared.plans[0].rows.find(r=>r.stage==='closing')!;
  const second=structuredClone(first);
  first.key='ending/new';first.ending_variant='new_contact';
  second.key='ending/existing';second.ending_variant='existing_partner';second.asset_id='separate-upload-same-bytes';
  const board={...prepared.plans[0],rows:[...prepared.plans[0].rows,second]};
  const page=()=>humanReviewBoardPage(board,prepared.data,prepared.lint);
  assert(page().includes('同一张原图与同一裁切'));
  assert(page().includes('原海报的佣金区'));
  assert(page().includes('本商品的原片 Storyboard'));
  second.asset_hash='a'.repeat(64);
  assert(!page().includes('同一张原图与同一裁切'));
  second.asset_hash=first.asset_hash;
  second.crop={left:0,top:0,right:0,bottom:0};
  assert(!page().includes('同一张原图与同一裁切'));
  board.rows.pop();
  assert(!page().includes('同一张原图与同一裁切'));
  first.ending_variant='unclassified';
  assert(!page().includes('原海报的佣金区'));
  assert(!page().includes('本商品的原片 Storyboard'));
  const output=await renderReviewBoards(await generateInput(),join(root,'ending-source-proof'),undefined,'human');
  const html=await readFile(output.artifacts[0].path,'utf8');
  const reference=join(root,'original-closing-proof.jpg');
  const asset=bindings.flatMap(doc=>doc.assets).find(a=>a.id===first.asset_id)!;
  await extractOneFrame(join(media,asset.src.split('/').at(-1)!),0,reference,false);
  assert(html.includes('核对未裁原图'));
  assert(html.includes('data:image/jpeg;base64,'+(await readFile(reference)).toString('base64')));
  assert.equal(networks,0);
 });
 await test('H6 declared repetition, two levels of estimated capacity, and visible quantity produce questions',async()=>{
  const {humanBoardQuestions}=await import('./blueprint-review-board-human'),{lintBlueprint}=await import('../../src/clipmentor/blueprint-lint');const prepared=planReviewBoards(input(green,bindings)),board=clone(prepared.plans[0]),lint=lintBlueprint(green),last=board.rows.find(r=>r.line_ids.includes('GM-L06'))!;last.range=[53,56];last.lint.push({rule_id:'B04',level:'warn',location:'GM-L06',excerpt:'RM20,000',message:'not a decision'});const g=lint.groups.find(g=>g.line_ids.includes('GM-L06'))!;g.estimated_seconds=30;g.empirical_lower_seconds=25;g.picture_seconds=10;
  const questions=()=>[...humanBoardQuestions(board,lint).get('GM-G5')??[]];
  const q=questions();assert(q.some(q=>q.includes('重复使用')));assert(q.some(q=>q.includes('RM20,000')));assert(q.some(q=>q.includes('估计约30秒')&&q.includes('是否偏紧')));
  g.empirical_lower_seconds=9;assert(questions().some(q=>q.includes('估计约30秒')&&q.includes('估算可能偏长')));assert(!questions().some(q=>q.includes('估计约30秒')&&q.includes('是否偏紧')));
 });
 await test('Adversarial H6 includes opening and ending visible-quantity questions',async()=>{
  const {humanBoardQuestions,humanReviewBoardPage}=await import('./blueprint-review-board-human');const p=planReviewBoards(input(green,bindings)),board=clone(p.plans[0]);
  for(const stage of ['opening','closing']){const row=board.rows.find(r=>r.stage===stage)!;row.lint.push({rule_id:'B04',level:'warn',location:row.line_ids[0],excerpt:'RM20,000',message:'Visible quantity absent'});const questions=humanBoardQuestions(board,p.lint);assert([...questions.get(row.key)??[]].some(q=>q.includes('RM20,000')),stage+' must retain its warning');}
  const page=humanReviewBoardPage(board,p.data,p.lint);const opening=page.slice(page.indexOf('data-card="opening"'),page.indexOf('data-card="group-1"')),ending=page.slice(page.indexOf('data-card="endings"'),page.indexOf('<footer>'));assert(opening.includes('画面上有RM20,000'));assert(ending.includes('画面上有RM20,000'));
  const first=board.rows.find(r=>r.stage==='closing')!,second=clone(p.plans[1].rows.find(r=>r.stage==='closing')!);first.unit_id=second.unit_id='shared-closing-section';first.key='closing/new';second.key='closing/existing';second.lint=[];board.rows.push(second);const scoped=humanBoardQuestions(board,p.lint);assert([...scoped.get(first.key)??[]].some(q=>q.includes('RM20,000')));assert(![...scoped.get(second.key)??[]].some(q=>q.includes('RM20,000')),'one ending warning must not leak into the other with same section ID');
 });
 await test('Adversarial H5 every line sharing a phase has its own illustration and zoom source',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');const p=planReviewBoards(input(green,bindings)),board=clone(p.plans[0]),rows=board.rows.filter(r=>r.stage==='explanation'),lastUnit=rows.at(-1)!.unit_id,sameUnit=rows.filter(r=>r.unit_id===lastUnit),first=sameUnit[0],second=sameUnit[1];first.lines.push(...second.lines);first.line_ids.push(...second.line_ids);board.rows=board.rows.filter(r=>r!==second);
  const page=humanReviewBoardPage(board,p.data,p.lint);assert.equal((page.match(/class="explanation"/g)??[]).length,6,'one illustration per sentence, not per phase');const group=page.slice(page.indexOf('data-card="group-5"'),page.indexOf('data-card="endings"'));assert.equal((group.match(/class="mock-caption"/g)??[]).length,2);assert(!/data-zoom="-1"/.test(page));assert(group.includes(second.lines[0].cards[0][0].replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))));
 });
 await test('Human source observations retain their exact timed excerpt, not a whole-group assertion',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');const p=planReviewBoards(input(green,bindings)),before=JSON.stringify(p.data),page=humanReviewBoardPage(p.plans[0],p.data,p.lint),card=(s:string,id:string)=>s.split('data-card="'+id+'"')[1].split('</section>')[0];
  for(const [group,time]of [['group-4','41–48.5秒'],['group-5','51.5–55.5秒']]){const section=card(page,group);assert(section.includes('原片观察摘录'));assert(section.includes(time));assert(section.includes('只描述其中'+time));}
  const e=(p.data.analysis.evidence as any[]).find(e=>e.evidence_id==='GM-E09-V');assert(card(page,'group-4').includes(e.text));assert.equal(JSON.stringify(p.data),before);
  const full=clone(p.data),fullEvidence=(full.analysis.evidence as any[]).find(e=>e.evidence_id==='GM-E09-V');fullEvidence.source_range_seconds=[41,51.5];const whole=card(humanReviewBoardPage(p.plans[0],full,p.lint),'group-4');assert(whole.includes('原片观察摘录'));assert(!whole.includes('只描述其中'));
 });
 await test('Human source observations without valid evidence timestamps stay hidden',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');const p=planReviewBoards(input(green,bindings));for(const time of [undefined,null,[-1,3],[48,41],[41,'48.5'],[NaN,48.5],[41]]){const data=clone(p.data),e=(data.analysis.evidence as any[]).find(e=>e.evidence_id==='GM-E09-V');e.text='NO_TIME_OBSERVATION_SENTINEL';if(time===undefined)delete e.source_range_seconds;else e.source_range_seconds=time;const page=humanReviewBoardPage(p.plans[0],data,p.lint),group=page.split('data-card="group-4"')[1].split('</section>')[0];assert(!group.includes('NO_TIME_OBSERVATION_SENTINEL'));assert(!group.includes('原片观察摘录'));assert(group.includes('source-strip'),'the raw pictures must remain');}
 });
 await test('H8 planner HTML is byte-identical apart from the authorized board name',async()=>{
  const {transformSync}=await import('esbuild'),{blueprintReviewBoardPage}=await import('./blueprint-review-board-page');const original=await readFile(join(process.cwd(),'server/clipmentor/fixtures/planner-page-before-human-20261102.txt'),'utf8');const module={exports:{}};runInNewContext(transformSync(original,{loader:'ts',format:'cjs'}).code,{module,exports:module.exports});const render=(module.exports as any).blueprintReviewBoardPage;for(const board of planReviewBoards(input(green,bindings)).plans){board.generated_at='2026-11-02T00:00:00Z';assert.equal(blueprintReviewBoardPage(board),render(board).replaceAll('蓝图审片板','策划自查板'));}
 });
 await test('H1 human CLI publishes the exact immutable artifact via the existing product cache',async()=>{
  const {runReviewBoardCli}=await import('./blueprint-review-board-cli.mts'),{reviewBoardArtifactRoot}=await import('./blueprint-review-board-artifacts');const before=await readFile(candidate),r=await runReviewBoardCli([candidate,'--out',join(root,'human-cli'),'--view','human',...materialPaths.flatMap(p=>['--bindings',p]),'--media-dir',media]);const a=r.artifacts[0] as any;assert.equal(r.artifacts.length,1);assert(a.url);const url=new URL(a.url,'http://localhost'),cache=join(reviewBoardArtifactRoot(url.searchParams.get('projectId')!),url.searchParams.get('artifact')!);assert.deepEqual(await readFile(cache),await readFile(a.path));assert.equal(hash(await readFile(cache)),a.cached_sha256);assert(url.searchParams.get('projectId')!.endsWith(a.cached_sha256));assert.deepEqual(await readFile(candidate),before);assert.equal(networks,0);
 });
 await test('H7 human reuses the actual local SHA checking script',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');const p=planReviewBoards(input(green,bindings)),h=humanReviewBoardPage(p.plans[0],p.data,p.lint);let listener:(e:any)=>Promise<void>=async()=>{};const nodes=new Map<string,any>();const document={getElementById:(id:string)=>{if(!nodes.has(id))nodes.set(id,{textContent:'',className:'',addEventListener:(_n:string,fn:any)=>{listener=fn;}});return nodes.get(id);},querySelectorAll:()=>[]};runInNewContext(h.match(/<script>([\s\S]*?)<\/script>/)![1],{document,crypto:webcrypto,TextDecoder,TextEncoder,Uint8Array});const send=async(v:unknown)=>{const b=Buffer.from(JSON.stringify(v));await listener({target:{files:[{arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}]}});};await send(green);assert.match(nodes.get('freshness').textContent,/与此候选一致/);await send({...green,status:'different'});assert.match(nodes.get('freshness').textContent,/已过期/);
 });
 await test('Human view and CLI reject unknown views or quietly omitted endings',async()=>{
  const {runReviewBoardCli}=await import('./blueprint-review-board-cli.mts');await assert.rejects(runReviewBoardCli([candidate,'--out',join(root,'bad-view'),'--view','typo']),/INPUT/);await assert.rejects(renderReviewBoards(await generateInput(),join(root,'bad-view'),'new_contact','human'),/INPUT/);await assert.rejects(readdir(join(root,'bad-view')));
 });
 await test('A10 original read-only tool/HTTP saves artifact, cold project stays unchanged',async()=>{
  const {withSerializedProjectStore}=await import('../plugins/project-store'),{loadOfflineStoredProject}=await import('../external-agent/offline-project-store'),{clipMentorProductionPlugin}=await import('../plugins/clipmentor-production'),{executeTool}=await import('../../src/agent/tools'),{makeDraft}=await import('../../src/editor/store');
  const doc=bindings[0];await withSerializedProjectStore(s=>s.writeEntry('project:review-board-test',doc));const before=await loadOfflineStoredProject('review-board-test');assert(before,'test fixture must actually be a valid saved project');const app=createMiniConnect(e=>{throw e;}),server=createServer((req,res)=>app.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as {port:number},origin='http://127.0.0.1:'+address.port;
  (clipMentorProductionPlugin(async()=>{throw Error('No worker permitted');}).configureServer as any)({httpServer:server,config:{server:{}},middlewares:{use:(route:string,fn:any)=>app.use(route,fn)}});
  try{const draft=makeDraft(doc),ctx={...draft,templates:[],audio:[],getProjectId:()=> 'review-board-test',getCreativeMode:()=> 'clipmentor',hostFetch:async(path:string,init:RequestInit)=>realFetch(new URL(path,origin),{...init,headers:{Origin:origin}})} as never;const result=await executeTool('render_clipmentor_review_board',{},ctx) as any;assert(!result.error,JSON.stringify(result));assert(result.artifacts.length);const beforeDraft=JSON.stringify(draft.getDoc());const blocked=await executeTool('set_aspect_ratio',{ratio:'1:1'},ctx) as any;assert(blocked.production_gate?.code,'read preparation must not permit editing without current approval');assert.equal(JSON.stringify(draft.getDoc()),beforeDraft);assert.equal(result.review_approved,false);const human=await executeTool('render_clipmentor_review_board',{view:'human'},ctx) as any;assert(!human.error,JSON.stringify(human));assert.equal(human.artifacts.length,1);const humanPage=await realFetch(new URL(human.artifacts[0].url,origin),{headers:{Origin:origin}});const humanBytes=await humanPage.text();assert.match(humanBytes,/人审版/);const changed=clone(doc);(changed.clipMentorAnalysis!.product as any).name='QA later board only';await withSerializedProjectStore(s=>s.writeEntry('project:review-board-test',changed));try{const next=await executeTool('render_clipmentor_review_board',{view:'human'},{...ctx,getDoc:()=>changed}) as any;assert(!next.error,JSON.stringify(next));assert.notEqual(next.artifacts[0].url,human.artifacts[0].url,'human links must bind inspected HTML bytes, not mutable project filenames');const retained=await realFetch(new URL(human.artifacts[0].url,origin),{headers:{Origin:origin}});assert.equal(await retained.text(),humanBytes,'a later board cannot replace an already inspected link');}finally{await withSerializedProjectStore(s=>s.writeEntry('project:review-board-test',doc));}const wrongView=await executeTool('render_clipmentor_review_board',{view:'typo'},ctx) as any;assert.match(wrongView.error,/INPUT/);const stale=await realFetch(origin+'/api/clipmentor/production-task?'+new URLSearchParams({view:'review_board',projectId:'review-board-test',expectedRevision:'stale'}),{headers:{Origin:origin}});assert.equal(stale.status,409);const page=await realFetch(new URL(result.artifacts[0].url,origin),{headers:{Origin:origin}});assert.equal(page.status,200);assert.match(await page.text(),/策划自查板/);assert.deepEqual(await loadOfflineStoredProject('review-board-test'),before);assert.equal((await realFetch(origin+'/api/clipmentor/production-task?view=review_board&projectId=review-board-test')).status,403);}finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
 await test('P5 optional Chinese persists through the original temporary project store and cold read',async()=>{
  const {withSerializedProjectStore}=await import('../plugins/project-store'),{loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
  const doc=clone(bindings[0]);for(const e of doc.clipMentorAnalysis!.evidence)if(e.kind==='original_claim')e.meaning_zh='测试策划译文';
  for(const u of doc.clipMentorAnalysis!.blueprint){const ir=(u as any).internal_review;for(const l of ir[ir.current_script_candidate].lines)l.labels_zh=(l.labels??[]).map(()=> '测试短标译文');for(const l of ir[ir.current_picture_plan].selected_narration??[])l.labels_zh=(l.labels??[]).map(()=> '测试短标译文');for(const section of ir[ir.current_picture_plan].delivery_sections??[])section.line.labels_zh=section.line.labels.map(()=> '测试短标译文');}
  await withSerializedProjectStore(s=>s.writeEntry('project:human-translation-cold',doc));
  const cold=await loadOfflineStoredProject('human-translation-cold');assert(cold);assert.deepEqual(cold.doc,doc);
  const loaded=await loadReviewBoardInput('human-translation-cold');const ready=planReviewBoards(loaded);const claims=ready.data.analysis.evidence.filter(e=>e.kind==='original_claim');assert(claims.length>0&&claims.every(e=>e.meaning_zh==='测试策划译文'));
 });
 assert.equal(networks,0);
}finally{globalThis.fetch=realFetch;if(priorData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=priorData;await rm(root,{recursive:true,force:true});}
if(tests.some(t=>!t.pass))throw Error(JSON.stringify(tests.filter(t=>!t.pass)));console.log('Blueprint review board:',tests.length,'checks passed, external/provider calls=0');
