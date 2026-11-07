import assert from 'node:assert/strict';
import {fitReviewSourceSamples,reviewFrameLabel} from './copy-review';
const original=Array.from({length:28},(_,i)=>({unit_id:'U-'+i,phase:'original' as const,source_seconds:i}));
const repeated=original.slice(0,15).map(p=>({...p,phase:'explanation' as const}));
const input=[...original,...repeated],before=structuredClone(input);
assert.equal(input.length+6,49);
const packed=fitReviewSourceSamples(input,6);
assert.equal(packed.length,28);assert.deepEqual(input,before);
for(const p of input){const found=packed.find(q=>q.source_seconds===p.source_seconds)!;const label=reviewFrameLabel({...found,base64:'YQ=='});assert(label.includes(`${p.unit_id}/${p.phase}`));}
assert.equal(fitReviewSourceSamples(input,5),input);
assert.throws(()=>fitReviewSourceSamples(Array.from({length:43},(_,i)=>({...original[0],source_seconds:i})),6),/no evidence truncated/);
const cross=[...input,{...original[0],unit_id:'another',phase:'context' as const}];
assert(reviewFrameLabel({...fitReviewSourceSamples(cross,6)[0],base64:'YQ=='}).includes('another/context'));
console.log('review packing: boundary, preserved associations, no truncation, normal compatibility passed');
