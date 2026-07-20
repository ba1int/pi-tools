import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACTION_INSTRUCTIONS,
  ContextSentinelState,
  normalizeThreshold,
  sentinelEnabled,
  usagePercent,
} from "../extensions/context-sentinel/core.js";

test("threshold configuration stays inside a safe operating range", () => {
  assert.equal(normalizeThreshold(undefined), 75);
  assert.equal(normalizeThreshold("68.5"), 68.5);
  assert.throws(() => normalizeThreshold("49"), /between 50 and 90/);
  assert.throws(() => normalizeThreshold("91"), /between 50 and 90/);
  assert.throws(() => normalizeThreshold("wat"), /between 50 and 90/);
  assert.equal(sentinelEnabled(undefined), true);
  assert.equal(sentinelEnabled("off"), false);
});

test("usage derives a percentage when Pi only exposes token counts", () => {
  assert.equal(usagePercent({ percent: 74, tokens: 1, contextWindow: 2 }), 74);
  assert.equal(usagePercent({ percent: null, tokens: 204000, contextWindow: 272000 }), 75);
  assert.equal(usagePercent({ percent: null, tokens: null, contextWindow: 272000 }), null);
});

test("sentinel triggers once after a tool turn and rearms after compaction", () => {
  const state = new ContextSentinelState(75);
  assert.deepEqual(
    state.observe({ percent: 74 }, { hasToolResults: true }),
    { trigger: false, percent: 74 },
  );
  assert.deepEqual(
    state.observe({ percent: 76 }, { hasToolResults: false }),
    { trigger: false, percent: 76 },
  );
  assert.deepEqual(
    state.observe({ percent: 76 }, { hasToolResults: true }),
    { trigger: true, percent: 76 },
  );
  assert.equal(state.observe({ percent: 80 }, { hasToolResults: true }).trigger, false);

  assert.equal(state.beginCompaction(), true);
  assert.equal(state.beginCompaction(), false);
  state.complete();
  assert.equal(state.observe({ percent: 70 }, { hasToolResults: true }).trigger, false);
  assert.equal(state.observe({ percent: 64 }, { hasToolResults: true }).trigger, false);
  assert.equal(state.observe({ percent: 76 }, { hasToolResults: true }).trigger, true);
});

test("compaction instructions preserve recovery state without secrets or log noise", () => {
  assert.match(COMPACTION_INSTRUCTIONS, /authorization and scope/);
  assert.match(COMPACTION_INSTRUCTIONS, /partial mutations/);
  assert.match(COMPACTION_INSTRUCTIONS, /prior compacted summary/);
  assert.match(COMPACTION_INSTRUCTIONS, /next safe action/);
  assert.match(COMPACTION_INSTRUCTIONS, /credentials or secret values/);
  assert.match(COMPACTION_INSTRUCTIONS, /without repeating a completed mutation/);
});
