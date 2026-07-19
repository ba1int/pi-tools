import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendLedgerEvent,
  createLedgerSnapshot,
  ledgerCwdLabel,
  modelLabel,
  recordAssistantUsage,
  resolveLedgerPath,
  startLedgerTask,
  toolLedgerDetail,
  toolLedgerKind,
  toolLedgerOutcome,
  updateLedgerEvent,
} from "./core.js";

type ToolRun = { sequence: number; startedAt: number; detail: string };

function isDisabled() {
  return /^(?:0|off|false)$/i.test(process.env.PI_TASK_LEDGER ?? "")
    || process.env.PI_SIDE_TASK_FLOAT === "1";
}

function writeSnapshot(path: string, snapshot: unknown) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("task ledger path must not be a symbolic link");
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function previousOrdinal(path: string, sessionId: string) {
  try {
    const previous = JSON.parse(readFileSync(path, "utf8"));
    if (previous?.sessionId === sessionId && Number.isInteger(previous?.taskOrdinal)) {
      return Math.max(0, previous.taskOrdinal);
    }
  } catch {
    // A missing or stale record starts a fresh sequence.
  }
  return 0;
}

export default function taskLedger(pi: ExtensionAPI) {
  if (isDisabled()) return;

  const paneId = process.env.ZELLIJ_PANE_ID || null;
  const zellijSession = process.env.ZELLIJ_SESSION_NAME || null;
  const ledgerPath = resolveLedgerPath();
  const toolRuns = new Map<string, ToolRun>();
  let snapshot: ReturnType<typeof createLedgerSnapshot> | null = null;
  let lastThinking = "unknown";

  const save = () => {
    if (snapshot) writeSnapshot(ledgerPath, snapshot);
  };

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    snapshot = createLedgerSnapshot({
      sessionId,
      sessionName: ctx.sessionManager.getSessionName?.() || ledgerCwdLabel(ctx.cwd),
      cwd: ctx.cwd,
      model: ctx.model,
      thinking: pi.getThinkingLevel(),
      paneId,
      processId: process.pid,
      zellijSession,
    });
    snapshot.taskOrdinal = previousOrdinal(ledgerPath, snapshot.sessionId);
    lastThinking = pi.getThinkingLevel();
    toolRuns.clear();
    save();
  });

  pi.on("input", async (event, ctx) => {
    if (!snapshot || event.source === "extension") return { action: "continue" as const };
    if (event.streamingBehavior) {
      appendLedgerEvent(snapshot, {
        kind: event.streamingBehavior === "steer" ? "steer" : "follow-up",
        detail: event.text,
        status: "queued",
      });
      save();
      return { action: "continue" as const };
    }

    lastThinking = pi.getThinkingLevel();
    startLedgerTask(snapshot, {
      prompt: event.text,
      thinking: lastThinking,
      model: ctx.model,
    });
    toolRuns.clear();
    save();
    return { action: "continue" as const };
  });

  pi.on("agent_start", async () => {
    if (!snapshot?.taskId) return;
    snapshot.state = "running";
    appendLedgerEvent(snapshot, { kind: "agent", detail: "work started", status: "running" });
    save();
  });

  pi.on("thinking_level_select", async (event) => {
    if (!snapshot?.taskId || !["queued", "running"].includes(snapshot.state)) {
      lastThinking = event.level;
      return;
    }
    if (event.level === lastThinking) return;
    appendLedgerEvent(snapshot, {
      kind: "route",
      detail: `${lastThinking} → ${event.level}`,
      status: event.level,
    });
    snapshot.thinking = event.level;
    lastThinking = event.level;
    save();
  });

  pi.on("model_select", async (event) => {
    if (!snapshot) return;
    snapshot.model = modelLabel(event.model);
    save();
  });

  pi.on("tool_execution_start", async (event) => {
    if (!snapshot?.taskId) return;
    const detail = toolLedgerDetail(event.toolName, event.args);
    const sequence = appendLedgerEvent(snapshot, {
      kind: toolLedgerKind(event.toolName),
      detail,
      status: "running",
    });
    toolRuns.set(event.toolCallId, { sequence, startedAt: Date.now(), detail });
    save();
  });

  pi.on("tool_execution_end", async (event) => {
    if (!snapshot?.taskId) return;
    const run = toolRuns.get(event.toolCallId);
    const outcome = toolLedgerOutcome(event.result, event.isError);
    if (run) {
      const detail = outcome.note ? `${run.detail} · ${outcome.note}` : run.detail;
      updateLedgerEvent(snapshot, run.sequence, {
        detail,
        status: outcome.status,
        elapsedMs: Date.now() - run.startedAt,
      });
      toolRuns.delete(event.toolCallId);
    } else {
      appendLedgerEvent(snapshot, {
        kind: toolLedgerKind(event.toolName),
        detail: outcome.note || toolLedgerDetail(event.toolName, {}),
        status: outcome.status,
      });
    }
    save();
  });

  pi.on("message_end", async (event) => {
    if (!snapshot?.taskId || event.message.role !== "assistant") return;
    recordAssistantUsage(snapshot, event.message);
    save();
  });

  pi.on("agent_settled", async () => {
    if (!snapshot?.taskId) return;
    snapshot.finishedAt = Date.now();
    snapshot.state = snapshot.error ? "failed" : "complete";
    appendLedgerEvent(snapshot, {
      kind: snapshot.error ? "stop" : "done",
      detail: snapshot.error || "agent settled",
      status: snapshot.error ? "fail" : "ok",
      at: snapshot.finishedAt,
    });
    save();
  });

  pi.on("session_shutdown", async () => {
    if (!snapshot) return;
    if (["queued", "running"].includes(snapshot.state)) {
      snapshot.state = "stopped";
      snapshot.finishedAt = Date.now();
      appendLedgerEvent(snapshot, {
        kind: "stop",
        detail: "session closed",
        status: "stopped",
        at: snapshot.finishedAt,
      });
    }
    save();
  });
}
