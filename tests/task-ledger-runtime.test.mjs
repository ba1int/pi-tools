import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import taskLedger from "../extensions/task-ledger/index.ts";

function harness() {
  const handlers = new Map();
  let thinking = "low";
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    getThinkingLevel() {
      return thinking;
    },
  };
  const ctx = {
    cwd: "/work/monitoring",
    model: { id: "gpt-5.6-sol" },
    sessionManager: {
      getSessionId: () => "runtime-session",
      getSessionName: () => "Operations",
    },
  };
  taskLedger(pi);
  return { ctx, handlers, setThinking: (level) => { thinking = level; } };
}

test("registration does not query Pi before the runtime is initialized", () => {
  const handlers = new Map();
  taskLedger({
    on(name, handler) { handlers.set(name, handler); },
    getThinkingLevel() { throw new Error("runtime not initialized"); },
  });
  assert.equal(handlers.has("session_start"), true);
});

test("runtime events create a zero-prompt checkpoint record", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "pi-ledger-runtime-"));
  const previous = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    ZELLIJ_SESSION_NAME: process.env.ZELLIJ_SESSION_NAME,
    PI_SIDE_TASK_FLOAT: process.env.PI_SIDE_TASK_FLOAT,
  };
  process.env.XDG_STATE_HOME = stateHome;
  process.env.ZELLIJ_SESSION_NAME = "ops";
  delete process.env.PI_SIDE_TASK_FLOAT;

  try {
    const testHarness = harness();
    const { handlers, ctx } = testHarness;
    await handlers.get("session_start")({}, ctx);
    await handlers.get("input")({
      source: "interactive",
      text: "Inspect lab-prod-app01 middleware health.",
    }, ctx);
    await handlers.get("agent_start")({}, ctx);
    await handlers.get("tool_execution_start")({
      toolCallId: "tool-1",
      toolName: "ssh_exec",
      args: { host: "lab-prod-app01", command: "cat /state/status" },
    }, ctx);
    testHarness.setThinking("high");
    await handlers.get("thinking_level_select")({ level: "high", previousLevel: "low" }, ctx);
    await handlers.get("tool_execution_end")({
      toolCallId: "tool-1",
      toolName: "ssh_exec",
      result: { details: { exitCode: 0, elapsedMs: 430 } },
      isError: false,
    }, ctx);
    await handlers.get("message_end")({
      message: {
        role: "assistant",
        usage: { totalTokens: 1200, cost: { total: 0.02 } },
        stopReason: "stop",
      },
    }, ctx);
    await handlers.get("agent_settled")({}, ctx);

    const snapshot = JSON.parse(readFileSync(
      join(stateHome, "pi-ledger", "ops", "current.json"),
      "utf8",
    ));
    assert.equal(snapshot.state, "complete");
    assert.equal(snapshot.thinking, "high");
    assert.equal(snapshot.cost, 0.02);
    assert.equal(snapshot.tokens, 1200);
    assert.equal(snapshot.events.find((event) => event.kind === "SSH").status, "ok");
    assert.equal(snapshot.events.find((event) => event.kind === "SSH").detail, "lab-prod-app01");
    assert.equal(snapshot.events.some((event) => event.kind === "ROUTE" && event.detail === "low → high"), true);
    assert.equal(snapshot.events.at(-1).kind, "DONE");
    assert.doesNotMatch(JSON.stringify(snapshot), /cat \/state\/status/);
  } finally {
    if (previous.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous.XDG_STATE_HOME;
    if (previous.ZELLIJ_SESSION_NAME === undefined) delete process.env.ZELLIJ_SESSION_NAME;
    else process.env.ZELLIJ_SESSION_NAME = previous.ZELLIJ_SESSION_NAME;
    if (previous.PI_SIDE_TASK_FLOAT === undefined) delete process.env.PI_SIDE_TASK_FLOAT;
    else process.env.PI_SIDE_TASK_FLOAT = previous.PI_SIDE_TASK_FLOAT;
    rmSync(stateHome, { recursive: true, force: true });
  }
});

test("floating side conversations do not claim the primary ledger", () => {
  const previous = process.env.PI_SIDE_TASK_FLOAT;
  process.env.PI_SIDE_TASK_FLOAT = "1";
  try {
    const handlers = new Map();
    taskLedger({
      on(name, handler) { handlers.set(name, handler); },
      getThinkingLevel() { return "high"; },
    });
    assert.equal(handlers.size, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_SIDE_TASK_FLOAT;
    else process.env.PI_SIDE_TASK_FLOAT = previous;
  }
});
