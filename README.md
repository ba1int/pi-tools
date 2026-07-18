# Pi tools

Small, user-owned Pi tools for the workstation agent. This repository contains
generic capabilities only; work-specific procedures remain in machine-local
skills.

## SSH Direct

`ssh_exec` executes one Bash program on one explicit SSH destination. The model
supplies the host on every call, so natural requests can span several machines
without `/ssh`, active-host state, pickers, or session modes.

The tool:

- passes the validated destination as an `ssh` argv item;
- sends the Bash program over stdin rather than embedding it in an SSH command;
- disables forwarding, local commands, TTY allocation, and host-key updates;
- defaults to a 30-second timeout;
- caps rendered output at 16 KiB by default and 32 KiB maximum;
- retains both the beginning and end when output is truncated;
- tells Pi to use parallel tool calls for independent hosts; and
- blocks model-generated `ssh`, `scp`, `sftp`, and `rsync` transports through
  local Bash so Pi retries through `ssh_exec` automatically.

This is transport and context control, not a remote authorization system. SSH
accounts, sudo policy, and the user's work skills remain the operational
boundaries.

## Incident Investigation

`incident-investigation` supplies a concise evidence contract for alerts and
outages. It separates symptoms from causes, requires discriminating evidence
before claiming root cause, preserves read-only requests, and reports the
smallest safe fix with validation and rollback. Domain skills still define the
actual topology, commands, logs, configuration, and change procedure.

## Install

Node.js 22.19 or newer is required.

```sh
./install.sh
```

The installer pins Pi to `pi-version.txt`, removes every configured third-party
Pi package, retires every other global extension into a timestamped backup,
links the repository-owned extension and generic incident skill, and installs
the Protocol Ink Pi theme. It preserves authentication, sessions, models, and
all other skills.

Restart Pi or run `/reload` after updating the extension.

## Test

```sh
npm test
```
