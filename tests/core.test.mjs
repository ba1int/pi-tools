import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedCapture,
  classifySshFailure,
  connectionReuseEnabled,
  enforceAllowedHost,
  enforceWorkerAuthority,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_SECONDS,
  formatResult,
  isTransportFailureKind,
  looksLikeRawRemoteTransport,
  normalizeOutputLimit,
  normalizeTimeout,
  remoteProgram,
  sanitizeTerminalText,
  sshArgs,
  truncateOutput,
  validateHost,
} from "../extensions/ssh-direct/core.js";

test("literal SSH aliases are accepted and shell-shaped hosts are rejected", () => {
  assert.equal(validateHost("lab-prod-app01"), "lab-prod-app01");
  assert.equal(validateHost("operator@app01.example.net"), "operator@app01.example.net");
  for (const invalid of ["-oProxyCommand=x", "host;id", "host name", "$(id)", "user@host/path", ""]) {
    assert.throws(() => validateHost(invalid));
  }
});

test("an optional worker lease restricts SSH to explicit hosts", () => {
  assert.equal(enforceAllowedHost("app01", "app01,relay01"), "app01");
  assert.throws(() => enforceAllowedHost("db01", "app01,relay01"), /outside this worker's SSH lease/);
  assert.throws(() => enforceAllowedHost("app01", "app01,app01"), /unique/);
  assert.equal(enforceAllowedHost("db01", ""), "db01");
});

test("a read-only worker lease mechanically rejects common remote mutations", () => {
  assert.equal(enforceWorkerAuthority("hostname; cat /etc/os-release", "true"), "hostname; cat /etc/os-release");
  assert.equal(enforceWorkerAuthority("probe 2>/dev/null", "1"), "probe 2>/dev/null");
  for (const command of [
    "sudo install -m 0644 next.conf /etc/app.conf",
    "sed -i 's/old/new/' /etc/app.conf",
    "docker restart middleware",
    "printf x > /etc/app.conf",
    "systemctl reload icinga2",
  ]) {
    assert.throws(() => enforceWorkerAuthority(command, "true"), /read-only SSH lease/);
    assert.equal(enforceWorkerAuthority(command, "false"), command);
  }
});

test("SSH argv fixes noninteractive and forwarding behavior", () => {
  const args = sshArgs("app01");
  assert.deepEqual(args.slice(-3), ["--", "app01", "exec bash -se"]);
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("ClearAllForwardings=yes"));
  assert.ok(args.includes("ForwardAgent=no"));
  assert.ok(args.includes("PermitLocalCommand=no"));
  assert.ok(!args.join(" ").includes("echo unsafe"));
});

test("SSH connection reuse is opt-out and adds only client control options", () => {
  assert.equal(connectionReuseEnabled(undefined), true);
  assert.equal(connectionReuseEnabled("off"), false);
  assert.equal(connectionReuseEnabled("FALSE"), false);
  assert.equal(connectionReuseEnabled("1"), true);

  const args = sshArgs("app01", { controlPath: "/tmp/pi-ssh-1000/%C" });
  assert.deepEqual(args.slice(-3), ["--", "app01", "exec bash -se"]);
  assert.ok(args.includes("ControlMaster=auto"));
  assert.ok(args.includes("ControlPersist=60"));
  assert.ok(args.includes("ControlPath=/tmp/pi-ssh-1000/%C"));
  assert.throws(() => sshArgs("app01", { controlPath: "" }), /controlPath/);
});

test("SSH failures distinguish transport faults from remote command exits", () => {
  const cases = [
    [{ exitCode: 0, stderr: "", timedOut: false }, null],
    [{ exitCode: 7, stderr: "application failed", timedOut: false }, "remote_exit"],
    [{ exitCode: 255, stderr: "ssh: Could not resolve hostname x: Name or service not known", timedOut: false }, "dns"],
    [{ exitCode: 255, stderr: "nobody@app: Permission denied (publickey).", timedOut: false }, "authentication"],
    [{ exitCode: 255, stderr: "Host key verification failed.", timedOut: false }, "host_key"],
    [{ exitCode: 255, stderr: "ssh: connect to host app port 22: Connection refused", timedOut: false }, "connection_refused"],
    [{ exitCode: 255, stderr: "ssh: connect to host app port 22: Operation timed out", timedOut: false }, "connection_timeout"],
    [{ exitCode: 255, stderr: "kex_exchange_identification: Connection closed by remote host", timedOut: false }, "connection_closed"],
    [{ exitCode: null, stderr: "", timedOut: true }, "timeout"],
    [{ exitCode: 255, stderr: "application chose exit 255", timedOut: false }, "remote_exit"],
  ];
  for (const [result, expected] of cases) {
    const actual = classifySshFailure(result);
    assert.equal(actual, expected, JSON.stringify(result));
  }
  assert.equal(isTransportFailureKind("dns"), true);
  assert.equal(isTransportFailureKind("timeout"), true);
  assert.equal(isTransportFailureKind("remote_exit"), false);
});

test("remote output cannot inject terminal control sequences", () => {
  const malicious = [
    "plain\t雪\n",
    "\u001b[31mred\u001b[0m\n",
    "\u001b]52;c;Y2xpcGJvYXJk\u0007after\n",
    "\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\n",
    "cursor\u001b[2Jdone\n",
    "carriage\roverwrite\n",
    "back\bspace\n",
    "\u001bPprivate-device-command\u001b\\\n",
  ].join("");
  assert.equal(
    sanitizeTerminalText(malicious),
    "plain\t雪\nred\nafter\nlink\ncursordone\ncarriageoverwrite\nbackspace\n\n",
  );
  const normal = "host=app01 status=ok\nsecond\tcolumn 雪\n";
  assert.equal(sanitizeTerminalText(normal), normal);
});

test("remote commands are sent as Bash stdin programs", () => {
  assert.equal(remoteProgram("hostname\nid"), "set -o pipefail\nhostname\nid\n");
  assert.throws(() => remoteProgram("\0"));
});

test("limits have bounded defaults and reject widening", () => {
  assert.equal(normalizeTimeout(undefined), DEFAULT_TIMEOUT_SECONDS);
  assert.equal(normalizeOutputLimit(undefined), DEFAULT_OUTPUT_BYTES);
  assert.throws(() => normalizeTimeout(121));
  assert.throws(() => normalizeOutputLimit(32769));
});

test("large output retains a bounded head and tail with an explicit marker", () => {
  const source = `HEAD-${"x".repeat(10000)}-TAIL`;
  const result = truncateOutput(source, 1024);
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith("HEAD-"));
  assert.ok(result.text.endsWith("-TAIL"));
  assert.match(result.text, /output truncated/);
  assert.ok(Buffer.byteLength(result.text) <= 1100);
});

test("stream capture never retains more than its configured byte budget", () => {
  const capture = new BoundedCapture(1024);
  capture.push(Buffer.from(`HEAD-${"x".repeat(5000)}`));
  capture.push(Buffer.from(`${"y".repeat(5000)}-TAIL`));
  assert.ok(capture.storedBytes() <= 1024);
  assert.ok(capture.text().startsWith("HEAD-"));
  assert.ok(capture.text().endsWith("-TAIL"));
  assert.match(capture.text(), /stream truncated/);
});

test("formatted tool results expose execution and truncation metadata", () => {
  const result = formatResult({
    host: "app01",
    exitCode: 2,
    stdout: "x".repeat(5000),
    stderr: "failed",
    elapsedMs: 42,
    maxOutputBytes: 1024,
    timedOut: false,
  });
  assert.match(result.text, /host: app01/);
  assert.match(result.text, /truncated: true/);
  assert.equal(result.truncated, true);
});

test("formatted failures add compact machine-readable semantics", () => {
  const result = formatResult({
    host: "app01",
    exitCode: 255,
    stdout: "",
    stderr: "ssh: connect to host app01 port 22: Connection refused",
    elapsedMs: 42,
    maxOutputBytes: 1024,
    timedOut: false,
    failureKind: "connection_refused",
  });
  assert.match(result.text, /failure_kind: connection_refused/);
});

test("formatted results sanitize remote terminal controls before rendering", () => {
  const result = formatResult({
    host: "app01",
    exitCode: 0,
    stdout: "\u001b[31mred\u001b[0m\n\u001b]52;c;cG9pc29u\u0007safe\n",
    stderr: "",
    elapsedMs: 42,
    maxOutputBytes: 1024,
    timedOut: false,
  });
  assert.match(result.text, /stdout:\nred\nsafe/);
  assert.equal(/[\u001b\u0007]/.test(result.text), false);
});

test("model-generated raw remote transports are detected without blocking ordinary local commands", () => {
  for (const command of [
    "ssh app01 hostname",
    "sudo ssh app01 id",
    "echo ok && scp file app01:/tmp/",
    "rsync -a ./ app01:/srv/app/",
    "env FOO=1 sftp app01",
  ]) {
    assert.equal(looksLikeRawRemoteTransport(command), true, command);
  }
  for (const command of ["rg ssh README.md", "printf 'ssh app01'", "npm test", "echo rsync"] ) {
    assert.equal(looksLikeRawRemoteTransport(command), false, command);
  }
});
