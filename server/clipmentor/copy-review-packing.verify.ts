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

// The sampler must let duplicate uses reach the existing lossless packer.
const {reviewSourceSamples}=await import('./copy-review');
const ranges=Array.from({length:10},(_,i)=>[i*0.3,i*0.3+0.2]);
const request={source:{duration:30,fps:30},packet:{units:[{unit_id:'U',points:[],picture_plan:{original_source_ranges:ranges,explanation_source_ranges:ranges,line_source_ranges:[]}}]}} as any;
const uses=reviewSourceSamples(request);
assert(uses.length>48,'fixture must exceed the pre-packing cap');
const wire=fitReviewSourceSamples(uses,0);assert(wire.length<=48);
for(const use of uses)assert(wire.some(f=>f.source_seconds===use.source_seconds&&(f.source_uses??[f]).some(u=>u.unit_id===use.unit_id&&u.phase===use.phase)));
const tooMany=structuredClone(request);tooMany.packet.units[0].picture_plan.original_source_ranges=Array.from({length:20},(_,i)=>[i,i+0.8]);tooMany.packet.units[0].picture_plan.explanation_source_ranges=[];
assert.throws(()=>fitReviewSourceSamples(reviewSourceSamples(tooMany),0),/no evidence truncated/);
assert.throws(()=>reviewSourceSamples({source:request.source,packet:{units:[]}} as any),/source samples/);
console.log('sampler-to-packer: over-48 duplicate uses retained, true wire overflow and empty inputs refused');
