import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package exposes the owned incident skill", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.skills, ["./skills/incident-investigation"]);
  assert.deepEqual(manifest.pi.extensions, [
    "./extensions/appearance-sync/index.ts",
    "./extensions/ssh-direct/index.ts",
    "./extensions/thinking-router/index.ts",
    "./extensions/side-task/index.ts",
    "./extensions/task-ledger/index.ts",
  ]);
});

test("incident skill carries the evidence and change contracts", async () => {
  const skill = await readFile(
    join(root, "skills", "incident-investigation", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\nname: incident-investigation\n/m);
  assert.match(skill, /Separate \*\*symptom\*\*, \*\*failure mechanism\*\*, and \*\*root cause\*\*/);
  assert.match(skill, /Apply a fix only when the user explicitly asks/);
  assert.match(skill, /discriminating or counterfactual test/);
  assert.doesNotMatch(skill, /TODO/);
});

test("installer links the incident skill without retiring domain skills", async () => {
  const installer = await readFile(join(root, "install.sh"), "utf8");
  assert.match(
    installer,
    /skills\/incident-investigation"[\s\\\n]+"\$agent_dir\/skills\/incident-investigation"/,
  );
  assert.doesNotMatch(installer, /for skill_path in/);
  assert.match(installer, /extensions\/appearance-sync" "\$extensions_dir\/appearance-sync"/);
  assert.match(installer, /extensions\/thinking-router" "\$extensions_dir\/thinking-router"/);
  assert.match(installer, /appearance-sync\|ssh-direct\|thinking-router\|side-task\|task-ledger\|study-learn-emit\) continue/);
  assert.match(installer, /extensions\/task-ledger" "\$extensions_dir\/task-ledger"/);
  assert.match(installer, /bin\/pi-ledger" "\$npm_prefix\/bin\/pi-ledger"/);
});

test("installer applies the repository-owned Sol context budget", async () => {
  const installer = await readFile(join(root, "install.sh"), "utf8");
  const models = JSON.parse(
    await readFile(join(root, "config", "models.json"), "utf8"),
  );

  assert.equal(
    models.providers["openai-codex"].modelOverrides["gpt-5.6-sol"]
      .contextWindow,
    272000,
  );
  assert.match(installer, /config\/models\.json/);
  assert.match(installer, /merge\(models, fragment\)/);
});
