import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACTION_INSTRUCTIONS,
  ContextSentinelState,
  compactionInstructions,
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

test("compaction instructions preserve the full operational safety boundary", () => {
  const instructions = compactionInstructions(null);
  assert.equal(instructions, COMPACTION_INSTRUCTIONS);
  assert.match(instructions, /authorization and scope/);
  assert.match(instructions, /runbook or skill identity/);
  assert.match(instructions, /host-by-host phase/);
  assert.match(instructions, /partial mutations/);
  assert.match(instructions, /ownership or approval boundaries/);
  assert.match(instructions, /credentials or secret values/);
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
