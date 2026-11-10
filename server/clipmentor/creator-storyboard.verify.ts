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
const {createPanelStoryboard,panelStoryboardAsset,preparePanelStoryboardForAuthor}=await import('./production-panel-delivery');
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
 const direct=structuredClone(doc);direct.clipMentorAnalysis!.evidence[0].source_ids=['source'];await assert.rejects(creatorStoryboard(direct),/excerpt_changed/);
 const tampered=structuredClone(doc);tampered.clipMentorAnalysis!.evidence[0].text='Beli sekarang.';await assert.rejects(creatorStoryboard(tampered),/excerpt_changed/);
 await saveCreatorStoryboardDocument(doc,content);const stored=structuredClone(doc);delete stored.assets[0].props!.clipmentorCreatorStoryboard;assert.deepEqual(await loadCreatorStoryboardDocument(stored),content);
 const changedEvidence=structuredClone(stored);changedEvidence.clipMentorAnalysis!.evidence[0].text='changed';await assert.rejects(loadCreatorStoryboardDocument(changedEvidence),/evidence_changed/);
 const longWord=structuredClone(doc);(longWord.assets[0].props!.clipmentorCreatorStoryboard as CreatorStoryboardDocument).rows[0].information_ms='W'.repeat(20);assert.equal((await creatorStoryboard(longWord)).pages,1,'long words wrap within their own column');
 const tooLong=structuredClone(doc);(tooLong.assets[0].props!.clipmentorCreatorStoryboard as CreatorStoryboardDocument).rows[0].information_ms='word '.repeat(230);
 assert.equal((await preparePanelStoryboardForAuthor(tooLong,new AbortController().signal)).issue,'storyboard_document_layout_overflow','saved overflow comes back to the author instead of blocking author execution');
 assert.equal((await preparePanelStoryboardForAuthor(tooLong,new AbortController().signal)).issue,'storyboard_document_layout_overflow','recovery also exposes the same author-repairable issue');
 assert((await preparePanelStoryboardForAuthor(doc,new AbortController().signal)).asset,'corrected author copy can resume local generation');
 const first=await createPanelStoryboard(doc,new AbortController().signal);assert(first);doc.assets.push(first!);
 (doc.assets[0].props!.clipmentorCreatorStoryboard as CreatorStoryboardDocument).rows[0].shot_ms='Dia memegang palet di hadapan kamera.';
 assert.equal(panelStoryboardAsset(doc),undefined,'an old cover is not current after author-copy changes');
 const fresh=await createPanelStoryboard(doc,new AbortController().signal);assert(fresh);doc.assets.push(fresh!);assert.equal(panelStoryboardAsset(doc)?.id,fresh!.id,'old assets remain saved but cannot shadow the new cover');
 assert.doesNotThrow(()=>assertCreatorDocumentEdit(doc,{action:'update',assetId:'source',props:{clipmentorCreatorStoryboard:content}}));
 for(const patch of [{action:'delete'},{assetId:'source-poster'},{code:'x'},{props:{other:1,clipmentorCreatorStoryboard:content}}])assert.throws(()=>assertCreatorDocumentEdit(doc,{action:'update',assetId:'source',props:{clipmentorCreatorStoryboard:content},...patch}),/only_creator_document/);
 await assert.rejects(creatorStoryboard(doc,AbortSignal.abort(Error('cancelled'))),/cancelled/);
 await writeFile(file,'changed');await assert.rejects(creatorStoryboard(doc),/source_changed/);
 const name=deliveryFileName('../JUDYDOLL\r\n','new_contact','video',Date.UTC(2026,10,9,1,2,3));assert.match(name,/JUDYDOLL_视频拆解_新建联达人版_20261109_090203.mp4$/);assert(!/[\r\n/]/.test(name));
 for(const product of ['A'.repeat(63)+'😀','JUDYDOLL\ud800'])assert.doesNotThrow(()=>attachmentDisposition(deliveryFileName(product,'new_contact','video',0)));
 console.log('Creator Storyboard: native searchable 3-column PDF, authored actions/info, complete original vs partial teaching, silent segments, source-only metadata, receipt integrity, old-cover invalidation, overflow repair/resume, exact scoped edits, cancellation and names passed; zero provider calls.');
}finally{await rm(directory,{recursive:true,force:true});}
