# Constellation

A multiplayer educational game used as a transparent medium for cognitive development. The game is not the point. The meta-system layered on top is the point.

**The One Principle:** `argmax E[KL(posterior ‖ prior)]` — maximize expected information gain about the student's cognitive model per session. Every architectural decision derives from this.

**The architectural foundation:**
- Layer 0 (The Ledger): append-only raw observations. Config vectors, outcomes, signals. No interpretations stored.
- Layer 1 (Current Approximation): views derived from Layer 0. Every value has a refutation condition. Every formula will be replaced.

**Start here:** `philosophy development/INDEX.md` — maintained living index of all documents, their current accuracy, and what supersedes what.
