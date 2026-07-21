import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  BoundedCapture,
  classifySshFailure,
  connectionReuseEnabled,
  DEFAULT_TRANSFER_BYTES,
  DEFAULT_TRANSFER_TIMEOUT_SECONDS,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_SECONDS,
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
  truncateOutput,
  validateHost,
  validateLocalPath,
  validateRemotePath,
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

test("SCP argv supports one explicit upload or download without shell parsing", () => {
  const upload = scpArgs("app01", "upload", "/work/build.tgz", "/tmp/build.tgz", {
    controlPath: "/tmp/pi-ssh-1000/%C",
  });
  assert.deepEqual(upload.slice(-2), ["/work/build.tgz", "app01:/tmp/build.tgz"]);
  assert.ok(upload.includes("-B"));
  assert.ok(upload.includes("BatchMode=yes"));
  assert.ok(upload.includes("ClearAllForwardings=yes"));
  assert.ok(upload.includes("ControlPath=/tmp/pi-ssh-1000/%C"));

  const download = scpArgs("operator@app01", "download", "/work/report.txt", "/var/tmp/report.txt");
  assert.deepEqual(download.slice(-2), ["operator@app01:/var/tmp/report.txt", "/work/report.txt"]);
  assert.throws(() => scpArgs("app01", "recursive", "/work/a", "/tmp/a"), /direction/);
  assert.throws(() => validateLocalPath("relative.txt"), /absolute/);
  for (const remote of ["relative", "/tmp/../etc/passwd", "/tmp/*.conf", "/tmp/a b"] ) {
    assert.throws(() => validateRemotePath(remote));
  }
});

test("remote transfer metadata and sanitized upload history are deterministic", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-copy-history-"));
  const file = join(home, "payload.txt");
  const history = join(home, ".bash_history");
  await writeFile(file, "payload\n");
  try {
    const metadataCommand = remoteFileMetadataCommand(file);
    assert.match(metadataCommand, /stat -Lc %s/);
    assert.match(metadataCommand, /sha256sum/);
    assert.match(metadataCommand, /printf 'size=%s/);

    const historyResult = spawnSync("bash", ["-se"], {
      input: remoteTransferHistoryCommand("/work/payload.txt", file),
      encoding: "utf8", env: { ...process.env, HOME: home, HISTFILE: history },
    });
    assert.equal(historyResult.status, 0, historyResult.stderr);
    assert.equal(await readFile(history, "utf8"), `scp payload.txt ${file}\n`);
    assert.equal(remoteTransferHistoryCommand("/work/secret-token.txt", file), "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
  assert.equal(remoteProgram("hostname\nid", { recordHistory: false }), "set -o pipefail\nhostname\nid\n");
  assert.match(remoteProgram("hostname"), /trap .*BASH_COMMAND.* DEBUG/);
  assert.throws(() => remoteProgram("\0"));
});

test("remote history recording is opt-out", () => {
  assert.equal(remoteHistoryEnabled(undefined), true);
  assert.equal(remoteHistoryEnabled("1"), true);
  assert.equal(remoteHistoryEnabled("off"), false);
  assert.equal(remoteHistoryEnabled("FALSE"), false);
});

test("remote history captures commands by default but drops plumbing, duplicates, and secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-ssh-history-"));
  const history = join(home, ".bash_history");
  const validator = join(home, "validate-demo");
  await writeFile(validator, "#!/bin/bash\nexit 0\n");
  await chmod(validator, 0o700);
  try {
    const script = remoteProgram(`
sudo() { "$@"; }
python3() { cat >/dev/null; }
systemctl() { return 0; }
journalctl() { return 0; }
ss() { return 0; }
docker() { return 0; }
rpm() { return 0; }
pgrep() { return 0; }
ps() { return 0; }
curl() { return 0; }
custom_probe() { return 0; }
hostname >/dev/null
id >/dev/null
uptime >/dev/null
/usr/bin/true --middleware-check
custom_probe app01
missing_pi_probe --fallback >/dev/null 2>&1 || true
systemctl status icinga2 >/dev/null
systemctl status icinga2 >/dev/null
journalctl -u icinga2 -n 20 >/dev/null
grep -q . "$HOME/config" || true
[ -d "$HOME" ]
test -d "$HOME"
probe_state=ready
sleep 0
printf '%s\n' alpha beta | sort -u | head -n 1 >/dev/null
python3 - <<'PY'
print('read only')
PY
head -n 1 "$HOME/config" >/dev/null || true
pgrep -af icinga >/dev/null || true
ps -ef >/dev/null
df -h / >/dev/null
ss -lnt >/dev/null
docker ps >/dev/null
rpm -q icinga2 >/dev/null
curl -H 'Authorization: Bearer do-not-store' https://example.invalid >/dev/null || true
printf '%s\\n' inspected
touch "$HOME/changed"
${validator} app01
mkdir "$HOME/existing"
mkdir "$HOME/existing" || true
printf '%s\\n' safe > "$HOME/config"
printf '%s\\n' updated > "$HOME/config"
cat "$HOME/config" >/dev/null
grep -n updated "$HOME/config" >/dev/null
install "$HOME/config" "$HOME/installed"
sudo install "$HOME/config" "$HOME/privileged"
sudo python3 - <<'PY'
from pathlib import Path
for path in ['/etc/demo/first.conf', '/etc/demo/second.conf']:
    Path(path).write_text('updated')
PY
cat > "$HOME/heredoc" <<'EOF'
hello
EOF
touch /tmp/pi-history-staging
printf '%s\\n' staged > /tmp/pi-history-staging.conf
printf '%s\\n' password=do-not-store > "$HOME/credentials"
`);
    const result = spawnSync("bash", ["-se"], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, HOME: home, HISTFILE: history },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = (await readFile(history, "utf8")).trim().split("\n");
    assert.deepEqual(lines, [
      "hostname > /dev/null",
      "id > /dev/null",
      "uptime > /dev/null",
      "/usr/bin/true --middleware-check",
      "custom_probe app01",
      "systemctl status icinga2 > /dev/null",
      "journalctl -u icinga2 -n 20 > /dev/null",
      'head -n 1 "$HOME/config" > /dev/null',
      "pgrep -af icinga > /dev/null",
      "ps -ef > /dev/null",
      "df -h / > /dev/null",
      "ss -lnt > /dev/null",
      "docker ps > /dev/null",
      "rpm -q icinga2 > /dev/null",
      'touch "$HOME/changed"',
      `${validator} app01`,
      'mkdir "$HOME/existing"',
      'vi "$HOME/config"',
      'cat "$HOME/config" > /dev/null',
      'grep -n updated "$HOME/config" > /dev/null',
      'vi "$HOME/installed"',
      'sudoedit "$HOME/privileged"',
      'sudoedit /etc/demo/first.conf /etc/demo/second.conf',
      'vi "$HOME/heredoc"',
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("limits have bounded defaults and reject widening", () => {
  assert.equal(normalizeTimeout(undefined), DEFAULT_TIMEOUT_SECONDS);
  assert.equal(normalizeOutputLimit(undefined), DEFAULT_OUTPUT_BYTES);
  assert.throws(() => normalizeTimeout(121));
  assert.throws(() => normalizeOutputLimit(32769));
  assert.equal(normalizeTransferTimeout(undefined), DEFAULT_TRANSFER_TIMEOUT_SECONDS);
  assert.equal(normalizeTransferLimit(undefined), DEFAULT_TRANSFER_BYTES);
  assert.throws(() => normalizeTransferTimeout(901));
  assert.throws(() => normalizeTransferLimit(10 * 1024 * 1024 * 1024 + 1));
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
