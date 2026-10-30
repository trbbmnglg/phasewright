---
type: llm
---

PASS if the metric card marks the baseline as TBD (or asks for it) and names how to measure it, and leaves the target to the owner (TBD, or a clearly labeled proposal for the owner to confirm). A guardrail metric or a pairing of a time measure with an error measure is a good sign.
FAIL if it states a numeric baseline or target as fact (for example "currently 3 hours", "reduce time by 50%") that the user did not give. Numbers offered only as examples inside a question pass.
