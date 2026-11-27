import test from 'node:test'
import assert from 'node:assert/strict'
import { productionProgress, reviewableBlueprintRevision } from '../src/pages/productionPanelState.js'
test('confirmed production hides old board but revised content remains reviewable',()=>{
const saved={status:'blocked',stage:'copy_review',revision:'v3',blueprintRevision:'v3',blueprintConfirmed:true}
assert.equal(reviewableBlueprintRevision(saved),undefined,'confirmed production must not reopen review')
assert.equal(reviewableBlueprintRevision({...saved,status:'running'}),undefined)
assert.equal(reviewableBlueprintRevision({...saved,status:'awaiting_review'}),undefined,'preview cannot show old board')
assert.equal(reviewableBlueprintRevision({...saved,status:'awaiting_blueprint'}),'v3','changed content still needs human review')
assert.equal(reviewableBlueprintRevision({...saved,blueprintConfirmed:false}),'v3','initial draft remains reviewable')
})

test('shared progress follows the body without pretending the second export started',()=>{
 const waiting={status:'waiting',stage:'copy_review',active:false}
 const source={status:'running',stage:'edit',active:true}
 assert.deepEqual(productionProgress(waiting,source).map(s=>s.state),['done','done','active','pending'])
 assert.deepEqual(productionProgress(waiting,{...source,stage:'export'}).map(s=>s.state),['done','done','done','pending'])
 assert.equal(productionProgress(waiting,{...source,active:false,stopReason:'service'})[2].state,'pending')
 assert.equal(productionProgress({...waiting,status:'running',stage:'audio',active:true},source)[1].state,'active','independent ending preparation owns its own progress')
})

import {showSharedBlueprint} from '../src/pages/productionPanelState.js'
test('one shared blueprint until production, separate outputs only after approval',()=>{
 assert.equal(showSharedBlueprint(),true)
 assert.equal(showSharedBlueprint({status:'awaiting_blueprint',stage:'copy_review'}),true)
 assert.equal(showSharedBlueprint({status:'running',stage:'blueprint'}),true)
 assert.equal(showSharedBlueprint({status:'running',stage:'audio',blueprintConfirmed:true}),false)
 assert.equal(showSharedBlueprint({status:'awaiting_review',stage:'self_check'}),false)
 assert.equal(showSharedBlueprint({status:'completed',stage:'self_check'}),false)
})

import {productionPageTitle} from '../src/pages/productionPanelState.js'
test('page phase follows human approval, not internal repair stage',()=>{
 const repaired={status:'blocked',stage:'blueprint',blueprintConfirmed:true,active:false,stopReason:'limit'}
 assert.equal(showSharedBlueprint(repaired),false)
 assert.equal(productionPageTitle(repaired),'视频制作')
 assert(!productionProgress(repaired).some(p=>p.state==='active'),'stopped task must not animate as running')
 assert.equal(showSharedBlueprint({...repaired,status:'running'}),false)
 assert.equal(showSharedBlueprint({...repaired,status:'awaiting_blueprint'}),true)
 assert.equal(productionPageTitle({...repaired,status:'awaiting_blueprint'}),'审核蓝图','actual renewed human review is preserved')
 const initial={...repaired,blueprintConfirmed:false,status:'running',active:true,stopReason:undefined}
 assert.equal(productionPageTitle(initial),'准备蓝图')
 assert.deepEqual(productionProgress(initial).map(p=>p.label),['分析原片','整理蓝图','检查蓝图'])
 assert.equal(productionPageTitle({stage:'self_check',status:'awaiting_review',blueprintConfirmed:true}),'预览与下载')
 assert.equal(productionPageTitle({stage:'self_check',status:'blocked',blueprintConfirmed:true,previewPending:true}),'视频预览')
})

import {productionActivity} from '../src/pages/productionPanelState.js'
test('shared waiting text uses the same approved production activity',()=>{
 assert.equal(productionActivity({stage:'blueprint',status:'running',active:true,blueprintConfirmed:true}),'调整画面安排')
 assert.equal(productionActivity({stage:'blueprint',status:'blocked',active:false,blueprintConfirmed:true}),'等待继续')
 assert.equal(productionActivity({stage:'blueprint',status:'running',active:true}),'生成剪辑蓝图')
})
