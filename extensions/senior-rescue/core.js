import { createHash } from "node:crypto";
import { finalResultRequiresEscalation } from "../thinking-router/core.js";

export const DEFAULT_TIMEOUT_SECONDS = 240;
export const MAX_TIMEOUT_SECONDS = 600;
export const DEFAULT_MAX_TOOL_CALLS = 6;
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export class ReactiveRescueState {
  constructor(maxHosts = 8) {
    this.maxHosts = maxHosts;
    this.reset();
  }

  reset() {
    this.objective = "";
    this.finalReport = "";
    this.automaticRescueUsed = false;
    this.observedHosts = new Set();
  }

  noteInput(event) {
    if (event?.source !== "extension" && !event?.streamingBehavior && !this.objective) {
      this.objective = String(event?.text ?? "").trim();
    }
  }

  noteHost(host) {
    if (typeof host === "string" && host && this.observedHosts.size < this.maxHosts) {
      this.observedHosts.add(host);
    }
  }

  noteFinal(messages) {
    for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      this.finalReport = (message.content ?? []).filter((part) => part.type === "text")
        .map((part) => part.text ?? "").join("\n").trim();
      return;
    }
    this.finalReport = "";
  }

  takeFollowUp() {
    if (this.automaticRescueUsed || this.observedHosts.size === 0
        || !finalResultRequiresEscalation(this.finalReport)) {
      this.finalReport = "";
      return null;
    }
    this.automaticRescueUsed = true;
    const blockedConclusion = this.finalReport;
    this.finalReport = "";
    return `Reactive blocker rescue. Call senior_rescue exactly once, then independently verify its handback and resume the original task if safe.\n\nOriginal objective:\n${this.objective || "Continue the current user-authorized task."}\n\nYour blocked conclusion:\n${blockedConclusion}\n\nPackage only verified current state and failed attempts. Lease only these already observed hosts: ${[...this.observedHosts].join(", ")}. Set mutation_authorized true only if the original user request authorized the needed in-scope changes; otherwise set it false. Never override missing authority, ownership conflicts, unsupported topology, credentials, or trust failures.`;
  }
}

export function normalizeSeniorRequest(value) {
  if (!value || typeof value !== "object") throw new Error("senior rescue request is required");
  const required = ["objective", "blocker", "current_state"];
  const request = {};
  for (const key of required) {
    if (typeof value[key] !== "string" || value[key].trim().length < 3) {
      throw new Error(`${key} must be a concrete non-empty string`);
    }
    request[key] = value[key].trim().slice(0, 12_000);
  }
  if (!Array.isArray(value.allowed_hosts) || value.allowed_hosts.length < 1 || value.allowed_hosts.length > 8) {
    throw new Error("allowed_hosts must contain 1-8 literal SSH hosts");
  }
  request.allowed_hosts = [...new Set(value.allowed_hosts.map((host) => {
    if (typeof host !== "string" || !/^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,252}|[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,252})$/.test(host)) {
      throw new Error("allowed_hosts contains an invalid SSH host");
    }
    return host;
  }))];
  request.failed_attempts = Array.isArray(value.failed_attempts)
    ? value.failed_attempts.filter((item) => typeof item === "string").slice(0, 6).map((item) => item.slice(0, 2_000))
    : [];
  request.constraints = typeof value.constraints === "string" ? value.constraints.slice(0, 4_000) : "";
  if (typeof value.mutation_authorized !== "boolean") {
    throw new Error("mutation_authorized must explicitly preserve the original user's authority");
  }
  request.mutation_authorized = value.mutation_authorized;
  return request;
}

export function rescueFingerprint(request) {
  return createHash("sha256")
    .update(JSON.stringify([request.objective, request.blocker, request.allowed_hosts]))
    .digest("hex");
}

export function buildSeniorPrompt(request) {
  const authority = request.mutation_authorized
    ? "MUTATION AUTHORIZED: the original task authorizes necessary in-scope changes. Use the smallest change that resolves this blocker."
    : "READ ONLY: the original task does not authorize mutation. Diagnose and return guidance; do not change remote state.";
  return `You are the temporary senior for one blocked operations task. The Luna operator remains owner.\n\nOBJECTIVE\n${request.objective}\n\nOBSERVED BLOCKER\n${request.blocker}\n\nCURRENT VERIFIED STATE\n${request.current_state}\n\nFAILED ATTEMPTS\n${request.failed_attempts.length ? request.failed_attempts.map((item) => `- ${item}`).join("\n") : "- none supplied"}\n\nCONSTRAINTS\n${request.constraints || "- preserve unrelated state; use least change necessary"}\n\nAUTHORITY\n${authority}\n\nLEASE\n- SSH hosts: ${request.allowed_hosts.join(", ")}\n- Do not expand scope, invent authority, delegate, or repeat failed attempts without new evidence.\n- Observe before mutation. After any mutation, verify the affected checkpoint.\n- If ownership, authority, credentials, trust, or topology is genuinely missing, stop safely.\n\nReturn ONLY one JSON object with this exact shape:\n{\n  "status": "resolved|guidance|blocked",\n  "root_cause": "...",\n  "changes": ["host: exact change"],\n  "verification": ["host: exact observed result"],\n  "handback": "what Luna should do next",\n  "remaining_risks": ["..."],\n  "hosts_touched": ["..."]\n}`;
}

export function parseJsonEvents(text) {
  const messages = [];
  const toolCalls = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "message_end" || !event.message) continue;
    messages.push(event.message);
    if (event.message.role !== "assistant") continue;
    for (const part of event.message.content ?? []) {
      if (part.type === "toolCall") toolCalls.push({ name: part.name, arguments: part.arguments });
    }
    const current = event.message.usage ?? {};
    usage.input += current.input ?? 0;
    usage.output += current.output ?? 0;
    usage.cacheRead += current.cacheRead ?? 0;
    usage.cacheWrite += current.cacheWrite ?? 0;
    usage.reasoning += current.reasoning ?? 0;
    usage.cost += current.cost?.total ?? 0;
  }
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  const finalText = (assistant?.content ?? []).filter((part) => part.type === "text")
    .map((part) => part.text ?? "").join("\n").trim();
  return { messages, toolCalls, usage, finalText };
}

export class JsonEventCollector {
  constructor(maxLineBytes = MAX_CAPTURE_BYTES) {
    this.maxLineBytes = maxLineBytes;
    this.buffer = "";
    this.toolCalls = [];
    this.finalText = "";
    this.stdoutBytes = 0;
    this.oversizedLine = false;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
  }

  push(chunk) {
    this.stdoutBytes += chunk.length;
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.consume(line);
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) {
      this.buffer = "";
      this.oversizedLine = true;
    }
  }

  consume(line) {
    if (!line.includes('"type":"message_end"')) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const message = event.type === "message_end" ? event.message : null;
    if (message?.role !== "assistant") return;
    const text = (message.content ?? []).filter((part) => part.type === "text")
      .map((part) => part.text ?? "").join("\n").trim();
    if (text) this.finalText = text;
    for (const part of message.content ?? []) {
      if (part.type === "toolCall") this.toolCalls.push({ name: part.name, arguments: part.arguments });
    }
    const current = message.usage ?? {};
    this.usage.input += current.input ?? 0;
    this.usage.output += current.output ?? 0;
    this.usage.cacheRead += current.cacheRead ?? 0;
    this.usage.cacheWrite += current.cacheWrite ?? 0;
    this.usage.reasoning += current.reasoning ?? 0;
    this.usage.cost += current.cost?.total ?? 0;
  }

  finish() {
    if (this.buffer) this.consume(this.buffer);
    this.buffer = "";
    return {
      toolCalls: this.toolCalls,
      finalText: this.finalText,
      usage: this.usage,
      stdoutBytes: this.stdoutBytes,
      oversizedLine: this.oversizedLine,
    };
  }
}

export function parseHandback(text, allowedHosts) {
  const raw = String(text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("senior returned no JSON handback");
  const value = JSON.parse(raw.slice(start, end + 1));
  if (!new Set(["resolved", "guidance", "blocked"]).has(value.status)) {
    throw new Error("senior handback has invalid status");
  }
  for (const key of ["root_cause", "handback"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`senior handback is missing ${key}`);
  }
  for (const key of ["changes", "verification", "remaining_risks", "hosts_touched"]) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
      throw new Error(`senior handback has invalid ${key}`);
    }
  }
  if (value.status === "resolved" && value.verification.length === 0) {
    throw new Error("resolved senior handback has no verification evidence");
  }
  const allowed = new Set(allowedHosts);
  const outside = value.hosts_touched.filter((host) => !allowed.has(host));
  if (outside.length) throw new Error(`senior reported hosts outside lease: ${outside.join(", ")}`);
  return value;
}

export function normalizeBudget(value, fallback = DEFAULT_MAX_TOOL_CALLS) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 12) throw new Error("max_tool_calls must be 1-12");
  return value;
}

export function normalizeSeniorTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(value) || value < 30 || value > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout_seconds must be 30-${MAX_TIMEOUT_SECONDS}`);
  }
  return value;
}

export function normalizeRescueLimit(value) {
  if (value === undefined || value === "") return 3;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 6) {
    throw new Error("PI_SENIOR_MAX_RESCUES must be 1-6");
  }
  return parsed;
}
