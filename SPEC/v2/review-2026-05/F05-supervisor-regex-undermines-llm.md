# F05 — Supervisor regex post-processor undermines its own LLM verdict

**Category**: bad-design
**Severity**: medium
**Transversality**: module

## Summary

The runtime supervisor asks an LLM whether the system is stuck, then runs `normalizeNonStuckOperationalVerdict` over the same logs and the LLM's verdict. If the post-processor sees substrings such as "running", "throttling", or "capacity" in the logs it can flip a `stuck=true` verdict back to `stuck=false`. The supervisor therefore second-guesses the very intelligence it just paid for.

## Evidence

- Verdict flow: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L132-L156).
- Post-processor call: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L154).
- System prompt already instructs the LLM to apply those exact rules ("If the only clear issue is model-provider throttling … mark stuck=false"): [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L158-L168).

## Why this matters

Either the LLM is competent enough to follow the rules in its own prompt (in which case the regex pass is dead weight that just hides bugs) or it isn't (in which case using its verdict at all is questionable). Today, when the LLM correctly identifies a real stuck pattern that happens to mention "throttling" in passing, the regex pass quietly silences it. The supervisor's threshold of `consecutiveStuckVerdicts=3` is then never reached, and the abort that should have rescued the system never fires.

## Operator comment

You can just remove this agent.

## Related

- F04 (hardcoded supervisor model)
- F23 (supervisor priority is incomplete)
