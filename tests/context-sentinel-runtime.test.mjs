import assert from "node:assert/strict";
import test from "node:test";
import contextSentinel from "../extensions/context-sentinel/index.ts";
import { CONTINUATION_PROMPT } from "../extensions/context-sentinel/core.js";

function harness(percent = 76) {
  const handlers = new Map();
  const notifications = [];
  const compactions = [];
  const messages = [];
  const checkpointEvents = [];
  const eventHandlers = new Map();
  let usage = { tokens: 206720, contextWindow: 272000, percent };

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
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
    getContextUsage() {
      return usage;
    },
    compact(options) {
      compactions.push(options);
    },
  };

  contextSentinel(pi);
  return {
    handlers,
    notifications,
    compactions,
    messages,
    checkpointEvents,
    ctx,
    setUsage(next) { usage = next; },
  };
}

test("runtime checkpoints only a continuing tool loop", async () => {
  const h = harness();
  await h.handlers.get("session_start")({}, h.ctx);
  await h.handlers.get("turn_end")({ toolResults: [] }, h.ctx);
  assert.equal(h.compactions.length, 0);

  await h.handlers.get("turn_end")({ toolResults: [{ toolCallId: "ssh-1" }] }, h.ctx);
  assert.equal(h.compactions.length, 0);
  assert.match(h.messages[0].message.content, /Do not call another tool/);
  assert.equal(h.messages[0].message.display, false);
  assert.deepEqual(h.notifications, [{
    message: "Context 76% · checkpointing before the next operation",
    level: "info",
  }]);

  await h.handlers.get("agent_settled")({}, h.ctx);
  assert.equal(h.compactions.length, 1);
  assert.match(h.compactions[0].customInstructions, /current blockers/);
  h.compactions[0].onComplete({});
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(h.messages[1].message.content, CONTINUATION_PROMPT);
  assert.deepEqual(h.messages[1].options, { deliverAs: "followUp", triggerTurn: true });
  assert.deepEqual(h.checkpointEvents.map((event) => event.data.pending), [false, true, false]);
});

test("runtime does not create a compaction loop while one is active", async () => {
  const h = harness(80);
  await h.handlers.get("session_start")({}, h.ctx);
  const toolTurn = { toolResults: [{ toolCallId: "ssh-1" }] };
  await h.handlers.get("turn_end")(toolTurn, h.ctx);
  await h.handlers.get("turn_end")(toolTurn, h.ctx);
  assert.equal(h.messages.length, 1);
  await h.handlers.get("agent_settled")({}, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  assert.equal(h.compactions.length, 1);
});

test("a compaction failure resumes cautiously instead of silently killing work", async () => {
  const h = harness(80);
  await h.handlers.get("session_start")({}, h.ctx);
  await h.handlers.get("turn_end")({ toolResults: [{ toolCallId: "ssh-1" }] }, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  h.compactions[0].onError(new Error("provider unavailable"));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.match(h.notifications.at(-1).message, /provider unavailable/);
  assert.match(h.messages.at(-1).message.content, /do not repeat completed mutations/);
});

test("headless modes leave Pi's native lifecycle untouched", async () => {
  const h = harness(80);
  h.ctx.mode = "print";
  await h.handlers.get("session_start")({}, h.ctx);
  await h.handlers.get("turn_end")({ toolResults: [{ toolCallId: "ssh-1" }] }, h.ctx);
  await h.handlers.get("agent_settled")({}, h.ctx);
  assert.equal(h.messages.length, 0);
  assert.equal(h.compactions.length, 0);
});
