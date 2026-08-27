# Deprecated: Sol Max Build Prompt

This file is retained only so old links do not send the project down the wrong workflow.

## Current ownership model

**Sol Max is planning-only. Grok 4.6 xhigh Fast is the primary implementation agent.**

Do not use Sol Max to broadly implement this repository under the current workflow.

### Step 1 — Sol Max

Use:

`SOL_MAX_PLAN_ONLY_PROMPT.md`

Sol Max must inspect the repository and create/update:

`plans/IMPLEMENTATION_PLAN.md`

Then Sol Max stops and hands the plan off.

### Step 2 — Grok

Use:

`GROK_46_XHIGH_FAST_BUILD_PROMPT.md`

Configure Grok as:

- model: Grok 4.6;
- reasoning: `xhigh`;
- Fast variant when available in the current UI/platform.

Grok then implements the Sol Max plan phase-by-phase, adds tests/replay coverage, fixes failures, updates implementation state, and commits completed phases.

### Bootstrap

For the complete workflow, start with:

`GROK_BOT_START_HERE.md`
