# CHANGE CONTROL — Agent Policy & Log

## Purpose

This document serves two functions:

1. **Policy**: Establishes how AI coding agents must classify and record every significant change.
2. **Log**: Acts as the active change register for this project.

Reference: `docs/CHANGE_CONTROL.md` contains the governing policy rules. This file is the agent-facing operational log.

---

## Change Classification

| Class | Scope | Agent Authority |
|-------|-------|-----------------|
| **C0** | Documentation only | Permitted |
| **C1** | Local non-production code | Permitted; requires tests |
| **C2** | Workflow / integration | Permitted; requires integration tests |
| **C3** | Security / configuration changes | Permitted with security review |
| **C4** | Production credentials / data | **Requires explicit human approval** |
| **C5** | Production deployment | **Requires release checklist + rollback plan + human approval** |

**AI agents must not perform C4 or C5 actions without explicit written authorization from the project owner.**

---

## Required Change Record Format

Every significant change (C1 and above) must be appended to the log below using this template:

```
## CC-XXXX — [Short Title]

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-XXXX |
| **Date**           | YYYY-MM-DD |
| **Class**          | C0 / C1 / C2 / C3 / C4 / C5 |
| **Agent**          | [Agent name/session ID] |
| **Requested by**   | [Human or task reference] |
| **Phase**          | Phase N |
| **Reason**         | [Why this change was made] |
| **Requirement**    | [PRD/spec reference, e.g., FR-004] |
| **Files changed**  | [List of files] |
| **Behavior changed** | [What changed functionally] |
| **Security impact** | None / [description] |
| **Data impact**    | None / [description] |
| **Tests run**      | [Test names / commands / results] |
| **Rollback**       | [How to revert] |
| **Documentation updated** | Yes / No / [which files] |
| **Status**         | COMPLETE / IN-PROGRESS / BLOCKED |
```

---

## Forbidden Shortcuts

Per `docs/CHANGE_CONTROL.md`, agents must **never**:

- Comment out failing tests to make the build pass
- Weaken validation logic to make tests pass
- Hard-code secrets in any file
- Delete logs or test output to hide failures
- Silently change business rules (e.g., verdict thresholds, money-matching logic)
- Bypass payment verification logic
- Make destructive Git operations (`git push --force`, `git reset --hard` on shared branches) without explicit authorization

---

## Change Log

<!-- Append new change records below this line. Most recent first. -->

### CC-0001 — Architecture Initialization

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-0001 |
| **Date**           | 2026-09-07 |
| **Class**          | C0 |
| **Agent**          | Antigravity (initialization task) |
| **Requested by**   | Project owner |
| **Phase**          | Phase 0 |
| **Reason**         | Establish repository skeleton, agent governance, and directory structure per the initialization prompt. |
| **Requirement**    | Phase 0 exit criteria: repository initialized, .agent instructions installed, .env.example created, .gitignore created, test framework initialized |
| **Files changed**  | `.gitignore`, `.env.example`, `.agent/README.md`, `.agent/CHANGE_CONTROL.md`, `n8n/README.md`, `src/*/gitkeep`, `tests/*/gitkeep`, `scripts/.gitkeep` |
| **Behavior changed** | No application behavior — initialization only |
| **Security impact** | `.gitignore` now protects secrets, WhatsApp session data, and credential files from VCS |
| **Data impact**    | None |
| **Tests run**      | Pre-commit git inspection: no secrets staged |
| **Rollback**       | `git revert HEAD` or delete the repository |
| **Documentation updated** | Yes — `.agent/README.md` upgraded from stub |
| **Status**         | COMPLETE |
