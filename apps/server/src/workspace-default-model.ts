import { z } from "zod";
import {createHash} from 'node:crypto';
import {ApiError} from './errors.js';

import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore } from "./workspace-kv-store.js";

/**
 * The model a new chat in a workspace would use. The renderer owns the choice
 * and mirrors it here so background callers (automations, remote sessions,
 * cloud workers) can start sessions on the same model.
 */
const modelPart = z.string().trim().min(1).max(200);

export const workspaceDefaultModelSchema = z.object({
  providerID: modelPart,
  modelID: modelPart,
  variant: modelPart.optional(),
});

export type WorkspaceDefaultModel = z.infer<typeof workspaceDefaultModelSchema>;

export const workspaceDefaultModelBodySchema = z.object({
  model: workspaceDefaultModelSchema.nullable(),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export type WorkspaceDefaultModelState = {
  model: WorkspaceDefaultModel | null;
  updatedAt: number | null;
  revision: string;
  conditionalWrite: true;
};

function parseStoredModel(json: string): WorkspaceDefaultModel | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = workspaceDefaultModelSchema.nullable().safeParse(value);
  return parsed.success ? parsed.data : null;
}

const workspaceDefaultModelStore = createWorkspaceKvStore<WorkspaceDefaultModel | null>({
  tableName: "workspace_default_models",
  valueColumn: "model_json",
  parse: parseStoredModel,
  serialize: (value) => JSON.stringify(value),
});
type DefaultRow = Awaited<ReturnType<typeof workspaceDefaultModelStore.getRow>>;
function defaultRevision(row: DefaultRow): string {
  return createHash('sha256').update(JSON.stringify({valueJson:row?.valueJson??null,updatedAt:row?.updatedAt??null})).digest('hex');
}
function defaultState(row: DefaultRow): WorkspaceDefaultModelState {
  return {model:row?.value??null,updatedAt:row?.updatedAt??null,revision:defaultRevision(row),conditionalWrite:true};
}

export async function readWorkspaceDefaultModel(
  config: ServerConfig,
  workspaceId: string,
): Promise<WorkspaceDefaultModelState> {
  const row = await workspaceDefaultModelStore.getRow(config, workspaceId);
  return defaultState(row);
}

export async function writeWorkspaceDefaultModel(
  config: ServerConfig,
  workspaceId: string,
  model: WorkspaceDefaultModel | null,
  revision?: string,
): Promise<WorkspaceDefaultModelState> {
  if(revision!==undefined&&!/^[a-f0-9]{64}$/.test(revision))throw new ApiError(400,'invalid_payload','Invalid default model revision');
  const valueJson=workspaceDefaultModelStore.serialize(model);
  // Legacy renderer writes keep overwrite behavior. A failed CAS performed no
  // write, so only that legacy path can reread and try the same native intent.
  for(let attempt=0;attempt<32;attempt++){
    const row=await workspaceDefaultModelStore.getRow(config,workspaceId);
    if(revision!==undefined&&defaultRevision(row)!==revision)break;
    const updatedAt=Math.max(Date.now(),(row?.updatedAt??0)+1);
    if(await workspaceDefaultModelStore.setIfUnchanged(config,workspaceId,model,updatedAt,row))return defaultState({value:model,valueJson,updatedAt});
    if(revision!==undefined)break;
  }
  throw new ApiError(409,'workspace_default_model_changed','The workspace default changed. Read its current value before saving.');
}
