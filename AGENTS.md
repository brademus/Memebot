# AI Agent Instructions

These instructions apply to every AI-assisted change in this repository.

## Shared coordination source

MemeBot HQ in Notion is the authoritative cross-assistant and cross-functional coordination system:

https://app.notion.com/p/3afd9c80c46c8196b456ff99c6907d1f

Before analyzing, planning, or modifying the repository:

1. Use the Notion connector to fetch **MemeBot HQ**.
2. Read **AI Collaboration Protocol** and **Current Project State** completely.
3. Review active **Projects**, active **Tasks**, recent **AI Work Log** entries, and accepted or unresolved **Decisions** relevant to the request.
4. Inspect current repository state, recent commits, and open pull requests. GitHub, tests, deployment configuration, and measured production telemetry remain authoritative for technical facts.
5. Check whether another agent already owns, attempted, or completed overlapping work.
6. Create or update the relevant Notion Task and claim the work in the AI Work Log before substantive implementation.
7. Use a focused branch and pull request unless Braden explicitly directs otherwise.
8. After the change, update Notion in the same work session with the exact behavior and files changed, goal, engineering rationale, verification, deployment/configuration impact, risks, interaction with prior work, and next action.
9. Update related Projects, Tasks, Decisions, Knowledge Base records, Marketing records, or Growth Experiments when the change affects them.
10. Preserve paper/alert-only and other accepted safety boundaries unless Braden explicitly supersedes them through a recorded decision.

Do not silently duplicate, contradict, or reverse another agent's work. If repository evidence conflicts with Notion, use the current code and measured evidence as the technical truth, then correct Notion.

If the Notion connector is unavailable, do not begin a substantive AI-assisted change unless Braden explicitly authorizes an emergency exception. Record the missing synchronization step as soon as access is restored.

`AI_SYNC.md` is retained only as a migration pointer and is not the active ledger.
