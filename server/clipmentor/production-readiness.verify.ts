import assert from 'node:assert/strict';
import {matchMeasuredNarration} from './production-readiness';
import type {MediaAsset} from '../../src/editor/types';
const voice={provider:'minimax',voiceId:'confirmed'};
const lines=[{line_id:'A',narration_ms:'Close-up comparison.'},{line_id:'B',narration_ms:'Usage sequence.'}];
const assets:MediaAsset[]=lines.map((l,i)=>({id:`audio-${i}`,kind:'audio',name:'fixture',src:'/media/uploads/fixture.mp3',durationInFrames:90,
 props:{generation:{...voice,text:l.narration_ms,speed:1,durationSeconds:3}}}));
assert.equal(matchMeasuredNarration(lines,assets,voice).length,2);
assert.throws(()=>matchMeasuredNarration(lines,[assets[0]],voice),/B/,'one audio does not satisfy the whole group');
for(const patch of [{text:'stale copy'},{speed:1.2},{durationSeconds:0},{durationSeconds:NaN},{voiceId:'unconfirmed'}]){
 const bad=structuredClone(assets);Object.assign(bad[1].props!.generation as object,patch);assert.throws(()=>matchMeasuredNarration(lines,bad,voice));
}
assert.throws(()=>matchMeasuredNarration(lines,[{...assets[0],props:{}}],voice));
console.log('production readiness: exact current text, confirmed voice, measured duration and normal speed per line; missing/stale/speed-up cases refused, valid group accepted');
