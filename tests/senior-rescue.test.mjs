import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSeniorPrompt,
  JsonEventCollector,
  ReactiveRescueState,
  normalizeBudget,
  normalizeSeniorRequest,
  normalizeRescueLimit,
  normalizeSeniorTimeout,
  parseHandback,
  parseJsonEvents,
  rescueFingerprint,
} from "../extensions/senior-rescue/core.js";

const request = {
  objective: "restore the failed deployment checkpoint",
  blocker: "validator fails after the smallest config change",
  current_state: "service is running; validator exits 7; canary is intact",
  failed_attempts: ["re-read active config and corrected the documented path"],
  constraints: "do not touch the legacy satellite",
  mutation_authorized: true,
  allowed_hosts: ["lab-dc2-sat01", "lab-dc1-master01"],
};

test("senior requests require a concrete bounded SSH lease", () => {
  const normalized = normalizeSeniorRequest(request);
  assert.deepEqual(normalized.allowed_hosts, request.allowed_hosts);
  assert.throws(() => normalizeSeniorRequest({ ...request, allowed_hosts: [] }), /1-8/);
  assert.throws(() => normalizeSeniorRequest({ ...request, allowed_hosts: ["host;id"] }), /invalid/);
  assert.throws(() => normalizeSeniorRequest({ ...request, blocker: "x" }), /blocker/);
  assert.equal(rescueFingerprint(normalized), rescueFingerprint(normalizeSeniorRequest(request)));
});

test("the senior prompt makes scope, verification, and handback explicit", () => {
  const prompt = buildSeniorPrompt(normalizeSeniorRequest(request));
  assert.match(prompt, /temporary senior for one blocked operations task/);
  assert.match(prompt, /lab-dc2-sat01, lab-dc1-master01/);
  assert.match(prompt, /Observe before mutation/);
  assert.match(prompt, /MUTATION AUTHORIZED/);
  assert.match(prompt, /Return ONLY one JSON object/);
});

test("JSON-mode events expose nested tool calls and usage", () => {
  const handback = {
    status: "resolved", root_cause: "active config shadowed the edited file",
    changes: ["lab-dc2-sat01: corrected active include"],
    verification: ["lab-dc2-sat01: validator exits 0"], handback: "verify once and resume",
    remaining_risks: [], hosts_touched: ["lab-dc2-sat01"],
  };
  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant", model: "gpt-5.6-sol",
      content: [
        { type: "toolCall", name: "ssh_exec", arguments: { host: "lab-dc2-sat01", command: "true" } },
        { type: "text", text: JSON.stringify(handback) },
      ],
      usage: { input: 10, output: 4, reasoning: 2, cost: { total: 0.01 } },
    },
  });
  const transcript = parseJsonEvents(`${event}\n`);
  assert.equal(transcript.toolCalls.length, 1);
  assert.equal(transcript.usage.cost, 0.01);
  assert.deepEqual(parseHandback(transcript.finalText, request.allowed_hosts), handback);
});

test("streaming event collection discards noisy deltas and retains the final handback", () => {
  const collector = new JsonEventCollector(1024);
  collector.push(Buffer.from(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { delta: "x".repeat(500) } })}\n`));
  const final = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: '{"status":"blocked"}' }],
      usage: { input: 3, output: 2, cost: { total: 0.02 } },
    },
  });
  collector.push(Buffer.from(`${final.slice(0, 20)}`));
  collector.push(Buffer.from(`${final.slice(20)}\n`));
  const result = collector.finish();
  assert.equal(result.finalText, '{"status":"blocked"}');
  assert.equal(result.usage.cost, 0.02);
  assert.equal(result.toolCalls.length, 0);
  assert.ok(result.stdoutBytes > final.length);
});

test("handbacks fail closed on invalid structure or out-of-lease hosts", () => {
  assert.throws(() => parseHandback("not json", request.allowed_hosts), /no JSON/);
  assert.throws(() => parseHandback(JSON.stringify({
    status: "resolved", root_cause: "x", changes: [], verification: ["other-host: checked"], handback: "x",
    remaining_risks: [], hosts_touched: ["other-host"],
  }), request.allowed_hosts), /outside lease/);
  assert.throws(() => parseHandback(JSON.stringify({
    status: "resolved", root_cause: "x", changes: [], verification: [], handback: "x",
    remaining_risks: [], hosts_touched: [],
  }), request.allowed_hosts), /no verification/);
});

test("senior time and tool budgets are bounded", () => {
  assert.equal(normalizeBudget(undefined), 6);
  assert.equal(normalizeBudget(8), 8);
  assert.throws(() => normalizeBudget(13), /1-12/);
  assert.equal(normalizeSeniorTimeout(undefined), 240);
  assert.throws(() => normalizeSeniorTimeout(601), /30-600/);
  assert.equal(normalizeRescueLimit(undefined), 3);
  assert.throws(() => normalizeRescueLimit("7"), /1-6/);
});

function assistantReport(text) {
  return [{ role: "assistant", content: [{ type: "text", text }] }];
}

test("reactive rescue queues exactly once after an unexpected host-bound stop", () => {
  const state = new ReactiveRescueState();
  state.noteInput({ source: "interactive", text: "Wire app01 into monitoring." });
  state.noteHost("app01");
  state.noteFinal(assistantReport("Blocked because assignment conflicts with live state. No changes made."));
  const followUp = state.takeFollowUp();
  assert.match(followUp, /Call senior_rescue exactly once/);
  assert.match(followUp, /Wire app01 into monitoring/);
  assert.match(followUp, /already observed hosts: app01/);
  assert.equal(state.takeFollowUp(), null);
});

test("reactive rescue preserves hard stops and requires an observed host", () => {
  for (const report of [
    "Blocked: this object belongs to another owning team; no changes made.",
    "Blocked: dual-relay topology is not covered by the runbook.",
  ]) {
    const state = new ReactiveRescueState();
    state.noteHost("app01");
    state.noteFinal(assistantReport(report));
    assert.equal(state.takeFollowUp(), null, report);
  }
  const noHost = new ReactiveRescueState();
  noHost.noteFinal(assistantReport("Blocked after validation; no changes made."));
  assert.equal(noHost.takeFollowUp(), null);
});
