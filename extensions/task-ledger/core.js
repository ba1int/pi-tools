import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const LEDGER_SCHEMA_VERSION = 1;
export const MAX_LEDGER_EVENTS = 48;
export const MAX_LEDGER_NOTES = 16;
export const FINISHED_VISIBILITY_MS = 30 * 60 * 1000;

const LEDGER_NOTE_STATES = new Set([
  "start",
  "working",
  "done",
  "verify",
  "blocked",
  "waiting",
  "changed",
]);

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const TRIVIAL_FOCUS_PATTERN = /^(?:(?:hi|hello|hey|yo|thanks|thank you|okay|ok|cool|nice|great|awesome|got it|sounds good|continue|carry on|go ahead|do it|yes|no|yep|nope)(?:\s+please)?|what(?:'s| is) (?:the )?(?:time|date)(?:\s+(?:now|today))?|how are you|who are you)\s*[.!?]*$/i;
const GENERIC_FOLLOW_UP_PATTERN = /^(?:(?:can|could|would) you\s+|please\s+)?(?:check|fix|inspect|look into|review|retry|try|update)(?:\s+(?:again|it|that|them|these|this|those))?\s*[.!?]*$/i;
const TASK_ACTION_PATTERN = /\b(?:add|analy[sz]e|build|check|configure|create|debug|deploy|diagnose|fix|implement|inspect|install|investigate|look into|migrate|monitor|onboard|repair|replace|restart|restore|review|set up|troubleshoot|update|upgrade|validate|verify|wire)\b/i;
const OPS_CONTEXT_PATTERN = /\b(?:alert|certificate|cpu|database|db|disk|error|failed|failure|host|icinga|incident|latency|memory|middleware|nagios|openvpn|prod|production|route|server|service|ssh|timeout|ticket|vpn)\b/i;
const TASK_IDENTIFIER_PATTERN = /\b(?:[A-Z][A-Z0-9]+-\d+|[a-z0-9]+(?:[-.][a-z0-9]+){1,})\b/i;

export function sanitizeSegment(value, fallback = "terminal") {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

export function sanitizeLedgerText(value, limit = 120) {
  const cleaned = String(value ?? "")
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function ledgerFocusScore(value) {
  const text = sanitizeLedgerText(value, 180);
  if (!text
      || /^[!/]/.test(text)
      || TRIVIAL_FOCUS_PATTERN.test(text)
      || GENERIC_FOLLOW_UP_PATTERN.test(text)) return 0;
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9_.-]*/g) || [];
  let score = Math.min(2, Math.floor(words.length / 4));
  if (TASK_ACTION_PATTERN.test(text)) score += 3;
  if (OPS_CONTEXT_PATTERN.test(text)) score += 2;
  if (TASK_IDENTIFIER_PATTERN.test(text)) score += 1;
  if (text.length >= 64) score += 1;
  return score;
}

export function selectLedgerFocus(current, candidate) {
  const previous = sanitizeLedgerText(current, 180);
  const next = sanitizeLedgerText(candidate, 180);
  if (!next) return previous;
  if (!previous) return next;

  const previousScore = ledgerFocusScore(previous);
  const nextScore = ledgerFocusScore(next);
  if (nextScore >= 3) return next;
  if (previousScore >= 3) return previous;
  return nextScore > previousScore ? next : previous;
}

export function updateLedgerFocus(snapshot, candidate, now = Date.now()) {
  const next = selectLedgerFocus(snapshot.prompt, candidate);
  if (!next || next === snapshot.prompt) return false;
  snapshot.prompt = next;
  snapshot.updatedAt = now;
  return true;
}

export function resolveLedgerDirectory(environment = process.env, home = homedir()) {
  const stateHome = environment.XDG_STATE_HOME?.trim()
    || join(home, ".local", "state");
  const session = sanitizeSegment(environment.ZELLIJ_SESSION_NAME, "terminal");
  return join(stateHome, "pi-ledger", session);
}

export function resolveAgentKey(environment = process.env, processId = process.pid) {
  const paneId = sanitizeSegment(environment.ZELLIJ_PANE_ID, "");
  return paneId ? `pane-${paneId}` : `pid-${Math.max(1, Number(processId) || 1)}`;
}

export function resolveLedgerPath(
  environment = process.env,
  home = homedir(),
  processId = process.pid,
) {
  return join(
    resolveLedgerDirectory(environment, home),
    "agents",
    `${resolveAgentKey(environment, processId)}.json`,
  );
}

export function modelLabel(model) {
  if (!model) return "unselected";
  return sanitizeLedgerText(model.id ?? model.name ?? String(model), 48) || "unselected";
}

export function createLedgerSnapshot({
  sessionId,
  sessionName,
  cwd,
  model,
  thinking,
  paneId = process.env.ZELLIJ_PANE_ID || null,
  processId = process.pid,
  zellijSession = process.env.ZELLIJ_SESSION_NAME || null,
  now = Date.now(),
}) {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    sessionId: sanitizeSegment(sessionId, "ephemeral"),
    sessionName: sanitizeLedgerText(sessionName || "unnamed", 48),
    paneId: paneId ? sanitizeLedgerText(paneId, 32) : null,
    processId: Number.isInteger(Number(processId)) ? Number(processId) : null,
    zellijSession: zellijSession ? sanitizeLedgerText(zellijSession, 64) : null,
    cwd: sanitizeLedgerText(cwd, 96),
    model: modelLabel(model),
    thinking: sanitizeLedgerText(thinking || "unknown", 16),
    taskOrdinal: 0,
    taskId: null,
    prompt: "",
    state: "idle",
    startedAt: null,
    updatedAt: now,
    finishedAt: null,
    cost: 0,
    tokens: 0,
    error: null,
    nextSequence: 1,
    events: [],
    notes: [],
  };
}

export function appendLedgerNote(snapshot, {
  state,
  subject = "",
  note,
  at = Date.now(),
}, maxNotes = MAX_LEDGER_NOTES) {
  const normalizedState = sanitizeLedgerText(state, 16).toLowerCase();
  const entry = {
    at,
    state: LEDGER_NOTE_STATES.has(normalizedState) ? normalizedState : "working",
    subject: sanitizeLedgerText(subject, 80),
    note: sanitizeLedgerText(note, 180),
  };
  if (!entry.note) return null;

  if (!Array.isArray(snapshot.notes)) snapshot.notes = [];
  const previous = snapshot.notes.at(-1);
  if (previous
      && previous.state === entry.state
      && previous.subject === entry.subject
      && previous.note === entry.note) {
    return previous;
  }

  snapshot.notes.push(entry);
  if (snapshot.notes.length > maxNotes) {
    snapshot.notes.splice(0, snapshot.notes.length - maxNotes);
  }
  snapshot.updatedAt = at;
  return entry;
}

export function appendLedgerEvent(snapshot, {
  kind,
  detail = "",
  status = "note",
  at = Date.now(),
  elapsedMs = null,
}, maxEvents = MAX_LEDGER_EVENTS) {
  const sequence = snapshot.nextSequence;
  snapshot.nextSequence += 1;
  snapshot.events.push({
    sequence,
    at,
    kind: sanitizeLedgerText(kind, 18).toUpperCase(),
    detail: sanitizeLedgerText(detail, 160),
    status: sanitizeLedgerText(status, 16).toLowerCase(),
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : null,
  });
  if (snapshot.events.length > maxEvents) {
    snapshot.events.splice(0, snapshot.events.length - maxEvents);
  }
  snapshot.updatedAt = at;
  return sequence;
}

export function updateLedgerEvent(snapshot, sequence, updates, now = Date.now()) {
  const event = snapshot.events.find((candidate) => candidate.sequence === sequence);
  if (!event) return false;
  if (updates.detail !== undefined) event.detail = sanitizeLedgerText(updates.detail, 160);
  if (updates.status !== undefined) event.status = sanitizeLedgerText(updates.status, 16).toLowerCase();
  if (Number.isFinite(updates.elapsedMs)) event.elapsedMs = Math.max(0, Math.round(updates.elapsedMs));
  snapshot.updatedAt = now;
  return true;
}

export function startLedgerTask(snapshot, { prompt, thinking, model, now = Date.now() }) {
  const focus = selectLedgerFocus(snapshot.prompt, prompt);
  snapshot.taskOrdinal += 1;
  snapshot.taskId = `${snapshot.sessionId.slice(0, 8)}-${String(snapshot.taskOrdinal).padStart(3, "0")}`;
  snapshot.prompt = focus;
  snapshot.model = modelLabel(model);
  snapshot.thinking = sanitizeLedgerText(thinking || "unknown", 16);
  snapshot.state = "queued";
  snapshot.startedAt = now;
  snapshot.updatedAt = now;
  snapshot.finishedAt = null;
  snapshot.cost = 0;
  snapshot.tokens = 0;
  snapshot.error = null;
  snapshot.nextSequence = 1;
  snapshot.events = [];
  snapshot.notes = [];
  appendLedgerEvent(snapshot, {
    kind: "route",
    detail: `thinking ${snapshot.thinking}`,
    status: snapshot.thinking,
    at: now,
  });
  return snapshot;
}

export function toolLedgerDetail(toolName, args = {}) {
  const name = String(toolName ?? "tool");
  if (name === "ssh_exec") {
    return sanitizeLedgerText(args.host ? String(args.host) : "remote host", 96);
  }
  if (["read", "edit", "write", "ls", "find"].includes(name)) {
    return sanitizeLedgerText(args.path ? String(args.path) : "local workspace", 96);
  }
  if (name === "grep") {
    return sanitizeLedgerText(args.path ? String(args.path) : "workspace search", 96);
  }
  if (name === "bash") return "local shell";
  return sanitizeLedgerText(name.replaceAll("_", " "), 96);
}

export function toolLedgerKind(toolName) {
  if (toolName === "ssh_exec") return "ssh";
  if (["read", "edit", "write", "grep", "find", "ls"].includes(toolName)) return toolName;
  return "tool";
}

export function toolLedgerOutcome(result, isError = false) {
  const details = result?.details ?? {};
  const exitCode = Number.isInteger(details.exitCode) ? details.exitCode : null;
  if (details.timedOut === true) return { status: "fail", note: "timeout" };
  if (details.failureKind) {
    return {
      status: details.failureKind === "remote_exit" && exitCode === 0 ? "ok" : "fail",
      note: sanitizeLedgerText(details.failureKind, 40),
    };
  }
  if (isError || (exitCode !== null && exitCode !== 0)) {
    return { status: "fail", note: exitCode === null ? "error" : `exit ${exitCode}` };
  }
  return { status: "ok", note: "" };
}

export function recordAssistantUsage(snapshot, message) {
  if (message?.role !== "assistant") return;
  const cost = Number(message.usage?.cost?.total);
  const tokens = Number(message.usage?.totalTokens);
  if (Number.isFinite(cost)) snapshot.cost += Math.max(0, cost);
  if (Number.isFinite(tokens)) snapshot.tokens += Math.max(0, tokens);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    snapshot.error = sanitizeLedgerText(message.errorMessage || message.stopReason, 120);
  }
}

function clip(value, width) {
  const text = sanitizeLedgerText(value, Math.max(1, width));
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

function pad(value, width) {
  const text = clip(value, width);
  return text + " ".repeat(Math.max(0, width - text.length));
}

function elapsedLabel(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function clockLabel(timestamp) {
  if (!Number.isFinite(timestamp)) return "--:--:--";
  return new Date(timestamp).toISOString().slice(11, 19);
}

export function processIsAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function ledgerDisplayState(snapshot, isAlive = processIsAlive) {
  const state = String(snapshot?.state || "idle").toLowerCase();
  if (["queued", "running"].includes(state)
      && Number.isInteger(snapshot?.processId)
      && !isAlive(snapshot.processId)) {
    return "stale";
  }
  return state;
}

export function lastLedgerEvent(snapshot) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  return events.at(-1) || null;
}

export function lastLedgerNote(snapshot) {
  const notes = Array.isArray(snapshot?.notes) ? snapshot.notes : [];
  return notes.at(-1) || null;
}

export function ledgerNoteDetail(note) {
  if (!note) return "";
  return [note.subject, note.note].filter(Boolean).join(" · ");
}

function stateRank(state) {
  if (["queued", "running"].includes(state)) return 0;
  if (state === "failed") return 1;
  if (state === "stale") return 2;
  if (state === "complete") return 3;
  return 4;
}

export function sortLedgerRecords(records) {
  return [...records].sort((left, right) => {
    const rank = stateRank(left.displayState) - stateRank(right.displayState);
    if (rank !== 0) return rank;
    return Number(right.snapshot.updatedAt || 0) - Number(left.snapshot.updatedAt || 0);
  });
}

export function loadLedgerRecords({
  environment = process.env,
  home = homedir(),
  now = Date.now(),
  retentionMs = FINISHED_VISIBILITY_MS,
  isAlive = processIsAlive,
} = {}) {
  const directory = resolveLedgerDirectory(environment, home);
  const agentsDirectory = join(directory, "agents");
  let names = [];
  try {
    names = readdirSync(agentsDirectory).filter((name) => name.endsWith(".json"));
  } catch {
    // A session without agent records is a normal empty state.
  }

  const records = [];
  for (const name of names) {
    const path = join(agentsDirectory, name);
    try {
      const snapshot = JSON.parse(readFileSync(path, "utf8"));
      if (snapshot?.schemaVersion !== LEDGER_SCHEMA_VERSION) continue;
      const displayState = ledgerDisplayState(snapshot, isAlive);
      const isActive = ["queued", "running"].includes(displayState);
      const age = Math.max(0, now - Number(snapshot.finishedAt || snapshot.updatedAt || now));
      if (!isActive && age > retentionMs) continue;
      records.push({ key: name.slice(0, -5), path, snapshot, displayState });
    } catch {
      // One partial or corrupt record must not take down the board.
    }
  }

  if (records.length === 0) {
    const legacyPath = join(directory, "current.json");
    try {
      const snapshot = JSON.parse(readFileSync(legacyPath, "utf8"));
      if (snapshot?.schemaVersion === LEDGER_SCHEMA_VERSION) {
        records.push({
          key: "legacy-current",
          path: legacyPath,
          snapshot,
          displayState: ledgerDisplayState(snapshot, isAlive),
        });
      }
    } catch {
      // No legacy snapshot is also a normal empty state.
    }
  }

  return sortLedgerRecords(records);
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  ink: "\x1b[38;2;243;240;231m",
  text: "\x1b[38;2;232;225;210m",
  muted: "\x1b[38;2;141;143;134m",
  rule: "\x1b[38;2;68;70;63m",
  teal: "\x1b[38;2;120;184;179m",
  coral: "\x1b[38;2;239;91;76m",
};

function paint(value, style, enabled) {
  if (!enabled) return value;
  return `${style}${value}${ANSI.reset}`;
}

function statusStyle(status) {
  if (["fail", "failed", "error", "aborted", "blocked"].includes(status)) return ANSI.coral;
  if (["run", "running", "start", "working", "verify", "low", "high", "xhigh", "medium"].includes(status)) return ANSI.teal;
  if (["stale", "stopped", "idle", "queued", "waiting", "changed"].includes(status)) return ANSI.muted;
  return ANSI.ink;
}

export function renderAgentBoard(records, {
  width = 96,
  height = 30,
  color = true,
  now = Date.now(),
  selectedKey = null,
  showTitle = true,
} = {}) {
  const columns = Math.max(58, Math.min(180, Math.floor(width || 96)));
  const rows = Math.max(16, Math.floor(height || 30));
  const rule = "─".repeat(columns);
  const active = records.filter((record) => ["queued", "running"].includes(record.displayState)).length;
  const failed = records.filter((record) => record.displayState === "failed").length;
  const stale = records.filter((record) => record.displayState === "stale").length;
  const summaryParts = [{ text: `${active} ACTIVE`, style: active ? ANSI.teal : ANSI.ink }];
  if (failed) summaryParts.push({ text: `${failed} FAILED`, style: ANSI.coral });
  if (stale) summaryParts.push({ text: `${stale} STALE`, style: ANSI.muted });
  const summary = summaryParts.map((part) => part.text).join(" · ");
  const paintedSummary = summaryParts
    .map((part) => paint(part.text, ANSI.bold + part.style, color))
    .join(paint(" · ", ANSI.muted, color));
  const lines = [];

  const boardTitle = showTitle ? "PI / AGENT BOARD" : "";
  lines.push(
    paint(boardTitle, ANSI.bold + ANSI.ink, color)
      + " ".repeat(Math.max(1, columns - boardTitle.length - summary.length))
      + paintedSummary,
  );
  lines.push(paint(rule, ANSI.rule, color));
  lines.push(paint("One record per Pi pane · current Zellij session", ANSI.muted, color));
  lines.push("");

  const fixedWidth = 2 + 4 + 10 + 7 + 7 + 5;
  const flexible = Math.max(23, columns - fixedWidth);
  const taskWidth = Math.max(12, Math.floor(flexible * 0.58));
  const eventWidth = Math.max(8, flexible - taskWidth);
  lines.push(paint(
    `  ${pad("NO", 4)} ${pad("STATE", 10)} ${pad("TIME", 7)} ${pad("THINK", 7)} ${pad("TASK", taskWidth)} ${pad("LAST CHECKPOINT", eventWidth)}`,
    ANSI.muted,
    color,
  ));
  lines.push(paint(rule, ANSI.rule, color));

  const visibleRows = Math.max(1, rows - lines.length - 3);
  const selectedIndex = Math.max(0, records.findIndex((record) => record.key === selectedKey));
  const startIndex = Math.min(
    Math.max(0, selectedIndex - visibleRows + 1),
    Math.max(0, records.length - visibleRows),
  );
  const visible = records.slice(startIndex, startIndex + visibleRows);
  if (visible.length === 0) {
    lines.push(paint("  —    IDLE       —       —       No Pi agents have reported in this session.", ANSI.muted, color));
  } else {
    visible.forEach((record, visibleIndex) => {
      const index = startIndex + visibleIndex;
      const selected = record.key === selectedKey || (!selectedKey && index === 0);
      const marker = selected ? "›" : " ";
      const snapshot = record.snapshot;
      const note = lastLedgerNote(snapshot);
      const event = lastLedgerEvent(snapshot);
      const age = snapshot.startedAt
        ? elapsedLabel((snapshot.finishedAt || now) - snapshot.startedAt)
        : "—";
      const task = snapshot.prompt || snapshot.sessionName || "Waiting for a task.";
      const checkpoint = note
        ? `${String(note.state).toUpperCase()} ${ledgerNoteDetail(note)}`
        : event
          ? `${event.kind} ${event.detail || event.status}`
          : "No checkpoint";
      const row = `${marker} ${pad(String(index + 1).padStart(2, "0"), 4)} `
        + `${pad(record.displayState.toUpperCase(), 10)} ${pad(age, 7)} `
        + `${pad(String(snapshot.thinking || "—").toUpperCase(), 7)} `
        + `${pad(task, taskWidth)} ${pad(checkpoint, eventWidth)}`;
      const rowStyle = selected ? ANSI.bold + ANSI.text : ANSI.text;
      lines.push(
        paint(row.slice(0, 2), selected ? ANSI.teal : ANSI.text, color)
          + paint(row.slice(2, 7), rowStyle, color)
          + paint(row.slice(7, 18), statusStyle(record.displayState), color)
          + paint(row.slice(18), rowStyle, color),
      );
    });
  }

  while (lines.length < rows - 2) lines.push("");
  lines.push(paint(rule, ANSI.rule, color));
  lines.push(paint(
    clip("↑/↓ select · enter jump · d detail · q close", columns),
    ANSI.muted,
    color,
  ));
  return lines.join("\n");
}

export function renderLedger(snapshot, {
  width = 96,
  height = 30,
  color = true,
  now = Date.now(),
  footer = "q close",
  showTitle = true,
} = {}) {
  const columns = Math.max(58, Math.min(160, Math.floor(width || 96)));
  const rows = Math.max(16, Math.floor(height || 30));
  const rule = "─".repeat(columns);
  const lines = [];

  if (!snapshot || snapshot.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    if (showTitle) {
      lines.push(paint(pad("PI / TASK LEDGER", columns), ANSI.bold + ANSI.ink, color));
      lines.push(paint(rule, ANSI.rule, color));
    }
    lines.push("");
    lines.push(paint("NO ACTIVE RECORD", ANSI.bold + ANSI.muted, color));
    lines.push(paint("Start Pi and submit a task in this Zellij session.", ANSI.muted, color));
    lines.push("");
    lines.push(paint(rule, ANSI.rule, color));
    lines.push(paint(clip(footer, columns), ANSI.muted, color));
    return lines.join("\n");
  }

  const state = String(snapshot.state || "idle").toUpperCase();
  const elapsed = snapshot.startedAt
    ? elapsedLabel((snapshot.finishedAt || now) - snapshot.startedAt)
    : "—";
  const headerRight = `${state}  ${elapsed}`;
  const ledgerTitle = showTitle ? "PI / TASK LEDGER" : "";
  lines.push(
    paint(ledgerTitle, ANSI.bold + ANSI.ink, color)
      + " ".repeat(Math.max(1, columns - ledgerTitle.length - headerRight.length))
      + paint(headerRight, ANSI.bold + statusStyle(String(snapshot.state)), color),
  );
  lines.push(paint(rule, ANSI.rule, color));
  lines.push(
    `${paint("RECORD", ANSI.muted, color)}  ${paint(snapshot.taskId || "—", ANSI.text, color)}`
      + `   ${paint("SESSION", ANSI.muted, color)}  ${paint(snapshot.sessionName || snapshot.sessionId, ANSI.text, color)}`,
  );
  lines.push(
    `${paint("MODEL ", ANSI.muted, color)}  ${paint(snapshot.model, ANSI.text, color)}`
      + `   ${paint("THINK", ANSI.muted, color)}  ${paint(String(snapshot.thinking).toUpperCase(), ANSI.teal, color)}`
      + `   ${paint("COST", ANSI.muted, color)}  ${paint(`$${Number(snapshot.cost || 0).toFixed(3)}`, ANSI.text, color)}`,
  );
  lines.push(paint("TASK", ANSI.muted, color));
  lines.push(paint(clip(snapshot.prompt || "Waiting for a task.", columns), ANSI.ink, color));
  lines.push(paint(rule, ANSI.rule, color));

  lines.push(paint("FIELD NOTES", ANSI.bold + ANSI.teal, color));
  const noteCapacity = Math.max(1, Math.min(5, rows - 15));
  const notes = Array.isArray(snapshot.notes) ? snapshot.notes.slice(-noteCapacity) : [];
  if (notes.length === 0) {
    lines.push(paint("--:--:--  —          No operator notes yet.", ANSI.muted, color));
  } else {
    for (const note of notes) {
      const timestamp = `${clockLabel(note.at)}  `;
      const stateLabel = `${pad(String(note.state).toUpperCase(), 10)} `;
      lines.push(
        paint(timestamp, ANSI.muted, color)
          + paint(stateLabel, statusStyle(String(note.state)), color)
          + paint(
            clip(
              ledgerNoteDetail(note),
              Math.max(1, columns - timestamp.length - stateLabel.length),
            ),
            ANSI.text,
            color,
          ),
      );
    }
  }
  lines.push(paint(rule, ANSI.rule, color));
  lines.push(paint("ACTIVITY", ANSI.bold + ANSI.ink, color));

  const fixed = 4 + 1 + 8 + 1 + 12 + 1 + 10 + 3;
  const detailWidth = Math.max(18, columns - fixed);
  lines.push(
    paint(
      `${pad("SEQ", 4)} ${pad("TIME", 8)} ${pad("RECORD", 12)} ${pad("DETAIL", detailWidth)} ${pad("STATE", 10)}`,
      ANSI.muted,
      color,
    ),
  );
  lines.push(paint(rule, ANSI.rule, color));

  const availableEvents = Math.max(1, rows - lines.length - 3);
  const events = Array.isArray(snapshot.events) ? snapshot.events.slice(-availableEvents) : [];
  if (events.length === 0) {
    lines.push(paint("—    --:--:--  WAITING      No checkpoints recorded.", ANSI.muted, color));
  } else {
    for (const event of events) {
      const elapsedSuffix = Number.isFinite(event.elapsedMs)
        ? ` · ${event.elapsedMs < 1000 ? `${event.elapsedMs}ms` : `${(event.elapsedMs / 1000).toFixed(1)}s`}`
        : "";
      const detail = `${event.detail || "—"}${elapsedSuffix}`;
      const raw = `${pad(String(event.sequence).padStart(3, "0"), 4)} ${pad(clockLabel(event.at), 8)} ${pad(event.kind, 12)} ${pad(detail, detailWidth)} `;
      lines.push(
        paint(raw, ANSI.text, color)
          + paint(pad(String(event.status).toUpperCase(), 10), statusStyle(String(event.status)), color),
      );
    }
  }

  while (lines.length < rows - 2) lines.push("");
  lines.push(paint(rule, ANSI.rule, color));
  lines.push(paint(clip(footer, columns), ANSI.muted, color));
  return lines.join("\n");
}

export function ledgerCwdLabel(cwd) {
  return basename(String(cwd || "")) || "~";
}
