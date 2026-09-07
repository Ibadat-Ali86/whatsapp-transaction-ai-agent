# `.agent/` — AI Agent Governance Directory

## Purpose

This directory is the **control centre for all AI coding agents** working on this repository.

It contains the mandatory documents that every agent must read before inspecting or modifying any code. The files in this directory govern:

- What the agent is allowed to do
- What the agent is forbidden to do
- The current project state and context
- Persistent architectural memory
- The change-control policy

**No agent may skip this directory.**

---

## Mandatory Reading Order

Every AI coding agent must read these files **in order** before performing any task:

```
1. AGENT_INSTRUCTIONS.md   ← Role, core rules, forbidden behavior, change protocol
2. PROJECT_CONTEXT.md      ← Project purpose, architecture, current phase, constraints
3. CHAT_MEMORY.md          ← Persistent decisions, confirmed progress, open questions
4. docs/PRD.md             ← Product requirements (source of truth for what to build)
5. docs/SYSTEM_ARCHITECTURE.md  ← Architecture and component boundaries
6. docs/TECHNICAL_SPEC.md  ← Technology stack, data contracts, error model
7. docs/PHASE_PLAN.md      ← Which phase is active; what is in scope vs out of scope
8. docs/SECURITY.md        ← Security and privacy rules (non-negotiable)
9. CHANGE_CONTROL.md       ← How to record and classify every significant change
10. Relevant phase docs    ← e.g., docs/OCR_SPEC.md for Phase 1 work
```

Then inspect the relevant source code **only after** reading the above.

---

## File Descriptions

### `AGENT_INSTRUCTIONS.md`
The primary system-level instruction document. Defines the agent's role, the 10 core rules, forbidden behavior, the change protocol, and the definition of done.

**Always read first.**

### `PROJECT_CONTEXT.md`
Concise authoritative context: project purpose, client, functional baseline, current phase, owner-approved deviations from the original specification, and what is NOT currently enabled.

### `CHAT_MEMORY.md`
Persistent project memory. Tracks confirmed decisions, current state, active objectives, and known blockers. Agents must update this file when new durable decisions are made.

**Never overwrite with temporary assumptions.**

### `CHANGE_CONTROL.md`
Policy governing how agents must classify, document, and record every significant change. Defines change classes C0–C5. Agents must not perform C4 (production credentials/data) or C5 (production deployment) actions without explicit human authorization.

---

## How These Documents Interact

```
AGENT_INSTRUCTIONS.md   ←— tells the agent HOW to work
       +
PROJECT_CONTEXT.md      ←— tells the agent WHAT the project is
       +
CHAT_MEMORY.md          ←— tells the agent WHERE the project stands NOW
       +
CHANGE_CONTROL.md       ←— tells the agent HOW to record changes safely
       +
/docs/ specification files ←— tell the agent WHAT to build and HOW
```

All of the above together form the **source of truth** for any agent task.

---

## Governance Rules

1. **Documentation is the source of truth.** If the code contradicts a document, that is a bug to fix — not a reason to silently update the document.
2. **Agents must not make architectural changes silently.** Every significant change must be logged in `CHANGE_CONTROL.md` with the correct change class.
3. **Agents must not invent requirements.** If a requirement is missing or ambiguous, mark it `UNKNOWN` and surface it — never decide silently.
4. **Agents must not fabricate test results.** A passing test must actually pass on real infrastructure, not be commented out or weakened.
5. **Agents must not commit secrets.** `.env`, WhatsApp session data, and API credentials must never enter the Git index.
