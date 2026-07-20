export const CONTEXT_CHECKPOINT_EVENT = "pi-tools:context-checkpoint";

export const COMPACTION_INSTRUCTIONS = [
  "This is an in-progress systems operation. Preserve only the operational state needed to continue safely:",
  "authorization and scope; loaded runbook or skill identity; mandatory checkpoints; hosts and topology; host-by-host phase; completed and partial mutations; validated observations; current blockers; rollback or recovery position; exact next safe action; ownership or approval boundaries; and relevant artifact or log paths.",
  "If a prior compacted summary exists, carry forward only still-relevant decisions, completed mutations, and unresolved blockers.",
  "Clearly distinguish facts from hypotheses. Omit repeated command output, routine warnings, and obsolete exploration.",
  "Preserve credentials and secret values that are still required to continue the authorized operation. Keep them only in the compacted context: do not echo them into operator-facing prose, ledger checkpoints, tool logs, or unrelated artifacts, and never introduce a value that was not already present.",
  "The task must continue after compaction without repeating a completed mutation.",
].join(" ");

export function sentinelEnabled(value) {
  return !/^(?:0|off|false)$/i.test(String(value ?? ""));
}

export function operationalManifest(snapshot) {
  if (!snapshot?.taskId || !["queued", "running"].includes(snapshot.state)) return "";
  const lines = [
    "Deterministic operator ledger at the compaction boundary:",
    `task: ${String(snapshot.taskId).slice(0, 80)}`,
    `objective: ${String(snapshot.prompt || "unspecified").slice(0, 240)}`,
    `state: ${String(snapshot.state).slice(0, 24)}`,
    `working_directory: ${String(snapshot.cwd || "unknown").slice(0, 240)}`,
  ];
  const notes = Array.isArray(snapshot.notes) ? snapshot.notes.slice(-12) : [];
  if (notes.length > 0) {
    lines.push("checkpoints:");
    for (const note of notes) {
      const state = String(note?.state || "working").slice(0, 16);
      const subject = String(note?.subject || "").replace(/\s+/g, " ").trim().slice(0, 100);
      const text = String(note?.note || "").replace(/\s+/g, " ").trim().slice(0, 240);
      if (text) lines.push(`- ${state}${subject ? ` / ${subject}` : ""}: ${text}`);
    }
  }
  const facts = operationalFacts(snapshot);
  if (facts.length > 0) {
    lines.push("recent_tool_outcomes (factual fallback; not proof of phase completion):");
    for (const fact of facts) {
      lines.push(`- ${fact.status} / ${fact.kind}: ${fact.detail}`);
    }
  }
  return lines.join("\n").slice(0, 4096);
}

export function operationalFacts(snapshot, maxFacts = 8) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const excludedKinds = new Set(["AGENT", "DONE", "INPUT", "ROUTE"]);
  const unique = new Map();
  for (const event of events) {
    const kind = String(event?.kind || "tool").toUpperCase().slice(0, 18);
    const status = String(event?.status || "unknown").toLowerCase().slice(0, 16);
    const detail = String(event?.detail || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!detail || excludedKinds.has(kind) || status === "running") continue;
    const key = `${kind}\0${detail}\0${status}`;
    unique.delete(key);
    unique.set(key, { kind: kind.toLowerCase(), status, detail });
  }
  return Array.from(unique.values()).slice(-Math.max(0, maxFacts));
}

export function compactionInstructions(snapshot) {
  return [COMPACTION_INSTRUCTIONS, operationalManifest(snapshot)].filter(Boolean).join("\n\n");
}

export class ContextSentinelState {
  constructor() {
    this.compacting = false;
    this.compactions = 0;
    this.reason = null;
  }

  reset() {
    this.compacting = false;
    this.compactions = 0;
    this.reason = null;
  }

  begin(reason = "threshold") {
    this.compacting = true;
    this.reason = reason;
  }

  complete() {
    this.compacting = false;
    this.compactions += 1;
    this.reason = null;
  }

  fail() {
    this.compacting = false;
    this.reason = null;
  }
}
