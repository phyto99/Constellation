# Constellation — Development Context

## What this project is

A multiplayer educational game (Constellation) that serves as the medium for a cognitive development meta-system. The game is not the point. The system layered on top — session selection, observation recording, student modeling — is the point. Every architectural decision is filtered through: does this maximize expected information gain about the student's cognitive model per session?

## Read these documents first, in this order

| Priority | File | What it is |
|----------|------|-----------|
| 1 | `philosophy development/evidence-engine.html` | The doctrine. Ledger vs State, axioms, channels, gap signal. Overrides everything older. |
| 2 | `philosophy development/layer-0-ledger.html` | Layer 0 prototype (live). Raw observation schema, config vector, permanence axioms. |
| 3 | `philosophy development/layer-1-approximation.html` | Layer 1 prototype (live). Current approximation — Elo, velocity, gap, provenance. |
| 4 | `philosophy development/configuration-architecture.html` | The compiler. Every game setting as a cognitive lever. Settings optimizer. |
| 5 | `philosophy development/SYNTHESIS.html` | Written philosophy. Alignment, singularity trajectory, multi-audience. |

The above 5 are authoritative. Everything else is context or archive.

## Do NOT use these for architecture decisions

These are Era 1-2 documents. They contain correct intuitions but wrong details (wrong variable set, segmented template architecture, static formulas presented as final). Reading them for architecture will introduce stale assumptions silently.

- `philosophy development/challenge-meta.html` — template library is UX scaffolding only; do not treat as architectural categories
- `philosophy development/system-viz.html` — contains `global_elo`, `same_mode_streak` — both excluded by Era 3 variable audit
- `philosophy development/system-complete.html` — superseded by evidence-engine.html
- `philosophy development/development-diagram.html` — missing elo_velocity and sessions_since
- `philosophy development/entropy-architecture.html` — philosophically correct, variable set wrong
- `philosophy development/perfect-system.html` — superseded by Layer 0/1 prototypes

Safe to read for historical context. Not safe to use as implementation reference.

## Core doctrine — do not re-derive these from older files

**The One Principle:** `argmax E[KL(posterior ‖ prior)]` — maximize expected information gain per session. Every decision derives from this.

**The Ledger axiom:** Record observations, not interpretations. Categories are views, not containers. The Ledger has no `mode` field — mode is derived from the config vector as a Layer 1 view.

**Layer 0 / Layer 1 distinction:**
- Layer 0 = append-only raw records: `{config_vector[12], outcome, signals, timestamp}`. Never modified. No mode label.
- Layer 1 = current approximation views over Layer 0: `mode_elo[6]`, velocity, gap signal. Every value is ASSERTED with a refutation condition. Every formula will be replaced in Phase 3.

**Non-segmenting:** The config space is 12-dimensional and continuous. Mode labels (QTY/SPT/FRT/DST/WRM/INV) are human-legible names for regions of that space, derived from the config vector. They are not architectural units.

**Every parameter is a hypothesis:** No formula is final. Every value carries `[ASSERTED]` or `[LEARNED n=X]` status. Refutation conditions are pre-registered. Phase 3 replaces all asserted values with fitted values from the Ledger.

**The compiler controls all settings:** The admin panel does not configure sessions — the compiler does. It outputs a complete 12-parameter config vector. Teachers observe and may override. Every parameter is a cognitive lever.

**Gap signal:** `game_elo[m] − transfer_elo[m]`. Positive = game skill ahead of cognitive development. Wide gap triggers INVERSION, template rotation, de-prioritization of ECHO. Requires BT integration.

## The 6 cognitive modes (multiplier regions)

| Mode | Config signal | Cognitive target |
|------|--------------|-----------------|
| QTY | count_mult dominates | Volume decision under time pressure |
| SPT | dist_mult dominates | Euclidean optimization under constraint |
| FRT | hq_mult dominates, dest_mult negative | Graph connectivity, multi-step planning |
| DST | dest_mult dominates (positive) | Inhibitory control, opponent modeling |
| WRM | all mults < 10 (wormhole win condition) | Goal-directed search under noise |
| INV | any mult < 0 | Reversal learning, cognitive flexibility |

## Open questions — current status

| Q | Problem | Status |
|---|---------|--------|
| Q1 | game_elo ≠ cognitive skill | Partially addressed: gap signal in Layer 1 prototype. Needs BT bridge. |
| Q2 | Announced INVERSION = contaminated signal | Specified: `overlay_announced: false` flag in server.js. Not yet implemented. |
| Q3 | Modes not orthogonal | Unresolved. Needs covariance model. |
| Q4 | Forgetting τ=14d wrong domain | Labeled ASSERTED. Will refute when return-Elo data exists. |
| Q5 | Social dimension absent | Record in TEACHER+GAME channels; scope from evidence. |
| Q6 | All parameters asserted | Addressed in Layer 1 prototype: all values labeled with refutation conditions. |
| Q7 | Gifted track incomplete | Partially specified. Needs controlled cohort. |
| Q8 | brain_metrics excluded until BT | Phase 2 item. Record now, include when BT validated. |

## What is implemented vs specified

| Component | Status |
|-----------|--------|
| Constellation game (multiplayer, bots, maps) | **IMPLEMENTED** |
| BT brain training system | **IMPLEMENTED** (separate folder) |
| Admin panel (manual session configuration) | **IMPLEMENTED** |
| Layer 0 Ledger (observation recording) | **SPECIFIED** — needs server.js additions |
| Round-by-round score snapshots | **SPECIFIED** — Phase −1 server.js edit |
| Move timestamps | **SPECIFIED** — Phase −1 server.js edit |
| Silent INVERSION flag | **SPECIFIED** — Phase 0 server.js edit |
| Layer 1 State derivation | **PROTOTYPE** (mock data) — needs real implementation |
| Session compiler | **SPECIFIED** — needs implementation |
| Terminal delivery | **SPECIFIED** — Phase 1 |
| Student Observatory | **PROTOTYPE** (simulated data) |
| BT → game bridge | **SPECIFIED** — Phase 2 |

## Build order

**Phase −1 (do before any students):** Add round snapshots, move timestamps, session timestamps to server.js. Write Observation records to Ledger on game_ended. Derive initial State from Ledger. Implement compiler v1 (mode selection + config output).

**Phase 0:** Silent INVERSION flag. Wormhole proximity tracking. Black hole chain detection. BT data bridge.

**Phase 1:** Terminal delivery (session_terminal Colyseus message). Student Observatory wired to live Ledger. Alpha track.

**Phase 2:** BT integration live. Gap signal drives session selection. brain_metrics → CORE.

**Phase 3:** Replace all [ASSERTED] parameters with fitted values from Ledger history.

## Key files for implementation

| File | Role |
|------|------|
| `server.js` | Colyseus rooms. Add Ledger writes here. |
| `index.html` | Game client (~9960 lines). Add terminal receiver, move timestamps. |
| `admin.html` | Admin panel. Compiler output displays here. |
| `game-registry.js` | Settings schema. Source of truth for all game parameters. |
| `GAME_INTEGRATION.md` | Authoritative checklist for adding new games. |
| `TODO.md` | Two pending game features (randomized wormhole req — feeds directly into THE GATEWAY archetype). |

## What to never do

- Do not use `global_elo` — derivable from mode_elo[6], zero independent information
- Do not use `same_mode_streak` — derivable from session history
- Do not add mode labels to Layer 0 records — mode is a view, not a field
- Do not treat template names as architectural categories — they are UX labels for config regions
- Do not write static formulas without [ASSERTED] markers and refutation conditions
- Do not configure sessions manually for students on the system — the compiler does this
