import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { patchPiInlineCompaction } from "../lib/patch-pi-inline-compaction.mjs";

const prefix = process.env.PI_NPM_PREFIX || join(homedir(), ".local");
const installedManifest = join(
  prefix,
  "lib/node_modules/@earendil-works/pi-coding-agent/package.json",
);
const installedSessionRuntime = join(
  dirname(installedManifest),
  "dist/core/agent-session.js",
);

function makeRuntimeProbe(AgentSession, { contextWindow = 1000, reserveTokens = 100 } = {}) {
  const session = Object.create(AgentSession.prototype);
  session.agent = {
    state: {
      messages: [],
      model: { contextWindow },
      thinkingLevel: "high",
      tools: [{ name: "probe" }],
    },
  };
  session.settingsManager = {
    getCompactionSettings: () => ({ enabled: true, reserveTokens, keepRecentTokens: 20 }),
  };
  session.sessionManager = { getBranch: () => [] };
  session._baseSystemPrompt = "probe-system";
  session._systemPromptOverride = undefined;
  session._inlineCompactionFailed = false;
  return session;
}

function makeToolTurn(messages) {
  return {
    context: { messages, systemPrompt: "stale-system", tools: [] },
    message: { role: "assistant", stopReason: "toolUse", timestamp: Date.now() },
    toolResults: [{ role: "toolResult", toolCallId: "probe", content: [] }],
  };
}

test("0.80.10 runtime patch is guarded, idempotent, and syntactically valid", {
  skip: !existsSync(installedManifest),
}, () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-inline-compaction-"));
  const sourceRoot = dirname(installedManifest);
  const targetRoot = join(temporary, "pi-coding-agent");
  try {
    cpSync(sourceRoot, targetRoot, { recursive: true });
    const manifest = join(targetRoot, "package.json");
    const first = patchPiInlineCompaction(manifest, "0.80.10");
    assert.equal(typeof first.changed, "boolean");
    assert.equal(patchPiInlineCompaction(manifest, "0.80.10").changed, false);

    const target = join(targetRoot, "dist/core/agent-session.js");
    const source = readFileSync(target, "utf8");
    assert.match(source, /pi-tools:inline-compaction:v1/);
    assert.match(source, /_shouldCompactBeforeNextToolTurn/);
    assert.match(source, /stopped before the next model turn/);
    assert.match(source, /Compaction produced an empty summary/);
    assert.match(source, /extensionResult\?\.customInstructions/);

    const syntax = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("runtime patch refuses a version it was not reviewed against", {
  skip: !existsSync(installedManifest),
}, () => {
  assert.throws(
    () => patchPiInlineCompaction(installedManifest, "0.80.11"),
    /expected @earendil-works\/pi-coding-agent@0\.80\.11/,
  );
});

test("installed Pi runtime gates rollover at the configured boundary", {
  skip: !existsSync(installedSessionRuntime),
}, async () => {
  const { AgentSession } = await import(pathToFileURL(installedSessionRuntime).href);
  const session = makeRuntimeProbe(AgentSession, { contextWindow: 1000, reserveTokens: 200 });

  assert.equal(
    await session._shouldCompactBeforeNextToolTurn(makeToolTurn([
      { role: "user", content: "small", timestamp: Date.now() },
    ])),
    false,
  );
  assert.equal(
    await session._shouldCompactBeforeNextToolTurn(makeToolTurn([
      { role: "user", content: "x".repeat(4000), timestamp: Date.now() },
    ])),
    true,
  );

  const noToolResult = makeToolTurn([
    { role: "user", content: "x".repeat(4000), timestamp: Date.now() },
  ]);
  noToolResult.toolResults = [];
  assert.equal(await session._shouldCompactBeforeNextToolTurn(noToolResult), false);
});

test("installed Pi runtime replaces the next turn with compacted messages", {
  skip: !existsSync(installedSessionRuntime),
}, async () => {
  const { AgentSession } = await import(pathToFileURL(installedSessionRuntime).href);
  const session = makeRuntimeProbe(AgentSession);
  const compactedMessages = [
    { role: "user", content: "durable compacted state", timestamp: Date.now() },
  ];
  session._shouldCompactBeforeNextToolTurn = async () => true;
  session._runAutoCompaction = async () => {
    session.agent.state.messages = compactedMessages;
    return true;
  };

  session._installAgentNextTurnRefresh();
  const snapshot = await session.agent.prepareNextTurnWithContext(
    makeToolTurn([{ role: "user", content: "old oversized context", timestamp: Date.now() }]),
    new AbortController().signal,
  );

  assert.deepEqual(snapshot.context.messages, compactedMessages);
  assert.notEqual(snapshot.context.messages, compactedMessages);
  assert.equal(snapshot.context.systemPrompt, "probe-system");
  assert.deepEqual(snapshot.context.tools, [{ name: "probe" }]);
});

test("installed Pi runtime fails closed before another model turn", {
  skip: !existsSync(installedSessionRuntime),
}, async () => {
  const { AgentSession } = await import(pathToFileURL(installedSessionRuntime).href);
  const session = makeRuntimeProbe(AgentSession);
  session._shouldCompactBeforeNextToolTurn = async () => true;
  session._runAutoCompaction = async () => false;
  session._installAgentNextTurnRefresh();

  await assert.rejects(
    session.agent.prepareNextTurnWithContext(
      makeToolTurn([{ role: "user", content: "oversized", timestamp: Date.now() }]),
      new AbortController().signal,
    ),
    /stopped before the next model turn/,
  );
  assert.equal(session._inlineCompactionFailed, true);
});

test("installed Pi runtime rejects a summary that is still over budget", {
  skip: !existsSync(installedSessionRuntime),
}, async () => {
  const { AgentSession } = await import(pathToFileURL(installedSessionRuntime).href);
  const session = makeRuntimeProbe(AgentSession, { contextWindow: 1000, reserveTokens: 200 });
  session._shouldCompactBeforeNextToolTurn = async () => true;
  session._runAutoCompaction = async () => {
    session.agent.state.messages = [
      { role: "user", content: "x".repeat(4000), timestamp: Date.now() },
    ];
    return true;
  };
  session._installAgentNextTurnRefresh();

  await assert.rejects(
    session.agent.prepareNextTurnWithContext(
      makeToolTurn([{ role: "user", content: "oversized", timestamp: Date.now() }]),
      new AbortController().signal,
    ),
    /above the configured safe boundary/,
  );
  assert.equal(session._inlineCompactionFailed, true);
});
