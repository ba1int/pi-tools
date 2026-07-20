import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACTION_INSTRUCTIONS,
  ContextSentinelState,
  compactionInstructions,
  operationalFacts,
  operationalManifest,
  sentinelEnabled,
} from "../extensions/context-sentinel/core.js";

test("sentinel can be disabled without changing Pi settings", () => {
  assert.equal(sentinelEnabled(undefined), true);
  assert.equal(sentinelEnabled("off"), false);
});

test("operational manifest carries only the active task and bounded checkpoints", () => {
  const snapshot = {
    taskId: "session-004",
    prompt: "Upgrade the six-host UAT environment",
    state: "running",
    cwd: "/work/os-upgrade",
    notes: Array.from({ length: 15 }, (_, index) => ({
      state: index === 14 ? "blocked" : "done",
      subject: `host${index + 1}`,
      note: `checkpoint ${index + 1}`,
    })),
  };
  const manifest = operationalManifest(snapshot);
  assert.match(manifest, /Upgrade the six-host UAT environment/);
  assert.doesNotMatch(manifest, /checkpoint 1(?:\D|$)/);
  assert.match(manifest, /blocked \/ host15: checkpoint 15/);
  assert.equal(operationalManifest({ ...snapshot, state: "complete" }), "");
});

test("operational manifest has a bounded factual fallback when semantic notes are missing", () => {
  const snapshot = {
    taskId: "session-005",
    prompt: "Recover a staged multi-host middleware rollout",
    state: "running",
    cwd: "/work/rollout",
    notes: [],
    events: [
      { kind: "ROUTE", status: "high", detail: "thinking high" },
      { kind: "AGENT", status: "running", detail: "work started" },
      { kind: "SSH", status: "fail", detail: "uat-web01 · remote_exit" },
      { kind: "SSH", status: "ok", detail: "uat-web01" },
      { kind: "SSH", status: "ok", detail: "uat-web01" },
      { kind: "WRITE", status: "ok", detail: "/work/evidence/uat-web01.log" },
      { kind: "INPUT", status: "queued", detail: "continue" },
    ],
  };
  assert.deepEqual(operationalFacts(snapshot), [
    { kind: "ssh", status: "fail", detail: "uat-web01 · remote_exit" },
    { kind: "ssh", status: "ok", detail: "uat-web01" },
    { kind: "write", status: "ok", detail: "/work/evidence/uat-web01.log" },
  ]);
  const manifest = operationalManifest(snapshot);
  assert.match(manifest, /factual fallback; not proof of phase completion/);
  assert.match(manifest, /fail \/ ssh: uat-web01 · remote_exit/);
  assert.match(manifest, /ok \/ write: \/work\/evidence\/uat-web01\.log/);
  assert.doesNotMatch(manifest, /thinking high|work started|continue/);
});

test("compaction instructions preserve the full operational safety boundary", () => {
  const instructions = compactionInstructions(null);
  assert.equal(instructions, COMPACTION_INSTRUCTIONS);
  assert.match(instructions, /authorization and scope/);
  assert.match(instructions, /runbook or skill identity/);
  assert.match(instructions, /host-by-host phase/);
  assert.match(instructions, /partial mutations/);
  assert.match(instructions, /ownership or approval boundaries/);
  assert.match(instructions, /Preserve credentials and secret values/);
  assert.match(instructions, /still required to continue the authorized operation/);
  assert.match(instructions, /only in the compacted context/);
  assert.match(instructions, /never introduce a value that was not already present/);
  assert.match(instructions, /without repeating a completed mutation/);
});

test("checkpoint state distinguishes success from fail-closed settlement", () => {
  const state = new ContextSentinelState();
  state.begin("threshold");
  assert.equal(state.compacting, true);
  assert.equal(state.reason, "threshold");
  state.complete();
  assert.equal(state.compactions, 1);
  assert.equal(state.compacting, false);

  state.begin("overflow");
  state.fail();
  assert.equal(state.compactions, 1);
  assert.equal(state.compacting, false);
  assert.equal(state.reason, null);
});
