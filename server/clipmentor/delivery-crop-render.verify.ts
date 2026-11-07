// Local regression only: real shared timeline renderer, installed headless binary,
// one-frame test compositions, no Agent/model/export job or production project.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {bundle} from '@remotion/bundler';
import {openBrowser,selectComposition,renderStill} from '@remotion/renderer';
import {deliveryPictureBinding,type DeliverySection} from '../../src/clipmentor/delivery-sections';
import {renderedVisualFrameRect} from '../../src/editor/visualFrameGeometry';
import {validateGenericUpdate} from '../../src/agent/tools/edit-item-generic';
import {copyReviewDependencies} from './copy-review';
import {ffmpegBin} from '../media-binaries';
import saved from '../../src/clipmentor/fixtures/delivery-review-inputs-20261029.json';
import type {ProjectDoc,ClipTransform} from '../../src/editor/types';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url))),exec=promisify(execFile),hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const argument=(n:string)=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
await mkdir(join(repo,'node_modules/.tmp'),{recursive:true});const dir=await mkdtemp(join(repo,'node_modules/.tmp/delivery-crop-'));
const out=argument('out-dir');if(out)await mkdir(out,{recursive:true});
const browserPlatform=process.platform==='darwin'?'mac':process.platform;
const browserPath=process.env.CC_BROWSER_EXECUTABLE??join(repo,'node_modules/.remotion/chrome-headless-shell',browserPlatform+'-'+process.arch,`chrome-headless-shell-${browserPlatform}-${process.arch}`,'chrome-headless-shell');
const started=performance.now();let browser:Awaited<ReturnType<typeof openBrowser>>|undefined;let renderedFrames=0;
try{
 await access(browserPath); // Never download a browser during a zero-call test.
 const imageArg=argument('image');let image:string;
 if(imageArg){image=resolve(imageArg);}else{
  const width=1587,height=2003,bytes=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=(y*width+x)*3;bytes[p]=Math.floor(x/40)%2?230:30;bytes[p+1]=Math.floor(y/40)%2?210:40;bytes[p+2]=(Math.floor(x/40)+Math.floor(y/40))%2?20:220;}
  const ppm=join(dir,'synthetic.ppm');await writeFile(ppm,Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`),bytes]));image=join(dir,'source.png');await exec(ffmpegBin(),['-v','error','-y','-i',ppm,image]);
 }
 const sourceBytes=await readFile(image),originalHash=hash(sourceBytes),data='data:image/png;base64,'+sourceBytes.toString('base64');
 const entry=join(dir,'entry.tsx');
 await writeFile(entry,`import React from 'react';import{registerRoot,Composition,AbsoluteFill,Img}from'remotion';import{TimelineComposition}from${JSON.stringify(join(repo,'src/editor/TimelineComposition'))};
const View=({mode,state,reference})=>mode==='reference'?<AbsoluteFill><div style={{position:'absolute',left:reference.rect.x,top:reference.rect.y,width:reference.rect.width,height:reference.rect.height,overflow:'hidden'}}><Img src={state.items[0].src} style={{position:'absolute',left:reference.frame.x-reference.rect.x,top:reference.frame.y-reference.rect.y,width:reference.frame.width,height:reference.frame.height,objectFit:state.fit==='cover'?'cover':'fill'}}/></div></AbsoluteFill>:<TimelineComposition state={state} transparent/>;
registerRoot(()=> <Composition id="crop-regression" component={View} defaultProps={{mode:'actual',state:{width:576,height:1024,fps:30,items:[],selectedId:null},reference:{}}} width={576} height={1024} fps={30} durationInFrames={1} calculateMetadata={({props})=>({width:props.state.width,height:props.state.height,durationInFrames:1,fps:30})}/>);`);
 await mkdir(join(dir,'public'));const serveUrl=await bundle({entryPoint:entry,publicDir:join(dir,'public'),outDir:join(dir,'bundle'),webpackOverride:config=>({...config,resolve:{...config.resolve,extensionAlias:{...config.resolve?.extensionAlias,'.js':['.js','.ts','.tsx']}},module:{...config.module,rules:[...(config.module?.rules??[]),{test:/\.frag$/,type:'asset/source'}]}})});
 browser=await openBrowser('chrome',{browserExecutable:browserPath,chromiumOptions:{gl:'swangle'}});
 const imagePixels=async(file:string)=>(await exec(ffmpegBin(),['-v','error','-i',file,'-f','rawvideo','-pix_fmt','rgba','-'],{encoding:'buffer',maxBuffer:64*1024*1024})).stdout;
 const results=[];
 for(const canvas of [{width:576,height:1024,fit:'contain' as const},{width:576,height:1024,fit:'cover' as const},{width:1587,height:2003,fit:'contain' as const}]){
  const section=structuredClone(saved.request.packet.delivery_sections![1]) as DeliverySection;
  const source={width:1587,height:2003},asset={id:section.picture.asset_id,kind:'image',src:section.picture.src,sourceContentHash:section.picture.sha256,...source};
  const imageItem={id:'image',kind:'image',sourceAssetId:asset.id,src:section.picture.src,track:'V1',startFrame:0,durationInFrames:1,...source};
  const doc={version:1,assets:[asset],activeTimelineId:'test',mediaFolders:[],timelines:[{id:'test',...canvas,fps:30,items:[imageItem],selectedId:null}]} as unknown as ProjectDoc;
  const binding=deliveryPictureBinding(doc,section),validated=validateGenericUpdate(doc.timelines[0],{type:'image',itemId:'image',transform:{crop:binding.tool_crop_px}});assert.equal(validated.error,undefined);doc.timelines[0].items[0].transform=validated.transform as ClipTransform;
  // Reference comes directly from the reviewed original-pixel rectangle, not a
  // second use of deliveryPictureBinding's calculated canvas crop.
  const sc=Math.max(canvas.width/source.width,canvas.height/source.height);
  const sourceFrame=canvas.fit==='cover'?{x:(canvas.width-source.width*sc)/2,y:(canvas.height-source.height*sc)/2,width:source.width*sc,height:source.height*sc}:renderedVisualFrameRect(canvas,source,'contain');
  const frame=canvas.fit==='cover'?{x:0,y:0,width:canvas.width,height:canvas.height}:sourceFrame;
  const x=Math.round(sourceFrame.x+432/1587*sourceFrame.width),y=Math.round(sourceFrame.y+550/2003*sourceFrame.height);
  const rect={x,y,width:Math.round(sourceFrame.x+832/1587*sourceFrame.width)-x,height:Math.round(sourceFrame.y+910/2003*sourceFrame.height)-y};
  const state={...doc.timelines[0],items:[{...doc.timelines[0].items[0],src:data}]};
  const inputProps={mode:'actual',state,reference:{rect,frame}};
  const render=async(mode:string,item=state.items[0])=>{const path=join(out??dir,`${canvas.width}x${canvas.height}-${canvas.fit}-${mode}.png`);const props={...inputProps,mode:mode==='reference'?'reference':'actual',state:{...state,items:[item]}};const composition=await selectComposition({serveUrl,id:'crop-regression',inputProps:props,puppeteerInstance:browser});await renderStill({serveUrl,composition,inputProps:props,frame:0,imageFormat:'png',output:path,puppeteerInstance:browser,chromiumOptions:{gl:'swangle'},timeoutInMilliseconds:60000});renderedFrames++;return path;};
  const actual=await render('actual'),reference=await render('reference');assert.deepEqual(await imagePixels(actual),await imagePixels(reference),'actual TimelineComposition pixels must match the independent reviewed-region reference');
  if(canvas.width===576&&canvas.fit==='contain'){const bad=await render('old-wrong',{...state.items[0],transform:{crop:section.picture.crop}});assert.notEqual(hash(await imagePixels(bad)),hash(await imagePixels(reference)),'the original coordinate bug must visibly differ');}
  if(canvas.width===1587){
   const actualCrop=join(out??dir,'execution-crop.jpg'),reviewCrop=join(out??dir,'review-crop.jpg');await exec(ffmpegBin(),['-v','error','-y','-i',actual,'-vf','crop=400:360:432:550:exact=1','-frames:v','1','-q:v','4',actualCrop]);
   await copyReviewDependencies().frame(image,0,reviewCrop,section.picture.crop);assert.deepEqual(await imagePixels(actualCrop),await imagePixels(reviewCrop),'at native scale, review crop and actual renderer crop are pixel-identical after the same JPEG encoding');
  }
  results.push({canvas,binding,actual,reference,identicalPixels:true});
 }
 assert.equal(hash(await readFile(image)),originalHash);const report={status:'passed',realProviderCalls:0,productionExportJobs:0,localTestFrames:renderedFrames,sourceUnchanged:true,elapsedMs:Math.round(performance.now()-started),results};if(out)await writeFile(join(out,'实际渲染像素核对.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(browser)await browser.close({silent:true});await rm(dir,{recursive:true,force:true});}
