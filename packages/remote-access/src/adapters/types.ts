import type {
  Host,
  ModelSelection,
  ModelSettings,
  WorkspaceDefaults,
  SavedPermissions,
  Workspace,
  Session,
  Message,
  SessionStatus,
  Approval,
  Capabilities,
  Page,
  QuestionRequest,
  QuestionAnswers,
} from "../contract/index.js";
import type { ArtifactContext } from '../artifacts/catalog.js';
import type { GroupSnapshot, GroupCommand } from './session-groups.js';
import type { SessionActionPreview } from './session-actions.js';
import type { ChangeContext } from '../changes/catalog.js';
export interface StagedAttachment { id: string; path: string; name: string; mime: string; bytes: number; sha256: string }
export interface NativePromptFile { id: string; uri: string; name: string; mime: string; bytes: number; sha256: string }
export interface AttachmentPrompt { text: string; messageId: string; files: NativePromptFile[] }
export interface OpenWorkAdapter {
  version: string;
  readonly compatibility: Host["compatibility"];
  capabilities: Capabilities;
  health(): Promise<void>;
  listWorkspaces(): Promise<Workspace[]>;
  listSessions(wid: string, cursor?: string, signal?: AbortSignal): Promise<Page<Session[]>>;
  readSession(wid: string, sid: string): Promise<Session>;
  readMessages(
    wid: string,
    sid: string,
    cursor?: string,
  ): Promise<Page<Message[]>>;
  readStatus(wid: string, sid: string): Promise<SessionStatus>;
  readApprovals(wid: string, sid: string): Promise<Approval[]>;
  readQuestions?(
    wid: string,
    sid: string,
    signal?: AbortSignal,
  ): Promise<QuestionRequest[]>;
  settleQuestion?(
    wid: string,
    sid: string,
    qid: string,
    revision: string,
    answers: QuestionAnswers | null,
    signal?: AbortSignal,
  ): Promise<void>;
  readAttachmentLimits?(
    wid: string,
    sid: string,
    signal?: AbortSignal,
  ): Promise<{ maxFileBytes: number; inputMIMEs: string[] }>;
  uploadAttachment?(
    wid: string,
    sid: string,
    file: StagedAttachment,
    signal: AbortSignal,
  ): Promise<{ uri: string }>;
  sendAttachments?(wid: string, sid: string, prompt: AttachmentPrompt, signal: AbortSignal): Promise<void>;
  readArtifactContext?(wid: string, sid: string, signal: AbortSignal): Promise<ArtifactContext>;
  readChangeContext?(wid: string, sid: string, signal: AbortSignal): Promise<ChangeContext>;
  readSessionGroups?(wid:string,signal:AbortSignal):Promise<GroupSnapshot>;
  changeSessionGroup?(wid:string,command:GroupCommand,revision:string,signal:AbortSignal):Promise<string|null>;
  readSessionActions?(wid:string,sid:string,signal:AbortSignal):Promise<SessionActionPreview>;
  forkSession?(wid:string,sid:string,beforeMessageId:string|null,revision:string,signal:AbortSignal):Promise<string>;
  deleteSession?(wid:string,sid:string,revision:string,signal:AbortSignal):Promise<string>;
  readWorkspaceDefaults?(wid:string,signal:AbortSignal,check?:()=>void):Promise<WorkspaceDefaults>;
  setWorkspaceDefaults?(wid:string,selection:ModelSelection,revision:string,signal:AbortSignal,check?:()=>void):Promise<string>;
  create(wid: string): Promise<string>;
  rename(
    wid: string,
    sid: string,
    title: string,
    previousTitle: string,
  ): Promise<void>;
  send(wid: string, sid: string, text: string): Promise<void>;
  stop(wid: string, sid: string): Promise<boolean>;
  reply(
    wid: string,
    sid: string,
    aid: string,
    decision: "allowOnce" | "deny",
    revision: string,
  ): Promise<void>;
  readModelSettings(wid: string, sid: string): Promise<ModelSettings>;
  setModel(
    wid: string,
    sid: string,
    model: ModelSelection,
    revision: string,
  ): Promise<void>;
  readSavedPermissions(wid: string, sid: string): Promise<SavedPermissions>;
  revokeSavedPermission(
    wid: string,
    sid: string,
    id: string,
    revision: string,
  ): Promise<void>;
  subscribe(wid: string, signal: AbortSignal): Promise<Response>;
}
