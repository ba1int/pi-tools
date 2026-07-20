import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import taskLedger from "../extensions/task-ledger/index.ts";

function harness() {
  const handlers = new Map();
  const tools = new Map();
  let thinking = "low";
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    getThinkingLevel() {
      return thinking;
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
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
  return { ctx, handlers, tools, setThinking: (level) => { thinking = level; } };
}

test("registration does not query Pi before the runtime is initialized", () => {
  const handlers = new Map();
  taskLedger({
    on(name, handler) { handlers.set(name, handler); },
    getThinkingLevel() { throw new Error("runtime not initialized"); },
    registerTool() {},
  });
  assert.equal(handlers.has("session_start"), true);
});

test("checkpoint prompt guidance names the tool in every flat guideline", () => {
  const { tools } = harness();
  const checkpoint = tools.get("ops_checkpoint");
  assert.ok(checkpoint);
  assert.equal(
    checkpoint.promptGuidelines.every((guideline) => guideline.includes("ops_checkpoint")),
    true,
  );
});

test("runtime events create a zero-prompt checkpoint record", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "pi-ledger-runtime-"));
  const previous = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    ZELLIJ_SESSION_NAME: process.env.ZELLIJ_SESSION_NAME,
    ZELLIJ_PANE_ID: process.env.ZELLIJ_PANE_ID,
    PI_SIDE_TASK_FLOAT: process.env.PI_SIDE_TASK_FLOAT,
  };
  process.env.XDG_STATE_HOME = stateHome;
  process.env.ZELLIJ_SESSION_NAME = "ops";
  process.env.ZELLIJ_PANE_ID = "terminal_7";
  delete process.env.PI_SIDE_TASK_FLOAT;

  try {
    const testHarness = harness();
    const { handlers, tools, ctx } = testHarness;
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
    await handlers.get("tool_execution_start")({
      toolCallId: "tool-note",
      toolName: "ops_checkpoint",
      args: {
        state: "done",
        subject: "lab-prod-app01",
        note: "Middleware health validated",
      },
    }, ctx);
    const checkpointResult = await tools.get("ops_checkpoint").execute("tool-note", {
      state: "done",
      subject: "lab-prod-app01",
      note: "Middleware health validated",
    });
    await handlers.get("tool_execution_end")({
      toolCallId: "tool-note",
      toolName: "ops_checkpoint",
      result: checkpointResult,
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
      join(stateHome, "pi-ledger", "ops", "agents", "pane-terminal_7.json"),
      "utf8",
    ));
    assert.equal(snapshot.state, "complete");
    assert.equal(snapshot.thinking, "high");
    assert.equal(snapshot.cost, 0.02);
    assert.equal(snapshot.tokens, 1200);
    assert.equal(snapshot.events.find((event) => event.kind === "SSH").status, "ok");
    assert.equal(snapshot.events.find((event) => event.kind === "SSH").detail, "lab-prod-app01");
    assert.equal(snapshot.events.some((event) => event.kind === "ROUTE" && event.detail === "low → high"), true);
    assert.deepEqual(snapshot.notes, [{
      at: snapshot.notes[0].at,
      state: "done",
      subject: "lab-prod-app01",
      note: "Middleware health validated",
    }]);
    assert.equal(snapshot.events.some((event) => event.detail === "ops checkpoint"), false);
    assert.equal(snapshot.events.at(-1).kind, "DONE");
    assert.doesNotMatch(JSON.stringify(snapshot), /cat \/state\/status/);
  } finally {
    if (previous.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous.XDG_STATE_HOME;
    if (previous.ZELLIJ_SESSION_NAME === undefined) delete process.env.ZELLIJ_SESSION_NAME;
    else process.env.ZELLIJ_SESSION_NAME = previous.ZELLIJ_SESSION_NAME;
    if (previous.ZELLIJ_PANE_ID === undefined) delete process.env.ZELLIJ_PANE_ID;
    else process.env.ZELLIJ_PANE_ID = previous.ZELLIJ_PANE_ID;
    if (previous.PI_SIDE_TASK_FLOAT === undefined) delete process.env.PI_SIDE_TASK_FLOAT;
    else process.env.PI_SIDE_TASK_FLOAT = previous.PI_SIDE_TASK_FLOAT;
    rmSync(stateHome, { recursive: true, force: true });
  }
});

test("streamed follow-ups promote a concrete task over an incidental opener", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "pi-ledger-focus-"));
  const previous = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    ZELLIJ_SESSION_NAME: process.env.ZELLIJ_SESSION_NAME,
    ZELLIJ_PANE_ID: process.env.ZELLIJ_PANE_ID,
    PI_SIDE_TASK_FLOAT: process.env.PI_SIDE_TASK_FLOAT,
  };
  process.env.XDG_STATE_HOME = stateHome;
  process.env.ZELLIJ_SESSION_NAME = "ops";
  process.env.ZELLIJ_PANE_ID = "terminal_8";
  delete process.env.PI_SIDE_TASK_FLOAT;

  try {
    const { handlers, ctx } = harness();
    await handlers.get("session_start")({}, ctx);
    await handlers.get("input")({
      source: "interactive",
      text: "What's the time?",
    }, ctx);
    await handlers.get("input")({
      source: "interactive",
      text: "Investigate the Icinga alert on lab-prod-app01.",
      streamingBehavior: "followUp",
    }, ctx);
    await handlers.get("input")({
      source: "interactive",
      text: "what did you find?",
      streamingBehavior: "followUp",
    }, ctx);

    const snapshot = JSON.parse(readFileSync(
      join(stateHome, "pi-ledger", "ops", "agents", "pane-terminal_8.json"),
      "utf8",
    ));
    assert.equal(snapshot.prompt, "Investigate the Icinga alert on lab-prod-app01.");
    assert.equal(snapshot.events.filter((event) => event.kind === "FOLLOW-UP").length, 2);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateHome, { recursive: true, force: true });
  }
});

test("three concurrent pane writers retain independent task records", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "pi-ledger-concurrent-"));
  const previous = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    ZELLIJ_SESSION_NAME: process.env.ZELLIJ_SESSION_NAME,
    ZELLIJ_PANE_ID: process.env.ZELLIJ_PANE_ID,
    PI_SIDE_TASK_FLOAT: process.env.PI_SIDE_TASK_FLOAT,
  };
  process.env.XDG_STATE_HOME = stateHome;
  process.env.ZELLIJ_SESSION_NAME = "dispatcher";
  delete process.env.PI_SIDE_TASK_FLOAT;

  try {
    const agents = ["terminal_1", "terminal_2", "terminal_3"].map((paneId) => {
      process.env.ZELLIJ_PANE_ID = paneId;
      return { paneId, ...harness() };
    });

    await Promise.all(agents.map(async ({ paneId, handlers, ctx }) => {
      await handlers.get("session_start")({}, ctx);
      await handlers.get("input")({
        source: "interactive",
        text: `Investigate task in ${paneId}.`,
      }, ctx);
      await handlers.get("agent_start")({}, ctx);
    }));

    const snapshots = agents.map(({ paneId }) => {
      const path = join(
        stateHome,
        "pi-ledger",
        "dispatcher",
        "agents",
        `pane-${paneId}.json`,
      );
      assert.equal(statSync(path).mode & 0o777, 0o600);
      return JSON.parse(readFileSync(path, "utf8"));
    });
    assert.deepEqual(snapshots.map((snapshot) => snapshot.paneId), [
      "terminal_1",
      "terminal_2",
      "terminal_3",
    ]);
    assert.deepEqual(snapshots.map((snapshot) => snapshot.prompt), [
      "Investigate task in terminal_1.",
      "Investigate task in terminal_2.",
      "Investigate task in terminal_3.",
    ]);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
