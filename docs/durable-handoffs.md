# Durable operation handoffs

`task-ledger` keeps a durable continuation record for work that has demonstrated
continuity value. A quick single-host inspection does not create an archive.
Archiving starts after any one of these signals:

- the agent records an `ops_checkpoint`;
- Pi performs an operational context checkpoint; or
- the task reaches at least two distinct SSH targets.

The extension refreshes the archive at semantic checkpoints, SSH outcomes,
settlement, and shutdown. It does not add a daemon, background model, prompt, or
slash command. Records are written atomically with user-only permissions below:

```text
${XDG_STATE_HOME:-~/.local/state}/pi-handoffs/
  workspaces/<cwd-fingerprint>/
    workspace.json
    records/<session-task>.json
    records/<session-task>.md
```

Records are never deleted automatically. Their lifecycle is `ACTIVE`,
`BLOCKED`, `WAITING`, `DORMANT`, `COMPLETE`, or `ARCHIVED`. Any record older
than seven days is returned with `REVALIDATE LIVE STATE`; age changes its trust
contract, not its retention.

When a user naturally asks Pi to resume, revisit, explain, or document earlier
work, the model can call `handoff_lookup` itself. Lookup prefers the current
working directory and concrete task, host, incident, and service terms. It
returns no result when a concrete query does not match, and only searches other
workspaces when the model explicitly requests it.

The archive contains the bounded task objective, semantic checkpoints, and safe
tool targets/outcomes. It does not contain raw tool output or commands. Common
credentials, authorization headers, private keys, credential-bearing URLs, and
long opaque values are redacted again at the archive boundary. A handoff is
prior evidence only: it never proves current state, grants approval, or carries
credentials.

Disable the parent extension with `PI_TASK_LEDGER=off`. No independent handoff
process remains when the ledger is disabled.
