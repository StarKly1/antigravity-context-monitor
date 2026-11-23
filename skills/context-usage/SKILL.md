---
name: context-usage
description: >-
  Check the current conversation's context window size, token usage, cache hit
  rate, and per-step growth from transcript.jsonl. Use when the user asks how
  big their context is, how many tokens they've used, or whether they should
  run /compact.
---

# Context Usage Breakdown

When the user asks for their current chat's context window size or token usage:

1. Run the bundled Node.js helper script (located at `scripts/context_status.mjs` inside this plugin's directory, e.g. `~/.gemini/config/plugins/context-monitor/scripts/context_status.mjs`) against the current conversation's `transcript.jsonl` (`<Artifact Directory Path>/.system_generated/logs/transcript.jsonl`):

   ```bash
   node ~/.gemini/config/plugins/context-monitor/scripts/context_status.mjs --detailed --transcript "<transcriptPath>"
   ```

2. Present a concise summary to the user including:
   - **Current context size** (`currentContextTotal` = uncached input + cache read tokens)
   - **Cache breakdown** (`cacheReadTokens`, `uncachedInputTokens`, `cacheHitPercent`%)
   - **Output tokens** (last call and cumulative)
   - **Activity** (user turns and total model calls)
   - **Recent growth** (a compact table of the last few model calls from `recentSteps`)
   - Recommend `/compact` if `compactSuggested` is `true` (over 120k tokens).
