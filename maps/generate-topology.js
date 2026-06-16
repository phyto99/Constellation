'use strict';
// Reads all map JSON files and computes topology.json
// Run: node maps/generate-topology.js
// Output: maps/topology.json

const fs   = require('fs');
const path = require('path');

const MAPS_DIR = path.join(__dirname, '..', 'Constellation maps 2');
const OUT_FILE = path.join(__dirname, 'topology.json');
const TOPOLOGY_VERSION = '1.0.0';

function analyzeMap(filename, data) {
    const stars = data.stars || [];
    const lines = data.lines || [];
    const [W, H] = data.dimensions || [320, 180];
    const diag = Math.sqrt(W * W + H * H);

    const star_count = stars.length;
    const hqStars    = stars.filter(s => s[2] === 2);
    const hq_count   = hqStars.length;
    const hq_positions = hqStars.map(s => [s[0], s[1]]);

    // Build per-node degree from edge list
    const degree = new Array(star_count).fill(0);
    for (const [a, b] of lines) {
        if (a >= 0 && a < star_count) degree[a]++;
        if (b >= 0 && b < star_count) degree[b]++;
    }
    const connection_count = lines.length;
    const avg_degree = star_count > 0
        ? parseFloat((2 * connection_count / star_count).toFixed(2))
        : 0;

    // Chokepoints: degree-1 or degree-2 nodes (potential bottlenecks)
    const chokepoint_count = degree.filter(d => d > 0 && d <= 2).length;
    const chokepoint_ratio = star_count > 0
        ? parseFloat((chokepoint_count / star_count).toFixed(3))
        : 0;

    // Average pairwise HQ distance, normalized by map diagonal
    let hq_distance_norm = 0.5; // default: unknown
    if (hq_positions.length >= 2) {
        let total = 0, pairs = 0;
        for (let i = 0; i < hq_positions.length; i++) {
            for (let j = i + 1; j < hq_positions.length; j++) {
                const dx = hq_positions[i][0] - hq_positions[j][0];
                const dy = hq_positions[i][1] - hq_positions[j][1];
                total += Math.sqrt(dx * dx + dy * dy);
                pairs++;
            }
        }
        hq_distance_norm = parseFloat((total / pairs / diag).toFixed(3));
    }

    // Spatial spread: how much of the map's bounding box the stars occupy
    const xs = stars.map(s => s[0]);
    const ys = stars.map(s => s[1]);
    const spread_x = star_count > 0 ? (Math.max(...xs) - Math.min(...xs)) / W : 0;
    const spread_y = star_count > 0 ? (Math.max(...ys) - Math.min(...ys)) / H : 0;
    const spatial_spread = parseFloat(((spread_x + spread_y) / 2).toFixed(3));

    // Connection density: connections per possible edge
    const possible_edges = star_count * (star_count - 1) / 2;
    const connection_density = possible_edges > 0
        ? parseFloat((connection_count / possible_edges).toFixed(4))
        : 0;

    return {
        filename,
        title:   data.title  || filename.replace('.json', ''),
        author:  data.author || 'unknown',
        dimensions: [W, H],
        topology_version: TOPOLOGY_VERSION,
        star_count,
        hq_count,
        hq_positions,
        connection_count,
        avg_degree,
        chokepoint_count,
        chokepoint_ratio,
        hq_distance_norm,
        spatial_spread,
        connection_density,
        // Mode affinity: computed after all maps are analyzed (needs normalization)
        mode_affinity: null,
        // Future — requires play data or manual annotation:
        // opening_divergence: null,
        // difficulty: {},
        // theoretical_optimal: {},
    };
}

function attachModeAffinities(maps) {
    const star_max  = Math.max(...maps.map(m => m.star_count), 1);
    const deg_max   = Math.max(...maps.map(m => m.avg_degree), 1);

    return maps.map(m => {
        // Normalize to [0,1] across the cohort
        const star_norm = Math.sqrt(m.star_count / star_max);       // sqrt dampens outliers
        const deg_norm  = m.avg_degree / deg_max;
        const hq_dist   = m.hq_distance_norm;
        const spread    = m.spatial_spread;
        const hq_n      = Math.min(m.hq_count / 4, 1.0);           // saturates at 4 HQs

        // qty: star count is the primary lever (more stars = more capturing opportunities)
        const qty = clip(0.35 * star_norm + 0.35 * (m.star_count > 60 ? 0.9 : 0.4) + 0.30 * spread);

        // spt: wide HQ separation + high spatial spread → distance-based strategy viable
        const spt = clip(0.55 * hq_dist + 0.45 * spread);

        // frt: HQ proximity (low dist) + multiple HQs → fortress dynamics
        const frt = clip(0.55 * (1 - hq_dist) + 0.45 * hq_n);

        // dst: high connectivity = more destruction targets; star count also helps
        const dst = clip(0.65 * deg_norm + 0.35 * star_norm);

        // wrm: flat until wormhole node data is available — [ASSERTED: 0.50]
        const wrm = 0.50;

        // inv: complexity-based — more complex maps reward inversion adaptation more
        const inv = clip(0.40 + 0.35 * star_norm + 0.25 * deg_norm);

        m.mode_affinity = {
            qty: round2(qty),
            spt: round2(spt),
            frt: round2(frt),
            dst: round2(dst),
            wrm,
            inv: round2(inv),
        };
        return m;
    });
}

function clip(v) { return Math.min(1.0, Math.max(0.0, v)); }
function round2(v) { return parseFloat(v.toFixed(2)); }

// ── Main ──────────────────────────────────────────────────────────────────────

const files = fs.readdirSync(MAPS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

const maps = files.map(f => {
    const raw = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
    return analyzeMap(f, raw);
});

const withAffinity = attachModeAffinities(maps);

// Build keyed object: filename → topology
const topology = {};
for (const m of withAffinity) {
    topology[m.filename] = m;
}

fs.writeFileSync(OUT_FILE, JSON.stringify(topology, null, 2), 'utf8');

console.log(`✅  Generated topology for ${files.length} maps → ${OUT_FILE}\n`);
for (const m of withAffinity) {
    const a = m.mode_affinity;
    console.log(`  ${m.filename}`);
    console.log(`    stars=${m.star_count} HQs=${m.hq_count} avg_deg=${m.avg_degree} hq_dist=${m.hq_distance_norm} spread=${m.spatial_spread}`);
    console.log(`    affinity: qty=${a.qty} spt=${a.spt} frt=${a.frt} dst=${a.dst} inv=${a.inv}\n`);
}
