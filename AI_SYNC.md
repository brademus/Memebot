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
| READY FOR REVIEW | GPT-5.6 Thinking | `fix/btc-research-fallback-ai-sync` | Restore BTC research fallback when actionable portfolio admission rejects a selected candidate; establish shared AI coordination protocol | 2026-08-01T19:37:00Z | PR #94. All GitHub CI jobs and Vercel preview passed. Ready to merge; keep the new $20 actionable target policy intact. |

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

**Status:** READY FOR REVIEW  
**Branch:** `fix/btc-research-fallback-ai-sync`  
**Pull request:** #94 — `Restore BTC research fallback and add shared AI coordination ledger`  
**Implementation commits:** `7aa3b25e6822dcb75fe82aa0239500ec6daf7e89`, `f26976ea0bf3bf04b855c3e487a3ad9c2ed0be42` plus coordination/documentation commits on the same branch  
**Owner request:** Fix the BTC subsystem no longer producing calls, then create a durable coordination mechanism so ChatGPT and Claude read the same repository context before changes and document exact changes and rationale afterward.

**Observed behavior and evidence:**

- The latest actionable-policy change raised the standard projected net ROI floor from 6% to 20% and the planned-loss budget from $6 to $13 while stating that the research book was unchanged.
- Inspection of `src/btc/platform/engine.ts` found a separate orchestration flaw: `evaluateStrategies()` treated every candidate selected by `selectActionable()` as consumed before `armActionable()` performed portfolio and cooldown admission.
- `armActionable()` returned no admission result. Therefore, when portfolio limits or cooldown rejected a selected actionable candidate, its ID remained excluded from `researchPool`. The candidate was persisted as an actionable rejection but received no research fallback, disappearing from both call books.
- This flaw is capable of producing a silent call drought when high-ranked candidates repeatedly reach actionable selection but fail the later portfolio/cooldown gate. It is independent of strategy signal generation and does not justify weakening the new actionable profitability standard.

**Implemented repair:**

- `src/btc/platform/engine.ts`
  - Added the pure, testable `shouldEvaluateResearchFallback()` decision function.
  - Changed `armActionable()` from `Promise<void>` to `Promise<boolean>` so selection and actual portfolio admission are no longer conflated.
  - Tracks `admittedActionableIds`, not merely selected candidate IDs.
  - Sends selected-but-not-admitted candidates through the existing research risk, capacity, cooldown, fill-revalidation, and persistence path.
  - Continues excluding successfully armed actionable candidates and approved candidates rejected only as duplicate/conflicting selections, preventing duplicate exposure.
- `src/btc/platform/engine-research.test.ts`
  - Added regression cases for selected/actionable-rejected fallback, successfully admitted actionable exclusion, duplicate-selection exclusion, shadow eligibility, and actionable-risk-rejected eligibility.
- `AI_SYNC.md`
  - Added this authoritative append-only coordination ledger, Active Work Board, invariants, detailed engineering decision record, and conflict protocol.
- `AGENTS.md`
  - Directs ChatGPT/Codex-style agents to read and update `AI_SYNC.md` before and after work.
- `CLAUDE.md`
  - Directs Claude to read `AGENTS.md` and `AI_SYNC.md`, claim work, avoid overlap, and update the ledger.
- `.github/pull_request_template.md`
  - Adds verification and AI-coordination completion checks to future pull requests.

**Why this design:**

- It preserves the strict actionable policy and portfolio protections.
- It restores the intended two-book contract: actionable rejection is not automatically research rejection.
- It reuses the existing research risk solver and capacity controls rather than bypassing them.
- It prevents duplicate actionable/research exposure because successfully armed actionable IDs remain excluded.
- It makes the transition measurable and testable instead of loosening thresholds to manufacture activity.

**Alternatives rejected:**

- Lowering the 20% actionable ROI floor: rejected because it would violate the owner’s explicit profit target and would not fix the orchestration defect.
- Increasing research concurrency blindly: rejected because the defect occurs before capacity admission and higher limits could increase correlated exposure.
- Sending every actionable candidate to both books: rejected because it would duplicate exposure and contaminate research evidence with redundant calls.

**Verification completed:**

- PR diff: six focused files, 216 additions, seven deletions; no environment, credential, live-execution, strategy-threshold, or memecoin implementation changes.
- GitHub Actions run `30715416324`:
  - `build-and-test`: SUCCESS, including TypeScript build, full test manifest, BTC regime/strategy tests, BTC multistrategy registry/leverage tests, BTC Wave 2 tests, cross-asset tests, API proxy regressions, and dashboard JavaScript syntax.
  - `postgres-persistence`: SUCCESS, including real Postgres paper persistence, BTC safety contract, BTC multistrategy contract, BTC downloadable report contract, and append-only evidence journal contract.
- Vercel preview status: SUCCESS.
- PR #94 is mergeable with no branch divergence from the `main` base used for the repair.

**Deployment/config impact:**

- No new environment variables, API keys, migrations, credentials, signing, broadcasting, or live exchange execution.
- Merging to `main` should trigger the normal deployment pipeline. The code change affects only BTC candidate book routing and repository coordination documentation.

**Interaction with earlier work:**

- Preserves commit `0f9137160173918383ee3d391fd66495c3e90909` and its $20 projected actionable-profit goal.
- Does not alter the research risk solver, research concurrency limits, strategy cooldown durations, strategy versions, or promotion evidence thresholds.
- Does not touch the separate Helius/PumpPortal discovery work.

**Known risks and follow-up:**

- A live drought can also be caused by unhealthy market feeds, stale active calls consuming research capacity, or all candidates legitimately failing research geometry. This repair addresses the confirmed suppression path; production status and rejection diagnostics should still be checked after deployment.
- Aggregate scan diagnostics by rejection reason would make future droughts faster to distinguish and should be considered as a separate coordinated change after this repair is measured.

**Next action:** Merge PR #94, allow the normal deployment, then confirm production BTC feed health and observe whether qualifying selected-but-actionable-rejected candidates resume entering the research book.
