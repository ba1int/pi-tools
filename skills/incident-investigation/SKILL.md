---
name: incident-investigation
description: Evidence-driven diagnosis of operational alerts, incidents, outages, failed checks, and degraded services. Use when asked to investigate, troubleshoot, determine root cause, or recommend a fix for a system or application problem, especially across remote hosts.
---

# Incident Investigation

Preserve the user's requested operating mode. Treat investigate, inspect, report, and read-only requests as non-mutating. Apply a fix only when the user explicitly asks for the change.

## Evidence contract

- Separate **symptom**, **failure mechanism**, and **root cause**.
- Treat alerts, health states, failed checks, and error messages as symptoms until causal evidence connects them to a fault.
- Load and follow matching domain skills for topology, authoritative commands, configuration, logs, validation, and rollback.
- Label an unproven explanation as a hypothesis with confidence; do not promote it to root cause.

Claim root cause only when the evidence establishes:

1. the faulty condition directly;
2. a mechanism that explains the observed symptom;
3. a discriminating or counterfactual test, when practical; and
4. no material contradictory evidence.

## Investigation loop

1. Confirm the exact target, impact, and authoritative failing check.
2. Read the relevant domain skill before rediscovering paths or topology.
3. Form one to three plausible hypotheses.
4. Choose the smallest read-only tests that distinguish those hypotheses. Prefer canonical logs, configuration, runtime state, and dependency probes over broad inventories or source-code archaeology.
5. When rendered configuration looks correct but behavior disagrees, inspect exact bytes and test the parsed value against the intended literal value.
6. After several remote calls without narrowing the cause, stop and reassess the hypotheses before collecting more data.
7. Stop investigating when the evidence contract is satisfied; do not gather redundant proof.

## Fixes

Recommend the smallest change that removes the cause rather than suppressing the symptom. Never propose clearing a health flag, deleting an alert, or forcing an OK state as a root-cause fix.

When explicitly authorized to implement a fix, follow the domain runbook, validate the result through the original failing check, and preserve a concrete rollback path.

## Report

Return:

- impact and observed symptom;
- root cause with confidence, or remaining hypotheses if unproven;
- direct supporting evidence and meaningful contradictory evidence;
- smallest safe fix;
- validation and rollback steps; and
- an explicit statement of whether any changes were made.
