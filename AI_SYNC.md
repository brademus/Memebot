# Memebot AI Coordination Ledger

This file is the authoritative coordination record for every AI-assisted repository change.

## Mandatory protocol

### Before changing code

Every AI agent must:

1. Read this file completely, including the newest change entries and the Active Work Board.
2. Inspect the current target branch, recent commits, and open pull requests before assuming repository state.
3. Check whether another agent already owns, attempted, or completed overlapping work.
4. Add or update an Active Work Board item before making a substantive change.
5. Preserve existing safety boundaries unless the owner explicitly changes them. In particular, Memebot remains paper/alert-only unless an explicit owner directive says otherwise.
6. Prefer a focused branch and pull request over unrelated direct changes to `main`.
7. Do not duplicate an existing implementation under a different name. Extend, repair, or supersede it explicitly.

### After changing code

Every AI agent must update this file in the same branch/PR with:

- UTC timestamp
- agent/model name
- branch and PR/commit references
- owner request being addressed
- exact files and behavior changed
- engineering rationale and intended outcome
- tests or verification performed and their results
- deployment/configuration impact
- known risks, assumptions, and unresolved questions
- interaction with earlier work, including anything superseded or intentionally left unchanged
- next recommended action

The reasoning recorded here should be a detailed engineering decision record: evidence, constraints, alternatives considered, and why the chosen design is preferred. Do not include private hidden chain-of-thought or credentials.

### Conflict rules

- Repository state and measured production evidence outrank stale notes.
- A newer entry may supersede an older decision, but it must name the superseded entry and explain why.
- Never silently reverse another agent's work.
- If two branches overlap, pause implementation, compare the diffs, and consolidate deliberately.
- If this file was not updated, the AI-assisted change is incomplete.

## Active Work Board

| Status | Owner | Branch | Scope | Started (UTC) | Notes |
|---|---|---|---|---|---|
| IN PROGRESS | GPT-5.6 Thinking | `fix/btc-research-fallback-ai-sync` | Restore BTC research fallback when actionable portfolio admission rejects a selected candidate; establish shared AI coordination protocol | 2026-08-01T19:37:00Z | Keep the new $20 actionable target policy intact. Add regression coverage and verify CI before merge. |

Allowed statuses: `PLANNED`, `IN PROGRESS`, `BLOCKED`, `READY FOR REVIEW`, `MERGED`, `ABANDONED`.

## Current system invariants

- BTC execution is paper-only; no signing, broadcasting, exchange credentials, or live order execution may be introduced incidentally.
- Actionable BTC calls and research BTC calls are separate books with separate admission logic and P&L reporting.
- Actionable strategy promotion remains version-specific and evidence-gated.
- Research calls are intentionally allowed to collect evidence when a candidate is not eligible for the actionable book, subject to research risk, concurrency, cooldown, and data-quality rules.
- The 2026-08-01 owner directive targets at least $20 projected net profit per $100 margin for actionable BTC calls. The standard actionable ROI floor is 20%; this does not authorize suppressing otherwise valid research observations.
- Strategy versions and historical results are immutable evidence cohorts; do not rewrite old calls to make newer logic look better.

## Change log

### 2026-08-01T19:37:00Z — GPT-5.6 Thinking — BTC research fallback and multi-agent synchronization

**Status:** IN PROGRESS  
**Branch:** `fix/btc-research-fallback-ai-sync`  
**Owner request:** Fix the BTC subsystem no longer producing calls, then create a durable coordination mechanism so ChatGPT and Claude read the same repository context before changes and document exact changes and rationale afterward.

**Observed behavior and evidence:**

- The latest actionable-policy change raised the standard projected net ROI floor from 6% to 20% and the planned-loss budget from $6 to $13 while stating that the research book was unchanged.
- Inspection of `src/btc/platform/engine.ts` found a separate orchestration flaw: `evaluateStrategies()` treated every candidate selected by `selectActionable()` as consumed before `armActionable()` performed portfolio and cooldown admission.
- `armActionable()` returned no admission result. Therefore, when portfolio limits or cooldown rejected a selected actionable candidate, its ID remained excluded from `researchPool`. The candidate was persisted as an actionable rejection but received no research fallback, disappearing from both call books.
- This flaw is capable of producing a silent call drought when high-ranked candidates repeatedly reach actionable selection but fail the later portfolio/cooldown gate. It is independent of strategy signal generation and does not justify weakening the new actionable profitability standard.

**Chosen repair:**

- Make actionable arming report whether the candidate was actually admitted.
- Exclude only successfully armed actionable candidate IDs from the research pool.
- Route selected-but-not-admitted candidates through the existing research risk, capacity, cooldown, fill, and persistence path.
- Add regression coverage that distinguishes "selected" from "admitted" and proves an actionable admission rejection remains eligible for research fallback.

**Why this design:**

- It preserves the strict actionable policy and portfolio protections.
- It restores the original two-book contract: actionable rejection is not automatically research rejection.
- It reuses the existing research risk solver and capacity controls rather than bypassing them.
- It prevents duplicate actionable/research exposure because successfully armed actionable IDs remain excluded.
- It makes the transition measurable and testable instead of loosening thresholds to manufacture activity.

**Alternatives rejected:**

- Lowering the 20% actionable ROI floor: rejected because it would violate the owner’s explicit profit target and would not fix the orchestration defect.
- Increasing research concurrency blindly: rejected because the defect occurs before capacity admission and higher limits could increase correlated exposure.
- Sending every actionable candidate to both books: rejected because it would duplicate exposure and contaminate research evidence with redundant calls.

**Planned verification:**

- Add focused unit/regression coverage.
- Run the repository test suite through CI on the pull request.
- Confirm the diff contains no execution-enablement or credential changes.
- After deployment, verify BTC status shows scanning/healthy feeds and that selected-but-actionable-rejected candidates can create research decisions/calls when they pass research gates.

**Deployment/config impact:** None expected. No new environment variables or credentials.

**Risks and follow-up:**

- A live drought can also be caused by unhealthy market feeds, stale active calls consuming research capacity, or all candidates legitimately failing research geometry. The code repair addresses the confirmed suppression path; production status and rejection diagnostics should still be checked after deployment.
- Consider adding aggregate scan diagnostics by rejection reason in a separate, coordinated change after this repair is measured.
