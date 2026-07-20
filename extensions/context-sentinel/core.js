export const CONTEXT_CHECKPOINT_EVENT = "pi-tools:context-checkpoint";

export const COMPACTION_INSTRUCTIONS = [
  "This is an in-progress systems operation. Preserve only the operational state needed to continue safely:",
  "authorization and scope; loaded runbook or skill identity; mandatory checkpoints; hosts and topology; host-by-host phase; completed and partial mutations; validated observations; current blockers; rollback or recovery position; exact next safe action; ownership or approval boundaries; and relevant artifact or log paths.",
  "If a prior compacted summary exists, carry forward only still-relevant decisions, completed mutations, and unresolved blockers.",
  "Clearly distinguish facts from hypotheses. Omit repeated command output, routine warnings, obsolete exploration, and credentials or secret values.",
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
  return lines.join("\n").slice(0, 4096);
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
