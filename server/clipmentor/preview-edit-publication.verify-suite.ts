import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ProjectDoc } from '../../src/editor/types';
import { buildPreviewRevision } from '../../src/clipmentor/preview-edit';
import { previewEditBridge, type PreviewEditPermit } from './preview-edit';

/** Local fake encoders exercise the real publication and render-binding path. */
export async function verifyPreviewMaterialPublication(root:string,doc:ProjectDoc,seed:PreviewEditPermit) {
  for(const kind of ['overlay','sniff_merge'] as const) {
    const cases:Array<{stage:number;outcome:'fail'|'same'|'wrong'}>=[
      ...Array.from({length:kind==='overlay'?2:3},(_,stage)=>({stage,outcome:'fail' as const})),
      {stage:0,outcome:'same'}, {stage:0,outcome:'wrong'},
    ];
    for(const {stage,outcome} of cases) {
      const operationId=randomUUID(),grant=join(root,seed.projectId,operationId);
      const permit:PreviewEditPermit=kind==='overlay'?{...seed,operationId}:{...seed,operationId,kind,
        removeFrames:[3,6],removeAudioSeconds:[.1,.2],sourceStartFrame:0,pictureFrames:3,captionFrames:2,captionReferenceFrame:6};
      await mkdir(grant,{recursive:true});await writeFile(join(grant,'permit.json'),JSON.stringify(permit));
      const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let executions=0;
      const bytes=(path:string)=>`complete fixture ${basename(path)}`;
      const execute=async(args:string[])=>{await writeFile(args.at(-1)!,bytes(args.at(-1)!));};
      const delayed=async(args:string[])=>{
        const path=args.at(-1)!;
        if(executions++===stage) {
          entered.resolve();await release.promise;
          if(outcome==='fail') {await writeFile(path,'');throw Error('fake late encoder failure');}
          if(outcome==='wrong') {await writeFile(path,'different complete fixture');return;}
        }
        await execute(args);
      };
      const deps={directory:root,resolve:(name:string)=>join(root,name),execute};
      const body={projectId:seed.projectId,operationId,doc,action:'prepare',...(kind==='overlay'?{tailFrame:2558}:{})};
      const late=previewEditBridge(body,{...deps,execute:delayed});
      const lateOutcome=outcome==='same'?late:assert.rejects(late,outcome==='fail'?/fake late encoder failure/:/content mismatch/);
      await entered.promise;
      const winner=await previewEditBridge(body,deps) as any,applied=buildPreviewRevision(doc,winner.plan);
      const check=()=>previewEditBridge({projectId:seed.projectId,operationId,action:'check_render',doc:applied},deps);
      await check();
      const prepared=await readFile(join(grant,'prepared.json'),'utf8');
      const materials=[...winner.plan.patches.map((patch:any)=>patch.asset),...(winner.plan.audio?[winner.plan.audio]:[])];
      const before=await Promise.all(materials.map((asset:any)=>readFile(join(root,asset.src.split('/').at(-1)))));
      release.resolve();const settled=await lateOutcome;
      if(outcome==='same')assert.deepEqual(settled,winner,'an exact late producer reads the existing winner');
      assert.equal(await readFile(join(grant,'prepared.json'),'utf8'),prepared);
      for(const [index,asset] of materials.entries())assert.deepEqual(await readFile(join(root,asset.src.split('/').at(-1))),before[index],
        `${kind} stage ${stage}/${outcome}: late output must never mutate winning material`);
      await check();
      assert(!(await readdir(root)).some(name=>name.startsWith('.preview-prepare-')),'every attempt removes its private output directory');
    }
  }
}
