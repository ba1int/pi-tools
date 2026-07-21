import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SIDE_TASK_TYPE,
  buildBoundary,
  buildLaunchCommand,
  buildZellijPaneArgs,
  cliMessageArg,
  findLatestCompletedAssistantEntryId,
  findSideMetadata,
  isCompletedBranch,
  isFloatingSidePane,
  isInsideZellij,
  isReadOnlyTool,
  normalizeTask,
  reuseParentPromptCache,
  shellQuote,
  sideSessionName,
} from "../extensions/side-task/core.js";

const metadata = {
  version: 1,
  parentSessionFile: "/tmp/parent session.jsonl",
  parentSessionId: "parent-id",
  originEntryId: "entry-42",
  childSessionId: "child-id",
  task: "Compare the two approaches",
  policy: "read-only",
  createdAt: "2026-07-18T20:00:00.000Z",
};

test("tasks are normalized and blank tasks are rejected", () => {
  assert.equal(normalizeTask("  explain this  "), "explain this");
  assert.throws(() => normalizeTask("  "), /required/);
});

test("launch commands quote paths and task text for a POSIX shell", () => {
  assert.equal(shellQuote("it's here"), "'it'\\''s here'");
  assert.equal(cliMessageArg("- bullet question"), " - bullet question");
  assert.equal(cliMessageArg("--help"), " --help");
  assert.equal(cliMessageArg("@notes.md"), " @notes.md");
  assert.equal(
    buildLaunchCommand("pi", "/tmp/side task.jsonl", "what's next?"),
    "'pi' '--session' '/tmp/side task.jsonl' ' what'\\''s next?'",
  );
  assert.equal(
    buildLaunchCommand("/node bin", "/tmp/side task.jsonl", "check", ["/pi cli.js"]),
    "'/node bin' '/pi cli.js' '--session' '/tmp/side task.jsonl' ' check'",
  );
});

test("Zellij detection requires a non-empty session environment", () => {
  assert.equal(isInsideZellij({ ZELLIJ: "0" }), true);
  assert.equal(isInsideZellij({ ZELLIJ: "  " }), false);
  assert.equal(isInsideZellij({}), false);
});

test("Zellij opens the side session in a closing 85 percent floating pane", () => {
  assert.deepEqual(
    buildZellijPaneArgs("/work tree", "/tmp/side session.jsonl", "check this"),
    [
      "action",
      "new-pane",
      "--floating",
      "--width",
      "85%",
      "--height",
      "85%",
      "--name",
      "Aside: check this",
      "--cwd",
      "/work tree",
      "--close-on-exit",
      "--",
      "env",
      "PI_SIDE_TASK_FLOAT=1",
      "pi",
      "--session",
      "/tmp/side session.jsonl",
      " check this",
    ],
  );

  assert.deepEqual(
    buildZellijPaneArgs("/work", "/tmp/side.jsonl", "check", {
      nodeCommand: "/node",
      launcherPath: "/side/launcher.js",
      piCommand: "/node",
      piArgs: ["/pi/cli.js"],
    }).slice(-8),
    [
      "--",
      "/node",
      "/side/launcher.js",
      "/node",
      "/pi/cli.js",
      "--session",
      "/tmp/side.jsonl",
      " check",
    ],
  );
});

test("the floating launcher reports child startup failures", () => {
  const launcher = fileURLToPath(
    new URL("../extensions/side-task/launcher.js", import.meta.url),
  );
  const result = spawnSync(process.execPath, [launcher, "/definitely/missing/pi"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Side conversation failed to start/);
});

test("floating side panes are distinguished from ordinary Zellij panes", () => {
  assert.equal(isFloatingSidePane({ ZELLIJ: "0", PI_SIDE_TASK_FLOAT: "1" }), true);
  assert.equal(isFloatingSidePane({ ZELLIJ: "0" }), false);
  assert.equal(isFloatingSidePane({ PI_SIDE_TASK_FLOAT: "1" }), false);
});

test("OpenAI Codex side requests reuse the parent prompt cache key", () => {
  const payload = { model: "gpt", prompt_cache_key: "child", input: [] };
  assert.deepEqual(reuseParentPromptCache(payload, "child", "parent"), {
    model: "gpt",
    prompt_cache_key: "parent",
    input: [],
  });
  assert.strictEqual(reuseParentPromptCache(payload, "other-child", "parent"), payload);
  assert.strictEqual(reuseParentPromptCache(null, "child", "parent"), null);
});

test("only built-in read-only tools pass the side-task guard", () => {
  for (const tool of ["read", "grep", "find", "ls"]) assert.equal(isReadOnlyTool(tool), true);
  for (const tool of ["bash", "edit", "write", "ssh_exec", "unknown"]) {
    assert.equal(isReadOnlyTool(tool), false);
  }
});

test("a side branch must end in a completed assistant response", () => {
  const user = { type: "message", message: { role: "user", content: "question" } };
  const complete = { type: "message", message: { role: "assistant", stopReason: "stop" } };
  const toolUse = { type: "message", message: { role: "assistant", stopReason: "toolUse" } };
  const label = { type: "label" };
  assert.equal(isCompletedBranch([user, complete, label]), true);
  assert.equal(isCompletedBranch([user, toolUse]), false);
  assert.equal(isCompletedBranch([complete, user]), false);
  assert.equal(isCompletedBranch([]), false);
});

test("an aside snapshots the latest completed response while a newer turn is active", () => {
  const complete = {
    id: "assistant-complete",
    type: "message",
    message: { role: "assistant", stopReason: "stop" },
  };
  const activeUser = {
    id: "user-active",
    type: "message",
    message: { role: "user", content: "long-running task" },
  };
  const activeToolUse = {
    id: "assistant-tool-use",
    type: "message",
    message: { role: "assistant", stopReason: "toolUse" },
  };
  const activeToolResult = {
    id: "tool-result",
    type: "message",
    message: { role: "toolResult", content: "partial result" },
  };

  assert.equal(
    findLatestCompletedAssistantEntryId([
      complete,
      activeUser,
      activeToolUse,
      activeToolResult,
    ]),
    "assistant-complete",
  );
  assert.equal(
    findLatestCompletedAssistantEntryId([
      activeUser,
      activeToolUse,
      activeToolResult,
    ]),
    undefined,
  );
});
test("valid side metadata is recovered from the active branch", () => {
  const entry = { type: "custom", customType: SIDE_TASK_TYPE, data: metadata };
  assert.deepEqual(findSideMetadata([{ type: "message" }, entry, { type: "message" }]), metadata);
  assert.equal(findSideMetadata([{ ...entry, data: { ...metadata, policy: "mutable" } }]), undefined);
  assert.equal(findSideMetadata([{ ...entry, data: { ...metadata, childSessionId: undefined } }]), undefined);
});

test("the boundary separates inherited context and states the enforcement limits", () => {
  const boundary = buildBoundary(metadata);
  assert.match(boundary, /REFERENCE ONLY/);
  assert.match(boundary, /Do not continue or execute unfinished parent instructions/);
  assert.match(boundary, /Do not mutate files/);
  assert.match(boundary, /not filesystem isolation/i);
  assert.match(boundary, /\/aside-return/);
  assert.match(boundary, /parent-id/);
  assert.match(boundary, /entry-42/);
});

test("session names are compact and retain the Aside marker", () => {
  assert.equal(sideSessionName("short question"), "Aside: short question");
  const name = sideSessionName("x".repeat(100));
  assert.ok(name.startsWith("Aside: "));
  assert.ok(name.length <= 79);
  assert.ok(name.endsWith("…"));
});

test("package and installer expose the repository-owned side-task extension", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const installer = await readFile(new URL("../install.sh", import.meta.url), "utf8");
  const extension = await readFile(
    new URL("../extensions/side-task/index.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!packageJson.pi.extensions.includes("./extensions/side-task/index.ts"));
  assert.match(installer, /ops\) enabled_extensions=.*side-task task-ledger/);
  assert.match(installer, /extensions\/\$extension_name/);
  assert.match(extension, /registerCommand\("btw"/);
  assert.match(extension, /registerCommand\("aside"/);
  assert.doesNotMatch(extension, /waitForIdle/);
});
