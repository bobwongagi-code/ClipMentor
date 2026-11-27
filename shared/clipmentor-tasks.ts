export const CLIPMENTOR_TASK_LIMIT = 5;

export type ClipMentorTaskStatus = 'materials' | 'running' | 'queued' | 'waiting' | 'blueprint' | 'preview' | 'paused' | 'completed' | 'cancelled';
export type ClipMentorTaskSummary = {
  id: string;
  name: string;
  status: ClipMentorTaskStatus;
  stage?: string;
  updatedAt: number;
  outputs: Array<{ audience: 'new_contact' | 'existing_partner'; status: ClipMentorTaskStatus | 'unavailable'; stage?:string; awaitingConfirmation?:boolean }>;
};
export type ClipMentorWorkspace = { tasks: ClipMentorTaskSummary[]; running: number; limit: number };
