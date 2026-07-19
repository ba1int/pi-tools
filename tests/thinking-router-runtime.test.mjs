import assert from "node:assert/strict";
import test from "node:test";
import thinkingRouter from "../extensions/thinking-router/index.ts";

function createHarness() {
  const handlers = new Map();
  const commands = new Map();
  const selections = [];
  const statuses = [];
  const notifications = [];
  let thinkingLevel = "high";

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
  };

  thinkingRouter(pi);
  return {
    commands,
    ctx,
    handlers,
    notifications,
    selections,
    statuses,
    thinkingLevel: () => thinkingLevel,
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
  assert.equal(harness.thinkingLevel(), "low");
  assert.match(harness.statuses.at(-1), /^auto low · bounded routine operation$/);
  await selectEvent(harness, "low");

  await harness.handlers.get("input")({
    source: "interactive",
    text: "Investigate this critical alert and find the root cause.",
  }, harness.ctx);
  assert.equal(harness.thinkingLevel(), "high");
  assert.match(harness.statuses.at(-1), /^auto high · investigation or runbook engineering$/);
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
  assert.match(harness.statuses.at(-1), /^manual high · manual override$/);

  await harness.commands.get("think").handler("auto", harness.ctx);
  await harness.handlers.get("input")({
    source: "interactive",
    text: "Onboard this host into monitoring.",
  }, harness.ctx);
  assert.equal(harness.thinkingLevel(), "low");
  assert.match(harness.statuses.at(-1), /^auto low · bounded routine operation$/);
});

test("runtime tool events escalate transport and post-mutation failures", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")({}, harness.ctx);

  await harness.handlers.get("input")({
    source: "interactive",
    text: "Onboard this host into monitoring.",
  }, harness.ctx);
  await selectEvent(harness, "low");
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
  assert.match(harness.statuses.at(-1), /^auto high · failed checkpoint after mutation$/);

  await selectEvent(harness, "high");
  await harness.handlers.get("input")({
    source: "interactive",
    text: "Onboard this host into monitoring.",
  }, harness.ctx);
  await selectEvent(harness, "low");
  await harness.handlers.get("tool_result")({
    toolName: "ssh_exec",
    isError: false,
    details: { exitCode: 255, timedOut: false, transportError: true },
  }, harness.ctx);
  assert.equal(harness.thinkingLevel(), "high");
  assert.match(harness.statuses.at(-1), /^auto high · SSH transport failure$/);
});
