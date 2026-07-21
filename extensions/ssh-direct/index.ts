import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  BoundedCapture,
  classifySshFailure,
  connectionReuseEnabled,
  formatResult,
  isTransportFailureKind,
  looksLikeRawRemoteTransport,
  normalizeOutputLimit,
  normalizeTimeout,
  normalizeTransferLimit,
  normalizeTransferTimeout,
  remoteFileMetadataCommand,
  remoteHistoryEnabled,
  remoteProgram,
  remoteTransferHistoryCommand,
  sanitizeTerminalText,
  scpArgs,
  sshArgs,
  validateCommand,
  validateHost,
  validateLocalPath,
  validateRemotePath,
} from "./core.js";

type ExecResult = {
  host: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
};

type CopyResult = {
  exitCode: number | null;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
};

async function prepareControlPath(): Promise<string | undefined> {
  if (!connectionReuseEnabled(process.env.PI_SSH_MULTIPLEXING)) return undefined;

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const directory = process.env.PI_SSH_CONTROL_DIR ?? `/tmp/pi-ssh-${uid ?? process.pid}`;
  if (!isAbsolute(directory)) return undefined;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
    if (uid !== undefined && metadata.uid !== uid) return undefined;
    if ((metadata.mode & 0o077) !== 0) await chmod(directory, 0o700);
    return join(directory, "%C");
  } catch {
    // Reuse is an optimization. SSH must remain available if the local
    // filesystem cannot safely host an OpenSSH control socket.
    return undefined;
  }
}

function executeSsh(
  host: string,
  command: string,
  timeoutSeconds: number,
  maxOutputBytes: number,
  controlPath: string | undefined,
  recordHistory: boolean,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("ssh", sshArgs(host, { controlPath }), { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = new BoundedCapture(maxOutputBytes);
    const stderr = new BoundedCapture(maxOutputBytes);
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutSeconds * 1000);
    const onAbort = () => terminate();

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error("ssh_exec aborted"));
        return;
      }
      resolve({
        host,
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        elapsedMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.stdin.end(remoteProgram(command, { recordHistory }));
  });
}

function executeScp(
  args: string[],
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<CopyResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("scp", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr = new BoundedCapture(16 * 1024);
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutSeconds * 1000);
    const onAbort = () => terminate();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error("ssh_copy aborted"));
        return;
      }
      resolve({
        exitCode,
        stderr: stderr.text(),
        elapsedMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

async function localFileMetadata(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${path} must be a regular file, not a directory or symbolic link`);
  }
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { size: metadata.size, sha256: hash.digest("hex") };
}

function parseRemoteMetadata(result: ExecResult) {
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`could not inspect remote file before verification: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  const size = Number(result.stdout.match(/^size=(\d+)$/m)?.[1]);
  const sha256 = result.stdout.match(/^sha256=([a-f0-9]{64})$/m)?.[1] ?? "";
  if (!Number.isSafeInteger(size) || size < 0 || !sha256) {
    throw new Error("remote file metadata was incomplete");
  }
  return { size, sha256 };
}

export default function sshDirect(pi: ExtensionAPI) {
  const controlPath = prepareControlPath();
  const recordHistory = remoteHistoryEnabled(process.env.PI_SSH_REMOTE_HISTORY);

  pi.registerTool({
    name: "ssh_exec",
    label: "ssh_exec",
    description:
      "Execute a targeted Bash program on one explicit remote SSH host. Use this directly whenever the user or a loaded skill names a remote host; no SSH mode or slash command is required.",
    promptSnippet: "Execute bounded Bash on an explicit SSH host without entering an SSH mode",
    promptGuidelines: [
      "For remote work, call ssh_exec with the literal host instead of invoking ssh, scp, sftp, or rsync through local bash.",
      "Call ssh_exec tools in parallel when independent checks are needed on multiple hosts.",
      "For one host, prefer one compact composite ssh_exec call that gathers all task-relevant evidence. Make a follow-up call only when the first result leaves a material question unanswered.",
      "Use the commands, paths, and probes supplied by a loaded skill or runbook before rediscovering a service implementation.",
      "If a usual utility or init system is absent, switch once to a portable fallback; do not repeatedly enumerate replacement tools.",
      "Keep remote commands targeted. Do not dump broad environment, package, process, or filesystem listings unless the task requires them.",
    ],
    parameters: Type.Object({
      host: Type.String({
        minLength: 1,
        maxLength: 320,
        description: "Literal SSH alias, hostname, or user@host. Never a shell expression.",
      }),
      command: Type.String({
        minLength: 1,
        description: "Bash program to execute remotely. It is sent over stdin to bash -se.",
      }),
      timeout_seconds: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 120,
        description: "Deadline for this remote call. Defaults to 30 seconds.",
      })),
      max_output_bytes: Type.Optional(Type.Integer({
        minimum: 1024,
        maximum: 32768,
        description: "Maximum rendered result size. Defaults to 16384 bytes.",
      })),
    }),
    async execute(_toolCallId, params, signal) {
      const host = validateHost(params.host);
      const command = validateCommand(params.command);
      const timeoutSeconds = normalizeTimeout(params.timeout_seconds);
      const maxOutputBytes = normalizeOutputLimit(params.max_output_bytes);
      const resolvedControlPath = await controlPath;
      const result = await executeSsh(
        host,
        command,
        timeoutSeconds,
        maxOutputBytes,
        resolvedControlPath,
        recordHistory,
        signal,
      );
      const failureKind = classifySshFailure(result);
      const rendered = formatResult({ ...result, maxOutputBytes, failureKind });
      return {
        content: [{ type: "text", text: rendered.text }],
        details: {
          host,
          exitCode: result.exitCode,
          elapsedMs: result.elapsedMs,
          timedOut: result.timedOut,
          truncated: rendered.truncated,
          originalBytes: rendered.originalBytes,
          connectionReuseEnabled: Boolean(resolvedControlPath),
          remoteHistoryEnabled: recordHistory,
          failureKind,
          transportError: isTransportFailureKind(failureKind),
        },
      };
    },
    renderCall(args, theme) {
      const host = typeof args?.host === "string" ? args.host : "...";
      const command = typeof args?.command === "string"
        ? sanitizeTerminalText(args.command).trim().split("\n", 1)[0].slice(0, 100)
        : "...";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ssh_exec"))} ${theme.fg("accent", host)} ${theme.fg("muted", command)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "ssh_copy",
    label: "ssh_copy",
    description:
      "Transfer one explicit regular file to or from one SSH host without exposing its contents to the model. Use this instead of raw scp, sftp, or rsync.",
    promptSnippet: "Upload or download one explicit file over the configured SSH transport",
    promptGuidelines: [
      "Use ssh_copy when an authorized task requires moving one file between the local workstation and a named remote host.",
      "Use absolute local and remote paths. Transfer to a user-writable staging path, then use ssh_exec for privileged installation and validation.",
      "Do not use ssh_copy to inspect file contents or recursively copy directories. Prefer generated configuration through ssh_exec when no source artifact already exists.",
    ],
    parameters: Type.Object({
      host: Type.String({
        minLength: 1,
        maxLength: 320,
        description: "Literal SSH alias, hostname, or user@host. Never a shell expression.",
      }),
      direction: Type.Union([Type.Literal("upload"), Type.Literal("download")]),
      local_path: Type.String({ description: "Absolute workstation path to the source or destination file." }),
      remote_path: Type.String({ description: "Absolute remote source or destination path without globs." }),
      overwrite: Type.Optional(Type.Boolean({ description: "Allow replacing an existing local download destination. Defaults to false." })),
      timeout_seconds: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 900,
        description: "Transfer deadline. Defaults to 120 seconds.",
      })),
      max_bytes: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 10737418240,
        description: "Maximum permitted file size. Defaults to 1 GiB; maximum 10 GiB.",
      })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      const host = validateHost(params.host);
      const direction = params.direction as "upload" | "download";
      const localPath = validateLocalPath(params.local_path);
      const remotePath = validateRemotePath(params.remote_path);
      const timeoutSeconds = normalizeTransferTimeout(params.timeout_seconds);
      const maxBytes = normalizeTransferLimit(params.max_bytes);
      const resolvedControlPath = await controlPath;
      let localTransferPath = localPath;
      let sourceMetadata: { size: number; sha256: string };

      if (direction === "upload") {
        sourceMetadata = await localFileMetadata(localPath);
        if (sourceMetadata.size > maxBytes) throw new Error(`local source exceeds max_bytes (${sourceMetadata.size} > ${maxBytes})`);
      } else {
        const parent = dirname(localPath);
        const parentMetadata = await lstat(parent);
        if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
          throw new Error("local download parent must be a real directory");
        }
        try {
          await lstat(localPath);
          if (!params.overwrite) throw new Error("local download destination exists; set overwrite=true explicitly");
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
        const remoteResult = await executeSsh(
          host,
          remoteFileMetadataCommand(remotePath),
          Math.min(timeoutSeconds, 120),
          1024,
          resolvedControlPath,
          false,
          signal,
        );
        sourceMetadata = parseRemoteMetadata(remoteResult);
        if (sourceMetadata.size > maxBytes) throw new Error(`remote source exceeds max_bytes (${sourceMetadata.size} > ${maxBytes})`);
        localTransferPath = `${localPath}.pi-transfer-${process.pid}-${Date.now()}`;
      }

      const startedAt = Date.now();
      try {
        const copy = await executeScp(
          scpArgs(host, direction, localTransferPath, remotePath, { controlPath: resolvedControlPath }),
          timeoutSeconds,
          signal,
        );
        if (copy.exitCode !== 0 || copy.timedOut) {
          const reason = copy.timedOut ? "timed out" : `exit ${copy.exitCode}`;
          throw new Error(`scp ${reason}: ${copy.stderr.trim() || "no diagnostic"}`);
        }

        let destinationMetadata: { size: number; sha256: string };
        let historyRecorded = false;
        if (direction === "upload") {
          const remoteResult = await executeSsh(
            host,
            remoteFileMetadataCommand(remotePath),
            Math.min(timeoutSeconds, 120),
            1024,
            resolvedControlPath,
            false,
            signal,
          );
          destinationMetadata = parseRemoteMetadata(remoteResult);
          const verified = sourceMetadata.size === destinationMetadata.size
            && sourceMetadata.sha256 === destinationMetadata.sha256;
          if (!verified) throw new Error("SHA-256 verification failed after transfer");
          const historyCommand = recordHistory ? remoteTransferHistoryCommand(localPath, remotePath) : "";
          if (historyCommand) {
            const historyResult = await executeSsh(
              host, historyCommand, Math.min(timeoutSeconds, 120), 1024,
              resolvedControlPath, false, signal,
            );
            historyRecorded = historyResult.exitCode === 0 && !historyResult.timedOut;
          }
        } else {
          destinationMetadata = await localFileMetadata(localTransferPath);
          if (destinationMetadata.size > maxBytes) throw new Error("downloaded file exceeds max_bytes");
          const verified = sourceMetadata.size === destinationMetadata.size
            && sourceMetadata.sha256 === destinationMetadata.sha256;
          if (!verified) throw new Error("SHA-256 verification failed after transfer");
          await rename(localTransferPath, localPath);
        }
        const verified = sourceMetadata.size === destinationMetadata.size
          && sourceMetadata.sha256 === destinationMetadata.sha256;
        if (!verified) throw new Error("SHA-256 verification failed after transfer");
        const text = [
          `host: ${host}`,
          `direction: ${direction}`,
          `bytes: ${sourceMetadata.size}`,
          `sha256: ${sourceMetadata.sha256}`,
          "verified: true",
          `remote_history: ${direction === "upload" ? (historyRecorded ? "recorded" : "not-recorded") : "not-applicable"}`,
          `elapsed_ms: ${Date.now() - startedAt}`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            host, direction, localPath, remotePath,
            bytes: sourceMetadata.size, sha256: sourceMetadata.sha256,
            verified: true, historyRecorded,
            elapsedMs: Date.now() - startedAt,
            connectionReuseEnabled: Boolean(resolvedControlPath),
          },
        };
      } finally {
        if (direction === "download" && localTransferPath !== localPath) {
          await rm(localTransferPath, { force: true }).catch(() => {});
        }
      }
    },
    renderCall(args, theme) {
      const host = typeof args?.host === "string" ? args.host : "...";
      const direction = args?.direction === "download" ? "download" : "upload";
      const path = direction === "download" ? args?.remote_path : args?.local_path;
      const detail = typeof path === "string" ? sanitizeTerminalText(path).slice(0, 90) : "...";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ssh_copy"))} ${theme.fg("accent", host)} ${theme.fg("muted", `${direction} ${detail}`)}`,
        0,
        0,
      );
    },
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt:
      event.systemPrompt
      + "\n\nRemote execution is stateless. When the user or a loaded skill identifies a remote host, call ssh_exec directly with that literal host, and use ssh_copy for explicit file transfer. Never ask the user to enter an SSH mode or slash command. Never invoke ssh, scp, sftp, or rsync through local bash. For one host, prefer one compact task-focused call and follow up only when evidence is materially incomplete. Obey loaded skills before rediscovering service internals. Use parallel ssh_exec calls for independent hosts and keep output targeted.",
  }));

  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!looksLikeRawRemoteTransport(event.input.command)) return;
    return {
      block: true,
      reason:
        "Model-generated raw SSH transport is disabled. Retry now with ssh_exec for commands or ssh_copy for one explicit file transfer; do not ask the user for an SSH mode or slash command.",
    };
  });
}
