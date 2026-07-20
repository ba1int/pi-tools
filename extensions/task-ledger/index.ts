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
  appendLedgerNote,
  createLedgerSnapshot,
  ledgerCwdLabel,
  modelLabel,
  recordAssistantUsage,
  resolveLedgerPath,
  sanitizeLedgerText,
  startLedgerTask,
  toolLedgerDetail,
  toolLedgerKind,
  toolLedgerOutcome,
  updateLedgerFocus,
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

  pi.registerTool({
    name: "ops_checkpoint",
    label: "checkpoint",
    description:
      "Record one concise, evidence-backed milestone in the local operator ledger during long or staged work.",
    promptSnippet: "Record sparse milestones for long operations",
    promptGuidelines: [
      "Use ops_checkpoint only for long/multi-host/staged work: phase or host completion, validation result, blocker/approval, or material plan change.",
      "With ops_checkpoint, never log routine steps, percentages, repetition, secrets, or unvalidated claims. Keep it concise and continue.",
    ],
    parameters: {
      type: "object",
      required: ["state", "note"],
      properties: {
        state: {
          type: "string",
          enum: ["start", "working", "done", "verify", "blocked", "waiting", "changed"],
          "~kind": "Union",
        },
        subject: {
          type: "string",
          maxLength: 80,
          "~kind": "String",
        },
        note: {
          type: "string",
          minLength: 1,
          maxLength: 180,
          "~kind": "String",
        },
      },
      "~kind": "Object",
    } as const,
    async execute(_toolCallId, params) {
      if (!snapshot?.taskId || !["queued", "running"].includes(snapshot.state)) {
        return {
          content: [{ type: "text", text: "checkpoint skipped: no active task" }],
          details: { recorded: false },
        };
      }
      const entry = appendLedgerNote(snapshot, params);
      save();
      return {
        content: [{ type: "text", text: entry ? "checkpoint recorded" : "checkpoint skipped" }],
        details: { recorded: Boolean(entry), state: entry?.state ?? null },
      };
    },
    renderCall(args, theme) {
      const state = sanitizeLedgerText(
        typeof args?.state === "string" ? args.state.toUpperCase() : "NOTE",
        12,
      );
      const subject = typeof args?.subject === "string" && args.subject.trim()
        ? ` ${sanitizeLedgerText(args.subject, 36)}`
        : "";
      const note = typeof args?.note === "string"
        ? ` · ${sanitizeLedgerText(args.note, 80)}`
        : "";
      return {
        invalidate() {},
        render(width: number) {
          const available = Math.max(1, width - 11);
          const detail = `${subject}${note}`.slice(0, available);
          return [
            `${theme.fg("toolTitle", theme.bold("checkpoint"))} ${theme.fg("accent", state)}${theme.fg("muted", detail)}`,
          ];
        },
      };
    },
  });

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
      updateLedgerFocus(snapshot, event.text);
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
    if (!snapshot?.taskId || event.toolName === "ops_checkpoint") return;
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
    if (!snapshot?.taskId || event.toolName === "ops_checkpoint") return;
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
