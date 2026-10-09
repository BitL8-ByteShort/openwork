import { test, expect } from "vitest";
import { EventHub } from "../src/events/hub.js";
import { OpenWorkV2 } from "../src/adapters/openwork-v2-01857.js";

test("shutdown cancels an idle body even when the upstream stream ignores abort", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const adapter = new OpenWorkV2(async () => {
    throw Error("No live upstream");
  });
  adapter.health = async () => {};
  adapter.listWorkspaces = async () => [{ id: "one", name: "One" }];
  adapter.subscribe = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const hub = new EventHub(adapter);
  try {
    await hub.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closed = await Promise.race([
      hub.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(closed).toBe(true);
    expect(cancelled).toBe(true);
  } finally {
    if (!cancelled) controller?.close();
    await hub.close();
  }
});

test("a body returned after shutdown is cancelled before reading or emitting", async () => {
  let finish: ((response: Response) => void) | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const adapter = new OpenWorkV2(async () => {
    throw Error("No live upstream");
  });
  adapter.health = async () => {};
  adapter.listWorkspaces = async () => [{ id: "one", name: "One" }];
  adapter.subscribe = async () =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    });
  const hub = new EventHub(adapter);
  const events: unknown[] = [];
  hub.add((event) => events.push(event));
  try {
    await hub.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const close = hub.close();
    finish?.(response);
    const closed = await Promise.race([
      close.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(closed).toBe(true);
    expect(cancelled).toBe(true);
    expect(events).toEqual([]);
  } finally {
    if (!cancelled) controller?.close();
    await hub.close();
  }
});

test("shutdown does not await an upstream cancellation callback that never finishes", async () => {
  let cancelled = false;
  const adapter = new OpenWorkV2(async () => {
    throw Error("No live upstream");
  });
  adapter.health = async () => {};
  adapter.listWorkspaces = async () => [{ id: "one", name: "One" }];
  adapter.subscribe = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      }),
    );
  const hub = new EventHub(adapter);
  await hub.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closed = await Promise.race([
    hub.close().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  expect(closed).toBe(true);
  expect(cancelled).toBe(true);
});

test("the running hub subscribes to projects added after startup without duplicating subscriptions", async () => {
  let workspaces = [{ id: "one", name: "One" }];
  const subscriptions: string[] = [];
  const adapter: any = {
    health: async () => {},
    listWorkspaces: async () => workspaces,
    subscribe: async (w: string, signal: AbortSignal) => {
      subscriptions.push(w);
      return new Response(
        new ReadableStream({
          start(c) {
            signal.addEventListener("abort", () => c.close(), { once: true });
          },
        }),
      );
    },
  };
  const hub = new EventHub(adapter);
  try {
    await hub.start();
    await new Promise((r) => setTimeout(r, 0));
    workspaces.push({ id: "two", name: "Two" });
    await (hub as any).refreshWorkspaces();
    await new Promise((r) => setTimeout(r, 0));
    await (hub as any).refreshWorkspaces();
    expect(subscriptions).toEqual(["one", "two"]);
  } finally {
    await hub.close();
  }
});
