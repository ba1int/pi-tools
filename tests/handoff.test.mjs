import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HANDOFF_STALE_MS,
  MAX_HANDOFF_OUTPUT,
  createHandoffRecord,
  loadHandoffRecords,
  persistHandoff,
  redactHandoffText,
  renderHandoffLookup,
  renderHandoffMarkdown,
  resolveHandoffDirectory,
  shouldPersistHandoff,
  workspaceFingerprint,
} from "../extensions/task-ledger/handoff.js";
import {
  appendLedgerEvent,
  appendLedgerNote,
  createLedgerSnapshot,
  startLedgerTask,
} from "../extensions/task-ledger/core.js";

function fixture({ cwd = "/work/icinga", now = 10_000 } = {}) {
  const snapshot = createLedgerSnapshot({
    sessionId: "session-123456",
    sessionName: "ops",
    cwd,
    model: { id: "gpt-5.6-luna" },
    thinking: "low",
    now: now - 1000,
  });
  startLedgerTask(snapshot, {
    prompt: "Upgrade the six-host UAT environment and validate Icinga.",
    model: { id: "gpt-5.6-luna" },
    thinking: "low",
    now,
  });
  return snapshot;
}

test("handoffs activate only for explicit checkpoints, compaction, or multi-host work", () => {
  const quick = fixture();
  appendLedgerEvent(quick, { kind: "ssh", detail: "uat-web01", status: "ok" });
  assert.equal(shouldPersistHandoff(quick), false);

  const noted = fixture();
  appendLedgerNote(noted, { state: "start", subject: "gate", note: "canary first" });
  assert.equal(shouldPersistHandoff(noted), true);

  const compacted = fixture();
  appendLedgerEvent(compacted, { kind: "context", detail: "checkpoint complete", status: "ok" });
  assert.equal(shouldPersistHandoff(compacted), true);

  const multiHost = fixture();
  appendLedgerEvent(multiHost, { kind: "ssh", detail: "uat-web01", status: "ok" });
  appendLedgerEvent(multiHost, { kind: "ssh", detail: "uat-web02", status: "ok" });
  assert.equal(shouldPersistHandoff(multiHost), true);
});

test("archive records are bounded, secret-redacted, and preserve completed work", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-"));
  try {
    const snapshot = fixture({ cwd: join(root, "project") });
    snapshot.state = "complete";
    snapshot.finishedAt = 20_000;
    appendLedgerNote(snapshot, {
      state: "done",
      subject: "uat-web01",
      note: "Validated API token=super-secret-value and password: hunter2",
      at: 19_000,
    });
    appendLedgerEvent(snapshot, {
      kind: "ssh",
      detail: "uat-web01",
      status: "ok",
      at: 19_500,
    });
    const result = persistHandoff(snapshot, {
      environment: { XDG_STATE_HOME: root },
      home: root,
      now: 21_000,
    });
    assert.ok(result);
    assert.equal(result.record.lifecycle, "complete");
    assert.equal(lstatSync(result.jsonPath).mode & 0o777, 0o600);
    const json = readFileSync(result.jsonPath, "utf8");
    const markdown = readFileSync(result.markdownPath, "utf8");
    assert.doesNotMatch(json, /super-secret-value|hunter2/);
    assert.match(json, /\[REDACTED\]/);
    assert.match(markdown, /State: COMPLETE/);
    assert.match(markdown, /Treat checkpoints as prior evidence/);

    const records = loadHandoffRecords({
      cwd: snapshot.cwd,
      query: "uat-web01 icinga",
      environment: { XDG_STATE_HOME: root },
      home: root,
      now: 22_000,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].lifecycle, "complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("week-old and interrupted records remain discoverable but require revalidation", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-stale-"));
  try {
    const snapshot = fixture({ cwd: join(root, "project"), now: 1000 });
    snapshot.state = "stopped";
    snapshot.updatedAt = 2000;
    snapshot.finishedAt = 2000;
    appendLedgerNote(snapshot, {
      state: "waiting",
      subject: "uat-web02",
      note: "Await application-owner acceptance",
      at: 1900,
    });
    persistHandoff(snapshot, {
      environment: { XDG_STATE_HOME: root },
      home: root,
      now: 2500,
    });
    const now = 2000 + HANDOFF_STALE_MS + 1;
    const [record] = loadHandoffRecords({
      cwd: snapshot.cwd,
      query: "application owner",
      environment: { XDG_STATE_HOME: root },
      home: root,
      now,
    });
    assert.equal(record.lifecycle, "waiting");
    assert.equal(record.requiresRevalidation, true);
    assert.match(renderHandoffMarkdown(record, now), /REVALIDATE LIVE STATE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lookup ranks the current workspace and relevant hosts without deleting history", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-rank-"));
  try {
    const current = fixture({ cwd: join(root, "current") });
    appendLedgerNote(current, { state: "blocked", subject: "dc2-sat01", note: "certificate trust failed" });
    persistHandoff(current, { environment: { XDG_STATE_HOME: root }, home: root, now: 20_000 });

    const other = fixture({ cwd: join(root, "other") });
    other.sessionId = "other-session";
    other.prompt = "Unrelated database maintenance";
    appendLedgerNote(other, { state: "done", subject: "db01", note: "backup verified" });
    persistHandoff(other, { environment: { XDG_STATE_HOME: root }, home: root, now: 21_000 });

    const records = loadHandoffRecords({
      cwd: current.cwd,
      query: "dc2-sat01 certificate",
      includeAllWorkspaces: true,
      environment: { XDG_STATE_HOME: root },
      home: root,
      now: 22_000,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].workspace, current.cwd);
    assert.match(records[0].objective, /six-host UAT/);
    assert.ok(existsSync(records[0].path));
    assert.deepEqual(loadHandoffRecords({
      cwd: current.cwd,
      query: "rabbitmq prod-mq99",
      includeAllWorkspaces: true,
      environment: { XDG_STATE_HOME: root },
      home: root,
      now: 22_000,
    }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive refuses a symlink target and uses stable workspace fingerprints", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-link-"));
  try {
    const snapshot = fixture({ cwd: join(root, "project") });
    appendLedgerNote(snapshot, { state: "start", subject: "gate", note: "canary only" });
    const directory = resolveHandoffDirectory(
      snapshot.cwd,
      { XDG_STATE_HOME: root },
      root,
    );
    const records = join(directory, "records");
    mkdirSync(records, { recursive: true, mode: 0o700 });
    const record = createHandoffRecord(snapshot, 20_000);
    const target = join(root, "outside.json");
    const path = join(records, `${record.recordId}.json`);
    symlinkSync(target, path);
    assert.throws(() => persistHandoff(snapshot, {
      environment: { XDG_STATE_HOME: root },
      home: root,
      now: 20_000,
    }), /symbolic link/);
    assert.equal(workspaceFingerprint(snapshot.cwd), workspaceFingerprint(snapshot.cwd));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lookup output stays bounded and secret patterns are removed", () => {
  assert.equal(
    redactHandoffText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"),
    "Authorization=[REDACTED]",
  );
  const record = createHandoffRecord(fixture(), 20_000);
  record.checkpoints = Array.from({ length: 100 }, (_, index) => ({
    state: "done",
    subject: `host-${index}`,
    note: "x".repeat(180),
  }));
  const output = renderHandoffLookup([record]);
  assert.ok(output.length <= MAX_HANDOFF_OUTPUT);
});
