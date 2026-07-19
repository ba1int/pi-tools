import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MAX_LEDGER_EVENTS,
  appendLedgerEvent,
  createLedgerSnapshot,
  renderLedger,
  resolveLedgerPath,
  sanitizeLedgerText,
  startLedgerTask,
  toolLedgerDetail,
  toolLedgerOutcome,
  updateLedgerEvent,
} from "../extensions/task-ledger/core.js";

test("ledger paths are session-scoped and sanitize Zellij names", () => {
  assert.equal(
    resolveLedgerPath(
      { XDG_STATE_HOME: "/state", ZELLIJ_SESSION_NAME: "ops / prod" },
      "/home/operator",
    ),
    "/state/pi-ledger/ops-prod/current.json",
  );
  assert.equal(
    resolveLedgerPath({}, "/home/operator"),
    "/home/operator/.local/state/pi-ledger/terminal/current.json",
  );
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
