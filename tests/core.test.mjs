import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedCapture,
  connectionReuseEnabled,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_SECONDS,
  formatResult,
  looksLikeRawRemoteTransport,
  normalizeOutputLimit,
  normalizeTimeout,
  remoteProgram,
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
