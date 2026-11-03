import type {AgentContext} from '../agent/context';
import {revisionOf} from '../agent/external-edit-session';
export async function renderClipMentorReviewBoard(ctx:AgentContext,view:unknown='planner'){
 if(view!=='human'&&view!=='planner')return{error:'INPUT: 未知审片板视图'};
 const projectId=ctx.getProjectId?.(),doc=ctx.getDoc();if(!projectId)return{error:'INPUT: 当前工程ID缺失'};
 try{const response=await(ctx.hostFetch??fetch)('/api/clipmentor/production-task?'+new URLSearchParams({view:'review_board',boardView:view,projectId,expectedRevision:revisionOf(doc)}),{method:'GET'}),body=await response.json();
  if(!response.ok)return{error:body.error??'INPUT: 审片板读取失败'};
  if(ctx.getDoc()!==doc||body.project_id!==projectId||body.project_revision!==revisionOf(doc))return{error:'INPUT: 生成中工程已变化，请重新读取'};
  return{...body,review_approved:false,meaning:'内部蓝图人工审片板，不是达人原片Storyboard，不代表任何审核通过'};
 }catch{return{error:'INPUT: 审片板入口不可用，不自动重试'};}
}
