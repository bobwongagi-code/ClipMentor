import type { AgentToolSchema } from '../../tool-schema';

export const EXPORT_QA_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'verify_export',
    description: [
      'Quality-check a COMPLETED video export before delivery.',
      'Pass renderId from submit_render_job/track_export, or a /media/uploads/ export src.',
      'Checks stream presence, duration, resolution, frame rate, black/frozen frames, long silence, and audio peaks.',
      'Returns a structured issue list plus a labeled before/after contact sheet around timeline edit points.',
      'Run after every important export; inspect warnings and fix the timeline before re-exporting when needed.',
      'executionManifest: pass the actual renderer-produced fps/total_frames/scenes/audios JSON unchanged, never a hand-filled Shot table. Structural transition self-check and merged Agent tasks run automatically. With only executionManifest this is local data-only (zero HTTP/model requests), not media QA or approval. Agent handles merged candidates within authorized scope; no per-flag human approvals.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        renderId: { type: 'string', description: 'Completed render job ID returned by submit_render_job.' },
        src: { type: 'string', description: 'Alternative completed export path under /media/uploads/.' },
        executionManifest: { type: 'object', description: 'Existing frame-based execution output with fps, total_frames, scenes and audios (lines optional). Do not invent layout/Shot records. Without audios, audio checks remain not_provided.' },
        maxCuts: { type: 'integer', minimum: 1, maximum: 8, description: 'Maximum edit boundaries to include in the evidence sheet; defaults to 8.' },
      },
    },
  },
];

export const EXPORT_QA_TOOL_NAMES = new Set(EXPORT_QA_TOOL_SCHEMAS.map((tool) => tool.name));
