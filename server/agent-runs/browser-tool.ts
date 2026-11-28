import { reserveHandoff } from '../clipmentor/handoff';
import { jsonSchema, tool } from 'ai';
import { policyForTool } from '../../src/agent/execution-policy';
import { ToolActivation } from '../../src/agent/tool-activation';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import { compactToolResultForModel } from '../../src/agent/tool-result-compaction';
import { projectToolResultForPersistence, attachAgentArtifactRef, artifactPlaceholder } from '../../src/agent/runtime-artifact';
import { archiveAgentToolResult } from '../../src/agent/runtime-ledger-serialization';
import type { AgentArtifactRef } from '../../src/agent/runtime-artifact';
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
  modelSchema?(schema:AgentToolSchema):AgentToolSchema;
  resolveReferences?(name:string,args:Record<string,unknown>,callId:string):{
    args:Record<string,unknown>; operation?:string; failure?:Record<string,unknown>; stop?:()=>void;
  };
  normalizeArgs?(name:string,args:Record<string,unknown>):Record<string,unknown>;
  afterFailure?(name:string,args:Record<string,unknown>,result:unknown):void;
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
  const parallel = !activation.host?.resolveReferences && toolExecutionMode(schema.name) === 'parallel';
  let release: (() => void) | undefined;
  if (!parallel) {
    const previous = activation.tail;
    const { promise: next, resolve } = Promise.withResolvers<void>();
    activation.tail = next;
    release = resolve;
    await previous;
  }
  let hostRequested=false,hostOutcomeRecorded=false,operation:string|undefined;
  try {
    activation.host?.signal?.throwIfAborted();
    activation.current = activation.current.admit(schema.name);
    args=activation.host?.normalizeArgs?.(schema.name,args)??args;
    const references=activation.host?.resolveReferences?.(schema.name,args,toolCallId);
    operation=references?.operation;
    args=references?.args??args;
    if(!references?.failure)assertCanonicalToolInvocation(schema, args, activation.current.schemas());
    const signal = activation.host?.signal ?? run.abort?.signal;
    const assertDispatch = await reserveHandoff(run, 'tool', toolCallId, schema.name, args, signal);
    signal?.throwIfAborted();
    assertDispatch?.();
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
    pushRunEvent(run, activation.host ? 'server-tool-request' : 'tool-request', { toolCallId, name: schema.name, args, argsDigest,
      ...(operation?{referenceOperation:operation}:{}) });
    hostRequested=!!activation.host;
    const delivered = activation.host
      ? references?.failure??await activation.host.execute(schema.name,args,toolCallId)
      : await waitForToolResult(run, toolCallId, schema.name, argsDigest);
    let artifactRef:AgentArtifactRef|null=null;
    if(activation.host){
      const receipt=delivered&&typeof delivered==='object'&&!Array.isArray(delivered)
        ?Object.fromEntries(Object.entries(delivered).filter(([key])=>key!=='__images')):delivered;
      artifactRef=await archiveAgentToolResult(run.projectId,run.id,{toolCallId,toolName:schema.name,result:receipt});
      pushRunEvent(run,'server-tool-result',{toolCallId,name:schema.name,argsDigest,success:!isFailedToolResult(delivered),
        ...(operation?{referenceOperation:operation}:{}),
        result:artifactRef?artifactPlaceholder(artifactRef,receipt):compactToolResultForModel(projectToolResultForPersistence(receipt))});
      hostOutcomeRecorded=true;
    }
    const followup = delivered && typeof delivered === 'object'
      && '__followup' in delivered && typeof delivered.__followup === 'string'
      ? delivered.__followup
      : null;
    if (followup) activation.followupText = followup;
    const shaped = activation.current.withToolResult(schema.name, delivered);
    if(artifactRef)attachAgentArtifactRef(shaped.result,artifactRef);
    activation.current = shaped.activation;
    if (isFailedToolResult(shaped.result)) {
      if(!activation.host)throw new Error(toolFailureReason(shaped.result));
      activation.toolFailures.record(schema.name,{success:false,result:shaped.result},operation);
      const r=shaped.result as Record<string,unknown>;
      pushRunEvent(run,'server-tool-diagnostic',{toolCallId,name:schema.name,...(structuredToolFailure(r)??{error:toolFailureReason(r),production_gate:r.production_gate,issues:r.issues,breakdown_check:r.breakdown_check})});
      activation.host.afterFailure?.(schema.name, args, delivered);
      references?.stop?.();
      return shaped.result;
    }
    activation.toolFailures.record(schema.name, { success: true, result: shaped.result },operation);
    if (!followup) recordTool(activation, schema, args);
    if (cacheablePureTool(schema.name)) {
      activation.lastSuccessfulPureTool = { name: schema.name, argsDigest, result: shaped.result };
    }
    return shaped.result;
  } catch (error) {
    if(hostRequested&&!hostOutcomeRecorded)pushRunEvent(run,'server-tool-result',{
      toolCallId,name:schema.name,argsDigest:digestToolArgs(args),success:false,
      ...(operation?{referenceOperation:operation}:{}),
      outcome:{kind:'outcome_unknown',operationId:toolCallId},
      error:projectToolResultForPersistence(error instanceof Error?error.message:String(error)),
    });
    activation.toolFailures.record(schema.name, { success: false, result: error },operation);
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
      (activation.host?.modelSchema?.(schema)??schema).input_schema as Parameters<typeof jsonSchema<Record<string, unknown>>>[0],
    ),
    execute: (args: Record<string, unknown>, options: { toolCallId: string }) => (
      executeBrowserTool(run, schema, args, options.toolCallId, activation)
    ),
    toModelOutput: ({ output }) => toolResultModelOutput(output, schema.name === 'load_skill'),
  })]));
}
