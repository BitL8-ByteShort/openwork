import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { ArtifactCatalog } from '../artifacts/catalog.js';
import { BridgeError, assertContract, type Session } from '../contract/index.js';
import type { OpenWorkAdapter } from '../adapters/types.js';
import type { Device } from '../storage/store.js';
import type { FeatureOperations } from '../auth/feature-access.js';

interface Options {
  remote: FastifyInstance; adapter: OpenWorkAdapter; operations: FeatureOperations;
  session: (req: FastifyRequest, wid: string, sid: string) => Promise<Session>;
  device: (req: FastifyRequest) => Device; envelope: (data: unknown) => unknown;
}
interface Params { wid: string; sid: string; id: string }
export function registerArtifactRoutes(o: Options) {
  const catalog = new ArtifactCatalog((wid, sid, signal) => {
    if (!o.adapter.readArtifactContext) throw new BridgeError('UNSUPPORTED_ACTION', 422);
    return o.adapter.readArtifactContext(wid, sid, signal);
  });
  const active = new Map<string, number>(); let total = 0;
  const authorize = async (req: FastifyRequest, wid: string, sid: string) => {
    if (o.adapter.capabilities.artifacts !== true || !o.adapter.readArtifactContext) throw new BridgeError('UNSUPPORTED_ACTION', 422);
    const d = o.device(req), access = o.operations.begin(d.id, wid, 'fileTransfer');
    const cancellation = new AbortController(), signal = AbortSignal.any([access.signal, cancellation.signal, AbortSignal.timeout(120000)]);
    if ((active.get(d.id) ?? 0) >= 2 || total >= 8) { access.dispose(); throw new BridgeError('RATE_LIMITED', 429); }
    active.set(d.id, (active.get(d.id) ?? 0) + 1); total++;
    let closed = false;
    const dispose = () => {
      if (closed) return; closed = true; cancellation.abort(); access.dispose(); total--;
      const remaining = (active.get(d.id) ?? 1) - 1; if (remaining) active.set(d.id, remaining); else active.delete(d.id);
      req.raw.off('aborted', dispose);
    };
    req.raw.on('aborted', dispose);
    const lease = { signal, check: () => { access.check(); if (signal.aborted) throw new BridgeError('FORBIDDEN', 403); }, dispose };
    try { await o.session(req, wid, sid); lease.check(); return { d, lease }; }
    catch (error) { dispose(); throw error; }
  };
  const base = '/v1/workspaces/:wid/sessions/:sid/artifacts';
  o.remote.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async req => {
    const { wid, sid } = req.params, { d, lease } = await authorize(req, wid, sid);
    try {
      if (Object.keys(req.query).length) throw new BridgeError('INVALID_REQUEST', 400);
      const result = await catalog.list(d.id, wid, sid, lease); lease.check();
      return o.envelope(assertContract('ArtifactCatalog', result));
    } finally { lease.dispose(); }
  });
  o.remote.get<{ Params: Params; Querystring: Record<string, unknown> }>(base + '/:id/content', async (req, reply) => {
    const { wid, sid, id } = req.params, { d, lease } = await authorize(req, wid, sid);
    let streaming = false;
    try {
      if (Object.keys(req.query).some(k => k !== 'revision') || typeof req.query.revision !== 'string' || !/^[a-f0-9]{64}$/.test(req.query.revision))
        throw new BridgeError('INVALID_REQUEST', 400);
      const result = await catalog.open(d.id, wid, sid, id, req.query.revision, req.headers.range, lease);
      lease.check();
      const encoded = encodeURIComponent(result.ref.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      reply.code(result.status).header('Content-Type', result.ref.mime).header('Content-Length', String(result.length))
        .header('Content-Disposition', "attachment; filename*=UTF-8''" + encoded).header('Accept-Ranges', 'bytes').header('ETag', '"' + result.ref.revision + '"');
      if (result.status === 206) reply.header('Content-Range', `bytes ${result.start}-${result.end}/${result.ref.bytes}`);
      const stream = Readable.from(result.stream);
      const cleanup = () => { stream.destroy(); lease.dispose(); };
      reply.raw.once('close', cleanup); reply.raw.once('finish', cleanup);
      streaming = true;
      return reply.send(stream);
    } finally { if (!streaming) lease.dispose(); }
  });
}
