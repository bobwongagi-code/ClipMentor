import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin } from '../media-binaries.ts';
import { analyzeExportFile } from './export-qa.ts';

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exit ${code}: ${stderr.slice(-600)}`));
    });
  });
}

const work = await mkdtemp(join(tmpdir(), 'occ-export-qa-verify-'));
try {
  const file = join(work, 'sample.mp4');
  await run(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=1',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-filter_complex', '[0:v]drawbox=x=26:y=22:w=32:h=12:c=white:t=fill[a];[1:v]drawbox=x=26:y=22:w=32:h=24:c=white:t=fill[b];[a][b]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    file,
  ]);
  assert.ok((await stat(file)).size > 0);

  const result = await analyzeExportFile(file, {
    durationSeconds: 2,
    width: 320,
    height: 180,
    fps: 10,
    expectsAudio: true,
    cutTimesSeconds: [0.5,1],
    maxEvidenceCuts: 1,
    labelProbes: [
      ...(['before','after'] as const).map(side=>({id:side,side,cutSeconds:1,
        region:[18/320,16/180,100/320,60/180] as [number,number,number,number],inkMinChannel:226})),
      {id:'outside',side:'after',cutSeconds:4,region:[0,0,1,1],inkMinChannel:226},
    ],
  });
  assert.equal(result.report.hasVideo, true);
  assert.equal(result.report.hasAudio, true);
  assert.equal(result.report.width, 320);
  assert.equal(result.report.height, 180);
  assert.equal(result.report.summary.errors, 0);
  assert.ok(result.evidence.base64 && result.evidence.base64.length > 100);
  assert.equal(result.evidence.samples.length, 2);
  assert(result.evidence.samples.every(sample=>sample.cutSeconds===1),'explicit probes take precedence over earlier automatic cuts');
  const byId=Object.fromEntries((result.evidence.labelMeasurements??[]).map(m=>[m.id,m]));
  assert.equal(byId.outside.status,'unmeasured');
  assert(byId.outside.status==='unmeasured'&&byId.outside.reason==='cut_not_sampled');
  await assert.rejects(analyzeExportFile(file,{durationSeconds:2,width:320,height:180,fps:30,expectsAudio:true,labelProbes:[
    {id:'bad',side:'before',cutSeconds:1,region:[0.9,0,0.2,1],inkMinChannel:226},
  ]}),/Invalid export QA label region/);
  assert(byId.before.status==='measured'&&byId.after.status==='measured');
  assert(byId.before.sampleSeconds<1&&byId.after.sampleSeconds>=1,'report decoded frame timestamps on their actual side of the cut');
  assert(byId.before.backgroundRgb[2]>200&&byId.before.backgroundRgb[0]<30);
  assert(byId.after.backgroundRgb[0]>200&&byId.after.backgroundRgb[2]<30);
  assert(Math.abs(byId.before.inkHeightPx!-12)<=1);
  assert(Math.abs(byId.after.inkHeightPx!-24)<=1);
  console.log('export QA actual MP4 label measurements',JSON.stringify(byId),'measurement ms',result.evidence.labelMeasurementMs);
} finally {
  await rm(work, { recursive: true, force: true });
}
