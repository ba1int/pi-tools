import assert from "node:assert/strict";
import test from "node:test";
import thinkingRouter from "../extensions/thinking-router/index.ts";

function createHarness() {
  const handlers = new Map();
  const commands = new Map();
  const selections = [];
  const modelSelections = [];
  const statuses = [];
  const notifications = [];
  const followUps = [];
  let thinkingLevel = "high";
  let currentModel = { provider: "openai-codex", id: "gpt-5.6-sol" };

  const models = new Map([
    ["openai-codex/gpt-5.6-luna", { provider: "openai-codex", id: "gpt-5.6-luna" }],
    ["openai-codex/gpt-5.6-sol", { provider: "openai-codex", id: "gpt-5.6-sol" }],
  ]);

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    async setModel(model) {
      const previousModel = currentModel;
      currentModel = model;
      modelSelections.push(model.id);
      await handlers.get("model_select")?.({
        type: "model_select", model, previousModel, source: "set",
      }, ctx);
      return true;
    },
    setThinkingLevel(level) {
      thinkingLevel = level;
      selections.push(level);
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(_key, value) {
        statuses.push(value);
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
    modelRegistry: {
      find(provider, model) {
        return models.get(`${provider}/${model}`);
      },
    },
    get model() {
      return currentModel;
    },
  };

  pi.sendUserMessage = (message, options) => {
    followUps.push({ message, options });
  };

  thinkingRouter(pi);
  return {
    commands,
    ctx,
    handlers,
    notifications,
    followUps,
    modelSelections,
    selections,
    statuses,
    thinkingLevel: () => thinkingLevel,
    model: () => currentModel,
  };
}

async function selectEvent(harness, level) {
  await harness.handlers.get("thinking_level_select")({ level }, harness.ctx);
}

test("runtime input events switch the actual Pi thinking level", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")({}, harness.ctx);

  await harness.handlers.get("input")({
    source: "interactive",
    text: "Onboard this host into monitoring.",
  }, harness.ctx);
  assert.equal(harness.model().id, "gpt-5.6-luna");
  assert.equal(harness.thinkingLevel(), "medium");
  assert.match(harness.statuses.at(-1), /^auto routine\/medium · bounded routine operation$/);
  await selectEvent(harness, "medium");

  await harness.handlers.get("input")({
    source: "interactive",
    text: "Investigate this critical alert and find the root cause.",
  }, harness.ctx);
  assert.equal(harness.thinkingLevel(), "high");
  assert.equal(harness.model().id, "gpt-5.6-sol");
  assert.match(harness.statuses.at(-1), /^auto frontier\/high · investigation or runbook engineering$/);
});

test("runtime manual override remains sticky until auto is restored", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")({}, harness.ctx);
  await selectEvent(harness, "high");

  await harness.handlers.get("input")({
    source: "interactive",
    text: "Onboard this host into monitoring.",
  }, harness.ctx);
  assert.equal(harness.thinkingLevel(), "high");
  assert.match(harness.statuses.at(-1), /^manual frontier\/high · manual override$/);

  await harness.commands.get("think").handler("auto", harness.ctx);
  await harness.handlers.get("input")({
    source: "interactive",
    text: "Onboard this host into monitoring.",
  }, harness.ctx);
  assert.equal(harness.thinkingLevel(), "medium");
  assert.equal(harness.model().id, "gpt-5.6-luna");
  assert.match(harness.statuses.at(-1), /^auto routine\/medium · bounded routine operation$/);
});

test("runtime tool events escalate post-mutation failures", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")({}, harness.ctx);

  await harness.handlers.get("input")({
    source: "interactive",
    text: "Onboard this host into monitoring.",
  }, harness.ctx);
  await selectEvent(harness, "medium");
  await harness.handlers.get("tool_call")({
    toolName: "ssh_exec",
    input: { command: "docker restart middleware" },
  });
  await harness.handlers.get("tool_result")({
    toolName: "ssh_exec",
    isError: false,
    details: { exitCode: 1, timedOut: false, transportError: false },
  }, harness.ctx);
  assert.equal(harness.thinkingLevel(), "high");
  assert.equal(harness.model().id, "gpt-5.6-sol");
  assert.match(harness.statuses.at(-1), /^auto frontier\/high · failed checkpoint after mutation$/);

});

test("runtime defers a preflight transport failure to semantic final-result routing", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.handlers.get("input")({
    source: "interactive",
    text: "Onboard this host into monitoring.",
  }, harness.ctx);
  await harness.handlers.get("tool_result")({
    toolName: "ssh_exec",
    isError: false,
    details: { exitCode: 255, timedOut: false, transportError: true },
  }, harness.ctx);
  assert.equal(harness.thinkingLevel(), "medium");
  assert.equal(harness.model().id, "gpt-5.6-luna");

  await harness.handlers.get("agent_end")({
    messages: [{
      role: "assistant",
      content: [{ type: "text", text: "Unable to reach the assigned relay, so no changes were made." }],
    }],
  }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.thinkingLevel(), "high");
  assert.equal(harness.model().id, "gpt-5.6-sol");
  assert.equal(harness.followUps.length, 1);
});

test("runtime retries an unexpected Luna stop once with Sol", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.handlers.get("input")({
    source: "interactive",
    text: "Wire this host into monitoring according to its assignment.",
  }, harness.ctx);
  assert.equal(harness.model().id, "gpt-5.6-luna");

  await harness.handlers.get("agent_end")({
    messages: [{
      role: "assistant",
      content: [{ type: "text", text: "Blocked because the ticket conflicts with live assignment data. No changes made." }],
    }],
  }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.model().id, "gpt-5.6-sol");
  assert.equal(harness.followUps.length, 1);
  assert.match(harness.followUps[0].message, /Automatic escalation/);
  assert.equal(harness.followUps[0].options.deliverAs, "followUp");
});

test("runtime preserves legitimate Luna safety stops", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.handlers.get("input")({
    source: "interactive",
    text: "Wire this host into monitoring according to its assignment.",
  }, harness.ctx);
  await harness.handlers.get("agent_end")({
    messages: [{
      role: "assistant",
      content: [{ type: "text", text: "Blocked: dual-relay topology is not covered by the runbook. Escalate to network-platform." }],
    }],
  }, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.model().id, "gpt-5.6-luna");
  assert.equal(harness.followUps.length, 0);
});
