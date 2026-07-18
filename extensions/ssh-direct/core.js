export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 120;
export const DEFAULT_OUTPUT_BYTES = 16 * 1024;
export const MAX_OUTPUT_BYTES = 32 * 1024;

const HOST_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,252}|[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,252})$/;

export function validateHost(value) {
  if (typeof value !== "string" || !HOST_PATTERN.test(value)) {
    throw new Error(
      "host must be one literal SSH alias or hostname using only letters, digits, dot, underscore, dash, and optional user@host",
    );
  }
  return value;
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

export function sshArgs(host) {
  return [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
    "-o", "UpdateHostKeys=no",
    "--",
    validateHost(host),
    "exec bash -se",
  ];
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

export function formatResult({ host, exitCode, stdout, stderr, elapsedMs, maxOutputBytes, timedOut }) {
  const sections = [
    `host: ${host}`,
    `exit: ${exitCode === null ? "none" : exitCode}`,
    `elapsed_ms: ${elapsedMs}`,
  ];
  if (timedOut) sections.push("timed_out: true");
  if (stdout) sections.push(`\nstdout:\n${stdout}`);
  if (stderr) sections.push(`\nstderr:\n${stderr}`);
  const result = truncateOutput(sections.join("\n"), maxOutputBytes);
  if (result.truncated) {
    result.text += `\ntruncated: true\noriginal_bytes: ${result.originalBytes}`;
  }
  return result;
}
