/** Offline only. Does not import a caller, load credentials, or invoke a model. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPreviewTimelineObservations } from './preview-timeline-check.ts';
import { parsePreviewTeachingJudgment, validatePreviewReviewInput } from './preview-review.ts';

const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export async function auditSavedPreview(args: Record<string, string>) {
  const required = ['manifest', 'review', 'input', 'binding', 'video', 'operation'];
  if (required.some(k => !args[k]) || Object.keys(args).some(k => !required.includes(k) && k !== 'format')
    || (args.format !== undefined && !['json', 'markdown'].includes(args.format))) throw new Error('Expected --manifest --review --input --binding --video --operation [--format json|markdown]');
  const files = await Promise.all(['manifest', 'review', 'input', 'binding'].map(k => readFile(resolve(args[k]), 'utf8')));
  const [manifest, review, input, binding] = files.map(f => JSON.parse(f));
  const videoHash = hash(await readFile(resolve(args.video)));
  const cleanInput = validatePreviewReviewInput(input);
  const inputHash = hash(JSON.stringify(cleanInput));
  if (binding.operationId !== args.operation || !/^[a-f0-9-]{36}$/i.test(args.operation)
    || binding.videoSha256 !== videoHash || review.video_sha256 !== videoHash
    || binding.inputSha256 !== inputHash || review.input_sha256 !== inputHash) throw new Error('Operation, video or review input binding mismatch');
  if (typeof review.raw_public_judgment !== 'string'
    || JSON.stringify(parsePreviewTeachingJudgment(review.raw_public_judgment)) !== JSON.stringify(review.judgment)) throw new Error('Saved judgment differs from raw response');
  return { ...checkPreviewTimelineObservations(manifest, review, cleanInput), provenance: {
    operation_id: args.operation, video_sha256: videoHash, input_sha256: inputHash,
    manifest_sha256: hash(files[0]), review_sha256: hash(files[1]), binding_sha256: hash(files[3]),
    manifest_video_binding: 'historical_execution_record_not_independently_pixel_verified',
  } };
}

export function renderTimelineAudit(report: Awaited<ReturnType<typeof auditSavedPreview>>) {
  const seconds = (n: number) => n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const out = ['# 已保存复核与执行时间线核对', '', `操作：${report.provenance.operation_id}`, '',
    `结果：${report.status}；新增模型调用0；不修改原判，不批准成片。`, '',
    '以下时间均为成片秒数，source为源片秒数；音轨时间是文件安排，不是实测发声边界。', ''];
  for (const unit of report.units) {
    out.push(`## ${unit.unit_id}`, '', `原判保留：叙事 ${unit.model_verdict_preserved.narrative.status}；教学 ${unit.model_verdict_preserved.teaching.status}。`, '',
      '| 成片范围 | 时长 | kind / label | 源片入点（relation为两个取帧点） |', '| --- | --- | --- | --- |');
    for (const s of unit.actual_segments) out.push(`| ${seconds(s.start_seconds)}–${seconds(s.end_seconds)} | ${seconds(s.duration_seconds)}s | ${s.kind} / ${s.label ?? ''} | ${JSON.stringify(s.source_start_seconds)} |`);
    out.push('', '模型描述与实际范围：', '');
    for (const c of unit.observation_checks) out.push(`- ${c.path}，${seconds(c.start_seconds)}–${seconds(c.end_seconds)}：${c.observed}（${c.medium_claim_check}）`);
    out.push('', '核对发现（同类已合并）：', '');
    for (const i of unit.issues) out.push(`- **${i.code}** [${i.certainty}]：${i.detail} 证据：${i.observations.join('、') || '对照本组观察全文'}；场景索引 ${i.scene_indices.join('、')}。`);
    if (!unit.issues.length) out.push('- 没有检测到机械冲突；不等于语义或观感通过。');
    out.push('', '切点：', '');
    for (const c of unit.cut_checks) out.push(`- ${seconds(c.at_seconds)}：${c.medium_before} → ${c.medium_after}。观察范围不等于模型精确识别该切点。`);
    out.push('', '安排音轨空隙：', '');
    for (const g of unit.scheduled_audio_gaps) out.push(`- ${seconds(g.start_seconds)}–${seconds(g.end_seconds)}，${seconds(g.duration_seconds)}s。`);
    out.push('');
  }
  out.push('## 边界', '', ...report.limits.map(l => `- ${l}`),
    '- 已核对operation、视频与审核输入哈希；manifest仅登记哈希，未独立证明渲染逐帧符合清单。', '');
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args: Record<string, string> = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i];
      if (!key.startsWith('--') || !process.argv[i + 1] || args[key.slice(2)] !== undefined) throw new Error('Invalid or duplicate CLI argument');
      args[key.slice(2)] = process.argv[i + 1];
    }
    const report = await auditSavedPreview(args);
    console.log(args.format === 'markdown' ? renderTimelineAudit(report) : JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'Invalid audit JSON' : error instanceof Error ? error.message : 'Timeline audit failed');
    process.exitCode = 1;
  }
}
