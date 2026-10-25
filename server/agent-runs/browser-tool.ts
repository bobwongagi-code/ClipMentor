import { jsonSchema, tool } from 'ai';
import { policyForTool } from '../../src/agent/execution-policy';
import { ToolActivation } from '../../src/agent/tool-activation';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import { toolResultModelOutput } from '../../src/agent/tool-result-output';
import {
  isFailedToolResult,
  toolFailureReason,structuredToolFailure,
  ToolFailureTracker,
} from '../../src/agent/toolFailure';
import { toolExecutionMode } from '../../src/agent/tools/execution-modes';
import { recordAcceptedTool, type AcceptanceLoopState } from './acceptance-loop';
import { assertCanonicalToolInvocation } from './tool-policy';
import {
  digestToolArgs,
  pushRunEvent,
  waitForToolResult,
  type ServerRun,
} from './store';

export interface ServerToolHost {
  execute(name:string,args:Record<string,unknown>,callId:string):Promise<unknown>;
  beforeRequest():Promise<void>;
  signal?:AbortSignal;
  maxTurns:number;
  deadlineAt:number;
}

export interface ActivationState {
  host?:ServerToolHost;
  current: ToolActivation;
  tail: Promise<void>;
  followupText: string | null;
  toolFailures: ToolFailureTracker;
  acceptance: AcceptanceLoopState;
  repeatGuardNote?: string;
  lastSuccessfulPureTool?: { name: string; argsDigest: string; result: unknown };
}

function cacheablePureTool(name: string): boolean {
  return name === 'analyze_music';
}

function recordTool(activation: ActivationState, schema: AgentToolSchema, args: Record<string, unknown>): void {
  activation.acceptance = recordAcceptedTool(
    activation.acceptance,
    policyForTool(schema.name, args).effect,
  );
}

export async function executeBrowserTool(
  run: ServerRun,
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  toolCallId: string,
  activation: ActivationState,
): Promise<unknown> {
  const parallel = toolExecutionMode(schema.name) === 'parallel';
  let release: (() => void) | undefined;
  if (!parallel) {
    const previous = activation.tail;
    const { promise: next, resolve } = Promise.withResolvers<void>();
    activation.tail = next;
    release = resolve;
    await previous;
  }
  try {
    activation.host?.signal?.throwIfAborted();
    activation.current = activation.current.admit(schema.name);
    assertCanonicalToolInvocation(schema, args, activation.current.schemas());
    const argsDigest = digestToolArgs(args);
    const cached = activation.lastSuccessfulPureTool;
    if (cacheablePureTool(schema.name)
      && cached?.name === schema.name
      && cached.argsDigest === argsDigest) {
      activation.repeatGuardNote = `Reused the adjacent successful ${schema.name} result; skipped duplicate browser execution.`;
      const shaped = activation.current.withToolResult(schema.name, cached.result);
      activation.current = shaped.activation;
      recordTool(activation, schema, args);
      return shaped.result;
    }
    activation.repeatGuardNote = undefined;
    activation.lastSuccessfulPureTool = undefined;
    pushRunEvent(run, activation.host ? 'server-tool-request' : 'tool-request', { toolCallId, name: schema.name, args, argsDigest });
    const delivered = activation.host
      ? await activation.host.execute(schema.name,args,toolCallId)
      : await waitForToolResult(run, toolCallId, schema.name, argsDigest);
    if(activation.host) pushRunEvent(run,'server-tool-result',{toolCallId,name:schema.name,success:!isFailedToolResult(delivered)});
    const followup = delivered && typeof delivered === 'object'
      && '__followup' in delivered && typeof delivered.__followup === 'string'
      ? delivered.__followup
      : null;
    if (followup) activation.followupText = followup;
    const shaped = activation.current.withToolResult(schema.name, delivered);
    activation.current = shaped.activation;
    if (isFailedToolResult(shaped.result)) {
      if(!activation.host)throw new Error(toolFailureReason(shaped.result));
      activation.toolFailures.record(schema.name,{success:false,result:shaped.result});
      const r=shaped.result as Record<string,unknown>;
      pushRunEvent(run,'server-tool-diagnostic',{toolCallId,name:schema.name,...(structuredToolFailure(r)??{error:toolFailureReason(r),production_gate:r.production_gate,issues:r.issues,breakdown_check:r.breakdown_check})});
      return shaped.result;
    }
    activation.toolFailures.record(schema.name, { success: true, result: shaped.result });
    if (!followup) recordTool(activation, schema, args);
    if (cacheablePureTool(schema.name)) {
      activation.lastSuccessfulPureTool = { name: schema.name, argsDigest, result: shaped.result };
    }
    return shaped.result;
  } catch (error) {
    activation.toolFailures.record(schema.name, { success: false, result: error });
    throw error;
  } finally {
    release?.();
  }
}

export function createServerTools(
  run: ServerRun,
  schemas: readonly AgentToolSchema[],
  activation: ActivationState,
) {
  return Object.fromEntries(schemas.map((schema) => [schema.name, tool({
    description: schema.description,
    inputSchema: jsonSchema<Record<string, unknown>>(
      schema.input_schema as Parameters<typeof jsonSchema<Record<string, unknown>>>[0],
    ),
    execute: (args: Record<string, unknown>, options: { toolCallId: string }) => (
      executeBrowserTool(run, schema, args, options.toolCallId, activation)
    ),
    toModelOutput: ({ output }) => toolResultModelOutput(output, schema.name === 'load_skill'),
  })]));
}
