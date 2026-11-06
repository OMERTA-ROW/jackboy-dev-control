# CODE gateway model choice and price value

No code, CODE switch, Emergency Stop or publishing changes. No paid calls.

## Chosen model: gpt-6-luna

Cheapest current (not deprecated) OpenAI model that supports the Responses endpoint the coding workflow uses. gpt-5-nano is cheaper but marked Deprecated, so it was skipped.

Published by OpenAI (checked Nov 6, 2026):
- Context window 1,050,000; maximum input 922,000 tokens; maximum output 128,000.
- $0.10 input / $0.50 output per million tokens, but prompts over 272K input tokens cost 2x input and 1.5x output for the whole request: $0.20 / $0.75.

The gateway uses one price per model and reserves the full input window, so the long-prompt rates are the safe ones to enter.

## Ready-to-paste CODE_GATEWAY_PRICES

```
{"gpt-6-luna":{"inputPerMillionUsd":0.2,"outputPerMillionUsd":0.75,"maxInputTokens":922000,"maxOutputTokens":128000}}
```

Worst-case reservation per call: 922,000 x $0.20/M = $0.1844, plus 128,000 x $0.75/M = $0.096, total about $0.28. That is under the $0.50 cap, so output did not need lowering.

CODE_GATEWAY_PER_CALL_CAP_USD: `0.50`

## Does the workflow need the model name set? Yes

The coding workflow step does not choose a model today, so OpenAI's coding tool sends its own default name. The gateway refuses any model not in the price table, so every call would be refused until the workflow names `gpt-6-luna`. The coding step supports a `model` setting for this.

Setting it is a workflow change. Under the safety rules that means:
1. A reviewed pull request adding `model: gpt-6-luna` to the Codex step in the CODE workflow.
2. Your merge approval.
3. Re-syncing the pinned workflow version in both `CODE_TARGETS` and the database allowlist (owner-approved, audited), because the pin changes when the workflow file changes.

## Things to know

- Each task has a $1.00 budget. At about $0.28 reserved per call, only about three model calls fit in one task; a multi-step coding run may stop early. Raising the per-task amount is a separate decision.
- Whether gpt-6-luna is good enough at coding for real tasks has not been tested.
- Activation stays BLOCKED (database access from Railway, total $10 guard).

## Proposed next step (after approval)

Prepare the one-line workflow pull request as a draft for your review. No merge, no allowlist change, no CODE activation without separate approval.
