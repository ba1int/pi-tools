export const SIDE_TASK_TYPE = "pi-side-task";
export const SIDE_BOUNDARY_TYPE = "pi-side-task-boundary";

export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function normalizeTask(value) {
  const task = String(value ?? "").trim();
  if (!task) throw new Error("A side-conversation question is required");
  return task;
}

export function cliMessageArg(task) {
  // Pi treats leading "-" as an option and leading "@" as a file argument.
  // A harmless leading space keeps arbitrary user text in the message channel.
  return ` ${normalizeTask(task)}`;
}
export function sideSessionName(task, limit = 72) {
  const compact = normalizeTask(task).replace(/\s+/g, " ");
  const suffix = compact.length > limit ? `${compact.slice(0, limit - 1).trimEnd()}…` : compact;
  return `Aside: ${suffix}`;
}

export function isCompletedBranch(branch) {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    return entry.message?.role === "assistant"
      && entry.message.stopReason !== "toolUse"
      && entry.message.stopReason !== "aborted"
      && entry.message.stopReason !== "error";
  }
  return false;
}

export function findLatestCompletedAssistantEntryId(branch) {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    if (
      entry.message.stopReason === "toolUse"
      || entry.message.stopReason === "aborted"
      || entry.message.stopReason === "error"
    ) {
      continue;
    }
    return typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
  }
  return undefined;
}
export function findSideMetadata(branch) {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== SIDE_TASK_TYPE) continue;
    const data = entry.data;
    if (
      data?.version === 1
      && typeof data.parentSessionFile === "string"
      && typeof data.parentSessionId === "string"
      && typeof data.originEntryId === "string"
      && typeof data.childSessionId === "string"
      && typeof data.task === "string"
      && data.policy === "read-only"
    ) {
      return data;
    }
  }
  return undefined;
}

export function isReadOnlyTool(toolName) {
  return READ_ONLY_TOOLS.has(toolName);
}

export function buildBoundary(metadata) {
  return [
    "SIDE CONVERSATION — REFERENCE ONLY",
    "",
    `Question: ${metadata.task}`,
    "",
    "The inherited parent conversation is background context only. Do not continue or execute unfinished parent instructions.",
    "Do not mutate files, repositories, remote systems, services, settings, or external state. Read-only inspection is allowed.",
    "Pi enforces this default by allowing only read, grep, find, and ls model tools here and by blocking ! shell commands.",
    "This is not filesystem isolation; other processes and unguarded third-party extension commands remain outside this policy boundary.",
    "",
    `Parent session: ${metadata.parentSessionId}`,
    `Origin entry: ${metadata.originEntryId}`,
    "Use /aside-return to switch this pane back to the parent. If the parent is already open elsewhere, exit this pane instead.",
  ].join("\n");
}

export function buildLaunchCommand(piCommand, sessionFile, task, piArgs = []) {
  return [piCommand, ...piArgs, "--session", sessionFile, cliMessageArg(task)]
    .map(shellQuote)
    .join(" ");
}

export function isInsideZellij(environment) {
  return typeof environment?.ZELLIJ === "string" && environment.ZELLIJ.trim().length > 0;
}

export function buildZellijPaneArgs(cwd, sessionFile, task, launch = {}) {
  const piCommand = launch.piCommand ?? "pi";
  const piArgs = launch.piArgs ?? [];
  const childCommand = launch.launcherPath
    ? [
        launch.nodeCommand,
        launch.launcherPath,
        piCommand,
        ...piArgs,
        "--session",
        sessionFile,
        cliMessageArg(task),
      ]
    : [
        "env",
        "PI_SIDE_TASK_FLOAT=1",
        piCommand,
        ...piArgs,
        "--session",
        sessionFile,
        cliMessageArg(task),
  ];
  return [
    "action",
    "new-pane",
    "--floating",
    "--width",
    "85%",
    "--height",
    "85%",
    "--name",
    sideSessionName(task),
    "--cwd",
    cwd,
    "--close-on-exit",
    "--",
    ...childCommand,
  ];
}

export function isFloatingSidePane(environment) {
  return isInsideZellij(environment) && environment?.PI_SIDE_TASK_FLOAT === "1";
}

export function reuseParentPromptCache(payload, childSessionId, parentSessionId) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (payload.prompt_cache_key !== childSessionId) return payload;
  return { ...payload, prompt_cache_key: parentSessionId };
}
