import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { sanitizeLedgerText, sanitizeSegment } from "./core.js";

export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_HANDOFF_RECORDS = 5;
export const MAX_HANDOFF_OUTPUT = 5200;

const SECRET_ASSIGNMENT = /\b(password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie)\b\s*[:=]\s*(?:["'][^"']*["']|\S+)/gi;
const AUTHORIZATION_SECRET = /\bauthorization\b\s*[:=]\s*(?:bearer\s+)?[A-Za-z0-9._~+/=-]+/gi;
const BEARER_SECRET = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
const OPAQUE_SECRET = /\b(?:[A-Fa-f0-9]{40,}|[A-Za-z0-9+/=_-]{48,})\b/g;
const LOOKUP_STOP_WORDS = new Set([
  "about", "again", "continue", "continued", "continuing", "document", "earlier",
  "from", "handoff", "into", "last", "previous", "prior", "resume", "show",
  "task", "that", "this", "what", "where", "with", "work",
]);

export function redactHandoffText(value, limit = 240) {
  const redacted = String(value ?? "")
    .replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]")
    .replace(AUTHORIZATION_SECRET, "Authorization=[REDACTED]")
    .replace(SECRET_ASSIGNMENT, (_match, label) => `${label}=[REDACTED]`)
    .replace(BEARER_SECRET, "$1 [REDACTED]")
    .replace(URL_CREDENTIAL, "$1[REDACTED]@")
    .replace(OPAQUE_SECRET, "[REDACTED]");
  return sanitizeLedgerText(redacted, limit);
}

export function workspaceFingerprint(cwd) {
  const canonical = resolve(String(cwd || "."));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function resolveHandoffRoot(environment = process.env, home = homedir()) {
  const stateHome = environment.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  return join(stateHome, "pi-handoffs");
}

export function resolveHandoffDirectory(cwd, environment = process.env, home = homedir()) {
  return join(resolveHandoffRoot(environment, home), "workspaces", workspaceFingerprint(cwd));
}

export function handoffRecordKey(snapshot) {
  const session = sanitizeSegment(snapshot?.sessionId, "session");
  const task = sanitizeSegment(snapshot?.taskId, "task");
  return `${session}-${task}`;
}

function handoffLifecycle(snapshot) {
  const state = String(snapshot?.state || "idle").toLowerCase();
  const lastNoteState = String(snapshot?.notes?.at?.(-1)?.state || "").toLowerCase();
  if (["blocked", "waiting"].includes(lastNoteState)) return lastNoteState;
  if (["queued", "running"].includes(state)) return "active";
  if (["failed", "stopped", "stale"].includes(state)) return "dormant";
  if (state === "complete") return "complete";
  return "archived";
}

export function shouldPersistHandoff(snapshot) {
  if (!snapshot?.taskId) return false;
  const notes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  if (notes.length > 0) return true;
  if (events.some((event) => String(event.kind).toUpperCase() === "CONTEXT")) return true;
  const hosts = new Set(
    events
      .filter((event) => String(event.kind).toUpperCase() === "SSH")
      .map((event) => redactHandoffText(event.detail, 96))
      .filter(Boolean),
  );
  return hosts.size >= 2;
}

function safeNotes(snapshot) {
  return (Array.isArray(snapshot?.notes) ? snapshot.notes : []).slice(-16).map((note) => ({
    at: Number(note.at) || Date.now(),
    state: sanitizeSegment(note.state, "working").toLowerCase(),
    subject: redactHandoffText(note.subject, 80),
    note: redactHandoffText(note.note, 180),
  })).filter((note) => note.note);
}

function safeEvidence(snapshot) {
  return (Array.isArray(snapshot?.events) ? snapshot.events : [])
    .filter((event) => ["SSH", "READ", "EDIT", "WRITE", "CONTEXT"].includes(String(event.kind).toUpperCase()))
    .slice(-12)
    .map((event) => ({
      at: Number(event.at) || Date.now(),
      kind: sanitizeSegment(event.kind, "event").toUpperCase(),
      target: redactHandoffText(event.detail, 120),
      status: sanitizeSegment(event.status, "note").toLowerCase(),
    }))
    .filter((event) => event.target);
}

export function createHandoffRecord(snapshot, now = Date.now()) {
  const notes = safeNotes(snapshot);
  const lastDirective = [...notes].reverse().find((note) =>
    ["blocked", "waiting", "changed", "verify", "working", "start"].includes(note.state));
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    recordId: handoffRecordKey(snapshot),
    taskId: sanitizeSegment(snapshot.taskId, "task"),
    sessionId: sanitizeSegment(snapshot.sessionId, "session"),
    workspace: resolve(String(snapshot.cwd || ".")),
    objective: redactHandoffText(snapshot.prompt, 240),
    lifecycle: handoffLifecycle(snapshot),
    sourceState: sanitizeSegment(snapshot.state, "unknown").toLowerCase(),
    startedAt: Number(snapshot.startedAt) || null,
    updatedAt: Number(snapshot.updatedAt) || now,
    finishedAt: Number(snapshot.finishedAt) || null,
    archivedAt: now,
    requiresRevalidation: now - Number(snapshot.updatedAt || now) > HANDOFF_STALE_MS,
    model: redactHandoffText(snapshot.model, 48),
    thinking: redactHandoffText(snapshot.thinking, 16),
    checkpoints: notes,
    evidence: safeEvidence(snapshot),
    nextAction: lastDirective ? [lastDirective.subject, lastDirective.note].filter(Boolean).join(" · ") : "",
  };
}

function atomicWrite(path, content) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  let targetStat = null;
  try {
    targetStat = lstatSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (targetStat?.isSymbolicLink()) {
    throw new Error("handoff archive path must not be a symbolic link");
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function renderHandoffMarkdown(record, now = Date.now()) {
  const stale = record.requiresRevalidation || now - Number(record.updatedAt || now) > HANDOFF_STALE_MS;
  const lines = [
    "# PI / OPERATION HANDOFF",
    "",
    `- Record: ${record.recordId}`,
    `- State: ${String(record.lifecycle).toUpperCase()}${stale ? " · REVALIDATE LIVE STATE" : ""}`,
    `- Workspace: ${record.workspace}`,
    `- Updated: ${new Date(record.updatedAt).toISOString()}`,
    "",
    "## Objective",
    "",
    record.objective || "No durable objective recorded.",
  ];
  if (record.checkpoints.length) {
    lines.push("", "## Verified checkpoints", "");
    for (const note of record.checkpoints) {
      const detail = [note.subject, note.note].filter(Boolean).join(" — ");
      lines.push(`- [${note.state.toUpperCase()}] ${detail}`);
    }
  }
  if (record.evidence.length) {
    lines.push("", "## Evidence trail", "");
    for (const event of record.evidence) {
      lines.push(`- ${event.kind} ${event.target} [${event.status}]`);
    }
  }
  if (record.nextAction) lines.push("", "## Resume from", "", record.nextAction);
  lines.push(
    "",
    "## Continuation rule",
    "",
    stale
      ? "Revalidate topology, authorization, host state, and the last checkpoint before changing anything."
      : "Treat checkpoints as prior evidence, not current proof. Revalidate the affected live state before changing anything.",
    "Never infer approval, credentials, or completion from this record.",
    "",
  );
  return lines.join("\n");
}

export function persistHandoff(snapshot, {
  environment = process.env,
  home = homedir(),
  now = Date.now(),
} = {}) {
  if (!shouldPersistHandoff(snapshot)) return null;
  const record = createHandoffRecord(snapshot, now);
  const directory = resolveHandoffDirectory(snapshot.cwd, environment, home);
  const recordsDirectory = join(directory, "records");
  const jsonPath = join(recordsDirectory, `${record.recordId}.json`);
  const markdownPath = join(recordsDirectory, `${record.recordId}.md`);
  atomicWrite(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  atomicWrite(markdownPath, renderHandoffMarkdown(record, now));
  atomicWrite(join(directory, "workspace.json"), `${JSON.stringify({
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    workspace: record.workspace,
    updatedAt: now,
  }, null, 2)}\n`);
  return { record, jsonPath, markdownPath };
}

function tokenize(value) {
  return new Set(
    (String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) || [])
      .filter((token) => !LOOKUP_STOP_WORDS.has(token)),
  );
}

function recordText(record) {
  return [
    record.objective,
    record.lifecycle,
    ...(record.checkpoints || []).flatMap((note) => [note.subject, note.note]),
    ...(record.evidence || []).map((event) => event.target),
  ].join(" ").toLowerCase();
}

export function scoreHandoff(record, query, workspace, now = Date.now()) {
  let score = 0;
  if (resolve(record.workspace) === resolve(workspace)) score += 12;
  if (["active", "blocked", "waiting", "dormant"].includes(record.lifecycle)) score += 4;
  const haystack = recordText(record);
  for (const token of tokenize(query)) {
    if (haystack.includes(token)) score += token.includes("-") || token.includes(".") ? 5 : 2;
  }
  const ageDays = Math.max(0, now - Number(record.updatedAt || 0)) / 86_400_000;
  score += Math.max(0, 3 - Math.floor(ageDays / 7));
  return score;
}

function handoffMatchCount(record, query) {
  const haystack = recordText(record);
  let matches = 0;
  for (const token of tokenize(query)) {
    if (haystack.includes(token)) matches += 1;
  }
  return matches;
}

export function loadHandoffRecords({
  cwd,
  query = "",
  includeAllWorkspaces = false,
  environment = process.env,
  home = homedir(),
  now = Date.now(),
  limit = MAX_HANDOFF_RECORDS,
} = {}) {
  const root = resolveHandoffRoot(environment, home);
  const workspaceDirectory = resolveHandoffDirectory(cwd, environment, home);
  let directories = [workspaceDirectory];
  if (includeAllWorkspaces) {
    try {
      directories = readdirSync(join(root, "workspaces"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, "workspaces", entry.name));
    } catch {
      directories = [];
    }
  }
  const records = [];
  for (const directory of directories) {
    let names = [];
    try {
      names = readdirSync(join(directory, "records")).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const path = join(directory, "records", basename(name));
        const record = JSON.parse(readFileSync(path, "utf8"));
        if (record?.schemaVersion !== HANDOFF_SCHEMA_VERSION) continue;
        const stale = now - Number(record.updatedAt || 0) > HANDOFF_STALE_MS;
        records.push({
          ...record,
          requiresRevalidation: Boolean(record.requiresRevalidation || stale),
          score: scoreHandoff(record, query, cwd, now),
          matchCount: handoffMatchCount(record, query),
          path,
        });
      } catch {
        // A partial or corrupt historical record must not break task startup.
      }
    }
  }
  const hasSpecificQuery = tokenize(query).size > 0;
  return records
    .filter((record) => !hasSpecificQuery || record.matchCount > 0)
    .sort((left, right) => right.score - left.score || Number(right.updatedAt) - Number(left.updatedAt))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || MAX_HANDOFF_RECORDS)));
}

export function renderHandoffLookup(records, now = Date.now()) {
  if (!records.length) return "No matching operation handoff was found.";
  const [best, ...rest] = records;
  const lines = [renderHandoffMarkdown(best, now).trim()];
  if (rest.length) {
    lines.push("", "## Other possible records", "");
    for (const record of rest) {
      lines.push(`- ${record.recordId} · ${record.lifecycle.toUpperCase()} · ${record.objective}`);
    }
  }
  const output = lines.join("\n");
  return output.length <= MAX_HANDOFF_OUTPUT
    ? output
    : `${output.slice(0, MAX_HANDOFF_OUTPUT - 2).trimEnd()}\n…`;
}
