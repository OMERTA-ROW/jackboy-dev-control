# CODE spending acceptance review

Scope: Foundry eec6dc53-ca22-4145-a9aa-499c281e45ad. Draft engineering only.

The current adapter cannot prove a strict $5 UTC-day cap for the actual runner credential. Migration 0037 already constrains provider_hard_cap_verified to false and blocks atomic runtime-slot claims; preserve that constraint. No migration or production control is changed here.

OpenAI documentation checked 2026-11-03: https://developers.openai.com/api/docs/guides/spend-limits describes monthly organization/project hard limits, with non-instantaneous enforcement and possible overrun. This is not evidence of a strict daily ceiling. Account configuration and actual runner project/key association remain unverified. Reporting timestamps and daily cost buckets cannot prove contemporaneous remaining balance or reserve future execution cost.

Fixes reject negative/nonfinite spend, previous-UTC-day or future/stale usage and duplicate final-bucket entries. Existing tests cover project/key mismatch, exhausted budget, missing metering and concurrent database slots. Concurrency success fixtures deliberately remove the database hard-cap constraint in an isolated test database; they are not activation evidence.

Safe alternatives require a separate reviewed design: an exclusive credential-bound admission proxy with atomic worst-case reservations and bounded requests, or a provider contract offering strict daily enforcement. Neither exists in this change. Do not reset monthly limits daily or mark reporting-only data authoritative.

Before activation: independently verify production migration state, exact credential/project association, complete fresh metering, enforceable spend policy, owner/session claims, scheduler/worker inventory, isolated runner privileges and durable audit evidence. Obtain separate owner approval for deployment and any supervised paid test. Keep Emergency Stop engaged and all autonomy off. No provider call or paid CODE test was made.
