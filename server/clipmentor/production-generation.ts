import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

export interface ProductionGeneration {
 qualityRules:'v1';
 referenceRules?:'registered-v1';
 creatorRules?:'creator-teaching-v1';
 commit?:string;
 trackedChanges?:boolean;
}

declare const __CLIPMENTOR_PRODUCTION_BUILD__: ProductionGeneration | undefined;

/** Capture the service's source/build identity once, when this module loads. */
export const loadedProductionGeneration:Promise<ProductionGeneration>=(async()=>{
 const rules={qualityRules:'v1',referenceRules:'registered-v1',creatorRules:'creator-teaching-v1'} as const;
 if(typeof __CLIPMENTOR_PRODUCTION_BUILD__!=='undefined')return {...__CLIPMENTOR_PRODUCTION_BUILD__,...rules};
 const built=process.env.OPENCHATCUT_BUILD_COMMIT;
 if(built&&/^[a-f0-9]{40}$/u.test(built))return {...rules,commit:built};
 try{
  const git=promisify(execFile);
  const cwd=fileURLToPath(new URL('../../',import.meta.url));
  const [revision,changes]=await Promise.all([
   git('git',['rev-parse','HEAD'],{cwd,timeout:2000}),
   git('git',['--no-optional-locks','status','--porcelain','--untracked-files=no'],{cwd,timeout:2000}),
  ]);
  const commit=revision.stdout.trim();
  if(/^[a-f0-9]{40}$/u.test(commit))return {...rules,commit,trackedChanges:!!changes.stdout.trim()};
 }catch{/* Packaged installs can lack Git and a build stamp. */}
 return rules;
})();
