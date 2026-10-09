import { test, expect } from "vitest";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenWorkV2 } from "../src/adapters/openwork-v2-01857.js";
import { createServers } from "../src/server.js";
import { Store } from "../src/storage/store.js";
import { Pairing } from "../src/auth/pairing.js";
import { assertContract, record } from "../src/contract/index.js";
import {
  normalizeQuestion,
  validateQuestionAnswers,
} from "../src/adapters/questions.js";

interface NativeForm {
  id: string;
  sessionID: string;
  metadata: { kind: string };
  fields: Record<string, unknown>[];
}
interface State {
  form: NativeForm | null;
  writes: number;
  answers: unknown;
  loseReply: boolean;
  beforePreflight?: () => Promise<void>;
}
interface Question {
  id: string;
  sessionId: string;
  revision: string;
  supported: boolean;
  fields: {
    key: string;
    kind: string;
    options: { value: string; label: string }[];
  }[];
}
const headers = { authorization: "Bearer synthetic" };
const url = "/v1/workspaces/ws_test/sessions/ses_test/questions";
async function fixture(
  run: (
    api: ReturnType<typeof createServers>,
    state: State,
    store: Store,
  ) => Promise<void>,
) {
  const state: State = {
    form: {
      id: "frm_test",
      sessionID: "ses_test",
      metadata: { kind: "question" },
      fields: [
        {
          key: "layout",
          type: "string",
          title: "Layout",
          description: "Which layout do you prefer?",
          custom: false,
          options: [
            {
              value: "simple",
              label: "Same label",
              description: "Few controls",
            },
            {
              value: "detailed",
              label: "Same label",
              description: "More controls",
            },
          ],
        },
        {
          key: "name",
          type: "string",
          title: "Project name",
          description: "What should it be called?",
          custom: true,
          options: [],
        },
      ],
    },
    writes: 0,
    answers: null,
    loseReply: false,
  };
  const upstream = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const path = req.url ?? "";
    if (req.method === "POST") {
      expect(path).toMatch(
        /\/session\/ses_test\/form\/frm_test\/(reply|cancel)$/,
      );
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const value: unknown = raw ? JSON.parse(raw) : undefined;
      state.answers = record(value) ? value.answer : null;
      state.writes++;
      state.form = null;
      if (state.loseReply) {
        req.socket.destroy();
        return;
      }
      res.end(JSON.stringify({ data: true }));
      return;
    }
    if (path.endsWith("/form/frm_test")) {
      await state.beforePreflight?.();
      if (!state.form) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      res.end(JSON.stringify({ data: state.form }));
      return;
    }
    if (path.endsWith("/form")) {
      res.end(JSON.stringify({ data: state.form ? [state.form] : [] }));
      return;
    }
    res.end(
      JSON.stringify(
        path === "/health"
          ? { ok: true, version: "0.18.57" }
          : {
              data: {
                id: "ses_test",
                title: "Disposable chat",
                time: { created: 0 },
              },
            },
      ),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string") throw Error("Missing address");
  const adapter = new OpenWorkV2(
    async () => ({
      origin: `http://127.0.0.1:${address.port}`,
      token: "synthetic",
    }),
    true,
    undefined,
    true,
  );
  await adapter.health();
  const root = await mkdtemp(join(tmpdir(), "owr-questions-"));
  const store = await Store.open(join(root, "state"));
  await store.update((s) =>
    s.devices.push({
      id: "device",
      deviceId: "phone",
      name: "Phone",
      tokenHash: createHash("sha256").update("synthetic").digest("hex"),
      workspaceIds: ["ws_test"],
      active: true,
      revoked: false,
    }),
  );
  const api = createServers({
    store,
    pairing: new Pairing(store),
    adapter,
    platform: "macos",
    architecture: "arm64",
    origin: "https://host.test",
  });
  try {
    await run(api, state, store);
  } finally {
    await api.remote.close();
    await api.admin.close();
    await store.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
async function pending(api: ReturnType<typeof createServers>) {
  const r = await api.remote.inject({ url, headers });
  expect(r.statusCode).toBe(200);
  return r.json<{ data: Question[] }>().data[0]!;
}
const answer = (q: Question) => ({
  requestId: randomUUID(),
  revision: q.revision,
  answers: { layout: "detailed", name: "Fixture project" },
});

test("duplicateLabelsUseValues and duplicateRequestForwardsOnce", async () =>
  fixture(async (api, state) => {
    const q = await pending(api);
    expect(q.fields[0]?.options.map((x) => x.value)).toEqual([
      "simple",
      "detailed",
    ]);
    const request = {
      method: "POST" as const,
      url: url + "/frm_test/reply",
      headers,
      payload: answer(q),
    };
    const r = await api.remote.inject(request);
    expect(r.statusCode).toBe(200);
    expect(r.json<{ data: { state: string } }>().data.state).toBe("accepted");
    expect(state.answers).toEqual({
      layout: "detailed",
      name: "Fixture project",
    });
    expect(state.writes).toBe(1);
    expect((await api.remote.inject(request)).json()).toEqual(r.json());
    expect(state.writes).toBe(1);
  }));

test("staleFormRejected without forwarding", async () =>
  fixture(async (api, state) => {
    const q = await pending(api);
    state.form!.fields[0]!.title = "Changed on computer";
    expect(
      (
        await api.remote.inject({
          method: "POST",
          url: url + "/frm_test/reply",
          headers,
          payload: answer(q),
        })
      ).statusCode,
    ).toBe(409);
    expect(state.writes).toBe(0);
  }));

test("answeredOnDesktopDisappears and cannot be answered again", async () =>
  fixture(async (api, state) => {
    const q = await pending(api);
    state.form = null;
    expect(
      (await api.remote.inject({ url, headers })).json<{ data: Question[] }>()
        .data,
    ).toEqual([]);
    expect(
      (
        await api.remote.inject({
          method: "POST",
          url: url + "/frm_test/reply",
          headers,
          payload: answer(q),
        })
      ).statusCode,
    ).toBe(404);
    expect(state.writes).toBe(0);
  }));

test("unknownFieldNeverSubmits and oversized forms require the computer", async () =>
  fixture(async (api, state) => {
    state.form!.fields[0]!.type = "password";
    let q = await pending(api);
    expect(q.supported).toBe(false);
    expect(
      (
        await api.remote.inject({
          method: "POST",
          url: url + "/frm_test/reply",
          headers,
          payload: answer(q),
        })
      ).statusCode,
    ).toBe(422);
    state.form!.fields = Array.from({ length: 33 }, (_, i) => ({
      key: "q" + i,
      type: "string",
      custom: true,
    }));
    q = await pending(api);
    expect(q.supported).toBe(false);
    expect(state.writes).toBe(0);
  }));

test("lostReplyDoesNotRetry or infer acceptance from disappearance", async () =>
  fixture(async (api, state) => {
    const q = await pending(api);
    state.loseReply = true;
    const request = {
      method: "POST" as const,
      url: url + "/frm_test/reply",
      headers,
      payload: answer(q),
    };
    const r = await api.remote.inject(request);
    expect(r.json<{ data: { state: string } }>().data.state).toBe(
      "outcome_unknown",
    );
    expect(
      (await api.remote.inject({ url, headers })).json<{ data: Question[] }>()
        .data,
    ).toEqual([]);
    expect(
      (await api.remote.inject(request)).json<{ data: { state: string } }>()
        .data.state,
    ).toBe("outcome_unknown");
    expect(state.writes).toBe(1);
  }));

test("crossSessionFormRejected and workspace authorization runs first", async () =>
  fixture(async (api, state) => {
    expect(
      (
        await api.remote.inject({
          url: url.replace("ws_test", "ws_other"),
          headers,
        })
      ).statusCode,
    ).toBe(403);
    state.form!.sessionID = "ses_other";
    expect((await api.remote.inject({ url, headers })).statusCode).toBe(404);
    expect(
      (
        await api.remote.inject({
          method: "POST",
          url: url + "/frm_test/reply",
          headers,
          payload: {
            requestId: randomUUID(),
            revision: "a".repeat(64),
            answers: { layout: "simple", name: "Fixture" },
          },
        })
      ).statusCode,
    ).toBe(404);
    expect(state.writes).toBe(0);
  }));

test("answers require native field keys, allowed values and bounded JSON", async () =>
  fixture(async (api, state) => {
    const q = await pending(api);
    for (const answers of [
      { layout: "Same label", name: "Fixture" },
      { layout: "simple" },
      { layout: "simple", name: "Fixture", extra: "x" },
      { layout: "simple", name: "x".repeat(32769) },
    ]) {
      const r = await api.remote.inject({
        method: "POST",
        url: url + "/frm_test/reply",
        headers,
        payload: { ...answer(q), answers },
      });
      expect([400, 413]).toContain(r.statusCode);
    }
    expect(state.writes).toBe(0);
  }));

test("dismiss is explicit and a replay cannot cancel twice", async () =>
  fixture(async (api, state) => {
    const q = await pending(api);
    const request = {
      method: "POST" as const,
      url: url + "/frm_test/dismiss",
      headers,
      payload: { requestId: randomUUID(), revision: q.revision },
    };
    expect((await api.remote.inject(request)).statusCode).toBe(200);
    expect(state.answers).toBe(null);
    expect((await api.remote.inject(request)).statusCode).toBe(200);
    expect(state.writes).toBe(1);
  }));

test("revocation during native preflight never forwards a question answer", async () =>
  fixture(async (api, state) => {
    const q = await pending(api);
    state.beforePreflight = async () => {
      await api.controls.revoke("device");
    };
    const r = await api.remote.inject({
      method: "POST",
      url: url + "/frm_test/reply",
      headers,
      payload: answer(q),
    });
    expect(r.statusCode).toBe(403);
    expect(state.writes).toBe(0);
  }));

test("question request schemas include valid reply and dismiss bodies", () => {
  const body = {
    requestId: randomUUID(),
    revision: "a".repeat(64),
    answers: { choice: ["first", "second"] },
  };
  expect(assertContract("QuestionReply", body)).toEqual(body);
  expect(
    assertContract("QuestionDismiss", {
      requestId: body.requestId,
      revision: body.revision,
    }),
  ).toBeDefined();
  expect(() =>
    assertContract("QuestionReply", { ...body, extra: "unrecognized" }),
  ).toThrow();
  expect(() => assertContract("QuestionDismiss", body)).toThrow();
});

test("multiple choices preserve native values, reject duplicates and bound options", () => {
  const form = {
    id: "frm_multi",
    sessionID: "ses_test",
    metadata: { kind: "question" },
    fields: [
      {
        key: "choices",
        type: "multiselect",
        custom: true,
        options: [
          { value: "a", label: "Same" },
          { value: "b", label: "Same" },
        ],
      },
    ],
  };
  const q = normalizeQuestion(form, "ses_test");
  expect(q.fields[0]?.kind).toBe("multipleChoice");
  expect(() =>
    validateQuestionAnswers(q, { choices: ["a", "b", "Custom answer"] }),
  ).not.toThrow();
  for (const choices of [[], ["a", "a"], "a"]) {
    expect(() => validateQuestionAnswers(q, { choices })).toThrow();
  }
  form.fields[0]!.options = Array.from({ length: 101 }, (_, i) => ({
    value: String(i),
    label: "Choice",
  }));
  expect(normalizeQuestion(form, "ses_test").supported).toBe(false);
});
