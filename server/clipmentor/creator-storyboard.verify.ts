import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {ProjectDoc} from '../../src/editor/types';
import type {CreatorStoryboardDocument} from './creator-storyboard-document';
const directory=await mkdtemp(join(tmpdir(),'creator-storyboard-test-'));
process.env.OPENCHATCUT_DATA_DIR=directory;
const {creatorStoryboard}=await import('./creator-storyboard');
const {validateCreatorDocument,assertCreatorDocumentEdit,saveCreatorStoryboardDocument,loadCreatorStoryboardDocument}=await import('./creator-storyboard-document');
const {assertCreatorDocumentPdf,renderCreatorDocument}=await import('./creator-storyboard-pdf');
const {installedRenderBrowserExecutable}=await import('../render-browser');
const {createPanelStoryboard,panelStoryboardAsset,preparePanelStoryboardForAuthor,preparePanelPartnerCard,panelPartnerPicture,verifyPanelPartnerCard}=await import('./production-panel-delivery');
const {deliveryFileName,attachmentDisposition}=await import('./delivery-filename');
const {uploadDir}=await import('../media-dir');
const {ffmpegBin}=await import('../media-binaries');
try{
 const previousBrowser=process.env.CC_BROWSER_EXECUTABLE,missingBrowserPath=join(directory,'missing-test-browser');
 const os=(await import('node:os')).default,oldPlatform=os.platform,oldArch=os.arch;
 try{
  delete process.env.CC_BROWSER_EXECUTABLE;
  for(const [platform,arch,folder,executable]of [
   ['linux','x64','linux64','chrome-headless-shell'],['linux','arm64','linux-arm64','headless_shell'],
   ['win32','x64','win64','chrome-headless-shell.exe'],['darwin','arm64','mac-arm64','chrome-headless-shell'],['darwin','x64','mac-x64','chrome-headless-shell'],
  ] as const){
   os.platform=()=>platform;os.arch=()=>arch;
   assert(installedRenderBrowserExecutable().endsWith(join(folder,`chrome-headless-shell-${folder}`,executable)),`${platform}/${arch} uses the installed engine's mapping`);
  }
 }finally{os.platform=oldPlatform;os.arch=oldArch;if(previousBrowser!==undefined)process.env.CC_BROWSER_EXECUTABLE=previousBrowser;}

 try{process.env.CC_BROWSER_EXECUTABLE=missingBrowserPath;assert.equal(installedRenderBrowserExecutable(),missingBrowserPath);
  await assert.rejects(renderCreatorDocument('<html></html>',new AbortController().signal),/ENOENT/);
 }finally{if(previousBrowser===undefined)delete process.env.CC_BROWSER_EXECUTABLE;else process.env.CC_BROWSER_EXECUTABLE=previousBrowser;}
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(renderCreatorDocument('<html></html>',cancelled.signal),/abort/i);
 const media=uploadDir();await mkdir(media,{recursive:true});const file=join(media,'source.mp4');
 execFileSync(ffmpegBin(),['-v','error','-f','lavfi','-i','color=c=red:s=96x160:r=10','-t','4','-c:v','libx264','-pix_fmt','yuv420p',file]);
 const sourceBytes=await readFile(file),sha=createHash('sha256').update(sourceBytes).digest('hex');
 const doc={assets:[{id:'source',src:'/media/uploads/source.mp4',kind:'video',sourceContentHash:sha}],clipMentorAnalysis:{product:{name:'JUDYDOLL'},source:{asset_id:'source',sourceContentHash:sha,duration_seconds:4,fps:10},
  evidence:[{evidence_id:'claim',kind:'original_claim',text:'Ini warna pilihan saya.',source_ids:['source'],call_status:'succeeded',source_range_seconds:[0,4]}],
  source_breakdown:{segments:[{segment_id:'one',source_range_seconds:[0,4],claim_evidence_ids:['claim']}],units:[{original_segment_ids:['one']}]}}} as unknown as ProjectDoc;
 await (await import('./creator-storyboard.verify-fixtures')).writeStoryboardFixtureReceipt(doc,directory);
 const content=doc.assets[0].props!.clipmentorCreatorStoryboard as CreatorStoryboardDocument;
 const before=JSON.stringify(doc),[a,b]=await Promise.all([creatorStoryboard(doc),creatorStoryboard(doc)]);
 assert.equal(a,b,'concurrent identical documents share work');assert.equal(a.bytes.subarray(0,5).toString(),'%PDF-');assert.equal(a.pages,1);
 await assertCreatorDocumentPdf(a.bytes,['Masa','Shot / aksi','Maklumat sari kata / suara',content.rows[0].shot_ms,content.rows[0].information_ms,'Rootify'],1);
 await assert.rejects(assertCreatorDocumentPdf(a.bytes,['missing action description'],1),/text_missing/,'PDF validity alone cannot certify missing content');
 assert.equal(JSON.stringify(doc),before);assert.deepEqual(await readFile(file),sourceBytes);
 for(const key of ['shot_ms','information_ms'] as const){const v=structuredClone(content);v.rows[0][key]='';assert.throws(()=>validateCreatorDocument(doc,v),/copy_missing/);}
 const wrongFrame=structuredClone(content);wrongFrame.rows[0].source_frames=[999];assert.throws(()=>validateCreatorDocument(doc,wrongFrame),/range_or_frame/);
 const gap=structuredClone(content);gap.rows[0].source_range_seconds=[1,4];assert.throws(()=>validateCreatorDocument(doc,gap),/range_or_frame/);
 const partial=structuredClone(doc);partial.clipMentorAnalysis!.source_breakdown!.units[0].original_source_ranges=[[0,2]];
 assert.equal((await creatorStoryboard(partial)).bytes,a.bytes,'teaching playback may select only part of the original; standalone document remains complete');
 const missing=structuredClone(doc);missing.clipMentorAnalysis!.evidence=[];await assert.rejects(creatorStoryboard(missing),/evidence_invalid/);
 const unrelated=structuredClone(doc);unrelated.assets.unshift({id:'reference',kind:'image',src:'',props:{clipmentorCreatorStoryboard:{source_sha256:'wrong'}}});
 assert.deepEqual(await loadCreatorStoryboardDocument(unrelated),content,'unrelated reference metadata cannot shadow the original document');
 const silent=structuredClone(doc);(silent.assets[0].props!.clipmentorCreatorStoryboard as CreatorStoryboardDocument).rows[0].claim_evidence_ids=[];
 (silent.assets[0].props!.clipmentorCreatorStoryboard as CreatorStoryboardDocument).rows[0].information_ms='Paparan warna pada palet.';
 silent.clipMentorAnalysis!.evidence=silent.clipMentorAnalysis!.evidence.filter(e=>e.kind!=='original_claim');assert.equal((await creatorStoryboard(silent)).pages,1,'no speech is required for a visible-only source segment');
 const mixed=structuredClone(doc);mixed.clipMentorAnalysis!.evidence[0].source_ids.unshift('source','missing-reference');assert.equal((await creatorStoryboard(mixed)).pages,1);
 const duplicate=structuredClone(doc),quote=structuredClone(duplicate.clipMentorAnalysis!.evidence[0]);duplicate.clipMentorAnalysis!.evidence[0].source_ids=['source'];quote.evidence_id='duplicate';duplicate.clipMentorAnalysis!.evidence.push(quote);assert.equal((await creatorStoryboard(duplicate)).pages,1,'equivalent evidence unions valid receipt origins');
 const direct=structuredClone(doc);direct.clipMentorAnalysis!.evidence[0].source_ids=['source'];await assert.rejects(creatorStoryboard(direct),/excerpt_changed:claim/);
 const tampered=structuredClone(doc);tampered.clipMentorAnalysis!.evidence[0].text='Beli sekarang.';await assert.rejects(creatorStoryboard(tampered),/excerpt_changed/);
 await saveCreatorStoryboardDocument(doc,content);const stored=structuredClone(doc);delete stored.assets[0].props!.clipmentorCreatorStoryboard;assert.deepEqual(await loadCreatorStoryboardDocument(stored),content);
 const changedEvidence=structuredClone(stored);changedEvidence.clipMentorAnalysis!.evidence[0].text='changed';await assert.rejects(loadCreatorStoryboardDocument(changedEvidence),/evidence_changed/);
 const longWord=structuredClone(doc);(longWord.assets[0].props!.clipmentorCreatorStoryboard as CreatorStoryboardDocument).rows[0].information_ms='W'.repeat(20);assert.equal((await creatorStoryboard(longWord)).pages,1,'long words wrap within their own column');
 const tooLong=structuredClone(doc);(tooLong.assets[0].props!.clipmentorCreatorStoryboard as CreatorStoryboardDocument).rows[0].information_ms='word '.repeat(230);
 assert.equal((await preparePanelStoryboardForAuthor(tooLong,new AbortController().signal)).issue,'storyboard_document_layout_overflow','saved overflow comes back to the author instead of blocking author execution');
 assert.equal((await preparePanelStoryboardForAuthor(tooLong,new AbortController().signal)).issue,'storyboard_document_layout_overflow','recovery also exposes the same author-repairable issue');
 assert((await preparePanelStoryboardForAuthor(doc,new AbortController().signal)).asset,'corrected author copy can resume local generation');
 const first=await createPanelStoryboard(doc,new AbortController().signal);assert(first);doc.assets.push(first!);
 const canonicalOrder=JSON.parse(JSON.stringify(doc,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):value)) as ProjectDoc;
 assert.equal(panelStoryboardAsset(canonicalOrder)?.id,first!.id,'the saved cover survives project key sorting');
 assert.equal(await createPanelStoryboard(canonicalOrder,new AbortController().signal),undefined,'unchanged cold-read document reuses its existing cover');
 const coverPath=join(media,first.src.split('/').at(-1)!);
 const originalCover=await readFile(coverPath);
 const sharp=(await import('sharp')).default;
 const scope={productAssetId:'partner-product',productAssetHash:'',salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:'c'.repeat(64),
  partnerEnding:'product_storyboard_pdf' as const};
 for(const [number,color] of ['#135a9a','#691764'].entries()){
  const product=await sharp({create:{width:160,height:200,channels:3,background:color}}).png().toBuffer();
  const id='partner-product-'+number,name=id+'.png';await writeFile(join(media,name),product);
  scope.productAssetId=id;scope.productAssetHash=createHash('sha256').update(product).digest('hex');
  doc.assets.push({id,kind:'image',name,src:'/media/uploads/'+name,sourceContentHash:scope.productAssetHash,durationInFrames:1});
  const built=await preparePanelPartnerCard(doc,scope,new AbortController().signal);
  assert(built);doc.assets.push(built);
  const picture=panelPartnerPicture(doc,scope);assert(picture);
  assert.equal(picture.layout.product.asset_id,id);
  assert.equal(picture.layout.storyboard.asset_id,first.id);
  assert.equal(await verifyPanelPartnerCard(doc,scope,undefined,picture),true);
  assert.equal(await preparePanelPartnerCard(doc,scope,new AbortController().signal),undefined,'same assets reuse their composition');
  const output=await readFile(join(media,built.src.split('/').at(-1)!));
  const [left,right]=await Promise.all([[160,532],[503,532]].map(([x,y])=>sharp(output)
   .extract({left:x,top:y,width:1,height:1}).raw().toBuffer()));
  assert.equal(left.toString('hex'),color.slice(1),'actual pixels contain the product on the left');
  assert.notDeepEqual(left,right,'actual arrangement did not replicate the product on both sides');
  const verifyRegisteredReplacement=async(bytes:Buffer)=>{
   const sha256=createHash('sha256').update(bytes).digest('hex'),assetId='clipmentor-partner-'+sha256;
   const src='/media/uploads/'+assetId+'.png';
   await writeFile(join(media,assetId+'.png'),bytes);
   const replaced={...doc,assets:doc.assets.map(asset=>asset.id===built.id?{...asset,id:assetId,src,sourceContentHash:sha256}:asset)};
   const impostor=panelPartnerPicture(replaced,scope);
   assert.equal(impostor?.asset_id,assetId,'the replacement passes registration before pixel verification');
   return verifyPanelPartnerCard(replaced,scope,undefined,impostor);
  };
  const fake=await sharp(originalCover).resize(720,1280,{fit:'contain'}).png().toBuffer();
  assert.equal(await verifyRegisteredReplacement(fake),false,'correct role IDs cannot certify cover-only pixels');
  const rgba=await sharp(output).ensureAlpha().raw().toBuffer();
  for(let offset=3;offset<rgba.length;offset+=4)rgba[offset]=0;
  const transparent=await sharp(rgba,{raw:{width:720,height:1280,channels:4}}).png().toBuffer();
  assert.equal(await verifyRegisteredReplacement(transparent),false,'hidden pixels cannot certify visible roles');

 }

 const wrongCover=await sharp({create:{width:1190,height:1684,channels:3,background:'#162222'}}).jpeg().toBuffer();
 const wrongHash=createHash('sha256').update(wrongCover).digest('hex'),wrongId='clipmentor-storyboard-'+wrongHash;
 await writeFile(join(media,wrongId+'.jpg'),wrongCover);
 const forged={...doc,assets:doc.assets.map(asset=>asset.id===first.id?
  {...asset,id:wrongId,src:'/media/uploads/'+wrongId+'.jpg',sourceContentHash:wrongHash}:asset)};
 assert.equal(panelStoryboardAsset(forged)?.id,wrongId,'the forged cover has matching claims and file identity');
 const regenerated=await createPanelStoryboard(forged,new AbortController().signal,true);
 assert.equal(regenerated?.id,first.id,'the strict repair produces the current source cover from canonical evidence');
 assert.deepEqual(await readFile(coverPath),originalCover);
 await rm(coverPath);
 assert.equal(await createPanelStoryboard(doc,new AbortController().signal),undefined,'a recovered cover retains the registered asset');
 assert.deepEqual(await readFile(coverPath),originalCover);
 await writeFile(coverPath,'damaged cover');
 assert.equal(await createPanelStoryboard(doc,new AbortController().signal),undefined);
 assert.deepEqual(await readFile(coverPath),originalCover,'recovery restores the exact approved bytes');
 (doc.assets[0].props!.clipmentorCreatorStoryboard as CreatorStoryboardDocument).rows[0].shot_ms='Dia memegang palet di hadapan kamera.';
 assert.equal(panelStoryboardAsset(doc),undefined,'an old cover is not current after author-copy changes');
 const fresh=await createPanelStoryboard(doc,new AbortController().signal);assert(fresh);doc.assets.push(fresh!);assert.equal(panelStoryboardAsset(doc)?.id,fresh!.id,'old assets remain saved but cannot shadow the new cover');
 assert.doesNotThrow(()=>assertCreatorDocumentEdit(doc,{action:'update',assetId:'source',props:{clipmentorCreatorStoryboard:content}}));
 for(const patch of [{action:'delete'},{assetId:'source-poster'},{code:'x'},{props:{other:1,clipmentorCreatorStoryboard:content}}])assert.throws(()=>assertCreatorDocumentEdit(doc,{action:'update',assetId:'source',props:{clipmentorCreatorStoryboard:content},...patch}),/only_creator_document/);
 const {openHeadlessEditor}=await import('./headless-editor');
 const {MemoryPersistence,projectDoc,projectId}=await import('../external-agent/offline-runtime.verify-fixtures');
 const original=JSON.parse(await readFile(new URL('../../src/clipmentor/fixtures/grouped-registration-v1.json',import.meta.url),'utf8')) as ProjectDoc;
 const analysis=original.clipMentorAnalysis!,duration=analysis.source.duration_seconds,sourceId=analysis.source.asset_id;
 const source=original.assets.find(asset=>asset.id===sourceId)!;
 const storyboardFixture={...projectDoc(),assets:[{...source,props:{marker:'preserve'}}],clipMentorAnalysis:analysis};
 analysis.evidence.push({evidence_id:'draft-fixture-action',kind:'visible_action',text:'The product is visible.',source_range_seconds:[0,duration],source_ids:[sourceId],supporting_evidence_ids:[],status:'fixture',observation_method:'fixture',call_status:'succeeded'});
 const draftDocument={source_sha256:analysis.source.sourceContentHash,rows:[{source_range_seconds:[0,duration],source_frames:[0],shot_ms:'Produk kelihatan.',information_ms:'Produk dipaparkan.',visible_evidence_ids:['draft-fixture-action'],claim_evidence_ids:[]}]};
 const write={action:'update',assetId:sourceId,props:{clipmentorCreatorStoryboard:draftDocument}};
 for(const creatorStoryboardDraft of [false,true]){
  const persistence=new MemoryPersistence(storyboardFixture);
  const editor=await openHeadlessEditor({projectId,runId:'storyboard-fixture',origin:'http://127.0.0.1:5199',review:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199'},
   creatorStoryboardDraft,persistence,browserConnected:()=>false,fetch:async()=>{throw Error('unexpected request');},effect:async()=>{throw Error('unexpected effect');}});
  try{
   const result=await editor.execute('edit_asset',write,'storyboard-draft') as {saved?:boolean;production_gate?:{allowed:boolean}};
   if(!creatorStoryboardDraft){assert.equal(result.production_gate?.allowed,false);assert.equal(persistence.commitCount,0);continue;}
   assert.equal(result.saved,true,'the real planning editor must save valid storyboard metadata before copy review');
   assert.deepEqual(persistence.current.assets[0].props,{marker:'preserve',clipmentorCreatorStoryboard:draftDocument});
   assert.deepEqual(persistence.current.timelines,storyboardFixture.timelines);
   assert.deepEqual(persistence.current.clipMentorAnalysis,analysis);
   await assert.rejects(editor.execute('edit_asset',{...write,name:'changed'},'unrelated-write'),/only_creator_document/);
   const denied=await editor.execute('clear_timeline',{},'unreviewed-edit') as {production_gate?:{allowed:boolean}};
   assert.equal(denied.production_gate?.allowed,false);
   assert.equal(persistence.commitCount,1);
  }finally{await editor.close();}
 }
 await assert.rejects(creatorStoryboard(doc,AbortSignal.abort(Error('cancelled'))),/cancelled/);
 await writeFile(file,'changed');await assert.rejects(creatorStoryboard(doc),/source_changed/);
 const name=deliveryFileName('../JUDYDOLL\r\n','new_contact','video',Date.UTC(2026,10,9,1,2,3));assert.match(name,/JUDYDOLL_视频拆解_新建联达人版_20261109_090203.mp4$/);assert(!/[\r\n/]/.test(name));
 for(const product of ['A'.repeat(63)+'😀','JUDYDOLL\ud800'])assert.doesNotThrow(()=>attachmentDisposition(deliveryFileName(product,'new_contact','video',0)));
 console.log('Creator Storyboard: native searchable 3-column PDF, authored actions/info, complete original vs partial teaching, silent segments, source-only metadata, receipt integrity, old-cover invalidation, overflow repair/resume, exact scoped edits, cancellation and names passed; zero provider calls.');
}finally{await rm(directory,{recursive:true,force:true});}
