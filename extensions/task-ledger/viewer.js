import { spawnSync } from "node:child_process";

export function selectedRecord(records, selectedKey = null) {
  if (records.length === 0) return null;
  return records.find((record) => record.key === selectedKey) || records[0];
}

export function moveSelection(records, selectedKey, delta) {
  if (records.length === 0) return null;
  const current = Math.max(0, records.findIndex((record) => record.key === selectedKey));
  const next = (current + delta + records.length) % records.length;
  return records[next].key;
}

export function validZellijPaneId(value) {
  return /^(?:(?:terminal|plugin)_)?\d+$/.test(String(value || ""));
}

export function focusZellijPane(paneId, run = spawnSync) {
  if (!validZellijPaneId(paneId) || !process.env.ZELLIJ_SESSION_NAME) return false;
  const result = run(
    "zellij",
    ["action", "focus-pane-id", String(paneId)],
    { stdio: "ignore", env: process.env },
  );
  return result.status === 0;
}
