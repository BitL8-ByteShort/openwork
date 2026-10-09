import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  BridgeError,
  assertContract,
  record,
  type Session,
  type QuestionAnswers,
} from "../contract/index.js";
import type { OpenWorkAdapter } from "../adapters/types.js";
import type { Device } from "../storage/store.js";
import type { FeatureOperations } from "../auth/feature-access.js";
import type { Ledger } from "../mutations/ledger.js";
interface Options {
  remote: FastifyInstance;
  adapter: OpenWorkAdapter;
  ledger: Ledger;
  operations: FeatureOperations;
  session: (req: FastifyRequest, wid: string, sid: string) => Promise<Session>;
  device: (req: FastifyRequest) => Device;
  envelope: (data: unknown) => unknown;
}
function submission(value: unknown, dismiss: boolean) {
  // Schema shapes are shared with the client; byte limits remain explicit below.
  try {
    assertContract(dismiss ? "QuestionDismiss" : "QuestionReply", value);
  } catch {
    throw new BridgeError("INVALID_REQUEST", 400);
  }
  if (
    !record(value) ||
    Object.keys(value).some(
      (k) =>
        !["requestId", "revision", ...(dismiss ? [] : ["answers"])].includes(k),
    ) ||
    typeof value.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.requestId,
    ) ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.revision)
  )
    throw new BridgeError("INVALID_REQUEST", 400);
  let answers: QuestionAnswers | null = null;
  if (!dismiss) {
    if (!record(value.answers) || Object.keys(value.answers).length > 32)
      throw new BridgeError("INVALID_REQUEST", 400);
    if (Buffer.byteLength(JSON.stringify(value.answers)) > 32768)
      throw new BridgeError("ANSWER_TOO_LARGE", 413);
    const entries: [string, string | string[]][] = [];
    for (const [key, v] of Object.entries(value.answers)) {
      if (!key || Buffer.byteLength(key) > 200)
        throw new BridgeError("INVALID_REQUEST", 400);
      if (typeof v === "string") entries.push([key, v]);
      else if (
        Array.isArray(v) &&
        v.length <= 101 &&
        v.every((x: unknown) => typeof x === "string")
      )
        entries.push([key, v]);
      else throw new BridgeError("INVALID_REQUEST", 400);
    }
    answers = Object.fromEntries<string | string[]>(entries);
  }
  return { requestId: value.requestId, revision: value.revision, answers };
}
export function registerQuestionRoutes(o: Options) {
  const base = "/v1/workspaces/:wid/sessions/:sid/questions";
  o.remote.get<{ Params: { wid: string; sid: string } }>(base, async (req) => {
    const { wid, sid } = req.params;
    await o.session(req, wid, sid);
    if (o.adapter.capabilities.questions !== true || !o.adapter.readQuestions)
      throw new BridgeError("UNSUPPORTED_ACTION", 422);
    const operation = o.operations.begin(o.device(req).id, wid);
    try {
      const questions = await o.adapter.readQuestions(
        wid,
        sid,
        operation.signal,
      );
      operation.check();
      return o.envelope(questions);
    } catch (error) {
      operation.check();
      throw error;
    } finally {
      operation.dispose();
    }
  });
  for (const action of ["reply", "dismiss"]) {
    o.remote.post<{ Params: { wid: string; sid: string; qid: string } }>(
      base + "/:qid/" + action,
      async (req) => {
        const { wid, sid, qid } = req.params;
        await o.session(req, wid, sid);
        if (
          o.adapter.capabilities.questions !== true ||
          !o.adapter.settleQuestion
        )
          throw new BridgeError("UNSUPPORTED_ACTION", 422);
        const settle = o.adapter.settleQuestion.bind(o.adapter);
        const b = submission(req.body, action === "dismiss");
        const d = o.device(req),
          operation = o.operations.begin(d.id, wid);
        try {
          const receipt = await o.ledger.perform(
            d.id,
            b.requestId,
            req.routeOptions.url!,
            { wid, sid, qid, ...b },
            async () => {
              operation.check();
              await settle(
                wid,
                sid,
                qid,
                b.revision,
                b.answers,
                operation.signal,
              );
              return qid;
            },
          );
          operation.check();
          return o.envelope(receipt);
        } catch (error) {
          operation.check();
          throw error;
        } finally {
          operation.dispose();
        }
      },
    );
  }
}
