import assert from "node:assert/strict";
import test from "node:test";
import contextSentinel from "../extensions/context-sentinel/index.ts";

function harness() {
  const handlers = new Map();
  const notifications = [];
  const checkpointEvents = [];
  const eventHandlers = new Map();

  const pi = {
    events: {
      emit(name, data) {
        checkpointEvents.push({ name, data });
        eventHandlers.get(name)?.forEach((handler) => handler(data));
      },
      on(name, handler) {
        const listeners = eventHandlers.get(name) ?? [];
        listeners.push(handler);
        eventHandlers.set(name, listeners);
        return () => {};
      },
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  contextSentinel(pi);
  return { handlers, notifications, checkpointEvents, ctx };
}

test("runtime contributes ops instructions and records native inline compaction", async () => {
  const h = harness();
  await h.handlers.get("session_start")({}, h.ctx);
  const result = await h.handlers.get("session_before_compact")({ reason: "threshold" }, h.ctx);
  assert.match(result.customInstructions, /host-by-host phase/);
  assert.equal(h.checkpointEvents.at(-1).data.pending, true);

  await h.handlers.get("session_compact")({ reason: "threshold" }, h.ctx);
  assert.deepEqual(h.checkpointEvents.at(-1).data, {
    pending: false,
    status: "ok",
    reason: "threshold",
    count: 1,
  });
  assert.equal(h.notifications.length, 0);
});

test("runtime fails closed without injecting a continuation prompt", async () => {
  const h = harness();
  await h.handlers.get("session_start")({}, h.ctx);
  await h.handlers.get("session_before_compact")({ reason: "threshold" }, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);

  assert.equal(h.checkpointEvents.at(-1).data.pending, false);
  assert.equal(h.checkpointEvents.at(-1).data.status, "fail");
  assert.match(h.notifications.at(-1).message, /failed closed/);
});

test("manual compaction receives instructions without becoming an active-task rollover", async () => {
  const h = harness();
  await h.handlers.get("session_start")({}, h.ctx);
  const beforeCount = h.checkpointEvents.length;
  const result = await h.handlers.get("session_before_compact")({ reason: "manual" }, h.ctx);
  await h.handlers.get("session_compact")({ reason: "manual" }, h.ctx);

  assert.match(result.customInstructions, /operational state/);
  assert.equal(h.checkpointEvents.length, beforeCount);
});

test("runtime warns after repeated compactions because summary drift compounds", async () => {
  const h = harness();
  await h.handlers.get("session_start")({}, h.ctx);
  for (let index = 0; index < 2; index += 1) {
    await h.handlers.get("session_before_compact")({ reason: "threshold" }, h.ctx);
    await h.handlers.get("session_compact")({ reason: "threshold" }, h.ctx);
  }
  assert.match(h.notifications.at(-1).message, /checkpoint 2 complete/);
});
