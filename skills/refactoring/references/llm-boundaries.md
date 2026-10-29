# Verifying LLM boundaries

Read this when a refactor touches code that builds model requests or parses model responses. It expands section 5 of [SKILL.md](../SKILL.md).

## Behavior-preserving prompt/request extraction

1. Capture a sanitized input corpus using approved data handling. Remove secrets and sensitive content; do not upload production data to external tools.
2. Supplement the corpus with explicit cases for empty/long history, truncation thresholds, optional context, enabled tools, and supported message combinations.
3. Compare baseline and refactored complete provider requests across the corpus and boundary cases: messages, roles, ordering, whitespace, model/settings, tool schemas, and structured-output configuration.
4. Compare serialized bytes when stable serialization is part of the contract. Otherwise compare canonical structures without discarding meaningful differences such as message ordering or prompt whitespace.
5. Test parsing and error handling against recorded or mocked provider responses.
6. Verify streaming, cancellation, timeouts, retries, fallbacks, and invocation ordering separately where affected; request snapshots do not cover these.

Do not require a new model-quality evaluation run solely for extraction when complete request equivalence and unchanged surrounding execution behavior are established. State the limits of the tested corpus; do not claim universal equivalence from sampled inputs.

## Intentional changes

For intentional prompt, model, parameter, tool-contract, or provider changes, use semantic-risk classification. Establish a representative evaluation set and acceptance criteria before editing. If evaluations are unavailable, report the verification gap and block merge readiness rather than claiming behavior preservation.
