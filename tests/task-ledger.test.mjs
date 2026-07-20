import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MAX_LEDGER_EVENTS,
  MAX_LEDGER_NOTES,
  appendLedgerEvent,
  appendLedgerNote,
  continueLedgerTask,
  createLedgerSnapshot,
  ledgerDisplayState,
  ledgerFocusScore,
  ledgerNoteDetail,
  lastLedgerNote,
  loadLedgerRecords,
  renderAgentBoard,
  renderLedger,
  resolveAgentKey,
  resolveLedgerDirectory,
  resolveLedgerPath,
  sanitizeLedgerText,
  selectLedgerFocus,
  shouldContinueLedgerTask,
  startLedgerTask,
  toolLedgerDetail,
  toolLedgerOutcome,
  updateLedgerFocus,
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

test("adaptive focus promotes concrete work and ignores conversational churn", () => {
  assert.equal(ledgerFocusScore("What's the time?"), 0);
  assert.equal(ledgerFocusScore("thanks"), 0);
  assert.equal(ledgerFocusScore("check again"), 0);
  assert.equal(ledgerFocusScore("could you fix it?"), 0);
  assert.ok(ledgerFocusScore("Investigate the Icinga alert on prod-app01.") >= 3);
  assert.equal(
    selectLedgerFocus("What's the time?", "Investigate the Icinga alert on prod-app01."),
    "Investigate the Icinga alert on prod-app01.",
  );
  assert.equal(
    selectLedgerFocus("Investigate the Icinga alert on prod-app01.", "what did you find?"),
    "Investigate the Icinga alert on prod-app01.",
  );

  const snapshot = createLedgerSnapshot({
    sessionId: "focus-session",
    sessionName: "ops",
    cwd: "/work",
    model: { id: "gpt-5.6-sol" },
    thinking: "high",
  });
  startLedgerTask(snapshot, {
    prompt: "What's the time?",
    thinking: "high",
    model: { id: "gpt-5.6-sol" },
  });
  assert.equal(updateLedgerFocus(snapshot, "Fix the OpenVPN route on dc2-relay."), true);
  assert.equal(snapshot.prompt, "Fix the OpenVPN route on dc2-relay.");
  startLedgerTask(snapshot, {
    prompt: "thanks",
    thinking: "high",
    model: { id: "gpt-5.6-sol" },
  });
  assert.equal(snapshot.prompt, "Fix the OpenVPN route on dc2-relay.");
});

test("related follow-ups reopen the same project while explicit new work resets", () => {
  const snapshot = createLedgerSnapshot({
    sessionId: "continuity-session",
    sessionName: "ops",
    cwd: "/work",
    model: { id: "gpt-5.6-sol" },
    thinking: "high",
    now: 1000,
  });
  startLedgerTask(snapshot, {
    prompt: "Test the controlled mock manufacturer on eucaris-nap-t-01.",
    thinking: "high",
    model: { id: "gpt-5.6-sol" },
    now: 2000,
  });
  snapshot.state = "complete";
  snapshot.finishedAt = 3000;
  appendLedgerNote(snapshot, {
    state: "blocked",
    subject: "XMLDSig",
    note: "SOAP-wrapped digest does not match",
    at: 2900,
  });
  const taskId = snapshot.taskId;

  for (const prompt of [
    "so how can we fix this?",
    "Can we test all this without talking to the networking team?",
    "Proceed with the proxy POC on eucaris-nap-t-01.",
    "What do I need to give the networking team, and are we ready for three hosts?",
  ]) {
    assert.equal(shouldContinueLedgerTask(snapshot, prompt), true, prompt);
    continueLedgerTask(snapshot, {
      prompt,
      thinking: "high",
      model: { id: "gpt-5.6-sol" },
      now: snapshot.updatedAt + 1000,
    });
    snapshot.state = "complete";
  }

  assert.equal(snapshot.taskId, taskId);
  assert.equal(snapshot.notes.length, 1);
  assert.match(snapshot.prompt, /networking team/i);
  assert.equal(shouldContinueLedgerTask(snapshot, "New task: investigate Icinga on prod-db02."), false);
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

test("operator field notes are sanitized, deduplicated, and bounded separately", () => {
  const snapshot = createLedgerSnapshot({
    sessionId: "notes-session",
    sessionName: "ops",
    cwd: "/work",
    model: { id: "gpt-5.6-sol" },
    thinking: "high",
    now: 1000,
  });
  startLedgerTask(snapshot, {
    prompt: "Upgrade the six-host environment.",
    thinking: "high",
    model: { id: "gpt-5.6-sol" },
    now: 2000,
  });
  const first = appendLedgerNote(snapshot, {
    state: "done",
    subject: "web01\n",
    note: "OS and \x1b[31mDocker\x1b[0m validated",
    at: 3000,
  });
  assert.deepEqual(first, {
    at: 3000,
    state: "done",
    subject: "web01",
    note: "OS and Docker validated",
  });
  assert.equal(ledgerNoteDetail(first), "web01 · OS and Docker validated");
  appendLedgerNote(snapshot, {
    state: "done",
    subject: "web01",
    note: "OS and Docker validated",
    at: 3100,
  });
  assert.equal(snapshot.notes.length, 1);

  for (let index = 0; index < MAX_LEDGER_NOTES + 5; index += 1) {
    appendLedgerNote(snapshot, {
      state: index % 2 ? "working" : "verify",
      subject: `host${index}`,
      note: `checkpoint ${index}`,
      at: 4000 + index,
    });
  }
  assert.equal(snapshot.notes.length, MAX_LEDGER_NOTES);
  assert.equal(lastLedgerNote(snapshot).subject, `host${MAX_LEDGER_NOTES + 4}`);
  assert.equal(snapshot.events.length, 1);
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
  appendLedgerNote(snapshot, {
    state: "done",
    subject: "lab-dev-app01",
    note: "Icinga validation passed",
    at: 4000,
  });
  const output = renderLedger(snapshot, { width: 80, height: 22, color: false, now: 5000 });
  assert.match(output, /PI \/ TASK LEDGER/);
  assert.match(output, /RUNNING\s+00:03/);
  assert.match(output, /Wire lab-dev-app01 into Icinga/);
  assert.match(output, /ROUTE.*thinking low.*LOW/);
  assert.match(output, /FIELD NOTES/);
  assert.match(output, /DONE.*lab-dev-app01 · Icinga validation passed/);
  assert.match(output, /ACTIVITY/);
  assert.equal(output.split("\n").at(-1), "q close");
  assert.doesNotMatch(output, /zero extra model tokens|local only|live event feed/);
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

test("agent board prefers the latest field note over mechanical activity", () => {
  const now = Date.now();
  const snapshot = recordFixture({
    paneId: "terminal_4",
    processId: process.pid,
    state: "running",
    prompt: "Upgrade the production environment.",
    updatedAt: now,
  });
  appendLedgerNote(snapshot, {
    state: "done",
    subject: "web02",
    note: "Healthy after reboot",
    at: now + 1,
  });
  appendLedgerEvent(snapshot, {
    kind: "ssh",
    detail: "app01",
    status: "running",
    at: now + 2,
  });
  const output = renderAgentBoard([
    { key: "pane-terminal_4", snapshot, displayState: "running" },
  ], { width: 110, height: 18, color: false, now: now + 3 });
  assert.match(output, /DONE web02 · Healthy after rebo…/);
  assert.doesNotMatch(output, /SSH app01/);
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
