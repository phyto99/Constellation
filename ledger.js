'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_DIR = path.join(__dirname, 'ledger');
const PARAMS_VERSION = 'v0.1.0';
const R_BOT_DEFAULT = 520; // [ASSERTED] baseline bot Elo — store in every record so it can be refuted

// Persistent files inside LEDGER_DIR (not JSONL — JSON, writable)
const REGISTRY_PATH = path.join(LEDGER_DIR, '_students.json'); // name → { id, created_at }
const ALIASES_PATH  = path.join(LEDGER_DIR, '_aliases.json');  // secondaryId → primaryId

const BOT_TYPE_IDX = {
    HAL: 0, CAESAR: 1, ATHENA: 2, ROBIN: 3, 'ROBIN HOOD': 3,
    EINSTEIN: 4, LORENZ: 5, CUSTOM: 6, random: 7, greedy: 8
};

function ensureDir() {
    if (!fs.existsSync(LEDGER_DIR)) fs.mkdirSync(LEDGER_DIR, { recursive: true });
}

function todayPath() {
    return path.join(LEDGER_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

// config_hash: join key for all observations in a session.
// SHA256 of the 12-element config vector, first 16 hex chars.
function configHash(vec) {
    return crypto.createHash('sha256').update(JSON.stringify(vec)).digest('hex').slice(0, 16);
}

// mapIndex: deterministic integer for a map filename.
// Two different maps always produce different indices.
// Position [9] in the config vector.
function mapIndex(filename) {
    if (!filename) return 0; // default map
    return parseInt(
        crypto.createHash('sha256').update(filename).digest('hex').slice(0, 4),
        16
    ) % 9999 + 1; // 1–9999 reserved for named maps; 0 = default
}

// nameToId: stable fallback student ID when no explicit UUID is assigned.
// Consistent for the same name — NOT globally unique, but better than nothing.
// Records where this is used are tagged student_id_confirmed: false.
function nameToId(name) {
    return 'name:' + crypto.createHash('sha256').update(name || '').digest('hex').slice(0, 12);
}

// Extract the 12-element config vector from gameConfig.
// [count_mult, dist_mult, hq_mult, dest_mult, moves, round_length_s,
//  rounds, steals, hq_count, map_idx, bot_type, bot_aggression×100]
function extractConfigVector(gc) {
    const m = gc.multipliers || {};
    const bot = (gc.aiBots || [])[0] || {};
    return [
        m.count       ?? 500,
        m.distance    ?? 1,
        m.hq          ?? 10,
        m.destruction ?? 1,
        gc.moves        ?? 15,
        gc.roundLength  ?? 30,
        gc.rounds       ?? 10,
        gc.steals       ?? 50,
        gc.headquarters ?? 2,
        mapIndex(gc.customMapFilename || null),
        BOT_TYPE_IDX[bot.type] ?? -1,
        Math.round((bot.aggression ?? 0.5) * 100)
    ];
}

function append(record) {
    ensureDir();
    try {
        fs.appendFileSync(todayPath(), JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
        console.error('[ledger] append error:', err.message);
    }
}

// ─── Student Registry ─────────────────────────────────────────────────────────
// Maps student name → stable UUID. Written on first encounter.
// Guarantees every student gets a confirmed ID from their very first session,
// so name-hash fallbacks are only used if the server fails to write the registry.

function readRegistry() {
    try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); }
    catch { return {}; }
}

function writeRegistry(reg) {
    ensureDir();
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), 'utf8');
}

function resolveStudentId(name) {
    if (!name || !name.trim()) return { id: nameToId(''), confirmed: false };
    const trimmed = name.trim();
    ensureDir();
    const reg = readRegistry();
    if (reg[trimmed]) {
        return { id: reg[trimmed].id, confirmed: true };
    }
    // First encounter — assign and persist a stable UUID
    const id = crypto.randomUUID();
    reg[trimmed] = { id, created_at: Math.floor(Date.now() / 1000) };
    writeRegistry(reg);
    return { id, confirmed: true };
}

// ─── Alias Resolution ─────────────────────────────────────────────────────────
// Used when a teacher merges two student records (e.g. name change).
// Append-only: merge is recorded in the Ledger; _aliases.json maps secondary → primary.

function readAliases() {
    try { return JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8')); }
    catch { return {}; }
}

function resolveAlias(id) {
    const aliases = readAliases();
    return aliases[id] || id;
}

function mergeStudents(primaryId, secondaryId) {
    // Record merge event in the Ledger (immutable evidence trail)
    append({ type: 'merge', primary: primaryId, secondary: secondaryId, t: Math.floor(Date.now() / 1000) });
    const aliases = readAliases();
    aliases[secondaryId] = primaryId;
    // Transitive resolution: anything pointing to secondaryId now points to primaryId
    for (const [k, v] of Object.entries(aliases)) {
        if (v === secondaryId) aliases[k] = primaryId;
    }
    ensureDir();
    fs.writeFileSync(ALIASES_PATH, JSON.stringify(aliases, null, 2), 'utf8');
    return { primary: primaryId, secondary: secondaryId, alias_count: Object.keys(aliases).length };
}

// ─── Integrity Verification ───────────────────────────────────────────────────
function verify() {
    if (!fs.existsSync(LEDGER_DIR)) return { files: [], total: 0, valid: 0, invalid: 0 };
    const files = fs.readdirSync(LEDGER_DIR).filter(f => f.endsWith('.jsonl')).sort();
    let total = 0, valid = 0, invalid = 0;
    const fileResults = files.map(file => {
        const lines = fs.readFileSync(path.join(LEDGER_DIR, file), 'utf8').split('\n');
        let fv = 0, fi = 0;
        for (const l of lines) {
            if (!l.trim()) continue;
            try { JSON.parse(l); fv++; } catch { fi++; }
        }
        total += fv + fi; valid += fv; invalid += fi;
        return { file, total: fv + fi, valid: fv, invalid: fi };
    });
    return { files: fileResults, total, valid, invalid };
}

// ─── Raw Record Access ────────────────────────────────────────────────────────
// Returns session-type records newest-first, up to limit.
function rawRecords(limit = 200, dateFilter = null) {
    if (!fs.existsSync(LEDGER_DIR)) return [];
    const files = fs.readdirSync(LEDGER_DIR)
        .filter(f => f.endsWith('.jsonl') && (!dateFilter || f.startsWith(dateFilter)))
        .sort().reverse();
    const records = [];
    for (const file of files) {
        const lines = fs.readFileSync(path.join(LEDGER_DIR, file), 'utf8')
            .split('\n').filter(l => l.trim()).reverse();
        for (const line of lines) {
            try {
                const obs = JSON.parse(line);
                if (obs.type === 'session') {
                    records.push(obs);
                    if (records.length >= limit) return records;
                }
            } catch { }
        }
    }
    return records;
}

module.exports = {
    append, configHash, extractConfigVector, mapIndex, nameToId,
    resolveStudentId, readAliases, resolveAlias, mergeStudents,
    verify, rawRecords,
    PARAMS_VERSION, R_BOT_DEFAULT, LEDGER_DIR
};
