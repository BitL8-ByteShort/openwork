import { record } from '../contract/index.js';

export interface ArtifactCandidate {
  path: string;
  source: 'completed_tool_manifest' | 'completed_write_metadata' | 'assistant_outbox_link';
}
export interface ArtifactCandidates { items: ArtifactCandidate[]; moreOnComputer: boolean }
const maxTextBytes = 1_048_576;
const maxCandidates = 100;
const manifestTools = new Set(['execute', 'shell', 'openwork_extension_call']);
const writeTools = new Set(['write', 'write_file', 'edit', 'edit_file', 'multi_edit', 'multiedit', 'apply_patch']);

// Candidates are untrusted references, not authorized file handles. The catalog
// must still verify the native session, approved root, open-time containment,
// file type, size and current revision before it exposes any bytes.
function pathValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 500 || /[\\\x00-\x1f\x7f]/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return;
  const path = value.startsWith('./') ? value.slice(2) : value;
  const parts = path.startsWith('/') ? path.slice(1).split('/') : path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return;
  return path;
}

export function artifactCandidates(messages: unknown[]): ArtifactCandidates {
  const items = new Map<string, ArtifactCandidate>();
  let moreOnComputer = messages.length > 100;
  const add = (value: unknown, source: ArtifactCandidate['source']) => {
    const path = pathValue(value);
    if (!path || items.has(path)) return;
    if (items.size >= maxCandidates) { moreOnComputer = true; return; }
    items.set(path, { path, source });
  };
  const boundedText = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    if (Buffer.byteLength(value) > maxTextBytes) { moreOnComputer = true; return false; }
    return true;
  };
  const assistantLinks = (text: unknown) => {
    if (!boundedText(text)) return;
    for (const match of text.matchAll(/\[[^\]\n]{0,500}\]\(([^\s)]+)\)/g)) {
      if (!match[1]) continue;
      let path: string;
      try { path = decodeURIComponent(match[1]); } catch { continue; }
      if (path.startsWith('.opencode/openwork/outbox/')) add(path, 'assistant_outbox_link');
    }
  };
  for (const message of messages.slice(0, 100)) {
    if (!record(message) || message.type !== 'assistant') continue;
    assistantLinks(message.text);
    if (!Array.isArray(message.content)) continue;
    if (message.content.length > 100) moreOnComputer = true;
    for (const part of message.content.slice(0, 100)) {
      if (!record(part)) continue;
      if (part.type === 'text') { assistantLinks(part.text); continue; }
      if (part.type !== 'tool' || typeof part.name !== 'string' || !record(part.state) || part.state.status !== 'completed') continue;
      const state = part.state, metadata = record(state.metadata) ? state.metadata : {};
      // Native local tools report executed:false even after completion. Their
      // completed state and a successful exit, when supplied, are authoritative.
      if (metadata.status === 'error' || (metadata.error !== undefined && metadata.error !== null) || (metadata.exit !== undefined && metadata.exit !== 0)) continue;
      const name = part.name.toLowerCase().replace(/^functions[._-]/, '');
      if (writeTools.has(name)) {
        const input = record(state.input) ? state.input : {};
        add(metadata.path ?? metadata.filePath ?? input.path ?? input.filePath, 'completed_write_metadata');
        if (name === 'apply_patch') {
          const patch = input.patchText ?? input.patch;
          if (boundedText(patch)) for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Move to):\s*(.+)$/gm)) add(match[1], 'completed_write_metadata');
        }
      }
      if (!manifestTools.has(name) || !Array.isArray(state.content)) continue;
      if (state.content.length > 100) moreOnComputer = true;
      for (const content of state.content.slice(0, 100)) {
        if (!record(content) || content.type !== 'text' || !boundedText(content.text)) continue;
        let value: unknown;
        try { value = JSON.parse(content.text); } catch { continue; }
        if (!record(value) || !Array.isArray(value.files)) continue;
        if (value.files.length > maxCandidates) moreOnComputer = true;
        for (const file of value.files.slice(0, maxCandidates)) {
          if (!record(file) || typeof file.mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(file.mime) ||
            typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 20 * 1024 * 1024 ||
            typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) continue;
          add(file.path, 'completed_tool_manifest');
        }
      }
    }
  }
  return { items: [...items.values()], moreOnComputer };
}
