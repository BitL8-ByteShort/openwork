import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BridgeError, record, type Session } from '../contract/index.js';
import type { OpenWorkAdapter } from '../adapters/types.js';
import type { Device, Store } from '../storage/store.js';
import type { FeatureOperations } from '../auth/feature-access.js';
import type { Ledger } from '../mutations/ledger.js';
import { UploadStore } from '../transfers/upload-store.js';
import { allocation, digest, requestUUID, chunkBytes } from '../transfers/metadata.js';

interface Options {
  remote: FastifyInstance;
  adapter: OpenWorkAdapter;
  store: Store;
  ledger: Ledger;
  operations: FeatureOperations;
  session: (req: FastifyRequest, wid: string, sid: string) => Promise<Session>;
  device: (req: FastifyRequest) => Device;
  envelope: (data: unknown) => unknown;
}
interface Params { wid: string; sid: string; id: string }
export function registerAttachmentRoutes(o: Options) {
  const uploads = new UploadStore(o.store, o.adapter);
  const base = '/v1/workspaces/:wid/sessions/:sid/attachments';
  const authorize = async (req: FastifyRequest, wid: string, sid: string) => {
    if (o.adapter.capabilities.attachments !== true || !o.adapter.readAttachmentLimits || !o.adapter.uploadAttachment)
      throw new BridgeError('UNSUPPORTED_ACTION', 422);
    const d = o.device(req), lease = o.operations.begin(d.id, wid, 'fileTransfer');
    try { await o.session(req, wid, sid); lease.check(); await uploads.sweep(); lease.check(); return { d, lease }; }
    catch (error) { lease.dispose(); throw error; }
  };
  o.remote.post<{ Params: Params }>(base, async req => {
    const { wid, sid } = req.params;
    const { d, lease } = await authorize(req, wid, sid);
    try {
      const b = allocation(req.body);
      const receipt = await o.ledger.perform(d.id, b.requestId, req.routeOptions.url!, { wid, sid, ...b },
        () => uploads.allocate(d.id, wid, sid, b, lease));
      lease.check();
      return o.envelope({ receipt, attachment: receipt.resourceId ? uploads.read(receipt.resourceId, d.id, wid, sid) : null });
    } finally { lease.dispose(); }
  });
  o.remote.get<{ Params: Params }>(base + '/:id', async req => {
    const { wid, sid, id } = req.params;
    const { d, lease } = await authorize(req, wid, sid);
    try { lease.check(); return o.envelope(uploads.read(id, d.id, wid, sid)); }
    finally { lease.dispose(); }
  });
  o.remote.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: chunkBytes }, (_req, body, done) => done(null, body));
  o.remote.put<{ Params: Params; Querystring: { offset?: string }; Body: Buffer }>(
    base + '/:id/chunks', { bodyLimit: chunkBytes }, async req => {
      const { wid, sid, id } = req.params;
      const { d, lease } = await authorize(req, wid, sid);
      try {
        if (!Buffer.isBuffer(req.body) || !/^(0|[1-9][0-9]{0,8})$/.test(req.query.offset ?? '') || Object.keys(req.query).some(k => k !== 'offset'))
          throw new BridgeError('INVALID_REQUEST', 400);
        const result = await uploads.chunk(id, d.id, wid, sid, Number(req.query.offset), req.body, lease);
        lease.check();
        return o.envelope(result);
      } finally { lease.dispose(); }
    });
  o.remote.post<{ Params: Params }>(base + '/:id/commit', async req => {
    const { wid, sid, id } = req.params;
    const { d, lease } = await authorize(req, wid, sid);
    try {
      const b = req.body;
      if (!record(b) || Object.keys(b).some(k => !['requestId', 'sha256'].includes(k)) ||
          typeof b.requestId !== 'string' || !requestUUID.test(b.requestId) || typeof b.sha256 !== 'string' || !digest.test(b.sha256))
        throw new BridgeError('INVALID_REQUEST', 400);
      uploads.read(id, d.id, wid, sid);
      const sha256 = b.sha256;
      const receipt = await o.ledger.perform(d.id, b.requestId, req.routeOptions.url!, { wid, sid, id, ...b },
        () => uploads.commit(id, d.id, wid, sid, sha256, lease));
      lease.check();
      return o.envelope({ receipt, attachment: uploads.read(id, d.id, wid, sid) });
    } finally { lease.dispose(); }
  });
  o.remote.post<{ Params: Params }>(base + '/:id/cancel', async req => {
    const { wid, sid, id } = req.params;
    const { d, lease } = await authorize(req, wid, sid);
    try {
      const b = req.body;
      if (!record(b) || Object.keys(b).some(k => k !== 'requestId') || typeof b.requestId !== 'string' || !requestUUID.test(b.requestId))
        throw new BridgeError('INVALID_REQUEST', 400);
      uploads.read(id, d.id, wid, sid);
      const receipt = await o.ledger.perform(d.id, b.requestId, req.routeOptions.url!, { wid, sid, id, ...b },
        () => uploads.cancel(id, d.id, wid, sid, lease));
      lease.check();
      return o.envelope({ receipt, attachment: uploads.read(id, d.id, wid, sid) });
    } finally { lease.dispose(); }
  });
  return uploads;
}
