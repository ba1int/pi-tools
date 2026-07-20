import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { patchPiInlineCompaction } from "../lib/patch-pi-inline-compaction.mjs";

const prefix = process.env.PI_NPM_PREFIX || join(homedir(), ".local");
const installedManifest = join(
  prefix,
  "lib/node_modules/@earendil-works/pi-coding-agent/package.json",
);

test("0.80.10 runtime patch is guarded, idempotent, and syntactically valid", {
  skip: !existsSync(installedManifest),
}, () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-inline-compaction-"));
  const sourceRoot = dirname(installedManifest);
  const targetRoot = join(temporary, "pi-coding-agent");
  try {
    cpSync(sourceRoot, targetRoot, { recursive: true });
    const manifest = join(targetRoot, "package.json");
    const first = patchPiInlineCompaction(manifest, "0.80.10");
    assert.equal(typeof first.changed, "boolean");
    assert.equal(patchPiInlineCompaction(manifest, "0.80.10").changed, false);

    const target = join(targetRoot, "dist/core/agent-session.js");
    const source = readFileSync(target, "utf8");
    assert.match(source, /pi-tools:inline-compaction:v1/);
    assert.match(source, /_shouldCompactBeforeNextToolTurn/);
    assert.match(source, /stopped before the next model turn/);
    assert.match(source, /Compaction produced an empty summary/);
    assert.match(source, /extensionResult\?\.customInstructions/);

    const syntax = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("runtime patch refuses a version it was not reviewed against", {
  skip: !existsSync(installedManifest),
}, () => {
  assert.throws(
    () => patchPiInlineCompaction(installedManifest, "0.80.11"),
    /expected @earendil-works\/pi-coding-agent@0\.80\.11/,
  );
});
