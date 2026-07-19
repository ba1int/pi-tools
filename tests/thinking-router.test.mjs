import assert from "node:assert/strict";
import test from "node:test";
import {
  RoutingState,
  classifyPrompt,
  finalResultRequiresEscalation,
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
    assert.deepEqual(
      { tier: classifyPrompt(prompt).tier, level: classifyPrompt(prompt).level },
      { tier: "routine", level: "medium" },
      prompt,
    );
  }
});

test("incidents, ambiguity, and runbook engineering route high", () => {
  for (const prompt of [
    "Investigate this Icinga critical and find the root cause.",
    "Why is middleware intermittently timing out?",
    "Create a reusable runbook for this procedure.",
    "The deployment hit an unexpected failure; diagnose it.",
  ]) {
    assert.deepEqual(
      { tier: classifyPrompt(prompt).tier, level: classifyPrompt(prompt).level },
      { tier: "frontier", level: "high" },
      prompt,
    );
  }
});

test("unknown requests default high and brief confirmations retain the prior level", () => {
  assert.equal(classifyPrompt("Handle this ticket for me.").tier, "frontier");
  for (const prompt of [
    "go ahead",
    "okay do it",
    "yes please",
    "awesome, go ahead",
    "awesome yes, go ahead and do that",
  ]) {
    assert.deepEqual(classifyPrompt(prompt, "medium"), {
      level: "medium", reason: "continuation", retained: true,
    }, prompt);
  }
  assert.equal(classifyPrompt("okay, investigate the new critical alert", "low").level, "high");
});

test("remote mutation detection distinguishes inspections from changes", () => {
  assert.equal(looksMutatingRemoteCommand("hostname; cat /etc/app.conf"), false);
  assert.equal(looksMutatingRemoteCommand("sudo install -m 0644 /tmp/x /etc/app.conf"), true);
  assert.equal(looksMutatingRemoteCommand("printf ok | sudo tee /etc/app.conf"), true);
  for (const command of [
    "apt-get install -y nginx",
    "sudo dnf upgrade middleware",
    "docker restart middleware",
    "docker compose up -d",
    "kubectl apply -f deployment.yaml",
    "helm upgrade middleware ./chart",
    "systemctl daemon-reload",
    "sudo usermod -aG operators appuser",
    "sudo nft add rule inet filter input tcp dport 5665 accept",
  ]) {
    assert.equal(looksMutatingRemoteCommand(command), true, command);
  }
  for (const command of [
    "apt-cache policy nginx",
    "docker inspect middleware",
    "kubectl get pods",
    "systemctl status middleware",
    "nft list ruleset",
  ]) {
    assert.equal(looksMutatingRemoteCommand(command), false, command);
  }
});

test("failures escalate after mutation while preflight transport errors defer", () => {
  assert.equal(toolFailureRequiresEscalation({ exitCode: 1 }, false), false);
  assert.equal(toolFailureRequiresEscalation({ exitCode: 1 }, true), true);
  assert.equal(toolFailureRequiresEscalation({ timedOut: true }, false), false);
  assert.equal(toolFailureRequiresEscalation({ timedOut: true }, true), true);
  assert.equal(toolFailureRequiresEscalation({ isError: true }, false), true);
  assert.equal(toolFailureRequiresEscalation({ exitCode: 255, transportError: true }, false), false);
  assert.equal(toolFailureRequiresEscalation({ exitCode: 255, transportError: true }, true), true);
  assert.equal(toolFailureRequiresEscalation({ exitCode: 255, transportError: false }, false), false);
});

test("routing state respects manual override and automatic failure escalation", () => {
  const state = new RoutingState();
  assert.equal(state.route("Onboard this host into monitoring.").tier, "routine");
  state.noteRemoteCommand("sudo tee /etc/app.conf");
  assert.equal(state.noteRemoteResult({ exitCode: 1 }).tier, "frontier");
  assert.equal(state.level, "high");

  state.setManual("routine", "medium");
  state.noteRemoteCommand("sudo tee /etc/app.conf");
  assert.equal(state.noteRemoteResult({ exitCode: 1 }), null);
  assert.equal(state.route("Investigate an outage.").tier, "routine");

  state.setAuto();
  assert.equal(state.route("Investigate an outage.").level, "high");
});

test("unexpected bounded-worker stops escalate but hard safety blocks do not", () => {
  assert.equal(finalResultRequiresEscalation(
    "Blocked because the ticket differs from live assignment data. No changes made.",
  ), true);
  for (const report of [
    "Blocked by an ownership conflict: the network belongs to another client.",
    "Stopped because this dual-relay topology is not covered by the runbook.",
    "Blocked pending network-platform change authority.",
    "Blocked by a certificate fingerprint mismatch.",
    "Already configured correctly; no changes were necessary.",
  ]) {
    assert.equal(finalResultRequiresEscalation(report), false, report);
  }

  const state = new RoutingState();
  state.route("Onboard this host into monitoring.");
  assert.equal(state.noteFinalResult("Blocked because ticket data differs from live state.").tier, "frontier");
  assert.equal(state.noteFinalResult("Blocked again."), null, "only one automatic escalation");
});

test("post-mutation transport escalation reports the actual reason", () => {
  const state = new RoutingState();
  assert.equal(state.route("Onboard this host into monitoring.").level, "medium");
  state.noteRemoteCommand("sudo tee /etc/app.conf");
  const escalation = state.noteRemoteResult({ exitCode: 255, transportError: true });
  assert.equal(escalation.reason, "SSH transport failure");
  assert.equal(state.level, "high");
});
