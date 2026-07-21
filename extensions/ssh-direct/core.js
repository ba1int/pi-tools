export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 120;
export const DEFAULT_OUTPUT_BYTES = 16 * 1024;
export const MAX_OUTPUT_BYTES = 32 * 1024;
export const CONTROL_PERSIST_SECONDS = 60;

const HOST_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,252}|[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,252})$/;

const TRANSPORT_FAILURE_KINDS = new Set([
  "timeout",
  "dns",
  "authentication",
  "host_key",
  "connection_refused",
  "connection_timeout",
  "connection_closed",
]);

export function validateHost(value) {
  if (typeof value !== "string" || !HOST_PATTERN.test(value)) {
    throw new Error(
      "host must be one literal SSH alias or hostname using only letters, digits, dot, underscore, dash, and optional user@host",
    );
  }
  return value;
}

export function allowedHosts(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const hosts = String(value).split(",").map((host) => validateHost(host.trim()));
  if (hosts.length === 0 || hosts.length > 32 || new Set(hosts).size !== hosts.length) {
    throw new Error("PI_SSH_ALLOWED_HOSTS must contain 1-32 unique literal SSH hosts");
  }
  return new Set(hosts);
}

export function enforceAllowedHost(host, value = process.env.PI_SSH_ALLOWED_HOSTS) {
  const validated = validateHost(host);
  const allowed = allowedHosts(value);
  if (allowed !== null && !allowed.has(validated)) {
    throw new Error(`host ${validated} is outside this worker's SSH lease`);
  }
  return validated;
}

export function validateCommand(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("command must be a non-empty Bash program");
  }
  if (value.includes("\0")) {
    throw new Error("command cannot contain a NUL byte");
  }
  return value;
}

export function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout_seconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`);
  }
  return value;
}

export function normalizeOutputLimit(value) {
  if (value === undefined) return DEFAULT_OUTPUT_BYTES;
  if (!Number.isInteger(value) || value < 1024 || value > MAX_OUTPUT_BYTES) {
    throw new Error(`max_output_bytes must be an integer from 1024 to ${MAX_OUTPUT_BYTES}`);
  }
  return value;
}

export function connectionReuseEnabled(value) {
  return !/^(?:0|off|false)$/i.test(String(value ?? ""));
}

export function classifySshFailure({ exitCode, stderr = "", timedOut = false }) {
  if (timedOut) return "timeout";
  if (exitCode === 0) return null;
  if (exitCode !== 255) return "remote_exit";

  const message = String(stderr);
  if (/Could not resolve hostname|Name or service not known|nodename nor servname provided|Temporary failure in name resolution/i.test(message)) {
    return "dns";
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known|Offending .* key/i.test(message)) {
    return "host_key";
  }
  if (/(?:^|\n)(?:[^:\n]+@[^:\n]+:\s*)?Permission denied \([^)]+\)\.?/i.test(message)
      || /Authentication failed|Too many authentication failures|No supported authentication methods available/i.test(message)) {
    return "authentication";
  }
  if (/Connection refused/i.test(message)) return "connection_refused";
  if (/Connection timed out|Operation timed out|connect to host .* port .*: timed out/i.test(message)) {
    return "connection_timeout";
  }
  if (/Connection (?:closed|reset)|kex_exchange_identification|banner exchange|Broken pipe|closed by remote host/i.test(message)) {
    return "connection_closed";
  }
  return "remote_exit";
}

export function isTransportFailureKind(kind) {
  return TRANSPORT_FAILURE_KINDS.has(kind);
}

function consumeCsi(value, index) {
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return index;
}

function consumeControlString(value, index) {
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return index;
}

export function sanitizeTerminalText(value) {
  const input = String(value ?? "");
  let output = "";

  for (let index = 0; index < input.length;) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      const next = input.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = consumeCsi(input, index + 2);
      } else if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = consumeControlString(input, index + 2);
      } else if ([0x28, 0x29, 0x2a, 0x2b, 0x2d, 0x2e, 0x2f].includes(next)) {
        index = Math.min(input.length, index + 3);
      } else {
        index = Math.min(input.length, index + 2);
      }
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(input, index + 1);
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = consumeControlString(input, index + 1);
      continue;
    }
    if (code === 0x0a || code === 0x09) {
      output += input[index];
    } else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      output += input[index];
    }
    index += 1;
  }

  return output;
}

export function sshArgs(host, { controlPath } = {}) {
  const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
    "-o", "UpdateHostKeys=no",
  ];
  if (controlPath !== undefined) {
    if (typeof controlPath !== "string" || controlPath.length === 0 || controlPath.includes("\0")) {
      throw new Error("controlPath must be a non-empty local path without NUL bytes");
    }
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
      "-o", `ControlPath=${controlPath}`,
    );
  }
  args.push("--", validateHost(host), "exec bash -se");
  return args;
}

export function remoteProgram(command) {
  return `set -o pipefail\n${validateCommand(command)}\n`;
}

export function looksLikeRawRemoteTransport(command) {
  if (typeof command !== "string") return false;
  const segments = command.split(/[\n;&|()]+/);
  return segments.some((segment) => {
    const normalized = segment.trim().replace(/^(?:command\s+|exec\s+|sudo(?:\s+-\S+)*\s+|env(?:\s+\S+=\S+)*\s+)+/, "");
    return /^(?:ssh|scp|sftp)(?:\s|$)/.test(normalized)
      || /^rsync(?:\s|$).*\S:/.test(normalized);
  });
}

export class BoundedCapture {
  constructor(limit) {
    this.limit = normalizeOutputLimit(limit);
    this.totalBytes = 0;
    this.overflow = false;
    this.full = [];
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.headLimit = Math.floor(this.limit * 0.6);
    this.tailLimit = this.limit - this.headLimit;
  }

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += bytes.length;

    if (!this.overflow) {
      this.full.push(bytes);
      const buffered = this.full.reduce((sum, item) => sum + item.length, 0);
      if (buffered <= this.limit) return;

      const combined = Buffer.concat(this.full);
      this.head = combined.subarray(0, this.headLimit);
      this.tail = combined.subarray(combined.length - this.tailLimit);
      this.full = [];
      this.overflow = true;
      return;
    }

    this.tail = Buffer.concat([this.tail, bytes]).subarray(-this.tailLimit);
  }

  storedBytes() {
    if (!this.overflow) return this.full.reduce((sum, item) => sum + item.length, 0);
    return this.head.length + this.tail.length;
  }

  text() {
    if (!this.overflow) return Buffer.concat(this.full).toString("utf8");
    const omitted = Math.max(0, this.totalBytes - this.head.length - this.tail.length);
    return `${this.head.toString("utf8")}\n\n... stream truncated (${omitted} bytes omitted) ...\n\n${this.tail.toString("utf8")}`;
  }
}

function safeUtf8Slice(buffer, start, end) {
  return buffer.subarray(start, end).toString("utf8");
}

export function truncateOutput(text, maxBytes) {
  const limit = normalizeOutputLimit(maxBytes);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) {
    return { text, truncated: false, originalBytes: bytes.length };
  }

  const marker = `\n\n... output truncated (${bytes.length - limit}+ bytes omitted) ...\n\n`;
  const markerBytes = Buffer.byteLength(marker);
  const contentBudget = Math.max(0, limit - markerBytes);
  const headBytes = Math.floor(contentBudget * 0.6);
  const tailBytes = contentBudget - headBytes;
  const head = safeUtf8Slice(bytes, 0, headBytes);
  const tail = safeUtf8Slice(bytes, bytes.length - tailBytes);
  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
    originalBytes: bytes.length,
  };
}

export function formatResult({ host, exitCode, stdout, stderr, elapsedMs, maxOutputBytes, timedOut, failureKind }) {
  const safeStdout = sanitizeTerminalText(stdout);
  const safeStderr = sanitizeTerminalText(stderr);
  const sections = [
    `host: ${host}`,
    `exit: ${exitCode === null ? "none" : exitCode}`,
  ];
  if (failureKind) sections.push(`failure_kind: ${failureKind}`);
  sections.push(`elapsed_ms: ${elapsedMs}`);
  if (timedOut) sections.push("timed_out: true");
  if (safeStdout) sections.push(`\nstdout:\n${safeStdout}`);
  if (safeStderr) sections.push(`\nstderr:\n${safeStderr}`);
  const result = truncateOutput(sections.join("\n"), maxOutputBytes);
  if (result.truncated) {
    result.text += `\ntruncated: true\noriginal_bytes: ${result.originalBytes}`;
  }
  return result;
}
