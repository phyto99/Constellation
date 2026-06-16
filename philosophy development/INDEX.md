# Philosophy Development — Document Index

Created: 2026-06-10  
Purpose: Reference index for all philosophy/architecture documents. Do not modify this index to reorganize; add new entries at the bottom under the correct era.

---

## Archive — Original Game Design Documents
*These are the source documents. Do not modify. They define the game's built-in philosophy.*

| File | What it is | Accuracy now | Accuracy after BT |
|------|-----------|-------------|------------------|
| `DESIGN_PHILOSOPHY.md` | The original written philosophy behind challenge-meta.html and system-viz.html. B&W design language, instrument philosophy, earned exceptions. | **100% — canonical** | 100% — timeless |
| `challenge-meta.html` | The Challenge Compiler: 6-layer pipeline, 14 templates across all modes, similarity spectrum (REMATCH→RADICAL), session generator, codename vocabulary, loading sequence structure, game plugin interface. | **100% — implemented** | 100% — foundation |
| `system-viz.html` | The Entropy Framework: 6 cognitive modes, player profile schema, entropy engine (Latin hypercube), scoring formula, Centauri mechanics, bot archetypes, session validity, team composer. | **100% — implemented** | 100% — foundation |

---

## Era 1 — System Architecture Development
*Built during initial philosophy refinement. Correct direction, some components superseded by later documents.*

| File | What it is | Accuracy now | Superseded by |
|------|-----------|-------------|--------------|
| `development-diagram.html` | Interactive diagram: development priority formula, template depth ranking, spectrum matrix, overlay gate. B&W + mode colors. First visual synthesis. | **85%** — correct architecture, missing elo_velocity and sessions_since_last | system-complete.html |
| `entropy-architecture.html` | The unified entropy principle: mutual information loop animation, information gain curve per mode, derivation table (layers → one principle), self-similarity concept. | **90%** — philosophically complete, variable set not yet corrected | system-complete.html + system-map.html |
| `perfect-system.html` | The variable audit (what to include/exclude), 3-layer architecture, minimum sufficient state, self-similarity diagram. First formal specification. | **90%** — correct, adds elo_velocity and sessions_since_last, missing BT bridge | system-map.html |

---

## Era 2 — Student Experience & Synthesis
*Current working documents. These are the most accurate and complete.*

| File | What it is | Accuracy now | Future gaps |
|------|-----------|-------------|------------|
| `system-complete.html` | Combined system: variable audit scatter, 3-layer diagram, information gain curves, mutual information loop (animated), terminal demo with zone-name messages, message library. | **92%** — complete architecture, Q1/Q2 not yet flagged visually | Add gap signal when BT available |
| `SYNTHESIS.html` | Complete written philosophy: alignment (never about winning the game), transparent medium, singularity trajectory (consumer→architect), design challenge system, multi-audience architecture, multi-game framework, 18 unwritten insights. | **95%** — the most complete written document | Add social dimension section |
| `alpha-system.html` | Alpha application system: zone name terminal previews (ECHO/RADICAL/PARALLEL/SHIFTING/REMATCH), detective framework (5-phase analysis), application form, mystery calibration (3 layers). | **95%** — fully designed, ready to implement | Implement in admin panel |
| `system-map.html` | Open questions map: orbital confidence diagram, 8 open questions (Q1–Q8), BT bridge architecture, confidence levels (confident/amber/red/blue/purple), build order. | **95%** — the most honest current document | Update as questions resolve |

---

## Era 3 — Evidence Architecture & The Observatory
*The measurement layer. Resolves the categorization problem permanently and prototypes the admin instrument.*

| File | What it is | Accuracy now | Future gaps |
|------|-----------|-------------|------------|
| `evidence-engine.html` | The Evidence Axiom (record observations, not interpretations; categories are views, not containers), Ledger vs State distinction (two inclusion criteria), 8 validation channels tracked simultaneously, generalized gap signal, Conundrum Protocol (5-step boundary-case lifecycle), Parameter Registry with pre-registered refutation conditions, Reaction Library (cognitive chemistry record). | **95% — doctrine complete** | Storage implementation; mint-threshold (5) is itself ASSERTED |
| `student-observatory.html` | Working prototype of the student admin panel: identity strip with trajectory stages, radar with velocity/staleness, mode signal table with purity flags, zone trajectory strip, per-student corroboration matrix with witness counts, evidence feed with provenance, boundary-case inbox, Layer-3 compiler preview, dual-view terminal (student render + per-line provenance) with loading-screen transform. 4 simulated students spanning all audience tiers. | **90% — fully designed, simulated data** | Wire to live ledger; admin.html integration |

---

## Era 4 — Configuration Architecture & Implementation Bridge
*Bridges philosophy to concrete implementation. The session compiler as complete settings optimizer.*

| File | What it is | Accuracy now | Future gaps |
|------|-----------|-------------|------------|
| `configuration-architecture.html` | The complete configuration architecture: every Constellation setting as a cognitive lever (multipliers, moves, roundLength, rounds, steals, headquarters, map, bots, overlay, allowPlayerTeamSelection) with compiler strategy per parameter. Complete compiler decision sequence (mode → template → difficulty calibration → mode-specific settings → overlay). Zero-data start. Budget levels (ZERO → EMERGING → DEVELOPED → MATURE → EXPERT). Signal additions required in server.js with exact file locations. Full Observation schema with config_hash as join key. Terminal output examples at each budget level. Build order from Phase −1 through Phase 3. Templates tab: all 17 archetypes as UX scaffolding (labels derived from config vector — not architectural categories). Student Model tab: complete pipeline from Layer 0 → State (Steps 1–4: Elo update, velocity/ZPD, gap signal, session priority), all parameters ASSERTED with refutation conditions, self-grading criterion, pipeline canvas. | **Current — implementation-ready** | Randomized wormhole req not yet accounted for as a difficulty lever |
| `layer-0-ledger.html` | Working Layer 0 prototype. 30 mock observations across 4 students. Three panels: Live Feed (clickable records, newest first), Config Space scatter (12 selectable axes, brightness=outcome, shape=dest_mult sign, no mode labels, Show L1 Regions toggle overlays mode region boxes as a Layer 1 view), Inspector (full config vector display, round trajectory bars, axiom confirmation that no mode/template/elo_delta fields exist at Layer 0). Axioms tab with four permanence axioms. Cross-link to layer-1-approximation.html. | **95% — fully working** | Wire to live /ledger/*.jsonl files from server.js Phase −1 implementation |
| `layer-1-approximation.html` | Working Layer 1 prototype. Four students (ARIA/BRAM/CLIO/DARA). Mode Elo table with ±CI, velocity, transfer_elo (BT), gap signal alert (ARIA QTY gap=+190 triggers red alert). Radar canvas: game_elo polygon (solid), transfer_elo polygon (dashed blue), CI band. Right panel tabs: Formulas (all with ASSERTED markers and refutation conditions, Phase 3 replacements), Provenance (click mode row → see which Layer 0 records produced that Elo), Next Session (compiler preview, all weights ASSERTED), Reaction Library (per-session predicted vs actual rank_pct, MAE, CALIBRATED/OVERESTIMATES/UNDERESTIMATES verdict, surprise bar), Calibration (scatter plot: predicted vs actual, diagonal = perfect, ±0.10 ASSERTED tolerance band, mode-colored points). Cross-link to layer-0-ledger.html. | **95% — fully working** | Wire to live Ledger; add BT data integration when available |
| `observatory.html` | Live admin Observatory — reads from real JSONL Ledger via server API (`/api/ledger/students`, `/api/ledger/state/:id`, `/api/compiler/:id`). Three-panel layout: student list (session count, last seen, name-hash vs confirmed ID badge), center mode table (game_elo/velocity/zpd_target/n/since/decay for all 6 modes, all ASSERTED), radar canvas. Right panel tabs: Compiler (next-session suggestion with mode, expected_rank_pct, config_vector, mode priority score bars), Sessions (reverse-chronological feed with SILENT_INV/compiler/name-hash flags), Calibration (live scatter of predicted vs actual rank_pct computed from running Elo, ±0.10 band, MAE/bias/verdict). Shows OFFLINE state with instructions when server not running. First document that reads from real Ledger data rather than mock. | **Current — live** | Requires running server; no data until first game session completes |

---

## Open Questions Summary
*From system-map.html — to be resolved in order of priority.*

| # | Question | Priority | Resolves with |
|---|---------|---------|--------------|
| Q1 | Elo measures game performance, not cognitive skill | **P0** | BT integration → transfer_elo |
| Q2 | Announced INVERSION = wrong signal | **P0** | Silent INVERSION sessions |
| Q3 | Mode non-orthogonality | P1 | Covariance model + BT factor analysis |
| Q4 | Wrong forgetting curve domain | P1 | Empirical measurement from game data |
| Q5 | Social dimension absent | P2 | Accept limitation or add teacher tags |
| Q6 | All parameters asserted | P2 | Phase 2 instrumentation |
| Q7 | Gifted track incomplete | P1 | Controlled cohort comparison |
| Q8 | brain_metrics excluded | **P0 when BT available** | BT integration |

**Restructured by Era 3 (2026-06-11):** the "external validation target" question (system-map.html, Build Order tab — options A–E) is no longer awaiting a decision. The evidence engine tracks all five paths simultaneously as independent channels; ground truth is an *output* (the channel agreement structure measured over time), not an input. Q5 and Q8 are likewise reframed: record now in their own channels, decide from evidence later. Q2/Q4/Q6/Q7 gain pre-registered refutation conditions in the Parameter Registry.

---

## Multi-Objective Balance (not only information gain)
*The system optimizes for information gain as primary, but these are the full dimensions:*

1. **Cognitive development** (primary) — maximize E[KL] per session
2. **Engagement** (hard constraint) — below minimum, nothing else matters
3. **Meta-community** (emergent product) — terminal language, zone vocabulary, Alpha track
4. **Teacher legibility** (operational) — teacher sees signal; student experiences story
5. **Student as architect** (terminal objective) — singularity = system obsolescence

---

## BT Brain Training Bridge
*Currently excluded. Transforms the system when available.*

- `brain_metrics`: currently EXCLUDE → becomes **CORE** when BT validated
- `transfer_elo[mode]` = BT cognitive scores mapped to Constellation modes
- Gap signal = `game_elo[mode] − transfer_elo[mode]` → most diagnostic metric
- Wide gap = game knowledge without cognitive transfer → system responds

---

## Build Order
- **Phase −1** (before everything, per Era 3): Start the ledger. Recording must precede every other phase — observations not recorded during Phases 0–1 can never be recovered. Recording is not endorsement; the ledger has no opinion.
- **Phase 0** (now): Silent INVERSION, elo_velocity tracking, forgetting measurement, template history
- **Phase 1** (core): Terminal zones, Alpha system, collaborative staircase, instrumentation
- **Phase 2** (BT): Dimension mapping, gap signal, brain_metrics upgrade
- **Phase 3** (learned): Replace all [ASSERTED] parameters with measured values
