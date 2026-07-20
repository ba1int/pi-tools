export const DEFAULT_THRESHOLD_PERCENT = 75;
export const MIN_THRESHOLD_PERCENT = 50;
export const MAX_THRESHOLD_PERCENT = 90;
export const REARM_MARGIN_PERCENT = 10;
export const CONTEXT_CHECKPOINT_EVENT = "pi-tools:context-checkpoint";

export const COMPACTION_INSTRUCTIONS = [
  "This is an in-progress systems operation. Preserve only the operational state needed to continue safely:",
  "authorization and scope; hosts and topology; completed and partial mutations; validated observations; current blockers; rollback or recovery position; exact next safe action; and relevant artifact or log paths.",
  "If a prior compacted summary exists, carry forward only still-relevant decisions, completed mutations, and unresolved blockers.",
  "Clearly distinguish facts from hypotheses. Omit repeated command output, routine warnings, obsolete exploration, and credentials or secret values.",
  "The task must continue after compaction without repeating a completed mutation.",
].join(" ");

export const CONTINUATION_PROMPT = [
  "Automatic context checkpoint complete. Continue the same task from the compacted operational state.",
  "Re-read live state before any mutation whose completion is uncertain, do not repeat completed changes, and keep following the loaded runbook and original authorization.",
].join(" ");

export const YIELD_PROMPT = [
  "Context checkpoint requested by the harness.",
  "Do not call another tool or begin another mutation in this agent run.",
  "End now with a concise operational handoff; the harness will compact the session and continue automatically.",
].join(" ");

export function normalizeThreshold(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return DEFAULT_THRESHOLD_PERCENT;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_THRESHOLD_PERCENT || parsed > MAX_THRESHOLD_PERCENT) {
    throw new Error(
      `PI_CONTEXT_SENTINEL_PERCENT must be between ${MIN_THRESHOLD_PERCENT} and ${MAX_THRESHOLD_PERCENT}`,
    );
  }
  return parsed;
}

export function sentinelEnabled(value) {
  return !/^(?:0|off|false)$/i.test(String(value ?? ""));
}

export function usagePercent(usage) {
  if (Number.isFinite(usage?.percent)) return usage.percent;
  if (Number.isFinite(usage?.tokens) && Number.isFinite(usage?.contextWindow) && usage.contextWindow > 0) {
    return (usage.tokens / usage.contextWindow) * 100;
  }
  return null;
}

export class ContextSentinelState {
  constructor(thresholdPercent = DEFAULT_THRESHOLD_PERCENT) {
    this.thresholdPercent = normalizeThreshold(thresholdPercent);
    this.armed = true;
    this.yieldRequested = false;
    this.compacting = false;
    this.compactions = 0;
  }

  reset() {
    this.armed = true;
    this.yieldRequested = false;
    this.compacting = false;
    this.compactions = 0;
  }

  observe(usage, { hasToolResults = false } = {}) {
    const percent = usagePercent(usage);
    if (percent === null) return { trigger: false, percent: null };

    if (!this.armed && !this.compacting && percent <= this.thresholdPercent - REARM_MARGIN_PERCENT) {
      this.armed = true;
    }

    const trigger = hasToolResults
      && this.armed
      && !this.compacting
      && percent >= this.thresholdPercent;
    if (trigger) {
      this.armed = false;
      this.yieldRequested = true;
    }
    return { trigger, percent };
  }

  complete() {
    this.yieldRequested = false;
    this.compacting = false;
    this.compactions += 1;
  }

  fail() {
    this.yieldRequested = false;
    this.compacting = false;
  }

  beginCompaction() {
    if (!this.yieldRequested || this.compacting) return false;
    this.compacting = true;
    return true;
  }
}
