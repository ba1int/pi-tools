import assert from "node:assert/strict";
import test from "node:test";
import {
  RoutingState,
  classifyPrompt,
  looksMutatingRemoteCommand,
  toolFailureRequiresEscalation,
} from "../extensions/thinking-router/core.js";

test("routine runbook operations route low", () => {
  for (const prompt of [
    "Wire app42 into Icinga according to its assignment.",
    "Onboard this host into monitoring.",
    "Follow the certificate rotation runbook for api01.",
    "Restart the middleware service using the documented procedure.",
  ]) {
    assert.equal(classifyPrompt(prompt).level, "low", prompt);
  }
});

test("incidents, ambiguity, and runbook engineering route high", () => {
  for (const prompt of [
    "Investigate this Icinga critical and find the root cause.",
    "Why is middleware intermittently timing out?",
    "Create a reusable runbook for this procedure.",
    "The deployment hit an unexpected failure; diagnose it.",
  ]) {
    assert.equal(classifyPrompt(prompt).level, "high", prompt);
  }
});

test("unknown requests default high and brief confirmations retain the prior level", () => {
  assert.equal(classifyPrompt("Handle this ticket for me.").level, "high");
  assert.deepEqual(classifyPrompt("go ahead", "low"), {
    level: "low", reason: "continuation", retained: true,
  });
});

test("remote mutation detection distinguishes inspections from changes", () => {
  assert.equal(looksMutatingRemoteCommand("hostname; cat /etc/app.conf"), false);
  assert.equal(looksMutatingRemoteCommand("sudo install -m 0644 /tmp/x /etc/app.conf"), true);
  assert.equal(looksMutatingRemoteCommand("printf ok | sudo tee /etc/app.conf"), true);
});

test("failures escalate only after mutation or for transport errors", () => {
  assert.equal(toolFailureRequiresEscalation({ exitCode: 1 }, false), false);
  assert.equal(toolFailureRequiresEscalation({ exitCode: 1 }, true), true);
  assert.equal(toolFailureRequiresEscalation({ timedOut: true }, false), true);
  assert.equal(toolFailureRequiresEscalation({ isError: true }, false), true);
});

test("routing state respects manual override and automatic failure escalation", () => {
  const state = new RoutingState();
  assert.equal(state.route("Onboard this host into monitoring.").level, "low");
  state.noteRemoteCommand("sudo tee /etc/app.conf");
  assert.equal(state.noteRemoteResult({ exitCode: 1 }).level, "high");
  assert.equal(state.level, "high");

  state.setManual("low");
  state.noteRemoteCommand("sudo tee /etc/app.conf");
  assert.equal(state.noteRemoteResult({ exitCode: 1 }), null);
  assert.equal(state.route("Investigate an outage.").level, "low");

  state.setAuto();
  assert.equal(state.route("Investigate an outage.").level, "high");
});
