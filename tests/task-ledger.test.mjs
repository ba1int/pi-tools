import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MAX_LEDGER_EVENTS,
  appendLedgerEvent,
  createLedgerSnapshot,
  ledgerDisplayState,
  loadLedgerRecords,
  renderAgentBoard,
  renderLedger,
  resolveAgentKey,
  resolveLedgerDirectory,
  resolveLedgerPath,
  sanitizeLedgerText,
  startLedgerTask,
  toolLedgerDetail,
  toolLedgerOutcome,
  updateLedgerEvent,
} from "../extensions/task-ledger/core.js";
import {
  focusZellijPane,
  moveSelection,
  validZellijPaneId,
} from "../extensions/task-ledger/viewer.js";

test("ledger paths are session and pane scoped without a shared writer file", () => {
  assert.equal(
    resolveLedgerPath(
      {
        XDG_STATE_HOME: "/state",
        ZELLIJ_SESSION_NAME: "ops / prod",
        ZELLIJ_PANE_ID: "terminal_4",
      },
      "/home/operator",
    ),
    "/state/pi-ledger/ops-prod/agents/pane-terminal_4.json",
  );
  assert.equal(
    resolveLedgerPath({}, "/home/operator", 4321),
    "/home/operator/.local/state/pi-ledger/terminal/agents/pid-4321.json",
  );
  assert.equal(resolveAgentKey({ ZELLIJ_PANE_ID: "2 / bad" }, 5), "pane-2-bad");
  assert.equal(resolveLedgerDirectory({}, "/home/operator"), "/home/operator/.local/state/pi-ledger/terminal");
});

test("ledger text strips terminal controls and remains bounded", () => {
  assert.equal(sanitizeLedgerText("inspect\n\x1b[31mprod\x1b[0m\t now", 80), "inspect prod now");
  assert.equal(sanitizeLedgerText("abcdefgh", 5), "abcd…");
});

test("task snapshots retain a bounded, updateable event ledger", () => {
  const snapshot = createLedgerSnapshot({
    sessionId: "session-1234",
    sessionName: "ops",
    cwd: "/work",
    model: { id: "gpt-5.6-sol" },
    thinking: "high",
    now: 1000,
  });
  startLedgerTask(snapshot, {
    prompt: "Inspect middleware health.",
    thinking: "high",
    model: { id: "gpt-5.6-sol" },
    now: 2000,
  });
  const sequence = appendLedgerEvent(snapshot, {
    kind: "ssh",
    detail: "lab-prod-app01",
    status: "running",
    at: 3000,
  });
  assert.equal(updateLedgerEvent(snapshot, sequence, {
    status: "ok",
    elapsedMs: 430,
  }, 3500), true);
  assert.equal(snapshot.events.at(-1).status, "ok");
  assert.equal(snapshot.events.at(-1).elapsedMs, 430);

  for (let index = 0; index < MAX_LEDGER_EVENTS + 10; index += 1) {
    appendLedgerEvent(snapshot, { kind: "read", detail: String(index) });
  }
  assert.equal(snapshot.events.length, MAX_LEDGER_EVENTS);
});

test("tool records expose targets and outcomes without raw commands", () => {
  assert.equal(
    toolLedgerDetail("ssh_exec", { host: "lab-prod-app01", command: "cat /secret" }),
    "lab-prod-app01",
  );
  assert.equal(toolLedgerDetail("bash", { command: "cat /secret" }), "local shell");
  assert.deepEqual(
    toolLedgerOutcome({ details: { exitCode: 1, failureKind: "remote_exit" } }, false),
    { status: "fail", note: "remote_exit" },
  );
  assert.deepEqual(toolLedgerOutcome({ details: { exitCode: 0 } }, false), {
    status: "ok", note: "",
  });
});

test("plain renderer produces a Protocol Ink record without ANSI escapes", () => {
  const snapshot = createLedgerSnapshot({
    sessionId: "session-1234",
    sessionName: "ops",
    cwd: "/work",
    model: { id: "gpt-5.6-sol" },
    thinking: "low",
    now: 1000,
  });
  startLedgerTask(snapshot, {
    prompt: "Wire lab-dev-app01 into Icinga.",
    thinking: "low",
    model: { id: "gpt-5.6-sol" },
    now: 2000,
  });
  snapshot.state = "running";
  const output = renderLedger(snapshot, { width: 80, height: 22, color: false, now: 5000 });
  assert.match(output, /PI \/ TASK LEDGER/);
  assert.match(output, /RUNNING\s+00:03/);
  assert.match(output, /Wire lab-dev-app01 into Icinga/);
  assert.match(output, /ROUTE.*thinking low.*LOW/);
  assert.doesNotMatch(output, /\x1b/);
});

test("embedded renderer leaves the title to its Zellij pane frame", () => {
  const empty = renderLedger(null, {
    width: 80,
    height: 22,
    color: false,
    showTitle: false,
  });
  assert.doesNotMatch(empty, /PI \/ TASK LEDGER/);
  assert.match(empty, /NO ACTIVE RECORD/);

  const now = Date.now();
  const records = [{
    key: "pane-terminal_1",
    displayState: "running",
    snapshot: recordFixture({
      paneId: "terminal_1",
      processId: process.pid,
      state: "running",
      prompt: "Inspect Icinga alert.",
      updatedAt: now,
    }),
  }];
  const board = renderAgentBoard(records, {
    width: 80,
    height: 22,
    color: false,
    now,
    showTitle: false,
  });
  assert.doesNotMatch(board, /PI \/ AGENT BOARD/);
  assert.match(board, /1 ACTIVE/);
});

function recordFixture({ paneId, processId, state, prompt, updatedAt, finishedAt = null }) {
  const snapshot = createLedgerSnapshot({
    sessionId: `session-${paneId}`,
    sessionName: paneId,
    cwd: "/work",
    model: { id: "gpt-5.6-sol" },
    thinking: "high",
    paneId,
    processId,
    zellijSession: "ops",
    now: updatedAt - 1000,
  });
  startLedgerTask(snapshot, {
    prompt,
    thinking: "high",
    model: { id: "gpt-5.6-sol" },
    now: updatedAt - 1000,
  });
  snapshot.state = state;
  snapshot.updatedAt = updatedAt;
  snapshot.finishedAt = finishedAt;
  appendLedgerEvent(snapshot, {
    kind: state === "failed" ? "ssh" : "agent",
    detail: state === "failed" ? "exit 255" : "work started",
    status: state === "failed" ? "fail" : state,
    at: updatedAt,
  });
  return snapshot;
}

test("agent discovery sorts concurrent records and marks dead writers stale", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-ledger-agents-"));
  const environment = {
    XDG_STATE_HOME: join(home, "state"),
    ZELLIJ_SESSION_NAME: "ops",
  };
  const agents = join(resolveLedgerDirectory(environment, home), "agents");
  mkdirSync(agents, { recursive: true });
  const fixtures = [
    ["pane-terminal_1.json", recordFixture({ paneId: "terminal_1", processId: 101, state: "running", prompt: "Inspect Icinga alert.", updatedAt: 9000 })],
    ["pane-terminal_2.json", recordFixture({ paneId: "terminal_2", processId: 102, state: "failed", prompt: "Repair VPN route.", updatedAt: 8000, finishedAt: 8000 })],
    ["pane-terminal_3.json", recordFixture({ paneId: "terminal_3", processId: 103, state: "running", prompt: "Check MQ health.", updatedAt: 7000 })],
  ];
  try {
    for (const [name, snapshot] of fixtures) {
      writeFileSync(join(agents, name), JSON.stringify(snapshot));
    }
    const records = loadLedgerRecords({
      environment,
      home,
      now: 10000,
      isAlive: (processId) => processId !== 103,
    });
    assert.deepEqual(records.map((record) => record.displayState), ["running", "failed", "stale"]);
    assert.deepEqual(records.map((record) => record.snapshot.paneId), ["terminal_1", "terminal_2", "terminal_3"]);
    assert.equal(ledgerDisplayState(fixtures[2][1], () => false), "stale");

    const output = renderAgentBoard(records, {
      width: 110,
      height: 22,
      color: false,
      now: 10000,
      selectedKey: records[1].key,
    });
    assert.match(output, /PI \/ AGENT BOARD/);
    assert.match(output, /1 ACTIVE · 1 FAILED · 1 STALE/);
    assert.match(output, /RUNNING.*Inspect Icinga alert.*AGENT work started/);
    assert.match(output, /› 02.*FAILED.*Repair VPN route.*SSH exit 255/);
    assert.match(output, /STALE.*Check MQ health/);
    assert.doesNotMatch(output, /\x1b/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("board selection wraps and pane focus validates Zellij identifiers", () => {
  const records = [{ key: "one" }, { key: "two" }, { key: "three" }];
  assert.equal(moveSelection(records, "one", -1), "three");
  assert.equal(moveSelection(records, "three", 1), "one");
  assert.equal(validZellijPaneId("terminal_12"), true);
  assert.equal(validZellijPaneId("12; touch /tmp/nope"), false);

  const previous = process.env.ZELLIJ_SESSION_NAME;
  process.env.ZELLIJ_SESSION_NAME = "ops";
  try {
    let invocation;
    assert.equal(focusZellijPane("terminal_12", (...args) => {
      invocation = args;
      return { status: 0 };
    }), true);
    assert.deepEqual(invocation[0], "zellij");
    assert.deepEqual(invocation[1], ["action", "focus-pane-id", "terminal_12"]);
    assert.equal(focusZellijPane("not a pane", () => {
      throw new Error("must not run");
    }), false);
  } finally {
    if (previous === undefined) delete process.env.ZELLIJ_SESSION_NAME;
    else process.env.ZELLIJ_SESSION_NAME = previous;
  }
});

test("agent board keeps the selected record visible in a long list", () => {
  const now = Date.now();
  const records = Array.from({ length: 20 }, (_, index) => ({
    key: `pane-${index + 1}`,
    displayState: "running",
    snapshot: recordFixture({
      paneId: `terminal_${index + 1}`,
      processId: process.pid,
      state: "running",
      prompt: `Task ${index + 1}`,
      updatedAt: now - index,
    }),
  }));
  const output = renderAgentBoard(records, {
    width: 90,
    height: 16,
    color: false,
    now,
    selectedKey: "pane-20",
  });
  assert.match(output, /› 20.*Task 20/);
  assert.doesNotMatch(output, /Task 1\s/);
});

test("agent board does not wrap its own rows in a narrow floating pane", () => {
  const now = Date.now();
  const snapshot = recordFixture({
    paneId: "terminal_1",
    processId: process.pid,
    state: "running",
    prompt: "Investigate a deliberately long monitoring incident title.",
    updatedAt: now,
  });
  const output = renderAgentBoard([
    { key: "pane-terminal_1", snapshot, displayState: "running" },
  ], { width: 58, height: 16, color: false, now });
  assert.match(output, /PI \/ AGENT BOARD/);
  assert.equal(Math.max(...output.split("\n").map((line) => [...line].length)), 58);
});

test("pi-ledger CLI renders a saved snapshot once", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ledger-cli-"));
  try {
    const path = join(directory, "current.json");
    const snapshot = createLedgerSnapshot({
      sessionId: "session-cli",
      sessionName: "ops",
      cwd: "/work",
      model: { id: "gpt-5.6-sol" },
      thinking: "high",
    });
    writeFileSync(path, JSON.stringify(snapshot));
    const result = spawnSync(
      process.execPath,
      [new URL("../bin/pi-ledger", import.meta.url).pathname, "--once", "--plain", "--path", path],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PI \/ TASK LEDGER/);
    assert.match(result.stdout, /SESSION\s+ops/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pi-ledger embedded mode omits its internal title", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ledger-embedded-cli-"));
  try {
    const path = join(directory, "current.json");
    const snapshot = createLedgerSnapshot({
      sessionId: "session-cli",
      sessionName: "ops",
      cwd: "/work",
      model: { id: "gpt-5.6-sol" },
      thinking: "high",
    });
    writeFileSync(path, JSON.stringify(snapshot));
    const result = spawnSync(
      process.execPath,
      [new URL("../bin/pi-ledger", import.meta.url).pathname, "--once", "--plain", "--embedded", "--path", path],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /PI \/ TASK LEDGER/);
    assert.match(result.stdout, /SESSION\s+ops/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pi-ledger CLI switches to the agent board for concurrent panes", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ledger-board-cli-"));
  const environment = {
    ...process.env,
    XDG_STATE_HOME: join(directory, "state"),
    ZELLIJ_SESSION_NAME: "ops",
  };
  const agents = join(environment.XDG_STATE_HOME, "pi-ledger", "ops", "agents");
  mkdirSync(agents, { recursive: true });
  try {
    writeFileSync(join(agents, "pane-terminal_1.json"), JSON.stringify(recordFixture({
      paneId: "terminal_1",
      processId: process.pid,
      state: "running",
      prompt: "Inspect Icinga alert.",
      updatedAt: Date.now(),
    })));
    writeFileSync(join(agents, "pane-terminal_2.json"), JSON.stringify(recordFixture({
      paneId: "terminal_2",
      processId: process.pid,
      state: "running",
      prompt: "Wire host into monitoring.",
      updatedAt: Date.now() - 1000,
    })));
    const result = spawnSync(
      process.execPath,
      [new URL("../bin/pi-ledger", import.meta.url).pathname, "--once", "--plain"],
      { encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PI \/ AGENT BOARD/);
    assert.match(result.stdout, /2 ACTIVE/);
    assert.match(result.stdout, /Inspect Icinga alert/);
    assert.match(result.stdout, /Wire host into monitoring/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
