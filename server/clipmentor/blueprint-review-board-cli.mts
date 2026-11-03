/** Local artifact generation only. Never starts a production task or provider. */
import {resolve} from 'node:path';
import {cacheHumanReviewArtifact} from './blueprint-review-board-artifacts';
import {pathToFileURL} from 'node:url';
import {loadReviewBoardInput,renderReviewBoards,type ReviewBoardView} from './blueprint-review-board';
export async function runReviewBoardCli(args:string[]){
 const input=args.shift();if(!input)throw Error('INPUT: board:clipmentor-blueprint -- <JSON或工程ID> --out <目录> [--view human|planner] [--variant <版本>] [--bindings <工程JSON>] [--media-dir <本地素材目录>]');
 let view:ReviewBoardView='planner';let out:string|undefined,variant:string|undefined,mediaDir:string|undefined;const bindings:string[]=[];
 while(args.length){const key=args.shift(),value=args.shift();if(!value)throw Error('INPUT: 参数缺值');if(key==='--view'){if(value!=='human'&&value!=='planner')throw Error('INPUT: view只能是human或planner');view=value;}else if(key==='--out')out=resolve(value);else if(key==='--variant')variant=value;else if(key==='--bindings')bindings.push(value);else if(key==='--media-dir')mediaDir=resolve(value);else throw Error('INPUT: 未知参数');}
 if(!out)throw Error('INPUT: 必须指定 --out');
 const result=await renderReviewBoards(await loadReviewBoardInput(input,{bindings,mediaDir}),out,variant,view);
 if(view==='human')return{...result,artifacts:await Promise.all(result.artifacts.map(async a=>({...a,...await cacheHumanReviewArtifact(a.path,a.candidate_sha256)})))};
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await runReviewBoardCli(process.argv.slice(2)),null,2));}catch(e){console.error(e instanceof Error?e.message:'INPUT: 生成失败');process.exitCode=1;}}
