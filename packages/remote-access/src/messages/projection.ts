import { BridgeError } from '../contract/index.js';

type Path = (string | number)[];
type Frame = { kind: 'object'; path: Path; state: 'key' | 'colon' | 'value' | 'comma'; key?: string } |
  { kind: 'array'; path: Path; state: 'value' | 'comma'; index: number };
const normalizedLimit = 8 * 1024 * 1024;
const wireLimit = 64 * 1024 * 1024;

// Native messages inline base64 files. Drop ONLY data[].files[].data strings
// while streaming; ordinary JSON and the normalized phone limit stay bounded.
class Projection {
  private frames: Frame[] = [];
  private root: 'value' | 'done' = 'value';
  private string: 'key' | 'value' | 'skip' | undefined;
  private escaped = false;
  private unicode = 0;
  private key = '';
  private primitive = false;
  private bytes = 0;
  private parts: string[] = [];
  private invalid(): never { throw new BridgeError('INVALID_UPSTREAM', 502); }
  private emit(value: string) {
    if (!value) return;
    this.bytes += Buffer.byteLength(value);
    if (this.bytes > normalizedLimit) throw new BridgeError('SNAPSHOT_TOO_LARGE', 413);
    this.parts.push(value);
  }
  private parent() { return this.frames.at(-1); }
  private valuePath(): Path {
    const frame = this.parent();
    if (!frame) { if (this.root !== 'value') this.invalid(); return []; }
    if (frame.state !== 'value') this.invalid();
    if (frame.kind === 'array') return [...frame.path, frame.index];
    if (frame.key === undefined) this.invalid();
    return [...frame.path, frame.key];
  }
  private valueStarted() {
    const frame = this.parent();
    if (frame) { if (frame.state !== 'value') this.invalid(); frame.state = 'comma'; }
    else { if (this.root !== 'value') this.invalid(); this.root = 'done'; }
  }
  push(text: string) {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (this.string === 'skip') {
        // Most base64 chunks contain no special character: skip in one scan.
        if (!this.escaped && !this.unicode) {
          const special = /[\x00-\x1f\\"]/.exec(text.slice(i));
          if (!special) { start = text.length; break; }
          i += special.index;
        }
        const current = text[i]!;
        if (this.unicode) {
          if (!/^[0-9a-fA-F]$/.test(current)) this.invalid();
          this.unicode--;
        } else if (this.escaped) {
          if (!/^["\\/bfnrtu]$/.test(current)) this.invalid();
          this.escaped = false; if (current === 'u') this.unicode = 4;
        } else if (current === '\\') this.escaped = true;
        else if (current === '"') this.string = undefined;
        else this.invalid(); // An unescaped control byte is never valid JSON.
        start = i + 1;
        continue;
      }
      if (this.string) {
        if (this.string === 'key') {
          this.key += char;
          if (this.key.length > 4096) this.invalid();
        }
        if (this.escaped) { this.escaped = false; continue; }
        if (char === '\\') { this.escaped = true; continue; }
        if (char === '"') {
          if (this.string === 'key') {
            const frame = this.parent();
            if (!frame || frame.kind !== 'object' || frame.state !== 'key') this.invalid();
            const key: unknown = JSON.parse('"' + this.key);
            if (typeof key !== 'string') this.invalid();
            frame.key = key; frame.state = 'colon'; this.key = '';
          }
          this.string = undefined;
        }
        continue;
      }
      if (this.primitive) {
        if (!/[\s,\]}]/.test(char)) continue;
        this.primitive = false;
      }
      if (/[ \t\r\n]/.test(char)) continue;
      const frame = this.parent();
      if (char === '"') {
        if (frame?.kind === 'object' && frame.state === 'key') { this.string = 'key'; this.key = ''; continue; }
        const path = this.valuePath(); this.valueStarted();
        if (path.length === 5 && path[0] === 'data' && typeof path[1] === 'number' && path[2] === 'files' &&
            typeof path[3] === 'number' && path[4] === 'data') {
          this.emit(text.slice(start, i)); this.emit('""'); start = i + 1; this.string = 'skip';
        } else this.string = 'value';
      } else if (char === '{' || char === '[') {
        const path = this.valuePath(); this.valueStarted();
        if (this.frames.length >= 64) this.invalid();
        this.frames.push(char === '{' ? { kind: 'object', path, state: 'key' } : { kind: 'array', path, state: 'value', index: 0 });
      } else if (char === '}' || char === ']') {
        if (!frame || (char === '}' ? frame.kind !== 'object' || !['key','comma'].includes(frame.state) :
            frame.kind !== 'array' || !['value','comma'].includes(frame.state))) this.invalid();
        this.frames.pop();
      } else if (char === ':') {
        if (!frame || frame.kind !== 'object' || frame.state !== 'colon') this.invalid();
        frame.state = 'value';
      } else if (char === ',') {
        if (!frame || frame.state !== 'comma') this.invalid();
        if (frame.kind === 'object') frame.state = 'key';
        else { frame.state = 'value'; frame.index++; }
      } else {
        this.valuePath(); this.valueStarted(); this.primitive = true;
      }
    }
    this.emit(text.slice(start));
  }
  finish(): unknown {
    if (this.frames.length || this.string || this.root !== 'done') this.invalid();
    return JSON.parse(this.parts.join(''));
  }
}
export async function projectMessageJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new BridgeError('INVALID_UPSTREAM', 502);
  const projection = new Projection(), decoder = new TextDecoder('utf-8', { fatal: true });
  let wireBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      wireBytes += chunk.value.byteLength;
      if (wireBytes > wireLimit) throw new BridgeError('SNAPSHOT_TOO_LARGE', 413);
      projection.push(decoder.decode(chunk.value, { stream: true }));
    }
    projection.push(decoder.decode());
    return projection.finish();
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('INVALID_UPSTREAM', 502);
  }
}
