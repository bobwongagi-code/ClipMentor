import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Inspect executable ClipMentor domains, not saved task input, examples, or tooling.
const files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--',
  'server/clipmentor','server/plugins/clipmentor-production.ts','src/clipmentor','src/agent/tools/clipmentor-analysis-tools.ts','shared/clipmentor-handoff.ts'],{encoding:'utf8'}).split('\0')
 .filter(path=>/\.[cm]?tsx?$/.test(path)&&!/(?:\/fixtures\/|\.verify(?:[.-]|$)|\.test\.)/.test(path));
const timeField=/^(?:source|clip|ending|tail)?(?:start|end)(?:Sec(?:onds)?)?$|^(?:source|evidence|main|background|closing|tail).*ranges?(?:_seconds)?$/i;
const timedEndpoint=expr=>ts.isIdentifier(expr)&&timeField.test(expr.text)
 ||ts.isPropertyAccessExpression(expr)&&timeField.test(expr.name.text)
 ||ts.isElementAccessExpression(expr)&&((ts.isIdentifier(expr.expression)&&timeField.test(expr.expression.text))
  ||ts.isPropertyAccessExpression(expr.expression)&&timeField.test(expr.expression.name.text));
const sourceWindowConsumer=/source|clip|ending|closing|tail|playback|evidence|declared|window/i;
const genericWindowUsedAsTime=(node,root)=>{
 const parent=node.parent;
 if(!ts.isVariableDeclaration(parent)||!ts.isIdentifier(parent.name)||!/^range$/i.test(parent.name.text))return false;
 const binding=parent.name.text;
 let used=false;
 const find=(part)=>{
  if(ts.isCallExpression(part)&&sourceWindowConsumer.test(part.expression.getText(root))&&part.arguments.some(arg=>ts.isIdentifier(arg)&&arg.text===binding))used=true;
  if(!used)ts.forEachChild(part,find);
 };
 const statement=parent.parent.parent;
 find(statement.parent);
 return used;
};
const timeContext=node=>{
 for(let parent=node.parent;parent&&!ts.isStatement(parent);parent=parent.parent){
  if((ts.isPropertyAssignment(parent)||ts.isVariableDeclaration(parent))&&ts.isIdentifier(parent.name)&&timeField.test(parent.name.text))return true;
  if(ts.isBinaryExpression(parent)&&timedEndpoint(parent.left))return true;
 }
 return false;
};
const fixed=expr=>ts.isNumericLiteral(expr)&&Number(expr.text)>0;
const relation=kind=>[ts.SyntaxKind.GreaterThanToken,ts.SyntaxKind.GreaterThanEqualsToken,
 ts.SyntaxKind.LessThanToken,ts.SyntaxKind.LessThanEqualsToken,ts.SyntaxKind.EqualsEqualsEqualsToken].includes(kind);
const metric=/\b(?:RM|MYR|USD|GMV|Revenue)\s*\d(?:[\d.,]*\d)?(?:[kKmM]\b)?|\b\d(?:[\d.,]*\d)?\s*[kKmM]?\s*(?:播放量?|件销量|tontonan|unit terjual)/iu;
const enforcedWindowField=/^(?:(?:hard|blocked|excluded|forbidden|required|mandatory|enforced)(?:Source|Evidence|Teaching)?(?:Ranges|Windows)|(?:require|mustCover)(?:All|Every)(?:Reference|Source|Evidence)?Windows)$/i;
const historicalWindowFields=new Set(['mainRanges','backgroundRanges']);

function windowAuthorityIssue(path,node){
 if(!ts.isIdentifier(node)&&!ts.isStringLiteralLike(node))return;
 if(enforcedWindowField.test(node.text))return 'task window cannot be a hard requirement';
 if(!historicalWindowFields.has(node.text))return;
 if(path==='shared/clipmentor-handoff.ts')return; // decode historical declarations
 if(path==='server/clipmentor/production-source-policy.ts'){
  // The adapter can copy the old values to advisory output.
  const member=ts.isPropertyAccessExpression(node.parent)?node.parent:node;
  if(ts.isPropertyAssignment(member.parent)
   &&['mainRanges','backgroundRanges','suggestedWindows','previouslyUnusedWindows'].some(key=>member.parent.name.getText()===key))return;
 }
 return 'historical task window can only be projected as advice';
}

function check(path,body){
 const input=ts.createSourceFile(path,body,ts.ScriptTarget.Latest,true);
 const findings=[];
 function visit(node){
  let issue=windowAuthorityIssue(path,node);
  if(ts.isStringLiteralLike(node)&&/(?<![a-f\d])[a-f\d]{64}(?![a-f\d])/i.test(node.text))issue='literal media SHA-256';
  if(ts.isStringLiteralLike(node)&&metric.test(node.text))issue='literal performance claim';
  if(ts.isPropertyAssignment(node)&&['views','units','revenue'].includes(node.name.getText(input))
   &&(fixed(node.initializer)||ts.isStringLiteralLike(node.initializer)&&/\d/.test(node.initializer.text)))issue='literal performance value';
  if(ts.isArrayLiteralExpression(node)&&node.elements.length===2&&node.elements.every(ts.isNumericLiteral)&&(timeContext(node)||genericWindowUsedAsTime(node,input)))
   issue='literal second window (declare source windows in the task)';
  if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&timeField.test(node.name.text)&&!/^(?:start|end)$/i.test(node.name.text)&&node.initializer&&fixed(node.initializer))
   issue='literal source-time boundary';
  if(ts.isBinaryExpression(node)&&relation(node.operatorToken.kind)
   &&(fixed(node.left)&&timedEndpoint(node.right)||fixed(node.right)&&timedEndpoint(node.left)))
   issue='literal source-time boundary';
  if(issue)findings.push(`${path}:${input.getLineAndCharacterOfPosition(node.getStart(input)).line+1} ${issue}`);
  ts.forEachChild(node,visit);
 }
 visit(input);
 return findings;
}

assert.equal(check('negative.ts',`const evidence='a'.repeat(64); const threshold=4; const canvas=[1080,1920]; if(start>=threshold) read(sourceRange);`).length,0);
for(const text of [
 `const sourceHash='${'b'.repeat(64)}'`,
 `const score='92.12k tontonan'; const info={views:'92.12k',units:'156',revenue:'RM7.32k'}`,
 `const sourceRanges=[[2.25,6.4]];`,
 `const range=[61.2,67.33]; return checkClosingEvidence(range);`,
 `if(start>=63&&end>=67) adopt();`,
 `if (topics.backgroundRanges.some(window => overlaps(window, evidence))) throw Error('outside scope');`,
 `const declaration={requiredEvidenceWindows: candidateWindows, mustCoverAllWindows: true};`,
 `if (declaration['mainRanges'].length !== covered.size) reject();`,
]) assert(check('positive.ts',text).length>0,text);

const issues=files.flatMap(file=>check(file,readFileSync(file,'utf8')));
if(issues.length)throw Error(issues.join('\n'));
console.log(`Verified no project facts embedded in ${files.length} ClipMentor runtime files.`);
