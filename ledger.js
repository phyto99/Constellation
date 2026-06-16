'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_DIR = path.join(__dirname, 'ledger');
const PARAMS_VERSION = 'v0.1.0';

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
        0,
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

module.exports = { append, configHash, extractConfigVector, PARAMS_VERSION };
