import type {ProductionInput} from './production-task';

/** Estimates and hard caps are frozen once at batch creation, never expanded by retry. */
export function panelProductionBudget():ProductionInput['budget'] {
 const routine={model:100,review:3,observation:3,tts:25,render:2,preview_review:3};
 return {...routine,model:200,review:6,observation:6,tts:50,render:4,preview_review:6,
  routine,maxElapsedMs:4*60*60*1000,maxRepairs:3};
}
export function outputProductionBudget(parent:ProductionInput['budget'],models:number):ProductionInput['budget'] {
 // One confirmed output: review + local repair; both variants share the remaining author/TTS pool.
 // Legacy explicitly authorized tasks keep their original contract.
 if(!parent.routine)return {model:models,review:3,observation:0,tts:50,render:1,preview_review:1,maxElapsedMs:4*60*60*1000,maxRepairs:3};
 const routine={model:Math.min(models,50),review:3,observation:1,tts:Math.min(parent.tts,25),render:1,preview_review:1};
 return {...routine,model:models,review:6,observation:2,tts:parent.tts,render:2,preview_review:2,
  routine,maxElapsedMs:parent.maxElapsedMs,maxRepairs:3};
}
