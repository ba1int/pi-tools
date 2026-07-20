import assert from "node:assert/strict";
import test from "node:test";
import { operationalManifest } from "../extensions/context-sentinel/core.js";
import {
  appendLedgerEvent,
  appendLedgerNote,
  continueLedgerTask,
  createLedgerSnapshot,
  shouldContinueLedgerTask,
  startLedgerTask,
} from "../extensions/task-ledger/core.js";

function project(prompt) {
  const snapshot = createLedgerSnapshot({
    sessionId: "trace-regression",
    sessionName: "ops",
    cwd: "/work/operation",
    model: { id: "gpt-5.6-sol" },
    thinking: "high",
    now: 1000,
  });
  startLedgerTask(snapshot, {
    prompt,
    thinking: "high",
    model: { id: "gpt-5.6-sol" },
    now: 2000,
  });
  return snapshot;
}

test("false-blocker investigation retains the corrected hypothesis across follow-ups", () => {
  const snapshot = project("Test the controlled mock manufacturer on eucaris-nap-t-01.");
  appendLedgerNote(snapshot, {
    state: "changed",
    subject: "root cause",
    note: "Standalone XML verifies; SOAP wrapping changes the digest context",
    at: 3000,
  });
  appendLedgerNote(snapshot, {
    state: "verify",
    subject: "submission",
    note: "Submit exactly once after wrapped digest and signature both verify",
    at: 4000,
  });
  snapshot.state = "complete";

  const followUp = "Can we test all this without talking to the networking team first?";
  assert.equal(shouldContinueLedgerTask(snapshot, followUp), true);
  continueLedgerTask(snapshot, {
    prompt: followUp,
    thinking: "high",
    model: { id: "gpt-5.6-sol" },
    now: 5000,
  });
  appendLedgerEvent(snapshot, {
    kind: "ssh",
    detail: "eucaris-nap-t-01",
    status: "ok",
    at: 6000,
  });

  const manifest = operationalManifest(snapshot);
  assert.match(manifest, /SOAP wrapping changes the digest context/);
  assert.match(manifest, /Submit exactly once/);
  assert.match(manifest, /ok \/ ssh: eucaris-nap-t-01/);
});

test("multi-host mutation contract survives noisy execution and a second project turn", () => {
  const snapshot = project("Upgrade the UAT environment from RHEL 8.3 to RHEL 9.7.");
  appendLedgerNote(snapshot, {
    state: "start",
    subject: "acceptance",
    note: "RHEL 9.7; Docker 29.0.3; Compose 2.27.0; 10/10 containers; Icinga connected",
    at: 3000,
  });
  appendLedgerNote(snapshot, {
    state: "done",
    subject: "canary",
    note: "uat-aportal1 passed the strict acceptance gate before fanout",
    at: 4000,
  });
  for (let index = 0; index < 60; index += 1) {
    appendLedgerEvent(snapshot, {
      kind: "ssh",
      detail: `uat-host${String(index % 10).padStart(2, "0")}`,
      status: index % 17 === 0 ? "fail" : "ok",
      at: 5000 + index,
    });
  }
  snapshot.state = "complete";

  const followUp = "Okay, proceed with the remaining hosts, but keep the same ticket targets.";
  assert.equal(shouldContinueLedgerTask(snapshot, followUp), true);
  const taskId = snapshot.taskId;
  continueLedgerTask(snapshot, {
    prompt: followUp,
    thinking: "high",
    model: { id: "gpt-5.6-sol" },
    now: 7000,
  });

  const manifest = operationalManifest(snapshot);
  assert.equal(snapshot.taskId, taskId);
  assert.match(manifest, /Docker 29\.0\.3/);
  assert.match(manifest, /Compose 2\.27\.0/);
  assert.match(manifest, /canary.*strict acceptance gate/i);
  assert.match(manifest, /recent_tool_outcomes/);
  assert.ok(manifest.length <= 4096);
  assert.doesNotMatch(manifest, /Docker 29\.4\.3/);

  snapshot.state = "complete";
  assert.equal(
    shouldContinueLedgerTask(
      snapshot,
      "Awesome, so how long were we unable to serve and what belongs in the report?",
    ),
    true,
  );
});

test("an explicit unrelated task does not inherit the previous operation", () => {
  const snapshot = project("Upgrade the UAT environment from RHEL 8.3 to RHEL 9.7.");
  appendLedgerNote(snapshot, {
    state: "start",
    subject: "acceptance",
    note: "Docker 29.0.3",
  });
  snapshot.state = "complete";

  const next = "New task: investigate the Icinga database latency incident.";
  assert.equal(shouldContinueLedgerTask(snapshot, next), false);
  startLedgerTask(snapshot, {
    prompt: next,
    thinking: "high",
    model: { id: "gpt-5.6-sol" },
  });
  assert.equal(snapshot.notes.length, 0);
  assert.doesNotMatch(operationalManifest({ ...snapshot, state: "running" }), /Docker 29\.0\.3/);
});
