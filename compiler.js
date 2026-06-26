'use strict';
const fs = require('fs');
const path = require('path');
const { configHash, nameToId, LEDGER_DIR, R_BOT_DEFAULT, PARAMS_VERSION, readAliases } = require('./ledger');

// ─── Topology registry ────────────────────────────────────────────────────────
const TOPOLOGY_PATH = path.join(__dirname, 'maps', 'topology.json');
let _topology = null;
function loadTopology() {
    if (_topology) return _topology;
    try {
        _topology = JSON.parse(fs.readFileSync(TOPOLOGY_PATH, 'utf8'));
    } catch {
        _topology = {}; // graceful fallback — no map selection if file missing
    }
    return _topology;
}

// ─── Bot profiles ─────────────────────────────────────────────────────────────
// Phase 1: aggression lever is the only real-time control (0–10, client-side AI).
// Phase 2: richer behavioral profiles via client-side strategy directives.
const BOT_PROFILES = {
    TURTLER:      { aggression: 2,  description: 'Passive — student sets the pace. Clean baseline signal.' },
    STANDARD:     { aggression: 5,  description: 'Baseline — default calibration opponent.' },
    CONTESTER:    { aggression: 6,  description: 'Targets student\'s developing zone — forces variation.' },
    ACCELERANT:   { aggression: 8,  description: 'Aggressive early expansion — tests tempo under pressure.' },
    MIRROR:       { aggression: 5,  description: 'Matches student\'s typical pace — Phase 2: copies dominant strategy.' },
    THEORETICIAN: { aggression: 5,  description: 'Optimal play for this map/mode — Phase 2: script-driven.' },
};

// ─── Constants ────────────────────────────────────────────────────────────────
const MODES = ['QTY', 'SPT', 'FRT', 'DST', 'WRM', 'INV'];
const BASE_ELO = 500;

// All numeric parameters below are [ASSERTED].
// Phase 3 replaces them with values fitted from Layer 0.
const ASSERTED = {
    K_high:            40,   // K when n_in_mode ≤ 5
    K_mid:             20,   // K when n_in_mode ≤ 20
    K_low:             10,   // K when n_in_mode > 20
    elo_scale:        400,   // logistic scale factor
    r_bot:    R_BOT_DEFAULT, // baseline bot Elo
    zpd_coeff:       0.85,   // difficulty target as fraction of current Elo
    forgetting_tau_d:  14,   // half-life of forgetting in days
    w_deficit:       0.50,   // priority weight: elo deficit
    w_staleness:     0.30,   // priority weight: sessions since last
    w_gap:           0.20,   // priority weight: BT gap (dormant until BT)
    elo_max:         1000,
    since_max_d:       30,
};

// ─── Bayesian posterior (μ, σ², λ) per dimension ──────────────────────────────
// Every student has a posterior over their true skill on each dimension.
// μ   = posterior mean       (currently ≡ Elo — same concept, explicit name)
// σ²  = posterior variance   (high = uncertain, shrinks with sessions, grows with time)
// λ   = forgetting rate      (how fast μ/σ² revert to prior between sessions)
//
// Migration path:
//   Phase 1 (now):  σ² derived from n via closed form; λ asserted at 1/30d.
//   Phase 2:        σ² stored in ledger after each session (Kalman update live).
//   Phase 3:        λ fitted per student × dimension from return-session residuals.
const SIGMA2_PRIOR = 22500;  // prior variance [ASSERTED] — σ₀ = 150 Elo points
const MU_PRIOR     = 500;    // prior mean [ASSERTED]
const LAMBDA_0     = 1 / 30; // forgetting rate per day [ASSERTED → fitted from return residuals]
const R_OBS        = 3600;   // observation noise variance [ASSERTED] — σ_obs = 60 Elo

// σ²(n): posterior variance after n sessions. Closed-form approximation of iterative
// Kalman updates at constant R. Derivation: σ²_n = σ²_0 / (1 + n·σ²_0/R_OBS).
// Converges to R_OBS/n for large n. At n=0: σ²_0 (full prior uncertainty).
function sigma2FromN(n) {
    return SIGMA2_PRIOR / (1 + n * SIGMA2_PRIOR / R_OBS);
}

// Ornstein-Uhlenbeck forgetting: project posterior forward τ days.
// μ_pred  = μ_∞ + exp(−λτ) · (μ − μ_∞)
// σ²_pred = σ²_∞ + exp(−2λτ) · (σ² − σ²_∞)
// At τ=0: identity. At τ→∞: reverts to prior (MU_PRIOR, SIGMA2_PRIOR).
function predict(mu, sigma2, lambda, tau) {
    const decay = Math.exp(-lambda * tau);
    return {
        mu_pred:     MU_PRIOR + decay * (mu - MU_PRIOR),
        sigma2_pred: SIGMA2_PRIOR + decay * decay * (sigma2 - SIGMA2_PRIOR),
    };
}

// Kalman update: incorporate observation y (Elo-equivalent) with noise R.
// K   = σ²_pred / (σ²_pred + R)   — optimal gain (replaces fixed K=40/20/10 [ASSERTED])
// μ'  = μ_pred + K · (y − μ_pred)
// σ²' = (1 − K) · σ²_pred
// Exported for use by game adapters and the BT bridge (Phase 2).
function kalmanUpdate(mu_pred, sigma2_pred, y, R) {
    const K = sigma2_pred / (sigma2_pred + R);
    return { mu_new: mu_pred + K * (y - mu_pred), sigma2_new: (1 - K) * sigma2_pred, K };
}

// Expected KL(posterior ‖ prior) from one session on this dimension.
// I(d) = ½ log(1 + σ²_pred / R)
// This IS the selection objective. All other criteria are approximations of this.
// Higher σ²_pred = more uncertain = more to learn = higher priority.
function informationGain(sigma2_pred, R) {
    return 0.5 * Math.log(1 + sigma2_pred / R);
}

// ─── Game registry ─────────────────────────────────────────────────────────────
// One entry per game in the suite. dimensions[] names the cognitive axes it probes.
// available:true iff the game server is built and this compiler can emit configs for it.
// Constellation's adapter IS compiler.js. Future adapters: golad.js, geobridge.js, c4d.js.
// To enable a game: (1) set available:true, (2) create adapter module, (3) wire compile().
const GAME_REGISTRY = {
    constellation: {
        id:          'constellation',
        name:        'Constellation',
        dimensions:  MODES,                     // ['QTY','SPT','FRT','DST','WRM','INV']
        available:   true,
        description: 'Spatial resource optimization. Primary probe: OPT, MOS.',
    },
    golad: {
        id:          'golad',
        name:        'GOLAD',
        dimensions:  ['SIM', 'ADP'],
        available:   false,
        description: 'Cellular automaton strategy. Primary probe: SIM, ADP.',
    },
    geobridge: {
        id:          'geobridge',
        name:        'Geobridge',
        dimensions:  ['COM', 'OPP', 'KNW'],
        available:   false,
        description: 'Bidding and category reasoning. Primary probe: COM, OPP, KNW.',
    },
    c4d: {
        id:          'c4d',
        name:        'C4D',
        dimensions:  ['TOP'],
        available:   false,
        description: 'Four-dimensional spatial reasoning. Primary probe: TOP.',
    },
};

// Select the available game maximizing total expected information gain.
// I(game) = Σ_{d ∈ game.dimensions} I(σ²_pred[d], R_OBS)
// Phase 1: always 'constellation' (only available game).
// Phase N: games compete on the same criterion — no special-casing, no bias.
function selectGame(state) {
    let best = null, bestScore = -Infinity;
    for (const [gameId, game] of Object.entries(GAME_REGISTRY)) {
        if (!game.available) continue;
        let score = 0;
        for (const d of game.dimensions) {
            const dim    = state[d];
            const mu     = dim ? dim.mu     : MU_PRIOR;
            const sigma2 = dim ? dim.sigma2 : SIGMA2_PRIOR;
            const lambda = dim ? dim.lambda : LAMBDA_0;
            const tau    = dim ? dim.tau    : 0;
            const { sigma2_pred } = predict(mu, sigma2, lambda, tau);
            score += informationGain(sigma2_pred, R_OBS);
        }
        if (score > bestScore) { bestScore = score; best = gameId; }
    }
    return best || 'constellation';
}

// ─── Mode assignment (Layer 1 view over Layer 0) ─────────────────────────────
// Mode label derived from config_vector — never stored in Layer 0.
function assignMode(cv) {
    if (!cv) return null;
    if (cv[0] < 0 || cv[1] < 0 || cv[2] < 0 || cv[3] < 0) return 'INV';
    const mults = [cv[0], cv[1], cv[2], cv[3]];
    if (mults.reduce((a, b) => a + b, 0) < 20) return 'WRM';
    return ['QTY', 'SPT', 'FRT', 'DST'][mults.indexOf(Math.max(...mults))];
}

// ─── Ledger reading ───────────────────────────────────────────────────────────

// Build the full set of IDs that belong to one student (primary + all aliases).
function idSet(studentId) {
    const aliases = readAliases();
    // Resolve studentId to its primary (in case it's itself an alias)
    const primary = aliases[studentId] || studentId;
    const set = new Set([studentId, primary]);
    // Collect all secondaries that point to this primary
    for (const [secondary, target] of Object.entries(aliases)) {
        if (target === primary) set.add(secondary);
    }
    return set;
}

function readStudentSessions(studentId) {
    if (!fs.existsSync(LEDGER_DIR)) return [];
    const ids = idSet(studentId);
    const files = fs.readdirSync(LEDGER_DIR)
        .filter(f => f.endsWith('.jsonl'))
        .sort(); // ascending date → chronological order
    const sessions = [];
    for (const file of files) {
        const lines = fs.readFileSync(path.join(LEDGER_DIR, file), 'utf8')
            .split('\n').filter(l => l.trim());
        for (const line of lines) {
            try {
                const obs = JSON.parse(line);
                if (ids.has(obs.student_id) && obs.type === 'session') {
                    sessions.push(obs);
                }
            } catch { /* malformed line — skip, never corrupt */ }
        }
    }
    return sessions.sort((a, b) => a.t - b.t);
}

function listStudents() {
    if (!fs.existsSync(LEDGER_DIR)) return [];
    const aliases = readAliases();
    const files = fs.readdirSync(LEDGER_DIR)
        .filter(f => f.endsWith('.jsonl'))
        .sort();
    const map = new Map();
    for (const file of files) {
        const lines = fs.readFileSync(path.join(LEDGER_DIR, file), 'utf8')
            .split('\n').filter(l => l.trim());
        for (const line of lines) {
            try {
                const obs = JSON.parse(line);
                if (!obs.student_id || obs.type !== 'session') continue;
                // Resolve to primary ID before aggregating
                const primary = aliases[obs.student_id] || obs.student_id;
                const cur = map.get(primary) || {
                    student_id: primary,
                    student_id_confirmed: obs.student_id_confirmed ?? false,
                    student_name: null,
                    sessions: 0, last_t: 0, wins: 0
                };
                cur.sessions++;
                if (obs.student_id_confirmed) cur.student_id_confirmed = true;
                if (obs.t > cur.last_t) {
                    cur.last_t = obs.t;
                    if (obs.student_name) cur.student_name = obs.student_name;
                }
                if (obs.outcome?.rank === 1) cur.wins++;
                map.set(primary, cur);
            } catch { }
        }
    }
    return Array.from(map.values()).sort((a, b) => b.last_t - a.last_t);
}

// ─── State computation ────────────────────────────────────────────────────────
function Kval(n) {
    if (n <= 5)  return ASSERTED.K_high;  // [ASSERTED] thresholds
    if (n <= 20) return ASSERTED.K_mid;
    return ASSERTED.K_low;
}

function computeState(sessions) {
    const modeElo      = Object.fromEntries(MODES.map(m => [m, BASE_ELO]));
    const modeN        = Object.fromEntries(MODES.map(m => [m, 0]));
    const modeLastT    = Object.fromEntries(MODES.map(m => [m, null]));
    const modeLastRank = Object.fromEntries(MODES.map(m => [m, null]));
    const modeHistory  = Object.fromEntries(MODES.map(m => [m, []])); // [{t, elo}]

    for (const obs of sessions) {
        const mode = assignMode(obs.config_vector);
        if (!mode || !MODES.includes(mode)) continue;
        const n   = modeN[mode];
        const elo = modeElo[mode];
        const R   = (obs.signals?.r_bot) ?? ASSERTED.r_bot;
        const E   = 1 / (1 + Math.pow(10, (R - elo) / ASSERTED.elo_scale));
        const S   = obs.outcome?.rank_pct ?? 0.5;
        const newElo = elo + Kval(n + 1) * (S - E);
        modeElo[mode]      = newElo;
        modeN[mode]++;
        modeLastT[mode]    = obs.t;
        modeLastRank[mode] = S;
        modeHistory[mode].push({ t: obs.t, elo: Math.round(newElo) });
    }

    const nowS = Date.now() / 1000;
    const state = {};
    for (const m of MODES) {
        const lastT = modeLastT[m];
        const sinceD = lastT ? (nowS - lastT) / 86400 : null;
        const decay = sinceD !== null ? Math.exp(-sinceD / ASSERTED.forgetting_tau_d) : 1.0;
        const hist = modeHistory[m];
        let velocity = null;
        if (hist.length >= 4) {
            velocity = (hist[hist.length - 1].elo - hist[Math.max(0, hist.length - 4)].elo) / 3;
        }
        // Bayesian posterior — derived from history; stored directly in Phase 2
        const mu_now    = Math.round(modeElo[m]);
        const sigma2_now = sigma2FromN(modeN[m]);
        const tau_now   = sinceD ?? 0;
        const { sigma2_pred: sigma2_fwd } = predict(mu_now, sigma2_now, LAMBDA_0, tau_now);

        state[m] = {
            elo:             mu_now,
            n:               modeN[m],
            velocity:        velocity !== null ? Math.round(velocity * 10) / 10 : null,
            last_rank_pct:   modeLastRank[m],
            last_t:          lastT,
            since_days:      sinceD !== null ? Math.round(sinceD * 10) / 10 : null,
            decay:           Math.round(decay * 1000) / 1000,
            zpd_target:      Math.round(modeElo[m] * ASSERTED.zpd_coeff * decay),
            history:         hist,
            // Bayesian fields
            mu:        mu_now,
            sigma2:    Math.round(sigma2_now),
            lambda:    LAMBDA_0,
            tau:       Math.round(tau_now * 10) / 10,
            info_gain: parseFloat(informationGain(sigma2_fwd, R_OBS).toFixed(4)),
        };
    }
    return state;
}

// ─── Mode selection ───────────────────────────────────────────────────────────
// argmax I(d) — select the dimension with highest expected information gain.
// I(d) = ½ log(1 + σ²_pred / R_OBS)
//
// Why this is correct: the system objective is argmax E[KL(posterior ‖ prior)].
// I(d) is the closed-form expected KL for a Gaussian observation. Selecting
// the dimension with highest σ²_pred maximizes information learned per session.
//
// transferElo (BT bridge, Phase 2) inflates σ²: if the game model and BT model
// disagree on a dimension, we're more uncertain than n alone suggests.
// α_transfer [ASSERTED 0.001] scales gap² contribution. Dormant until BT is live.
function selectMode(state, transferElo) {
    const ALPHA_TRANSFER = 0.001; // [ASSERTED] gap² → σ² bonus. Dormant: BT not built.
    let best = null, bestScore = -Infinity;
    const scores = {};
    for (const m of MODES) {
        const d = state[m];
        const { mu_pred, sigma2_pred: sigma2_base } = predict(d.mu, d.sigma2, d.lambda, d.tau);
        // Cross-channel discrepancy (BT vs game) adds uncertainty to this dimension
        const gap = (transferElo && transferElo[m]) ? Math.abs(d.mu - transferElo[m]) : 0;
        const sigma2_eff = sigma2_base + ALPHA_TRANSFER * gap * gap;
        const I = informationGain(sigma2_eff, R_OBS);
        scores[m] = {
            info_gain:   parseFloat(I.toFixed(4)),
            mu_pred:     Math.round(mu_pred),
            sigma2_pred: Math.round(sigma2_eff),
            // Legacy fields kept for Observatory/admin panels
            score:    parseFloat(I.toFixed(4)),
            deficit:  parseFloat((1 - d.mu / ASSERTED.elo_max).toFixed(4)),
            staleness: parseFloat(Math.min(d.tau / ASSERTED.since_max_d, 1).toFixed(4)),
            gapScore:  gap > 0 ? parseFloat((gap / ASSERTED.elo_max).toFixed(4)) : 0,
        };
        if (I > bestScore) { bestScore = I; best = m; }
    }
    return { mode: best, scores };
}

// ─── Map selection ────────────────────────────────────────────────────────────
// Picks the highest mode-affinity map that hasn't been used recently.
function selectMap(mode, recentMapFilenames) {
    const topology = loadTopology();
    const entries  = Object.entries(topology);
    if (entries.length === 0) return null;

    const modeKey = mode.toLowerCase(); // 'QTY' → 'qty'
    const recentSet = new Set((recentMapFilenames || []).slice(-3)); // avoid last 3

    let best = null, bestScore = -Infinity;
    for (const [filename, topo] of entries) {
        const affinity = topo.mode_affinity?.[modeKey] ?? 0.5;
        const recencyPenalty = recentSet.has(filename) ? 0.4 : 0;
        const score = affinity - recencyPenalty;
        if (score > bestScore) { bestScore = score; best = filename; }
    }
    return best;
}

// ─── Zone assignment ──────────────────────────────────────────────────────────
// Describes the relationship between the student and this session.
// Does NOT label the cognitive mode — labels the challenge relationship.
function assignZone(sessions, selectedMode, state) {
    if (sessions.length === 0) return 'ECHO'; // first session: calibration, use neutral name

    const last = sessions[sessions.length - 1];
    const lastMode = assignMode(last.config_vector);
    const lastRankPct = last.outcome?.rank_pct ?? 0.5;
    const lastT = last.t;
    const nowS = Date.now() / 1000;
    const sinceLastMode = state[selectedMode].since_days;

    // REMATCH: decisive loss on most recent session of the selected mode
    const modeSessionsDesc = sessions
        .filter(s => assignMode(s.config_vector) === selectedMode)
        .sort((a, b) => b.t - a.t);
    if (modeSessionsDesc.length > 0 && modeSessionsDesc[0].outcome?.rank_pct < 0.35) {
        return 'REMATCH';
    }

    // RADICAL: very stale mode (>21 days) or first session ever in this mode
    if (sinceLastMode === null || sinceLastMode > 21) return 'RADICAL';

    // RADICAL: mode was just selected due to a large deficit (low Elo relative to max)
    if (state[selectedMode].elo < 450 && selectedMode !== lastMode) return 'RADICAL';

    // SHIFTING: mode changed from last session
    if (lastMode !== selectedMode) return 'SHIFTING';

    // PARALLEL: same mode, Elo developing (5+ sessions in mode, decent performance)
    if (state[selectedMode].n >= 5 && lastRankPct >= 0.45) return 'PARALLEL';

    // Default: ECHO — consolidation in familiar territory
    return 'ECHO';
}

// ─── Bot profile selection ────────────────────────────────────────────────────
function selectBotProfile(sessions, state, zone, sessionCount) {
    // Zero or very few sessions: TURTLER — let student explore, clean baseline
    if (sessionCount < 3) return 'TURTLER';

    // REMATCH: student was overwhelmed — reduce pressure
    if (zone === 'REMATCH') return 'TURTLER';

    // RADICAL: student being stretched into new territory — MIRROR shows them
    // their own strategy applied to unfamiliar mode
    if (zone === 'RADICAL') return 'MIRROR';

    // SHIFTING: new mode, new territory — CONTESTER forces adaptation
    if (zone === 'SHIFTING') return 'CONTESTER';

    // PARALLEL: same mode but pushing ceiling — ACCELERANT tests tempo
    if (zone === 'PARALLEL') return 'ACCELERANT';

    // High session count: graduate to THEORETICIAN for ceiling measurement
    if (sessionCount >= 20) return 'THEORETICIAN';

    // Default ECHO: familiar territory, standard opponent
    return 'STANDARD';
}

// ─── Config vector construction ───────────────────────────────────────────────
// All multiplier values are [ASSERTED]. Phase 3 fits these from Ledger data.
const MODE_DEFAULTS = {
    QTY: [500,   1,  10,    1],
    SPT: [  1, 500,   1,    1],
    FRT: [ 50,   1, 500, -200],
    DST: [  1,   1,   1,  300],
    WRM: [  1,   1,   1,    1],
    INV: [-100,  1,   1,    1],
};

// ─── Template registry (Phase 1: 14 of 17 archetypes) ────────────────────────
// Excluded: blind_reach (proximity-reveal mechanic), architect (pattern-target
//           display), decoy (multi-wormhole active/trap) — engine not yet built.
// mults: [count_mult, dist_mult, hq_mult, dest_mult] — overrides MODE_DEFAULTS.
// params.moves_override, rounds, steals, hq_count — override ZPD-calibrated values.
// bot: overrides selectBotProfile() result when set.
// INV templates have mults:null — computed at runtime by computeInvMults().
const TEMPLATES = {
    QTY: [
        { id: 'flood',       mults: [500, 1, 1,    1], params: { steals: 0 } },
        { id: 'speed_flood', mults: [500, 1, 1,    1], params: { rounds: 5 } },
        { id: 'miser',       mults: [500, 1, 1,    1], params: { moves_override: 8 } },
    ],
    SPT: [
        { id: 'reach',       mults: [1, 500, 0,    1], params: {} },
    ],
    FRT: [
        { id: 'network',     mults: [50, 1, 500, -200], params: { hq_count: 4 } },
        { id: 'siege',       mults: [50, 1, 500, -200], params: { hq_count: 4 }, bot: 'ACCELERANT' },
        { id: 'patience',    mults: [50, 1, 500, -200], params: { hq_count: 4, moves_override: 10 } },
    ],
    DST: [
        { id: 'chain',       mults: [-100, 1, 1, 500],  params: {} },
        { id: 'hunter',      mults: [1, 1, 1, 200],     params: { steals: 50 } },
        { id: 'scorched',    mults: [1, 1, 1, 500],     params: {} },
    ],
    WRM: [
        { id: 'gate',        mults: [1, 1, 1, 1],       params: {} },
    ],
    INV: [
        { id: 'hidden',         mults: null, params: {} },
        { id: 'mirror',         mults: null, params: {} },
        { id: 'negative_space', mults: null, params: {} },
    ],
};

// Negative magnitude per axis — avoids symmetry, keeps signal distinct
const INV_NEG = [-100, -50, -50, -100];

function computeInvMults(templateId, sessions, state) {
    if (templateId === 'mirror') {
        // Invert the dominant axis of the most recent non-INV session
        const lastNonInv = sessions.slice().reverse()
            .find(s => s.config_vector && assignMode(s.config_vector) !== 'INV');
        if (lastNonInv) {
            const cv = lastNonInv.config_vector;
            const abs = [Math.abs(cv[0]), Math.abs(cv[1]), Math.abs(cv[2]), Math.abs(cv[3])];
            const axis = abs.indexOf(Math.max(...abs));
            const m = [1, 1, 1, 1];
            m[axis] = INV_NEG[axis];
            return m;
        }
    }
    if (templateId === 'negative_space') {
        // Invert the axis of the student's strongest non-INV mode
        const modeAxis = { QTY: 0, SPT: 1, FRT: 2, DST: 3 };
        let bestMode = 'QTY', bestElo = 0;
        for (const m of ['QTY', 'SPT', 'FRT', 'DST']) {
            if ((state[m]?.elo || 0) > bestElo) { bestElo = state[m].elo; bestMode = m; }
        }
        const axis = modeAxis[bestMode] ?? 0;
        const mults = [1, 1, 1, 1];
        mults[axis] = INV_NEG[axis];
        return mults;
    }
    // 'hidden': random axis — student cannot predict which objective is inverted
    const axis = Math.floor(Math.random() * 4);
    const mults = [1, 1, 1, 1];
    mults[axis] = INV_NEG[axis];
    return mults;
}

// ─── Template selection ───────────────────────────────────────────────────────
function selectTemplate(mode, zone, sessions, state) {
    const pool = TEMPLATES[mode];
    if (!pool || pool.length === 0) return null;
    if (pool.length === 1) return pool[0];

    // Recent template IDs for this mode (last 3 sessions)
    const recentIds = sessions
        .filter(s => assignMode(s.config_vector) === mode && s.signals?.template_id)
        .map(s => s.signals.template_id)
        .slice(-3);
    const lastId = recentIds[recentIds.length - 1] || null;

    // REMATCH / ECHO: consolidate on same template when available
    if ((zone === 'REMATCH' || zone === 'ECHO') && lastId) {
        const last = pool.find(t => t.id === lastId);
        if (last) return last;
    }

    // PARALLEL: explicitly different template within the same mode
    if (zone === 'PARALLEL' && pool.length > 1) {
        const notRecent = pool.filter(t => !recentIds.includes(t.id));
        if (notRecent.length > 0) return notRecent[Math.floor(Math.random() * notRecent.length)];
        const notLast = pool.filter(t => t.id !== lastId);
        if (notLast.length > 0) return notLast[Math.floor(Math.random() * notLast.length)];
    }

    // SHIFTING / RADICAL / default: fresh template, avoiding recently used
    const fresh = pool.filter(t => !recentIds.includes(t.id));
    if (fresh.length > 0) return fresh[Math.floor(Math.random() * fresh.length)];

    // All recently used — rotate away from the last one only
    const notLast = pool.filter(t => t.id !== lastId);
    return notLast.length > 0
        ? notLast[Math.floor(Math.random() * notLast.length)]
        : pool[0];
}

function buildConfigVector(mode, state, template, sessions) {
    const d = state[mode];

    // Multipliers: from template (computed for INV), or MODE_DEFAULTS
    let mults;
    if (template && template.mults !== null) {
        mults = template.mults;
    } else if (template && template.mults === null && mode === 'INV') {
        mults = computeInvMults(template.id, sessions || [], state);
    } else {
        mults = MODE_DEFAULTS[mode] || [500, 1, 10, 1];
    }

    // Difficulty calibration — moves proxy [ASSERTED thresholds]
    const zpd = d.zpd_target;
    const moves   = zpd > 700 ? 10 : zpd > 550 ? 12 : 15;
    const rl      = mode === 'SPT' ? 35 : mode === 'FRT' ? 28 : 30;
    const rounds  = mode === 'WRM' ? 8 : 10;
    const steals  = mode === 'FRT' ? 3 : mode === 'DST' ? 40 : 15;
    const hq_cnt  = mode === 'FRT' ? 4 : 2;

    const cv = [
        mults[0], mults[1], mults[2], mults[3],
        moves, rl, rounds, steals, hq_cnt,
        0,  // map_idx — legacy (map selected by filename, not index)
        0,  // bot_type — HAL [ASSERTED]
        50, // bot_aggression×100 — overridden by toGameConfig from bot profile
    ];

    // Template parameter overrides (applied after ZPD calibration)
    if (template?.params) {
        const p = template.params;
        if (p.moves_override !== undefined) cv[4] = p.moves_override;
        if (p.rounds        !== undefined) cv[6] = p.rounds;
        if (p.steals        !== undefined) cv[7] = p.steals;
        if (p.hq_count      !== undefined) cv[8] = p.hq_count;
    }

    return cv;
}

// ─── Main compile function ────────────────────────────────────────────────────
function compile(studentId, transferElo) {
    const sessions = readStudentSessions(studentId);
    const state    = computeState(sessions);
    // Two-level selection: game first, then dimension within game.
    // Phase 1: selectGame always returns 'constellation' (only available game).
    // Phase N: multiple games compete — same criterion, no special-casing.
    const game_id  = selectGame(state);
    const { mode, scores } = selectMode(state, transferElo || null);

    // Zone must be assigned before template selection (template depends on zone)
    const zone        = assignZone(sessions, mode, state);

    // Template selection — chooses one of the 14 available archetypes
    const template    = selectTemplate(mode, zone, sessions, state);

    const cv       = buildConfigVector(mode, state, template, sessions);
    const ch       = configHash(cv);
    const R        = ASSERTED.r_bot;
    const mElo     = state[mode].elo;
    const E        = 1 / (1 + Math.pow(10, (R - mElo) / ASSERTED.elo_scale));

    // Map selection — picks highest mode-affinity map avoiding last 3 played
    const recentMaps = sessions.slice(-10)
        .map(s => s.config_map_filename)
        .filter(Boolean);
    const map_filename = selectMap(mode, recentMaps);

    // Bot profile — template may override (e.g. 'siege' forces ACCELERANT)
    let bot_profile = selectBotProfile(sessions, state, zone, sessions.length);
    if (template?.bot) bot_profile = template.bot;

    return {
        student_id:           studentId,
        game_id,
        mode,
        zone,
        template_id:          template?.id || null,
        map_filename,
        bot_profile,
        config_vector:        cv,
        config_hash:          ch,
        expected_rank_pct:    parseFloat(E.toFixed(3)),
        r_bot:                R,
        state_snapshot:       state,
        mode_scores:          scores,
        session_count:        sessions.length,
        asserted:             ASSERTED,
        params_version:       PARAMS_VERSION,
        generated_at:         Math.floor(Date.now() / 1000),
    };
}

// ─── gameConfig bridge ────────────────────────────────────────────────────────
// Translate compiler output → Colyseus gameConfig fields
function toGameConfig(compilerResult, existingConfig) {
    const cv      = compilerResult.config_vector;
    const profile = BOT_PROFILES[compilerResult.bot_profile] || BOT_PROFILES.STANDARD;

    const base = {
        ...existingConfig,
        multipliers: {
            count:       cv[0],
            distance:    cv[1],
            hq:          cv[2],
            destruction: cv[3],
        },
        moves:         cv[4],
        roundLength:   cv[5],
        rounds:        cv[6],
        steals:        cv[7],
        headquarters:  cv[8],
        // Bot: one HAL bot per session, aggression from profile
        aiBots: [{
            type:       'HAL',
            aggression: profile.aggression,
            teamIndex:  1, // bot is always team 1 (student team 0)
        }],
        _compiler: {
            mode:               compilerResult.mode,
            zone:               compilerResult.zone,
            bot_profile:        compilerResult.bot_profile,
            map_filename:       compilerResult.map_filename,
            config_hash:        compilerResult.config_hash,
            expected_rank_pct:  compilerResult.expected_rank_pct,
            r_bot:              compilerResult.r_bot,
            params_version:     compilerResult.params_version,
        },
    };

    // Set the map if compiler selected one (can be overridden by teacher post-hoc)
    if (compilerResult.map_filename && !existingConfig?.customMapFilename) {
        base.customMapFilename = compilerResult.map_filename;
    }

    return base;
}

module.exports = {
    compile, computeState, readStudentSessions, listStudents,
    assignMode, selectMode, assignZone, selectMap, selectBotProfile,
    buildConfigVector, selectTemplate, toGameConfig,
    loadTopology, BOT_PROFILES, MODES, ASSERTED, TEMPLATES,
    // Bayesian primitives — used by Observatory, admin, future game adapters
    selectGame, informationGain, predict, kalmanUpdate, sigma2FromN,
    GAME_REGISTRY, SIGMA2_PRIOR, MU_PRIOR, LAMBDA_0, R_OBS,
};
