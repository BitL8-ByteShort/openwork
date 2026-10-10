import { PreflightError, record, assertContract, type Attachment } from '../contract/index.js';

export const chunkBytes = 1024 * 1024;
export const fileBytes = 20 * chunkBytes;
export const promptBytes = 40 * chunkBytes;
export const stagingBytes = 100 * chunkBytes;
export const uploadLifetime = 24 * 60 * 60 * 1000;
export const attachmentID = /^att_[a-f0-9]{32}$/;
export const digest = /^[a-f0-9]{64}$/;
export const requestUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIMEs = ['image/png', 'image/jpeg', 'application/pdf'];
export interface UploadMetadata { name: string; mime: string; bytes: number; sha256: string }
export interface UploadRecord extends Attachment {
  deviceId: string;
  workspaceId: string;
  sessionId: string;
  createdAt: number;
  chunks: { offset: number; bytes: number; sha256: string }[];
  nativeURI?: string;
  promptRequestId?: string;
}
function safeName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 0 &&
    Buffer.byteLength(name) <= 200 && name !== '.' && name !== '..' &&
    !/[\/\\\x00-\x1f\x7f]/.test(name);
}
export function allocation(value: unknown): UploadMetadata & { requestId: string } {
  if (!record(value) || Object.keys(value).some(k => !['requestId', 'name', 'mime', 'bytes', 'sha256'].includes(k)) ||
      typeof value.requestId !== 'string' || !requestUUID.test(value.requestId) ||
      !safeName(value.name) || typeof value.mime !== 'string' || !MIMEs.includes(value.mime) ||
      typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1 ||
      typeof value.sha256 !== 'string' || !digest.test(value.sha256))
    throw new PreflightError('INVALID_REQUEST', 400);
  if (value.bytes > fileBytes) throw new PreflightError('FILE_TOO_LARGE', 413);
  return { requestId: value.requestId, name: value.name, mime: value.mime, bytes: value.bytes, sha256: value.sha256 };
}
export function publicAttachment(r: UploadRecord): Attachment {
  return assertContract('Attachment', { id: r.id, name: r.name, mime: r.mime, bytes: r.bytes, sha256: r.sha256, receivedBytes: r.receivedBytes, state: r.state });
}
export function validUpload(id: string, v: unknown): v is UploadRecord {
  if (!record(v) || !attachmentID.test(id) || v.id !== id || !safeName(v.name) ||
      typeof v.mime !== 'string' || !MIMEs.includes(v.mime) || typeof v.bytes !== 'number' ||
      !Number.isSafeInteger(v.bytes) || v.bytes < 1 || v.bytes > fileBytes ||
      typeof v.sha256 !== 'string' || !digest.test(v.sha256) || typeof v.receivedBytes !== 'number' ||
      !Number.isSafeInteger(v.receivedBytes) || v.receivedBytes < 0 || v.receivedBytes > v.bytes ||
      !['uploading', 'committing', 'ready', 'sending', 'attached', 'outcome_unknown', 'cancelled', 'expired'].includes(String(v.state)) ||
      typeof v.deviceId !== 'string' || !v.deviceId || typeof v.workspaceId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(v.workspaceId) || typeof v.sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(v.sessionId) || typeof v.createdAt !== 'number' ||
      !Number.isSafeInteger(v.createdAt) || !Array.isArray(v.chunks) || v.chunks.length > 20 ||
      (v.nativeURI !== undefined && (typeof v.nativeURI !== 'string' || !v.nativeURI.startsWith('file:///') || v.nativeURI.length > 8192)) ||
      (v.promptRequestId !== undefined && (typeof v.promptRequestId !== 'string' || !requestUUID.test(v.promptRequestId)))) return false;
  let offset = 0;
  for (const c of v.chunks) {
    if (!record(c) || c.offset !== offset || typeof c.bytes !== 'number' || !Number.isSafeInteger(c.bytes) ||
        c.bytes < 1 || c.bytes > chunkBytes || typeof c.sha256 !== 'string' || !digest.test(c.sha256)) return false;
    offset += c.bytes;
  }
  return offset === v.receivedBytes &&
    (!['ready', 'sending', 'attached'].includes(String(v.state)) || (typeof v.nativeURI === 'string' && v.receivedBytes === v.bytes)) &&
    (!['sending', 'attached'].includes(String(v.state)) || typeof v.promptRequestId === 'string');
}
