# Constellation

A multiplayer educational game used as a transparent medium for cognitive development. The game is not the point. The meta-system layered on top is the point.

**The One Principle:** `argmax E[KL(posterior ‖ prior)]` — maximize expected information gain about the student's cognitive model per session. Every architectural decision derives from this.

**The architectural foundation:**
- Layer 0 (The Ledger): append-only raw observations. Config vectors, outcomes, signals. No interpretations stored.
- Layer 1 (Current Approximation): views derived from Layer 0. Every value has a refutation condition. Every formula will be replaced.

**Start here:** `philosophy development/INDEX.md` — maintained living index of all documents, their current accuracy, and what supersedes what.

---

## PERMANENT CONSTRAINTS

1. Never add "— X" or any signature to student-facing terminal messages. (Rejected in induction.html.)
2. **ALL edits to student-next.html MUST use Python file write, not the Edit tool.** Edit tool converts ASCII apostrophes to Unicode smart quotes in JS → SyntaxError.
3. Do not build without being asked. Architecture first, confirm, then build.

---

## SETTLED ARCHITECTURE (do not re-derive)

**6 modes:** QTY / SPT / FRT / DST / WRM / INV

**5 compiler zones (canonical — student-design.html):**
- ECHO: familiar, consolidating
- PARALLEL: same mode, parameters shifted
- SHIFTING: mode change or INVERSION config
- RADICAL: large deficit, maximum novelty
- REMATCH: previously ranked below 0.40, retry for signal
- CALIBRATION is a pre-data UI phase (n < threshold), NOT a compiler zone

**ALPHA and SINGULARITY are progression tiers, not zones.** They affect what students can see — not what zone the compiler assigns.

**config_vector[12] (array, 0-indexed):**
`[count_mult, dist_mult, hq_mult, dest_mult, moves, round_length_s, rounds, steals, hq_count, map_idx, bot_type, bot_aggression*100]`

**Key formulas (all ASSERTED):**
- Elo: `E = 1/(1+10^((R_bot-R_student)/400))`, K=40/20/10, R_bot=520
- ZPD: `elo[m] * 0.85 * exp(-tau/14)`
- Priority: `0.50*deficit + 0.30*staleness + 0.20*gap`
- Velocity: `(elo_N - elo_{N-3}) / 3`

**INVERSION: always silent.** Never announced pre-session. purity_flag on any contaminated record.

**Bot opacity:** profile name WITHHELD always. Aggression WITHHELD pre-session. Presence VISIBLE always.

**Mode adjacency for SHIFTING:**
`QTY<->SPT, SPT<->FRT, FRT<->DST, DST<->INV, INV<->WRM, WRM<->SPT`
(QTY<->WRM not adjacent — use RADICAL)

---

## LIVE PANELS (current state)

| Panel | Status | Notes |
|---|---|---|
| student-next.html | Phase 0 complete | Zone pools = ECHO/PARALLEL/SHIFTING/RADICAL/REMATCH/CALIBRATION. buildTrainOpts uses cv array indexing, bot profile aggression, cv[4] for moves, getMapJsonByFilename for map. |
| layer-0-ledger.html | Production-ready | Live badge, MOCK fallback, student filter, scatter, inspector |
| observatory.html | Live | Reads /api/ledger/*, per-student Elo, radar, compiler preview |
| admin.html | Live | Game operator panel |

---

## LIVE API ENDPOINTS

```
GET  /api/ledger/raw?limit=N
GET  /api/ledger/students
GET  /api/ledger/state/:studentId
GET  /api/ledger/sessions/:studentId
GET  /api/compiler/:studentId          ← returns {mode, zone, bot_profile, map_filename, config_vector (array), config_hash, expected_rank_pct, r_bot, params_version}
GET  /api/ledger/health
POST /api/ledger/students/merge
POST /api/rooms/:roomId/apply-compiler
```

**compiler.js functions live:** `compile()`, `assignZone()`, `selectMap()`, `selectBotProfile()`, `buildConfigVector()`, `toGameConfig()`

**BOT_PROFILES (server-side aggression):** TURTLER=2, STANDARD=5, CONTESTER=6, ACCELERANT=8, MIRROR=5, THEORETICIAN=5

---

## WHAT IS NOT YET BUILT (Phase 1)

1. **Terminal message wiring** — compiler outputs zone/mode/expected_rank_pct. The terminal in student-next.html needs to pull these and generate behavioral observation lines from real Ledger data, not mock/random. Message library exists in system-complete.html Messages tab.
2. **Alpha system in admin.html** — fully designed in alpha-system.html. Detective framework, 5-phase application, eligibility criteria (>=15 sessions, all 6 modes, >=1 INV, not in REMATCH loop).
3. **Template selection** — compiler uses MODE_DEFAULTS only; 17 archetypes exist in challenge-meta.html, 14 available now (3 need new game mechanics).

## WHAT IS DEFERRED

- BT bridge (Phase 2): transfer_elo, gap signal, brain_metrics
- Multi-game architecture (Phase inf)
- Social composition in sessions

---

## CONTEXT COHERENCE STRATEGY

Each session: read this file first. It contains the authoritative current state.
After building something: update the "LIVE PANELS" table and "WHAT IS NOT YET BUILT" sections.
The philosophy docs in `philosophy development/` are the source of truth for WHY. CLAUDE.md is the source of truth for WHERE WE ARE NOW.
