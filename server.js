const { Server, Room, matchMaker } = require('colyseus');
const { MapSchema, Schema, type } = require('@colyseus/schema');
const { createServer } = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const basicAuth = require('express-basic-auth');
const { monitor } = require('@colyseus/monitor');
const fs = require('fs');
const axios = require('axios');
const { StarSchema, TeamSchema, GameStateSchema } = require('./game-schema');
const WebSocket = require('ws');

// ─── Centauri Godot relay ─────────────────────────────────────────────────────
// Binary protocol: Server→Client [type(1), peer_id(LE32), ...payload]
//   type 0 = data  (peer_id = source, payload = game bytes)
//   type 1 = peer connected  (peer_id = new peer)
//   type 2 = peer disconnected (peer_id = gone peer)
//   type 3 = your ID  (peer_id = assigned id for this client)
// Client→Server [dest_peer_id(LE32), ...payload]  dest 0 = broadcast
const centauriGodotWss  = new WebSocket.Server({ noServer: true });
const centauriGodotRooms = new Map(); // roomId → Map<peerId, ws>

centauriGodotWss.on('connection', (ws, roomId) => {
    if (!centauriGodotRooms.has(roomId)) centauriGodotRooms.set(roomId, new Map());
    const room = centauriGodotRooms.get(roomId);

    // First joiner is peer 1 (host), subsequent get 2, 3 …
    let peerId = 1;
    while (room.has(peerId)) peerId++;
    room.set(peerId, ws);
    ws._cPeerId  = peerId;
    ws._cRoomId  = roomId;

    const mkSys = (type, id) => { const b = Buffer.alloc(5); b.writeUInt8(type,0); b.writeInt32LE(id,1); return b; };
    const sendData = (target, src, payload) => {
        if (target.readyState !== WebSocket.OPEN) return;
        const b = Buffer.alloc(5 + payload.length);
        b.writeUInt8(0,0); b.writeInt32LE(src,1); payload.copy(b,5);
        target.send(b);
    };

    // Tell new client its ID
    ws.send(mkSys(3, peerId));
    // Introduce new client to existing peers and vice-versa
    for (const [eid, ews] of room) {
        if (eid === peerId) continue;
        ews.readyState === WebSocket.OPEN && ews.send(mkSys(1, peerId)); // existing hears new
        ws.send(mkSys(1, eid));                                           // new hears existing
    }
    console.log(`CentauriRelay: peer ${peerId} joined room ${roomId}`);

    ws.on('message', (data) => {
        if (data.length < 4) return;
        const buf  = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const dest = buf.readInt32LE(0);
        const payload = buf.slice(4);
        const src  = ws._cPeerId;
        if (dest === 0) {
            for (const [pid, pws] of room) { if (pid !== src) sendData(pws, src, payload); }
        } else {
            const t = room.get(dest); if (t) sendData(t, src, payload);
        }
    });

    ws.on('close', () => {
        room.delete(ws._cPeerId);
        const disc = mkSys(2, ws._cPeerId);
        for (const [, pws] of room) { pws.readyState === WebSocket.OPEN && pws.send(disc); }
        if (room.size === 0) centauriGodotRooms.delete(roomId);
        console.log(`CentauriRelay: peer ${ws._cPeerId} left room ${roomId}`);
    });
});

// ─── TTClub WebRTC Signaling Server ───────────────────────────────────────────
const ttclubWss = new WebSocket.Server({ noServer: true });
const ttclubRooms = new Map(); // roomCode -> { clients: Map<id,ws>, hostId, sealed, players: Map<id,{color,name,joinedAt}> }
let ttclubPeerIdCounter = 1;

// Deterministic color palette matching Constellation's team color system
const TEAM_COLORS = [
    '#ef4444','#f97316','#eab308','#22c55e','#14b8a6',
    '#3b82f6','#8b5cf6','#ec4899','#f43f5e','#06b6d4',
    '#84cc16','#a855f7','#fb923c','#4ade80','#60a5fa',
];

function ttclubGenerateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (ttclubRooms.has(code));
    return code;
}

ttclubWss.on('connection', (ws) => {
    ws._tc = { id: null, roomCode: null };

    ws.on('message', (rawData) => {
        const msg = rawData.toString();
        const nl = msg.indexOf('\n');
        if (nl < 0) return;
        const header = msg.substring(0, nl);
        const body = msg.substring(nl + 1);
        if (header.startsWith('J: ')) {
            ttclubHandleJoin(ws, header.substring(3).trim());
        } else if (header.startsWith('S: ')) {
            ttclubHandleSeal(ws);
        } else if (header.startsWith('O: ')) {
            ttclubForward(ws, parseInt(header.substring(3)), `O: ${ws._tc.id}\n${body}`);
        } else if (header.startsWith('A: ')) {
            ttclubForward(ws, parseInt(header.substring(3)), `A: ${ws._tc.id}\n${body}`);
        } else if (header.startsWith('C: ')) {
            ttclubForward(ws, parseInt(header.substring(3)), `C: ${ws._tc.id}\n${body}`);
        }
    });

    ws.on('close', () => ttclubHandleDisconnect(ws));
    ws.on('error', () => ttclubHandleDisconnect(ws));
});

function ttclubHandleJoin(ws, requestedCode) {
    const id = ttclubPeerIdCounter++;
    ws._tc.id = id;
    ws.send(`I: ${id}\n`);

    if (requestedCode === '') {
        const code = ttclubGenerateRoomCode();
        const players = new Map([[id, { color: TEAM_COLORS[0], name: `Player 1`, joinedAt: Date.now(), isHost: true }]]);
        ttclubRooms.set(code, { clients: new Map([[id, ws]]), hostId: id, sealed: false, players });
        ws._tc.roomCode = code;
        ws.send(`J: ${code}\n`);
        console.log(`[TTClub] Room ${code} created, host=${id}`);
    } else {
        const room = ttclubRooms.get(requestedCode);
        if (!room) { ws.close(4007, 'Room does not exist.'); return; }
        if (room.sealed) { ws.close(4008, 'Room is sealed.'); return; }
        for (const [existingId, existingWs] of room.clients) {
            if (existingWs.readyState === WebSocket.OPEN) existingWs.send(`N: ${id}\n`);
            ws.send(`N: ${existingId}\n`);
        }
        room.clients.set(id, ws);
        const playerNum = room.players.size + 1;
        const color = TEAM_COLORS[(playerNum - 1) % TEAM_COLORS.length];
        room.players.set(id, { color, name: `Player ${playerNum}`, joinedAt: Date.now(), isHost: false });
        ws._tc.roomCode = requestedCode;
        ws.send(`J: ${requestedCode}\n`);
        console.log(`[TTClub] Peer ${id} joined room ${requestedCode}`);
    }
}

function ttclubHandleSeal(ws) {
    const { roomCode, id } = ws._tc;
    if (!roomCode) return;
    const room = ttclubRooms.get(roomCode);
    if (!room || room.hostId !== id) return;
    room.sealed = true;
    for (const [, clientWs] of room.clients) {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(`S: \n`);
    }
    console.log(`[TTClub] Room ${roomCode} sealed`);
}

function ttclubForward(fromWs, destId, msg) {
    const room = ttclubRooms.get(fromWs._tc.roomCode);
    if (!room) return;
    const destWs = room.clients.get(destId);
    if (destWs && destWs.readyState === WebSocket.OPEN) destWs.send(msg);
}

function ttclubHandleDisconnect(ws) {
    const { id, roomCode } = ws._tc;
    if (!roomCode || id === null) return;
    ws._tc.roomCode = null;
    const room = ttclubRooms.get(roomCode);
    if (!room) return;
    room.clients.delete(id);
    room.players.delete(id);
    for (const [, clientWs] of room.clients) {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(`D: ${id}\n`);
    }
    if (room.hostId === id || room.clients.size === 0) {
        if (room.hostId === id) {
            for (const [, clientWs] of room.clients) clientWs.close(4003, 'Host has disconnected.');
        }
        ttclubRooms.delete(roomCode);
        console.log(`[TTClub] Room ${roomCode} closed`);
    } else {
        console.log(`[TTClub] Peer ${id} left room ${roomCode}`);
    }
}
// ──────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Track server start time for deployment info
const SERVER_START_TIME = new Date();

// Airtable configuration
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appTD6mhx60nuMHtd';
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID || 'tblbareHvl8s0hjAg';
const AIRTABLE_PERSONAL_ACCESS_TOKEN = process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN || 'patWv1h9n2yFvE2h8j.4b8f9e6a3c2d1b0a9c8d7e6f5a4b3c2d1';
const AIRTABLE_JSON_FIELD = 'JSON'; // Field name for the JSON data
const AIRTABLE_NAME_FIELD = 'Name'; // Field name for the map name

// Local map folder configuration
const MAPS_FOLDER = path.join(__dirname, 'Constellation maps 2');

// Airtable API helper - handles pagination to get all records
async function fetchAirtableRecords() {
    try {
        let allRecords = [];
        let offset = null;

        do {
            const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`;
            const params = offset ? { offset } : {};

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${AIRTABLE_PERSONAL_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                params
            });

            allRecords = allRecords.concat(response.data.records);
            offset = response.data.offset; // Will be undefined if no more pages

        } while (offset);

        console.log(`📍 Fetched ${allRecords.length} total records from Airtable`);
        return allRecords;
    } catch (error) {
        console.error('Error fetching Airtable records:', error.response?.data || error.message);
        throw error;
    }
}

app.get('/api/maps', async (req, res) => {
    try {
        // Read all JSON files from the maps folder
        const files = fs.readdirSync(MAPS_FOLDER)
            .filter(file => file.endsWith('.json'))
            .sort(); // Sort alphabetically

        console.log(`📍 Found ${files.length} maps in local folder:`, files);
        res.json(files);
    } catch (error) {
        console.error('Error reading maps from local folder:', error);
        res.status(500).json({ error: 'Failed to read maps from local folder' });
    }
});

app.get('/api/maps/:filename', async (req, res) => {
    const filename = req.params.filename;
    console.log(`📍 Request for map: ${filename}`);

    try {
        // Security: Ensure filename has .json extension and doesn't contain path traversal
        if (!filename.endsWith('.json') || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            console.log(`❌ Invalid filename: ${filename}`);
            return res.status(400).json({ error: 'Invalid filename' });
        }

        const filePath = path.join(MAPS_FOLDER, filename);
        
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            console.log(`❌ Map file not found: ${filename}`);
            return res.status(404).json({ error: 'Map not found' });
        }

        // Read and parse the JSON file
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const jsonData = JSON.parse(fileContent);
        
        console.log(`✅ Serving map: ${filename}, stars: ${jsonData.stars?.length || 0}`);
        res.json(jsonData);

    } catch (error) {
        console.error('Error reading map file:', error);
        if (error instanceof SyntaxError) {
            res.status(500).json({ error: 'Invalid JSON in map file' });
        } else {
            res.status(500).json({ error: 'Failed to read map file' });
        }
    }
});

// Deployment timestamp endpoint - returns server start time
app.get('/api/deployment-info', (req, res) => {
    res.json({ deployedAt: SERVER_START_TIME.toISOString() });
});

// Schema definitions
class Player extends Schema {
    constructor() {
        super();
        this.id = '';
        this.name = '';
        this.team = null;
        this.ready = false;
        this.connected = true;
        this.connectedAt = 0;
        this.isHost = false;
        this.isBot = false;
    }
}

type('string')(Player.prototype, 'id');
type('string')(Player.prototype, 'name');
type('number')(Player.prototype, 'team');
type('boolean')(Player.prototype, 'ready');
type('boolean')(Player.prototype, 'connected');
type('number')(Player.prototype, 'connectedAt');
type('string')(Player.prototype, 'studentId');
type('number')(Player.prototype, 'movesLeft');
type('boolean')(Player.prototype, 'isBot');

class RoomState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.gameState = 'waiting';
        this.teams = new MapSchema();
        this.hostId = '';
        this.game = new GameStateSchema(); // Add game state
    }
}

type({ map: Player })(RoomState.prototype, 'players');
type('string')(RoomState.prototype, 'gameState');
type({ map: 'any' })(RoomState.prototype, 'teams');
type('string')(RoomState.prototype, 'hostId');
type(GameStateSchema)(RoomState.prototype, 'game');

// ConstellationRoom class
class ConstellationRoom extends Room {
    onCreate(options) {
        console.log('ConstellationRoom created with options:', options);

        // Initialize pause state early
        this.isPaused = false;
        this.pauseReason = '';
        this.currentTimeRemaining = 0;

        const state = new RoomState();
        state.gameState = 'waiting';
        state.hostId = '';
        this.setState(state);

        // Prevent room from disappearing when page is refreshed (empty room)
        this.autoDispose = false;

        this.maxClients = options.maxPlayers || 20;

        // Assign sequential session number from counter
        this.sessionNumber = this.getNextSessionNumber();
        // Ensure gameConfig has defaults so clients receive full settings
        this.gameConfig = {
            name: options.name || `Game ${this.roomId.substring(0, 6)}`,
            gameType: options.gameType || 'Constellation',
            roundLength: options.roundLength || 30,
            rounds: options.rounds || 10,
            countdownLength: options.countdownLength || 5,
            steals: options.steals || 50,
            headquarters: options.headquarters || 2,
            moves: options.moves || 15,
            multipliers: options.multipliers || { count: 500, distance: 1, hq: 10, destruction: 1 },
            aiBots: options.aiBots || [],
            sessionNumber: this.sessionNumber, // Add session number to config
            // Allow players to select their own team from the game client
            allowPlayerTeamSelection: options.allowPlayerTeamSelection !== undefined ? options.allowPlayerTeamSelection : false,
            // Dynamic team colors - synced from admin panel to all clients
            teamColors: options.teamColors || [
                { color: 0x00FFFF, name: 'cyan', displayName: 'Cyan' },
                { color: 0xFF00FF, name: 'magenta', displayName: 'Magenta' },
                { color: 0x00FF00, name: 'lime', displayName: 'Lime' },
                { color: 0xFFD700, name: 'gold', displayName: 'Gold' },
                { color: 0x0000FF, name: 'blue', displayName: 'Blue' },
                { color: 0xFF0000, name: 'red', displayName: 'Red' },
                { color: 0x006400, name: 'dark green', displayName: 'Dark Green' }
            ]
        };

        this.setMetadata({
            name: this.gameConfig.name,
            type: this.gameConfig.gameType,
            gameState: 'waiting',
            createdAt: new Date().toISOString(),
            maxPlayers: this.maxClients,
            clients: 0,
            sessionNumber: this.sessionNumber
        });

        // Listen for admin presence commands so the admin UI doesn't need to join game rooms
        if (this.presence) {
            this.presence.subscribe(`room_${this.roomId}`, (msg) => {
                try {
                    if (!msg || !msg.type) return;
                    if (msg.type === 'start_game') {
                        if (this.state.gameState === 'waiting') {
                            // Validate: Check if there are any human players (non-bot, non-admin)
                            let humanPlayerCount = 0;
                            this.state.players.forEach((player, id) => {
                                // Count only human players (not bots, not admin accounts)
                                if (!player.isBot && !id.startsWith('bot_') && !player.name.includes('Admin')) {
                                    humanPlayerCount++;
                                }
                            });

                            if (humanPlayerCount === 0) {
                                console.log(`❌ Cannot start game: No human players connected (only bots/admin)`);
                                // Notify admin that game cannot start
                                if (this.presence) {
                                    this.presence.publish('admin_update', {
                                        roomId: this.roomId,
                                        error: 'Cannot start game without human players',
                                        state: 'waiting'
                                    });
                                }
                                return;
                            }

                            console.log(`✅ Starting game with ${humanPlayerCount} human player(s)`);
                            this.state.gameState = 'playing';

                            // Initialize Round State
                            this.state.game.round = 1;

                            // CRITICAL: Register AI bots as players BEFORE distributing moves
                            this.registerBotPlayers();

                            // CRITICAL: Distribute moves when started via Admin presence (isGameStart = true)
                            this.distributeMoves(true);

                            this.broadcast('game_started', {
                                gameState: 'playing',
                                config: this.gameConfig,
                                currentRound: 1,
                                botPlayers: this.getBotPlayerIds()
                            });

                            // Start the Game Loop
                            this.startGameLoop();

                            this.setMetadata({ ...this.metadata, gameState: 'playing' });
                            this.updateAdminRoom();
                        }
                    } else if (msg.type === 'force_dispose') {
                        // lock and disconnect all clients, the room will auto-dispose
                        this.locked = true;
                        this.clients.forEach((c) => { try { c.leave(1000); } catch (e) { console.error('Error forcing client leave:', e); } });
                        setTimeout(() => this.updateAdminRoom(), 200);
                    } else if (msg.type === 'assign_team') {
                        // Only allow team assignment when game is waiting (not started)
                        if (this.state.gameState !== 'waiting') {
                            console.log(`❌ Team assignment rejected: game is ${this.state.gameState}, not waiting`);
                            return;
                        }

                        const player = this.state.players.get(msg.playerId);
                        if (player) {
                            player.team = (msg.teamIndex === null || msg.teamIndex === undefined || msg.teamIndex === '') ? null : parseInt(msg.teamIndex, 10);
                            this.updateAdminRoom();
                        }
                    } else if (msg.type === 'kick_player') {
                        const target = this.clients.find((c) => c.sessionId === msg.playerId);
                        if (target) {
                            try { target.leave(1000); } catch (e) { console.error('Error kicking player:', e); }
                        }
                        // Also remove from state if present
                        if (this.state.players.has(msg.playerId)) {
                            this.state.players.delete(msg.playerId);
                        }
                        this.updateAdminRoom();
                    } else if (msg.type === 'update_settings') {
                        // Merge provided settings into gameConfig
                        if (msg.settings) {
                            console.log(`📥 Received settings update for room ${this.roomId}:`, {
                                hasCustomMapFilename: msg.settings.customMapFilename !== undefined,
                                customMapFilename: msg.settings.customMapFilename || 'none'
                            });

                            // Deep merge multipliers if provided
                            if (msg.settings.multipliers) {
                                this.gameConfig.multipliers = { ...this.gameConfig.multipliers, ...msg.settings.multipliers };
                                delete msg.settings.multipliers;
                            }

                            // Handle map loading - fetch from Airtable if filename provided
                            const handleMapAndBroadcast = async () => {
                                // Check if customMapFilename is present and has a value
                                if (msg.settings.customMapFilename && msg.settings.customMapFilename !== '') {
                                    if (msg.settings.customMapFilename === '__manual_json__' && msg.settings.customMapJson) {
                                        // Manual JSON entry - parse and use directly
                                        try {
                                            this.gameConfig.customMap = JSON.parse(msg.settings.customMapJson);
                                            this.gameConfig.customMapFilename = '__manual_json__';
                                            console.log(`📍 Loaded manual map JSON for room ${this.roomId}`);
                                        } catch (e) {
                                            console.error(`❌ Failed to parse manual map JSON:`, e.message);
                                            this.gameConfig.customMap = null;
                                            this.gameConfig.customMapFilename = null;
                                        }
                                    } else {
                                        // Load map from local file system
                                        try {
                                            console.log(`📍 Loading map from local folder: ${msg.settings.customMapFilename}`);
                                            
                                            // Security: Ensure filename has .json extension and doesn't contain path traversal
                                            if (!msg.settings.customMapFilename.endsWith('.json') || 
                                                msg.settings.customMapFilename.includes('..') || 
                                                msg.settings.customMapFilename.includes('/') || 
                                                msg.settings.customMapFilename.includes('\\')) {
                                                console.error(`❌ Invalid map filename: ${msg.settings.customMapFilename}`);
                                                this.gameConfig.customMap = null;
                                                this.gameConfig.customMapFilename = null;
                                                return;
                                            }
                                            
                                            const filePath = path.join(MAPS_FOLDER, msg.settings.customMapFilename);
                                            
                                            // Check if file exists
                                            if (!fs.existsSync(filePath)) {
                                                console.error(`❌ Map file not found: ${msg.settings.customMapFilename}`);
                                                this.gameConfig.customMap = null;
                                                this.gameConfig.customMapFilename = null;
                                                return;
                                            }
                                            
                                            // Read and parse the JSON file
                                            const fileContent = fs.readFileSync(filePath, 'utf8');
                                            const mapData = JSON.parse(fileContent);
                                            
                                            this.gameConfig.customMap = mapData;
                                            this.gameConfig.customMapFilename = msg.settings.customMapFilename;
                                            console.log(`✅ Loaded map from local folder: ${msg.settings.customMapFilename}, stars: ${this.gameConfig.customMap.stars?.length || 0}`);
                                            
                                        } catch (e) {
                                            console.error(`❌ Failed to load map from local folder:`, e.message);
                                            this.gameConfig.customMap = null;
                                            this.gameConfig.customMapFilename = null;
                                        }
                                    }
                                } else if (msg.settings.customMapFilename === null || msg.settings.customMapFilename === '') {
                                    // Map was explicitly cleared
                                    console.log(`📍 Map cleared for room ${this.roomId}`);
                                    this.gameConfig.customMap = null;
                                    this.gameConfig.customMapFilename = null;
                                }
                                // If customMapFilename is undefined, don't touch the existing map

                                // Remove the temporary fields before merging
                                delete msg.settings.customMapFilename;
                                delete msg.settings.customMapJson;

                                // Merge other top-level settings
                                Object.assign(this.gameConfig, msg.settings);

                                // Update team steals if the steals setting changed
                                if (msg.settings.steals !== undefined && this.state.game.teams.length > 0) {
                                    const newStealLimit = parseInt(msg.settings.steals, 10);
                                    this.state.game.teams.forEach((team, index) => {
                                        team.stealsLeft = newStealLimit;
                                    });
                                    console.log(`� Updated all team steals to ${newStealLimit}`);
                                    
                                    // Broadcast steals update to all clients
                                    const teamUpdates = this.state.game.teams.map((team, index) => ({
                                        index: index,
                                        stealsLeft: newStealLimit
                                    }));
                                    this.broadcast('state_changed', { teams: teamUpdates });
                                }

                                // Sync AI bots when settings are updated (only during waiting phase)
                                if (this.state.gameState === 'waiting' && msg.settings.aiBots !== undefined) {
                                    this.syncBotPlayers();
                                }

                                // Broadcast update to all clients in the room
                                this.broadcast('settings_update', { config: this.gameConfig });
                                console.log(`📤 Broadcast settings to room ${this.roomId}, customMap:`, this.gameConfig.customMap ? `exists (${this.gameConfig.customMap.stars?.length || 0} stars)` : 'null');
                            };

                            // Execute async map loading
                            handleMapAndBroadcast().catch(err => {
                                console.error('Error in handleMapAndBroadcast:', err);
                            });
                        }
                    } else if (msg.type === 'pause_game') {
                        if (this.state.gameState === 'playing' && !this.isPaused) {
                            this.isPaused = true;
                            this.pauseReason = msg.reason || '';
                            console.log(`⏸️ Game paused in room ${this.roomId}. Reason: ${this.pauseReason}`);

                            this.broadcast('game_paused', {
                                reason: this.pauseReason,
                                announcement: this.pauseReason
                            });
                            try {
                                this.updateAdminRoom();
                            } catch (err) {
                                console.error('Error updating admin room after pause:', err);
                            }
                        }
                    } else if (msg.type === 'resume_game') {
                        if (this.state.gameState === 'playing' && this.isPaused) {
                            const countdownLength = (this.gameConfig.countdownLength || 5) * 1000;
                            console.log(`▶️ Game resuming in room ${this.roomId} with ${countdownLength}ms countdown`);

                            // Broadcast countdown start
                            this.broadcast('game_resuming', { countdown: this.gameConfig.countdownLength || 5 });

                            // Start countdown then resume
                            setTimeout(() => {
                                this.isPaused = false;
                                this.broadcast('game_resumed', {});
                                try {
                                    this.updateAdminRoom();
                                } catch (err) {
                                    console.error('Error updating admin room after resume:', err);
                                }
                                console.log(`▶️ Game resumed in room ${this.roomId}`);
                            }, countdownLength);
                        }
                    }
                } catch (e) {
                    console.error('Error handling presence message for room', this.roomId, e);
                }
            });
        }

        this.onMessage('join_team', (client, data) => {
            // Only allow team changes when game is waiting (not started)
            if (this.state.gameState !== 'waiting') {
                client.send('team_change_rejected', {
                    reason: 'game_started',
                    teamIndex: data.teamIndex
                });
                console.log(`❌ Team change rejected for ${client.sessionId}: game is ${this.state.gameState}, not waiting`);
                return;
            }

            // Check if player team selection is allowed
            if (!this.gameConfig.allowPlayerTeamSelection) {
                client.send('team_change_rejected', {
                    reason: 'not_allowed',
                    teamIndex: data.teamIndex
                });
                console.log(`❌ Team change rejected for ${client.sessionId}: player team selection not allowed`);
                return;
            }

            const player = this.state.players.get(client.sessionId);
            if (!player) return;

            const targetTeamIndex = data.teamIndex;

            // Check if target team already has players (other than the requesting player)
            let teamHasOtherPlayers = false;
            this.state.players.forEach((p, id) => {
                if (id !== client.sessionId && p.team === targetTeamIndex) {
                    teamHasOtherPlayers = true;
                }
            });

            if (teamHasOtherPlayers) {
                client.send('team_change_rejected', {
                    reason: 'team_occupied',
                    teamIndex: targetTeamIndex
                });
                console.log(`❌ Team change rejected for ${client.sessionId}: team ${targetTeamIndex} already has players`);
                return;
            }

            // Valid team change
            player.team = targetTeamIndex;
            client.send('team_change_accepted', { teamIndex: targetTeamIndex });
            this.updateAdminRoom();
            console.log(`✅ Player ${client.sessionId} joined team ${targetTeamIndex}`);
        });

        this.onMessage('update_name', (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (player && data.name) {
                player.name = data.name.trim().substring(0, 20); // Limit to 20 characters
                this.updateAdminRoom();
                console.log(`Player ${client.sessionId} updated name to: ${player.name}`);
            }
        });
        this.onMessage('start_game', (client, data) => {
            if (this.state.gameState === 'waiting') {
                this.state.gameState = 'playing';

                // CRITICAL: Register AI bots as players BEFORE distributing moves
                this.registerBotPlayers();

                // Distribute Initial Moves (isGameStart = true)
                this.distributeMoves(true);

                // Initialize Round State
                this.state.game.round = 1;

                this.broadcast('game_started', { 
                    gameState: 'playing', 
                    config: this.gameConfig, 
                    currentRound: 1, 
                    botPlayers: this.getBotPlayerIds()
                });

                // Start the Game Loop
                this.startGameLoop();

                // update monitor metadata to reflect new state
                this.setMetadata({ ...this.metadata, gameState: 'playing' });
                this.updateAdminRoom();
            }
        });

        // Pause game handler
        this.onMessage('pause_game', (client, data) => {
            if (this.state.gameState === 'playing' && !this.isPaused) {
                this.isPaused = true;
                this.pauseReason = data.reason || '';
                console.log(`⏸️ Game paused in room ${this.roomId}. Reason: ${this.pauseReason}`);

                this.broadcast('game_paused', {
                    reason: this.pauseReason,
                    announcement: this.pauseReason
                });
                this.updateAdminRoom();
            }
        });

        // Resume game handler
        this.onMessage('resume_game', (client, data) => {
            if (this.state.gameState === 'playing' && this.isPaused) {
                const countdownLength = (this.gameConfig.countdownLength || 5) * 1000;
                console.log(`▶️ Game resuming in room ${this.roomId} with ${countdownLength}ms countdown`);

                // Broadcast countdown start
                this.broadcast('game_resuming', { countdown: this.gameConfig.countdownLength || 5 });

                // Start countdown then resume
                setTimeout(() => {
                    this.isPaused = false;
                    this.broadcast('game_resumed', {});
                    this.updateAdminRoom();
                    console.log(`▶️ Game resumed in room ${this.roomId}`);
                }, countdownLength);
            }
        });

        // Game Loop Logic
        this.startGameLoop = () => {
            if (this.gameLoopInterval) clearInterval(this.gameLoopInterval);

            // Config
            const roundLength = (this.gameConfig.roundLength || 30) * 1000;
            const rounds = this.gameConfig.rounds || 10;

            let timeRemaining = this.savedTimeRemaining > 0 ? this.savedTimeRemaining : roundLength;
            this.savedTimeRemaining = 0;
            let inIntermission = false;

            console.log(`⏱️ Game loop started for room ${this.roomId}. Round length: ${roundLength}ms`);

            this.gameLoopInterval = setInterval(() => {
                // Check if game ended or disposed
                if (this.locked || this.state.gameState === 'ended' || this.state.gameState === 'finished') {
                    clearInterval(this.gameLoopInterval);
                    return;
                }

                // Check if paused
                if (this.isPaused) {
                    return; // Skip tick while paused
                }

                timeRemaining -= 1000;
                this.currentTimeRemaining = timeRemaining; // Store for pause/resume
                if (timeRemaining % 5000 === 0) console.log(`⏱️ Room ${this.roomId} Tick: ${timeRemaining}ms, Round: ${this.state.game.round}`);

                if (timeRemaining < 0) {
                    // Check game over (Round Limit Reached)
                    if (this.state.game.round >= rounds) {
                        console.log(`🏁 Game ended for room ${this.roomId}`);

                        // Calculate Winner - Support all teams, not just 0 and 1
                        const scores = {};
                        this.state.game.stars.forEach(s => {
                            if (s.tm !== -1) {
                                if (!scores[s.tm]) scores[s.tm] = 0;
                                scores[s.tm]++;
                            }
                        });

                        // Find the team with the highest score
                        let winningTeam = -1;
                        let highestScore = -1;
                        let tiedTeams = [];

                        for (const [teamId, score] of Object.entries(scores)) {
                            const teamIndex = parseInt(teamId);
                            if (score > highestScore) {
                                highestScore = score;
                                winningTeam = teamIndex;
                                tiedTeams = [teamIndex];
                            } else if (score === highestScore) {
                                tiedTeams.push(teamIndex);
                            }
                        }

                        // Only declare tie if there are actually multiple teams with the same highest score
                        if (tiedTeams.length > 1) {
                            winningTeam = -1; // Indicates tie
                        }

                        // Mark game as finished
                        this.state.gameState = 'finished';
                        this.setMetadata({ ...this.metadata, gameState: 'finished' });
                        this.updateAdminRoom();

                        this.broadcast('game_ended', {
                            finalRound: this.state.game.round,
                            winningTeam: winningTeam,
                            scores: scores,
                            stars: this.state.game.stars.map(s => ({ tm: s.tm, hq: s.hq, pr: s.pr, destroyed: s.destroyed }))
                        });
                        clearInterval(this.gameLoopInterval);
                        return;
                    }

                    // INSTANT ROUND TRANSITION (No Intermission)
                    this.state.game.round++;
                    timeRemaining = roundLength;
                    console.log(`🚀 Round ${this.state.game.round} starting. Replenishing moves.`);

                    // REPLENISH MOVES
                    this.distributeMoves(false);

                    // Get updated moves for broadcast to ensure INSTANT UI update
                    const playerMoves = {};
                    this.state.players.forEach((p, sessionId) => {
                        playerMoves[sessionId] = p.movesLeft;
                    });

                    // Broadcast new round AND moves immediately
                    this.broadcast('round_started', {
                        currentRound: this.state.game.round,
                        playerMoves: playerMoves
                    });

                } else {
                    // Timer Update
                    this.broadcast('time_update', {
                        timeRemaining: timeRemaining,
                        currentRound: this.state.game.round,
                        state: 'playing' // Always playing
                    });

                    // Broadcast authoritative scores every 5 seconds to prevent client drift
                    if (timeRemaining % 5000 === 0) {
                        this.broadcastAuthoritativeScores();
                    }
                }
            }, 1000);
        };


        // Cursor movement throttling - limit broadcasts to reduce network overhead
        this.cursorThrottleMap = new Map(); // Track last broadcast time per client
        const CURSOR_THROTTLE_MS = 50; // Only broadcast cursor every 50ms per player

        // Broadcast cursor movements to all other players (throttled)
        this.onMessage('cursor_move', (client, data) => {
            const now = Date.now();
            const lastBroadcast = this.cursorThrottleMap.get(client.sessionId) || 0;
            
            // Throttle: only broadcast if enough time has passed
            if (now - lastBroadcast >= CURSOR_THROTTLE_MS) {
                this.broadcast('cursor_move', {
                    playerId: client.sessionId,
                    x: data.x,
                    y: data.y,
                    teamIndex: data.teamIndex
                }, { except: client });
                this.cursorThrottleMap.set(client.sessionId, now);
            }
        });

        // Broadcast pointer effects to all other players
        this.onMessage('pointer_effect', (client, data) => {
            this.broadcast('pointer_effect', {
                playerId: client.sessionId,
                x: data.x,
                y: data.y,
                teamIndex: data.teamIndex
            }, { except: client });
        });

        // Game state synchronization - claim_star
        this.onMessage('claim_star', (client, data) => {
            // Support bot moves: if botId is provided, use bot player; otherwise use client player
            let player;
            if (data.botId && this.state.players.has(data.botId)) {
                player = this.state.players.get(data.botId);
                console.log(`🤖 Bot ${data.botId} claiming star ${data.starIndex}`);
            } else {
                player = this.state.players.get(client.sessionId);
            }
            if (!player || player.team === null) return;

            const teamIndex = player.team;
            const team = this.state.game.teams[teamIndex];

            // Server-side authority: Determine if this is an HQ placement
            // First N moves (defined by limit) MUST be HQs
            const hqLimit = parseInt(this.gameConfig.headquarters || 2, 10);
            const isHQ = team && (team.hqCount < hqLimit);

            // Check player has moves left BEFORE validation
            if (player.movesLeft <= 0) {
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: 'No moves remaining',
                    refund: { moves: 0 },
                    botId: data.botId
                });
                console.log(`❌ Claim rejected for star ${data.starIndex}: No moves remaining (player: ${player.id})`);
                return;
            }

            // Use correct validation method
            let validation;
            if (isHQ) {
                validation = this.validateHQ(data.starIndex, teamIndex);
            } else {
                validation = this.validateClaim(data.starIndex, teamIndex);
            }

            if (validation.valid) {
                // Decrement player moves
                player.movesLeft--;

                // Track team moves sum (optional but good for consistency)
                if (team) {
                    team.movesLeft--;
                    if (isHQ) team.hqCount++;
                }

                // Update authoritative server state so all clients and late joiners stay in sync
                if (this.state.game.initialized && data.starIndex >= 0 && data.starIndex < this.state.game.stars.length) {
                    const star = this.state.game.stars[data.starIndex];
                    star.tm = teamIndex;
                    star.hq = isHQ;
                }

                const starUpdate = { index: data.starIndex, tm: teamIndex, hq: isHQ };
                const teamUpdate = { index: teamIndex, movesLeft: -1 };
                if (isHQ) teamUpdate.hqCount = 1;

                const stateChange = { stars: [starUpdate], teams: [teamUpdate] };
                if (data.botId) {
                    stateChange.botMove = { botId: data.botId, movesLeft: player.movesLeft };
                }

                this.broadcast('state_changed', stateChange);
                // Score broadcast removed - handled by 5-second timer for performance

                console.log(`✅ Star ${data.starIndex} claimed by team ${teamIndex}${isHQ ? ' (HQ)' : ''} (player: ${player.id})`);

                // Check for special star activations after the move
                // Check wormhole first - it takes priority over blackhole
                const wormholeWin = this.checkWormHoleActivation(teamIndex);
                if (wormholeWin) {
                    this.state.gameState = 'ended';
                    
                    // Stop the timer immediately
                    this.broadcast('time_update', {
                        timeRemaining: 0,
                        currentRound: this.state.game.round,
                        state: 'ended'
                    });
                    
                    this.broadcast('game_ended', {
                        winner: teamIndex,
                        reason: 'wormhole',
                        message: `Team ${teamIndex} wins by connecting wormholes!`,
                        stars: this.state.game.stars.map(s => ({ tm: s.tm, hq: s.hq, pr: s.pr, destroyed: s.destroyed }))
                    });
                } else {
                    // Only check blackhole if wormhole didn't trigger
                    this.checkBlackHoleActivation(teamIndex);
                }
            } else {
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: validation.reason,
                    refund: { moves: 1 },
                    botId: data.botId
                });
                console.log(`❌ Claim rejected for star ${data.starIndex}: ${validation.reason}`);
            }
        });

        // Game state synchronization - steal_star
        this.onMessage('steal_star', (client, data) => {
            // Support bot moves: if botId is provided, use bot player; otherwise use client player
            let player;
            if (data.botId && this.state.players.has(data.botId)) {
                player = this.state.players.get(data.botId);
                console.log(`🤖 Bot ${data.botId} stealing star ${data.starIndex}`);
            } else {
                player = this.state.players.get(client.sessionId);
            }
            if (!player || player.team === null) return;

            const teamIndex = player.team;
            const team = this.state.game.teams[teamIndex];

            // Check player has moves left BEFORE validation
            if (player.movesLeft <= 0) {
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: 'No moves remaining',
                    refund: { moves: 0, steals: 0 },
                    botId: data.botId
                });
                console.log(`❌ Steal rejected for star ${data.starIndex}: No moves remaining (player: ${player.id})`);
                return;
            }

            // Server-side authority: Determine if this is an HQ placement/upgrade
            const hqLimit = parseInt(this.gameConfig.headquarters || 2, 10);
            const isHQ = team && (team.hqCount < hqLimit);

            let validation = this.validateSteal(data.starIndex, teamIndex);

            // Extra check for HQ limit if upgrading to HQ on steal (Redundant but safe)
            if (validation.valid && isHQ) {
                if (team && team.hqCount >= hqLimit) {
                    validation = { valid: false, reason: 'HQ limit reached' };
                }
            }

            if (validation.valid) {
                // Decrement moves and steals
                player.movesLeft--;
                if (team) {
                    team.movesLeft--;
                    // Ensure steals don't go below 0
                    if (team.stealsLeft > 0) {
                        team.stealsLeft--;
                    }
                    if (isHQ) team.hqCount++;
                }

                // Update authoritative server state
                if (this.state.game.initialized && data.starIndex >= 0 && data.starIndex < this.state.game.stars.length) {
                    const star = this.state.game.stars[data.starIndex];
                    star.tm = teamIndex;
                    star.hq = isHQ;
                }

                const starUpdate = { index: data.starIndex, tm: teamIndex, hq: isHQ, stolen: true };
                // Only send steal decrement if steals were actually decremented
                const teamUpdate = { index: teamIndex, movesLeft: -1 };
                if (team && team.stealsLeft >= 0) {
                    teamUpdate.stealsLeft = -1;
                }
                if (isHQ) teamUpdate.hqCount = 1;

                const stateChange = { stars: [starUpdate], teams: [teamUpdate] };
                if (data.botId) {
                    stateChange.botMove = { botId: data.botId, movesLeft: player.movesLeft };
                }

                this.broadcast('state_changed', stateChange);
                // Score broadcast removed - handled by 5-second timer for performance

                console.log(`✅ Star ${data.starIndex} stolen by team ${teamIndex}${isHQ ? ' (HQ)' : ''} (player: ${player.id})`);

                // Check for special star activations after the move
                // Check wormhole first - it takes priority over blackhole
                const wormholeWin = this.checkWormHoleActivation(teamIndex);
                if (wormholeWin) {
                    this.state.gameState = 'ended';
                    
                    // Stop the timer immediately
                    this.broadcast('time_update', {
                        timeRemaining: 0,
                        currentRound: this.state.game.round,
                        state: 'ended'
                    });
                    
                    this.broadcast('game_ended', {
                        winner: teamIndex,
                        reason: 'wormhole',
                        message: `Team ${teamIndex} wins by connecting wormholes!`,
                        stars: this.state.game.stars.map(s => ({ tm: s.tm, hq: s.hq, pr: s.pr, destroyed: s.destroyed }))
                    });
                } else {
                    // Only check blackhole if wormhole didn't trigger
                    this.checkBlackHoleActivation(teamIndex);
                }
            } else {
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: validation.reason,
                    refund: { moves: 1, steals: 0 },
                    botId: data.botId
                });
                console.log(`❌ Steal rejected for star ${data.starIndex}: ${validation.reason}`);
            }
        });

        // Game state synchronization - place_hq
        this.onMessage('place_hq', (client, data) => {
            // Support bot moves: if botId is provided, use bot player; otherwise use client player
            let player;
            if (data.botId && this.state.players.has(data.botId)) {
                player = this.state.players.get(data.botId);
                console.log(`🤖 Bot ${data.botId} placing HQ at star ${data.starIndex}`);
            } else {
                player = this.state.players.get(client.sessionId);
            }
            if (!player || player.team === null) return;

            const teamIndex = player.team;

            // Check player has moves left BEFORE validation
            if (player.movesLeft <= 0) {
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: 'No moves remaining',
                    refund: { moves: 0 },
                    botId: data.botId
                });
                console.log(`❌ HQ placement rejected for star ${data.starIndex}: No moves remaining (player: ${player.id})`);
                return;
            }

            const validation = this.validateHQ(data.starIndex, teamIndex);

            if (validation.valid) {
                // Decrement player moves
                player.movesLeft--;

                if (this.state.game.teams[teamIndex]) {
                    this.state.game.teams[teamIndex].movesLeft--;
                    this.state.game.teams[teamIndex].hqCount++;
                }

                // Update authoritative server state
                if (this.state.game.initialized && data.starIndex >= 0 && data.starIndex < this.state.game.stars.length) {
                    const star = this.state.game.stars[data.starIndex];
                    star.tm = teamIndex;
                    star.hq = true;
                }

                const stateChange = {
                    stars: [{ index: data.starIndex, tm: teamIndex, hq: true }],
                    teams: [{ index: teamIndex, movesLeft: -1, hqCount: 1 }]
                };
                if (data.botId) {
                    stateChange.botMove = { botId: data.botId, movesLeft: player.movesLeft };
                }

                this.broadcast('state_changed', stateChange);
                // Score broadcast removed - handled by 5-second timer for performance

                console.log(`✅ HQ placed at star ${data.starIndex} by team ${teamIndex} (player: ${player.id})`);

                // Check for special star activations after the move
                // Check wormhole first - it takes priority over blackhole
                const wormholeWin = this.checkWormHoleActivation(teamIndex);
                if (wormholeWin) {
                    this.state.gameState = 'ended';
                    
                    // Stop the timer immediately
                    this.broadcast('time_update', {
                        timeRemaining: 0,
                        currentRound: this.state.game.round,
                        state: 'ended'
                    });
                    
                    this.broadcast('game_ended', {
                        winner: teamIndex,
                        reason: 'wormhole',
                        message: `Team ${teamIndex} wins by connecting wormholes!`,
                        stars: this.state.game.stars.map(s => ({ tm: s.tm, hq: s.hq, pr: s.pr, destroyed: s.destroyed }))
                    });
                } else {
                    // Only check blackhole if wormhole didn't trigger
                    this.checkBlackHoleActivation(teamIndex);
                }
            } else {
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: validation.reason,
                    refund: { moves: 1 },
                    botId: data.botId
                });
                console.log(`❌ HQ placement rejected for star ${data.starIndex}: ${validation.reason}`);
            }
        });

        // Handle player leaving with move transfer choice
        // Player can choose to transfer remaining moves to teammates or forfeit them
        this.onMessage('player_leaving', (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (!player) return;

            const transferMoves = data.transferMoves === true;
            const movesToTransfer = player.movesLeft || 0;
            const teamIndex = player.team;

            console.log(`👋 Player ${client.sessionId} leaving. Transfer moves: ${transferMoves}, Moves: ${movesToTransfer}`);

            if (transferMoves && movesToTransfer > 0 && teamIndex !== null && teamIndex !== undefined) {
                // Find other players on the same team (excluding bots and the leaving player)
                const teammates = [];
                this.state.players.forEach((p, id) => {
                    if (id !== client.sessionId && p.team === teamIndex && !id.startsWith('bot_')) {
                        teammates.push(p);
                    }
                });

                if (teammates.length > 0) {
                    // Distribute moves evenly among teammates
                    const movesPerPlayer = Math.floor(movesToTransfer / teammates.length);
                    const remainder = movesToTransfer % teammates.length;

                    teammates.forEach((teammate, idx) => {
                        const bonus = idx < remainder ? 1 : 0; // Distribute remainder
                        teammate.movesLeft += movesPerPlayer + bonus;
                    });

                    console.log(`✅ Transferred ${movesToTransfer} moves to ${teammates.length} teammates on team ${teamIndex}`);

                    // Broadcast move transfer to all clients
                    this.broadcast('moves_transferred', {
                        fromPlayer: client.sessionId,
                        toTeam: teamIndex,
                        movesTransferred: movesToTransfer,
                        teammateCount: teammates.length
                    });
                } else {
                    console.log(`⚠️ No teammates to transfer moves to on team ${teamIndex}`);
                }
            }

            // Mark player as leaving (will be removed in onLeave)
            player.connected = false;
        });

        // Initialize game state when game starts
        this.onMessage('init_game_state', (client, data) => {
            try {
                console.log(`📥 Received init_game_state from ${client.sessionId}:`, {
                    starsCount: data.stars?.length,
                    teamsCount: data.teams?.length,
                    initialized: this.state.game.initialized
                });

                if (!this.state.game.initialized && data.stars && data.teams) {
                    // Initialize stars with server-generated requirements for special stars
                    data.stars.forEach((starData, index) => {
                        const star = new StarSchema();
                        star.x = starData.x;
                        star.y = starData.y;
                        star.ty = starData.ty;
                        star.tm = starData.tm !== null && starData.tm !== undefined ? starData.tm : -1;
                        star.hq = starData.hq || false;
                        star.pr = starData.pr || false;
                        star.destroyed = starData.destroyed || false;

                        // Set requirements for special stars to minimum value
                        // For black holes (ty=2) and wormholes (ty=3), use min_value or default to 2
                        // Type mapping: 0=Normal, 1=Cluster, 2=Black hole, 3=Wormhole
                        if (starData.ty === 2 || starData.ty === 3) {
                            star.req = starData.min_value || 2;
                            console.log(`✓ Set req=${star.req} for ${starData.ty === 2 ? 'black hole' : 'wormhole'} at index ${index}`);
                        } else {
                            star.req = starData.req || 0;
                        }

                        this.state.game.stars.push(star);
                    });

                    // Initialize teams
                    data.teams.forEach((teamData, index) => {
                        const team = new TeamSchema();
                        team.movesLeft = teamData.movesLeft || 0;
                        team.stealsLeft = teamData.stealsLeft || 0;
                        team.hqCount = teamData.hqCount || 0;
                        this.state.game.teams.push(team);
                    });

                    this.state.game.initialized = true;
                    console.log(`✅ Game state initialized for room ${this.roomId}: ${this.state.game.stars.length} stars, ${this.state.game.teams.length} teams`);

                    // Broadcast server-generated requirements to all clients
                    const starRequirements = this.state.game.stars
                        .map((star, index) => ({ index, req: star.req, ty: star.ty }))
                        .filter(s => s.ty === 2 || s.ty === 3); // Only special stars

                    if (starRequirements.length > 0) {
                        this.broadcast('star_requirements', { requirements: starRequirements });
                        console.log(`📡 Broadcast ${starRequirements.length} star requirements to all clients`);
                    }
                } else {
                    console.log(`⚠️ Game state already initialized or invalid data for room ${this.roomId}`);
                }
            } catch (error) {
                console.error(`❌ Error initializing game state for room ${this.roomId}:`, error);
                console.error('Error stack:', error.stack);
                // Don't disconnect client, just log the error
            }
        });

        // Handle player state requests (for move synchronization)
        this.onMessage('request_player_state', (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (player) {
                // Send current player state back to the requesting client
                client.send('player_state_update', {
                    movesLeft: player.movesLeft,
                    team: player.team,
                    name: player.name
                });
                console.log(`📤 Sent player state update to ${client.sessionId}: moves=${player.movesLeft}, team=${player.team}`);
            }
        });

        // Allow admin-side deletion by forcing all clients to leave (room will auto-dispose)
        this.onMessage('force_dispose', () => {
            try {
                this.locked = true;
                // Disconnect all clients
                this.clients.forEach((c) => {
                    try { c.leave(1000); } catch (e) { console.error('Error forcing client leave:', e); }
                });
                setTimeout(() => this.updateAdminRoom(), 200);
            } catch (e) {
                console.error('Failed to force dispose room:', e);
            }
        });

        setTimeout(() => this.updateAdminRoom(), 100);
    }

    onDispose() {
        if (this.gameLoopInterval) {
            clearInterval(this.gameLoopInterval);
        }
        console.log(`Room ${this.roomId} disposed`);
    }

    distributeMoves(isGameStart = false) {
        try {
            // Distribute moves for ALL teams
            const teams = {}; // teamIndex -> [players]
            this.state.players.forEach(p => {
                if (p.team !== null) {
                    if (!teams[p.team]) teams[p.team] = [];
                    teams[p.team].push(p);
                }
            });

            const totalMoves = this.gameConfig.moves || 15;
            console.log(`📊 Distributing ${totalMoves} moves per team. Teams found:`, Object.keys(teams));

            Object.keys(teams).forEach(teamIdxStr => {
                const teamIdx = parseInt(teamIdxStr); // Ensure integer index
                const players = teams[teamIdxStr];
                if (players.length === 0) return;

                // ENSURE TEAM OBJECT EXISTS in state
                // If the game state hasn't been initialized by a client map load yet,
                // we must initialize the team entry to track moves and HQs safely.
                while (this.state.game.teams.length <= teamIdx) {
                    const newTeam = new TeamSchema();
                    newTeam.hqCount = 0; // Explicitly 0
                    this.state.game.teams.push(newTeam);
                }

                // Reset team moves sum and resources
                if (this.state.game.teams[teamIdx]) {
                    this.state.game.teams[teamIdx].movesLeft = totalMoves;

                    // ON GAME START ONLY: Reset shared resources
                    if (isGameStart) {
                        this.state.game.teams[teamIdx].hqCount = 0;
                        const stealLimit = parseInt(this.gameConfig.steals || 15, 10);
                        this.state.game.teams[teamIdx].stealsLeft = stealLimit;
                        
                        // Broadcast steals initialization to all clients
                        this.broadcast('state_changed', {
                            teams: [{
                                index: teamIdx,
                                stealsLeft: stealLimit
                            }]
                        });
                        console.log(`🔄 Initialized team ${teamIdx} steals to ${stealLimit}`);
                    }
                }

                const base = Math.floor(totalMoves / players.length);
                let remainder = totalMoves % players.length;

                // Shuffle players for random distribution of remainder
                const shuffled = players.sort(() => Math.random() - 0.5);

                shuffled.forEach(p => {
                    const allocatedMoves = base + (remainder > 0 ? 1 : 0);
                    p.movesLeft = allocatedMoves;
                    remainder--;

                    // Log bot move allocation
                    if (p.isBot || p.id.startsWith('bot_')) {
                        console.log(`🤖 Bot ${p.id} allocated ${allocatedMoves} moves (team ${teamIdx})`);
                    }

                    // FORCE SYNC: Send direct message to client to ensure UI updates
                    const client = this.clients.find(c => c.sessionId === p.id);
                    if (client) {
                        client.send('update_moves', { moves: allocatedMoves });
                    }
                });
                console.log(`Distributed ${totalMoves} moves to Team ${teamIdx} (${players.length} players):`, players.map(p => `${p.id}:${p.movesLeft}`));
            });
        } catch (error) {
            console.error('❌ Error distributing moves:', error);
        }
    }

    // Register AI bots as players in the game state
    // This ensures bots are treated identically to human players for move distribution
    registerBotPlayers() {
        const aiBots = this.gameConfig.aiBots || [];
        if (aiBots.length === 0) {
            console.log(`🤖 No AI bots configured for room ${this.roomId}`);
            return;
        }

        // Check if bots are already registered (from syncBotPlayers during waiting phase)
        let existingBotCount = 0;
        this.state.players.forEach((player, id) => {
            if (id.startsWith('bot_') || player.isBot) {
                existingBotCount++;
            }
        });

        if (existingBotCount > 0) {
            console.log(`🤖 ${existingBotCount} bots already registered for room ${this.roomId}, skipping registration`);
            return;
        }

        console.log(`🤖 Registering ${aiBots.length} AI bots for room ${this.roomId}`);
        this._createBotPlayers(aiBots);
        this.updateAdminRoom();
    }

    // Sync AI bots with current config (add new bots, remove deleted bots, update existing)
    // Called when settings are updated during waiting phase
    syncBotPlayers() {
        const aiBots = this.gameConfig.aiBots || [];

        // Get current bot IDs
        const currentBotIds = [];
        this.state.players.forEach((player, id) => {
            if (id.startsWith('bot_') || player.isBot) {
                currentBotIds.push(id);
            }
        });

        // Remove all existing bots first (clean slate approach for simplicity)
        currentBotIds.forEach(botId => {
            this.state.players.delete(botId);
            console.log(`🤖 Removed bot: ${botId}`);
        });

        // Add bots from current config
        if (aiBots.length > 0) {
            console.log(`🤖 Syncing ${aiBots.length} AI bots for room ${this.roomId}`);
            this._createBotPlayers(aiBots);
        } else {
            console.log(`🤖 No AI bots in config for room ${this.roomId}`);
        }

        this.updateAdminRoom();
    }

    // Internal helper to create bot Player objects - eliminates code duplication
    _createBotPlayers(aiBots) {
        aiBots.forEach((botConfig, index) => {
            const botId = `bot_${index}_${Date.now()}`;

            const botPlayer = new Player();
            botPlayer.id = botId;
            botPlayer.name = `${botConfig.type || 'AI'} Bot ${index + 1}`;
            botPlayer.studentId = '';
            botPlayer.team = botConfig.teamIndex !== undefined ? botConfig.teamIndex : index % 7;
            botPlayer.ready = true;
            botPlayer.connected = true; // Bots are always "connected"
            botPlayer.connectedAt = Date.now();
            botPlayer.isHost = false;
            botPlayer.isBot = true; // Mark as bot for identification
            botPlayer.movesLeft = 0; // Will be set by distributeMoves

            this.state.players.set(botId, botPlayer);
            console.log(`🤖 Created bot: ${botPlayer.name} (ID: ${botId}) on Team ${botPlayer.team}`);
        });
    }

    // Get list of bot player IDs for client-side bot initialization
    getBotPlayerIds() {
        const botIds = [];
        const aiBots = this.gameConfig.aiBots || [];
        let botIndex = 0;

        this.state.players.forEach((player, id) => {
            if (id.startsWith('bot_')) {
                const botConfig = aiBots[botIndex] || {};
                const botData = {
                    id: id,
                    name: player.name,
                    team: player.team,
                    type: botConfig.type || 'HAL',
                    aggression: botConfig.aggression || 5,
                    movesLeft: player.movesLeft,
                    customConfig: botConfig.customConfig || null // Pass custom config if present
                };
                botIds.push(botData);
                console.log(`🤖 getBotPlayerIds: Bot ${id} has ${player.movesLeft} moves (team ${player.team})`);
                botIndex++;
            }
        });
        console.log(`🤖 getBotPlayerIds returning ${botIds.length} bots:`, botIds.map(b => `${b.id}:${b.movesLeft}`));
        return botIds;
    }

    // Get next sequential session number from persistent counter
    getNextSessionNumber() {
        const counterPath = path.join(__dirname, 'game_counter.json');
        try {
            let counterData = { counter: 1 };
            if (fs.existsSync(counterPath)) {
                const fileContent = fs.readFileSync(counterPath, 'utf8');
                counterData = JSON.parse(fileContent);
            }
            const sessionNumber = counterData.counter;
            counterData.counter++;
            fs.writeFileSync(counterPath, JSON.stringify(counterData, null, 2));
            console.log(`📊 Assigned session number: ${sessionNumber}`);
            return sessionNumber;
        } catch (error) {
            console.error('Error managing session counter:', error);
            return Date.now(); // Fallback to timestamp
        }
    }

    onJoin(client, options) {
        console.log(`Player ${client.sessionId} joined room ${this.roomId}`);

        const isFirstPlayer = this.state.players.size === 0;
        if (isFirstPlayer) {
            this.state.hostId = client.sessionId;
        }

        const player = new Player();
        player.id = client.sessionId;
        player.name = options.name || `Player ${client.sessionId.substring(0, 6)}`;
        player.studentId = options.studentId || '';
        player.team = null; // Unassigned - player must select team or admin assigns them
        player.ready = false;
        player.connected = true;
        player.connectedAt = Date.now();
        player.isHost = isFirstPlayer;

        this.state.players.set(client.sessionId, player);

        // CRITICAL: Send current game config to the new player so they get the correct map and settings
        client.send('settings_update', { config: this.gameConfig });
        console.log(`📤 Sent current config to new player ${client.sessionId}, customMap:`, this.gameConfig.customMap ? `exists (${this.gameConfig.customMap.title || 'untitled'})` : 'null');

        // If game is already running, send game_started to late joiner
        if (this.state.gameState === 'playing') {
            console.log(`🎮 Late joiner ${client.sessionId} - sending game_started message`);

            // Give them base moves for the current round
            const totalMoves = this.gameConfig.moves || 15;
            player.movesLeft = Math.floor(totalMoves / 2); // Give them half the moves to be fair

            // Send game_started message with current round info
            client.send('game_started', {
                gameState: 'playing',
                config: this.gameConfig,
                currentRound: this.state.game.round || 1,
                botPlayers: this.getBotPlayerIds(),
                lateJoin: true // Flag to indicate this is a late join
            });

            // Also send current time remaining if available
            if (this.currentTimeRemaining > 0) {
                client.send('time_update', {
                    timeRemaining: this.currentTimeRemaining,
                    currentRound: this.state.game.round || 1,
                    state: 'playing'
                });
            }
        }

        // keep monitor metadata in sync with game state
        this.setMetadata({ ...this.metadata, clients: this.clients.length });
        this.updateAdminRoom();
    }

    onLeave(client, consented) {
        console.log(`Player ${client.sessionId} left room ${this.roomId}`);
        
        // Clean up cursor throttle tracking
        if (this.cursorThrottleMap) {
            this.cursorThrottleMap.delete(client.sessionId);
        }
        this.state.players.delete(client.sessionId);
        // update monitor metadata clients count
        this.setMetadata({ ...this.metadata, clients: this.clients.length });
        this.updateAdminRoom();
    }

    // Validation methods for server-authoritative game state
    // NOTE: Player move checks (player.movesLeft) are done in message handlers BEFORE calling these
    // These validation functions check GAME RULES only (star state, team limits, etc.)
    // This separation ensures:
    // 1. Handlers check player-specific limits (movesLeft)
    // 2. Validators check game-rule constraints (star ownership, steal limits, HQ limits)

    validateClaim(starIndex, teamIndex) {
        // Basic index validation
        if (starIndex < 0 || teamIndex < 0) {
            return { valid: false, reason: 'Invalid indices' };
        }

        // If game state not initialized yet, allow the move (client-side validation already passed)
        if (!this.state.game.initialized) {
            return { valid: true };
        }

        if (starIndex >= this.state.game.stars.length) {
            return { valid: false, reason: 'Invalid star index' };
        }

        const star = this.state.game.stars[starIndex];
        const team = this.state.game.teams[teamIndex];

        if (!team) {
            return { valid: false, reason: 'Invalid team index' };
        }

        if (star.destroyed) {
            return { valid: false, reason: 'Star is destroyed' };
        }

        if (star.tm !== -1) {
            return { valid: false, reason: 'Star already owned' };
        }

        // NOTE: player.movesLeft is checked in the message handler, not here
        // This keeps validation functions pure (no player context needed)

        return { valid: true };
    }

    validateSteal(starIndex, teamIndex) {
        if (starIndex < 0 || teamIndex < 0) {
            return { valid: false, reason: 'Invalid indices' };
        }

        // If game state not initialized yet, allow the move
        if (!this.state.game.initialized) {
            return { valid: true };
        }

        if (starIndex >= this.state.game.stars.length) {
            return { valid: false, reason: 'Invalid star index' };
        }

        const star = this.state.game.stars[starIndex];
        const team = this.state.game.teams[teamIndex];

        if (!team) {
            return { valid: false, reason: 'Invalid team index' };
        }

        if (star.destroyed) {
            return { valid: false, reason: 'Star is destroyed' };
        }

        if (star.tm === -1) {
            return { valid: false, reason: 'Cannot steal unclaimed star' };
        }

        if (star.tm === teamIndex) {
            return { valid: false, reason: 'Cannot steal own star' };
        }

        if (star.hq) {
            return { valid: false, reason: 'Cannot steal HQ' };
        }

        if (star.pr) {
            return { valid: false, reason: 'Star is protected' };
        }

        // Type 1 = cluster, Type 2 = blackhole
        if (star.ty === 1 || star.ty === 2) {
            return { valid: false, reason: 'Cannot steal cluster or blackhole' };
        }

        if (team.stealsLeft <= 0) {
            return { valid: false, reason: 'No steals remaining' };
        }

        // Steals consume 1 move from PLAYER, 1 steal from TEAM
        // We check player moves in handler or here via context if passed
        // Since we don't pass player context here, we assume handler checks player.movesLeft

        return { valid: true };
    }

    validateHQ(starIndex, teamIndex) {
        if (starIndex < 0 || teamIndex < 0) {
            return { valid: false, reason: 'Invalid indices' };
        }

        // If game state not initialized yet, allow the move
        if (!this.state.game.initialized) {
            return { valid: true };
        }

        if (starIndex >= this.state.game.stars.length) {
            return { valid: false, reason: 'Invalid star index' };
        }

        const star = this.state.game.stars[starIndex];
        const team = this.state.game.teams[teamIndex];

        if (!team) {
            return { valid: false, reason: 'Invalid team index' };
        }

        if (star.destroyed) {
            return { valid: false, reason: 'Star is destroyed' };
        }

        if (star.tm !== -1 && star.tm !== teamIndex) {
            return { valid: false, reason: 'Cannot place HQ on enemy star' };
        }

        // Assuming HQ limit is 2 (from gameConfig.headquarters)
        const hqLimit = parseInt(this.gameConfig.headquarters || 2, 10);
        if (team.hqCount >= hqLimit) {
            return { valid: false, reason: 'HQ limit reached' };
        }

        // HQ consumes 1 move from PLAYER, increments TEAM HQ count

        return { valid: true };
    }

    // Check for black hole activation and handle destruction
    checkBlackHoleActivation(teamIndex) {
        if (!this.state.game.initialized) return;

        const stars = this.state.game.stars;
        const lines = this.state.game.lines;

        // Build adjacency cache
        const adjacency = Array(stars.length).fill(null).map(() => []);
        lines.forEach(line => {
            if (!line.destroyed) {
                adjacency[line.f].push(line.t);
                adjacency[line.t].push(line.f);
            }
        });

        // Find all black holes fulfilled by this team
        const fulfilledBlackHoles = [];

        for (let i = 0; i < stars.length; i++) {
            const star = stars[i];
            if (star.ty === 2 && !star.destroyed) { // Type 2 = black hole
                const connectedBlackHoles = this.countConnectedBlackHoles(i, teamIndex, adjacency);
                if (connectedBlackHoles >= star.req) {
                    fulfilledBlackHoles.push(i);
                }
            }
        }

        // If 2+ black holes are fulfilled and connected, destroy paths between them
        if (fulfilledBlackHoles.length >= 2) {
            for (let i = 0; i < fulfilledBlackHoles.length; i++) {
                for (let j = i + 1; j < fulfilledBlackHoles.length; j++) {
                    const path = this.findPathBetweenBlackHoles(
                        fulfilledBlackHoles[i],
                        fulfilledBlackHoles[j],
                        teamIndex,
                        adjacency
                    );

                    if (path.length > 0) {
                        // Destroy the lines in the path
                        this.destroyBlackHolePath(path, teamIndex);
                        console.log(`💥 Black hole activation: Team ${teamIndex} destroyed path between black holes ${fulfilledBlackHoles[i]} and ${fulfilledBlackHoles[j]}`);
                    }
                }
            }
        }
    }

    // Count connected black holes for a team (including the black hole itself if connected)
    countConnectedBlackHoles(blackHoleIndex, teamIndex, adjacency) {
        const stars = this.state.game.stars;
        let count = 0;
        const visited = new Set();
        const queue = [blackHoleIndex];
        visited.add(blackHoleIndex);

        while (queue.length > 0) {
            const current = queue.shift();
            const star = stars[current];

            // If this is a black hole and connected to the team, count it
            if (star.ty === 2 && this.isBlackHoleConnectedToTeam(current, teamIndex, adjacency)) {
                count++;
            }

            // Explore neighbors through valid paths
            const neighbors = adjacency[current] || [];
            for (const neighborIndex of neighbors) {
                if (!visited.has(neighborIndex) &&
                    this.isValidBlackHolePath(current, neighborIndex, teamIndex)) {
                    visited.add(neighborIndex);
                    queue.push(neighborIndex);
                }
            }
        }

        return count;
    }

    // Check if a black hole is connected to a team
    isBlackHoleConnectedToTeam(blackHoleIndex, teamIndex, adjacency) {
        const stars = this.state.game.stars;
        const neighbors = adjacency[blackHoleIndex] || [];

        for (const neighborIndex of neighbors) {
            const neighbor = stars[neighborIndex];
            if (neighbor.tm === teamIndex) {
                return true;
            }
        }
        return false;
    }

    // Check if a path between two stars is valid for black hole connections
    isValidBlackHolePath(fromIndex, toIndex, teamIndex) {
        const stars = this.state.game.stars;
        const toStar = stars[toIndex];

        // Path cannot have HQ dots, wormholes (type 3), or cluster dots (type 1)
        if (toStar.hq || toStar.ty === 3 || toStar.ty === 1) {
            return false;
        }

        // If destination is a black hole (type 2), it's valid
        if (toStar.ty === 2) {
            return true;
        }

        // If destination is a normal star (type 0) owned by the team, it's valid
        if (toStar.ty === 0 && toStar.tm === teamIndex) {
            return true;
        }

        return false;
    }

    // Find path between two black holes
    findPathBetweenBlackHoles(bh1, bh2, teamIndex, adjacency) {
        const stars = this.state.game.stars;
        const visited = new Set();
        const queue = [{ index: bh1, path: [bh1] }];
        visited.add(bh1);

        while (queue.length > 0) {
            const { index: currentIndex, path } = queue.shift();

            if (currentIndex === bh2) {
                return path;
            }

            const neighbors = adjacency[currentIndex] || [];
            for (const neighborIndex of neighbors) {
                if (!visited.has(neighborIndex) &&
                    this.isValidBlackHolePath(currentIndex, neighborIndex, teamIndex)) {
                    visited.add(neighborIndex);
                    queue.push({ index: neighborIndex, path: [...path, neighborIndex] });
                }
            }
        }

        return [];
    }

    // Destroy lines in black hole path
    destroyBlackHolePath(path, teamIndex) {
        const lines = this.state.game.lines;
        const destroyedLines = [];

        for (let i = 0; i < path.length - 1; i++) {
            const from = path[i];
            const to = path[i + 1];

            // Find and destroy the line
            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                const line = lines[lineIdx];
                if (!line.destroyed &&
                    ((line.f === from && line.t === to) || (line.f === to && line.t === from))) {
                    line.destroyed = true;
                    destroyedLines.push(lineIdx);
                }
            }
        }

        // Broadcast the destruction
        if (destroyedLines.length > 0) {
            this.broadcast('black_hole_destruction', {
                team: teamIndex,
                lines: destroyedLines,
                path: path
            });
        }
    }

    // Check for wormhole activation and handle game end
    checkWormHoleActivation(teamIndex) {
        if (!this.state.game.initialized) return false;

        const stars = this.state.game.stars;
        const lines = this.state.game.lines;

        // Build adjacency cache
        const adjacency = Array(stars.length).fill(null).map(() => []);
        lines.forEach(line => {
            if (!line.destroyed) {
                adjacency[line.f].push(line.t);
                adjacency[line.t].push(line.f);
            }
        });

        // Find all activated wormholes for this team
        const activatedWormholes = [];

        for (let i = 0; i < stars.length; i++) {
            const star = stars[i];
            if (star.ty === 3 && star.tm === teamIndex && !star.destroyed) { // Type 3 = wormhole
                const connectedCount = this.countConnectedStars(i, teamIndex, adjacency);
                if (connectedCount >= star.req) {
                    activatedWormholes.push(i);
                }
            }
        }

        // If 2+ wormholes are activated and connected, team wins
        if (activatedWormholes.length >= 2) {
            if (this.areWormholesConnected(activatedWormholes, teamIndex, adjacency)) {
                console.log(`🌀 Wormhole victory: Team ${teamIndex} has connected ${activatedWormholes.length} wormholes!`);
                return true;
            }
        }

        return false;
    }

    // Count connected stars of the same team (including the wormhole itself)
    countConnectedStars(starIndex, teamIndex, adjacency) {
        const stars = this.state.game.stars;
        const star = stars[starIndex];
        
        // Start with 1 to count the wormhole itself
        let count = 1;
        const neighbors = adjacency[starIndex] || [];

        for (const neighborIndex of neighbors) {
            const neighbor = stars[neighborIndex];
            if (neighbor.tm === teamIndex && !neighbor.destroyed) {
                count++;
            }
        }

        return count;
    }

    // Check if wormholes are connected through team's network
    areWormholesConnected(wormholes, teamIndex, adjacency) {
        for (let i = 0; i < wormholes.length - 1; i++) {
            for (let j = i + 1; j < wormholes.length; j++) {
                if (this.canReachThroughTeamNetwork(wormholes[i], wormholes[j], teamIndex, adjacency)) {
                    return true;
                }
            }
        }
        return false;
    }

    // BFS to check if two wormholes can reach each other through team's network
    canReachThroughTeamNetwork(startWormhole, endWormhole, teamIndex, adjacency) {
        const stars = this.state.game.stars;
        const visited = new Set();
        const queue = [startWormhole];
        visited.add(startWormhole);

        while (queue.length > 0) {
            const current = queue.shift();

            if (current === endWormhole) {
                return true;
            }

            const connections = adjacency[current] || [];
            for (const neighborIndex of connections) {
                const neighbor = stars[neighborIndex];

                if (!visited.has(neighborIndex) &&
                    neighbor.tm === teamIndex &&
                    !neighbor.destroyed) {
                    visited.add(neighborIndex);
                    queue.push(neighborIndex);
                }
            }
        }

        return false;
    }


    updateAdminRoom() {
        if (this.presence) {
            console.log(`📡 Room ${this.roomId} publishing admin_update (Players: ${this.clients.length})`);
            this.presence.publish('admin_update', {
                roomId: this.roomId,
                players: Array.from(this.state.players.values()),
                state: this.state.gameState,
                isPaused: this.isPaused || false,
                playerCount: this.clients.length,
                metadata: this.metadata || {},
                config: this.gameConfig
            });
        }
    }

    // Broadcast authoritative scores to prevent client drift
    broadcastAuthoritativeScores() {
        if (!this.state.game.initialized || !this.state.game.stars) return;

        // Calculate authoritative scores from server state
        const teamScores = {};
        this.state.game.stars.forEach(star => {
            if (star.tm !== -1) {
                if (!teamScores[star.tm]) teamScores[star.tm] = 0;
                teamScores[star.tm]++;
            }
        });

        // Broadcast authoritative scores to all clients
        this.broadcast('authoritative_scores', {
            teamScores: teamScores,
            timestamp: Date.now()
        });

        console.log(`📊 Broadcast authoritative scores:`, teamScores);
    }

    onDispose() {
        console.log(`Room ${this.roomId} disposed`);
    }
}

// AdminRoom class

// ─── GOLAD colour palette (matches client/admin) ──────────────────────────────
const GOLAD_PALETTE = [
    [255,255,255],[248,218,184],[255,105,180],[200,0,40],[255,100,0],
    [210,180,45],[255,220,0],[160,220,0],[0,150,40],[0,152,117],
    [0,204,255],[0,80,200],[160,0,255],[150,0,110],[220,0,90],
    [100,0,25],[80,30,0]
];

// ─── GOLAD AI helpers ─────────────────────────────────────────────────────────
function _goladNeighbors(cells, bs, idx) {
    const x = idx % bs, y = Math.floor(idx / bs);
    let t1 = 0, t2 = 0, tg = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x+dx, ny = y+dy;
            if (nx >= 0 && nx < bs && ny >= 0 && ny < bs) {
                const v = cells[ny*bs+nx];
                if (v===1) t1++; else if (v===2) t2++; else if (v===3) tg++;
            }
        }
    }
    return [t1, t2, tg];
}
function _goladStep(cells, bs, birth, survive) {
    const next = new Array(cells.length).fill(0);
    for (let i = 0; i < cells.length; i++) {
        const [t1,t2,tg] = _goladNeighbors(cells, bs, i);
        const total = t1+t2+tg, cur = cells[i];
        if (cur === 0) { if (birth.includes(total)) next[i] = t1>t2?1:t2>t1?2:3; }
        else           { next[i] = survive.includes(total) ? cur : 0; }
    }
    return next;
}
function _goladRatio(cells, myState) {
    let mine = 0, opp = 0;
    const os = myState===1?2:1;
    for (const c of cells) { if (c===myState) mine++; else if (c===os) opp++; }
    return opp===0 ? (mine>0?1e9:0) : mine/opp;
}
function goladDumbAI(cells, bs, myState) {
    let best=-1, bestScore=-1;
    for (let i=0;i<cells.length;i++) {
        if (cells[i]!==0) {
            const [t1,t2,tg]=_goladNeighbors(cells,bs,i);
            const oppN=myState===1?t2+tg:t1+tg;
            if (oppN>bestScore){bestScore=oppN;best=i;}
        }
    }
    return best!==-1?{action:'remove',cellIndex:best}:null;
}
function goladOkayAI(cells, bs, myState, birth, survive) {
    const mine=[];
    for (let i=0;i<cells.length;i++) if (cells[i]===myState) mine.push(i);

    let bv1=-1,bv2=-1,bestVR=-1;
    for (let m=0;m<mine.length-1;m++) {
        for (let n=m+1;n<mine.length;n++) {
            const t=cells.slice(); t[mine[m]]=0; t[mine[n]]=0;
            const r=_goladRatio(_goladStep(t,bs,birth,survive),myState);
            if (r>bestVR){bestVR=r;bv1=mine[m];bv2=mine[n];}
        }
    }
    let bestRatio=-1,bestCell=-1,bestV1=-1,bestV2=-1;
    if (bv1!==-1) {
        for (let i=0;i<cells.length;i++) {
            if (cells[i]===0) {
                const t=cells.slice(); t[i]=myState; t[bv1]=0; t[bv2]=0;
                const r=_goladRatio(_goladStep(t,bs,birth,survive),myState);
                if (r>bestRatio){bestRatio=r;bestCell=i;bestV1=bv1;bestV2=bv2;}
            }
        }
    }
    for (let i=0;i<cells.length;i++) {
        if (cells[i]!==0) {
            const t=cells.slice(); t[i]=0;
            const r=_goladRatio(_goladStep(t,bs,birth,survive),myState);
            if (r>bestRatio){bestRatio=r;bestCell=i;bestV1=-1;bestV2=-1;}
        }
    }
    if (bestCell===-1)  return goladDumbAI(cells,bs,myState);
    if (bestV1===-1)    return {action:'remove',cellIndex:bestCell};
    return {action:'place',cellIndex:bestCell,ventricle1:bestV1,ventricle2:bestV2};
}

// ─── GOLAD Room ───────────────────────────────────────────────────────────────
class GoladRoom extends Room {
    onCreate(options) {
        console.log('GoladRoom created:', options.name || options.roomName);
        this.autoDispose = false;
        this.maxClients  = options.maxPlayers || 20;

        const state = new RoomState();
        state.gameState = 'waiting';
        state.hostId    = '';
        this.setState(state);

        this.goladConfig = {
            name:       options.name || options.roomName || `GOLAD ${this.roomId.substring(0, 6)}`,
            gameType:   'GOLAD',
            boardSize:  options.boardSize  || 16,
            birth:      options.birth      || [3],
            survive:    options.survive    || [2, 3],
            p1Type:     options.p1Type     || 'human',
            p2Type:     options.p2Type     || 'human',
            p1Color:    options.p1Color    || GOLAD_PALETTE[3],
            p2Color:    options.p2Color    || GOLAD_PALETTE[11],
            cellShape:   options.cellShape   || 'square',
            hints:       options.hints       !== undefined ? options.hints       : true,
            animations:  options.animations  !== undefined ? options.animations  : true,
            showCursor:  options.showCursor  !== undefined ? options.showCursor  : true,
            showPreview: options.showPreview !== undefined ? options.showPreview : true,
        };

        const bs = this.goladConfig.boardSize;
        this.goladState = {
            cells:       new Array(bs * bs).fill(0),
            currentTurn: 0,
            gamePhase:   'waiting',
            winner:      -1,
            team0Count:  0,
            team1Count:  0
        };

        this.playerTeams = new Map(); // sessionId → 0|1 or -1 (observer)

        this.setMetadata({
            name:       this.goladConfig.name,
            type:       'GOLAD',
            gameState:  'waiting',
            createdAt:  new Date().toISOString(),
            maxPlayers: this.maxClients,
            clients:    0
        });

        if (this.presence) {
            this.presence.subscribe(`room_${this.roomId}`, (msg) => {
                if (!msg || !msg.type) return;
                if (msg.type === 'start_game') {
                    if (this.goladState.gamePhase === 'waiting') this.startGoladGame();
                } else if (msg.type === 'force_dispose') {
                    this.disconnect();
                } else if (msg.type === 'update_settings' && msg.settings) {
                    const s = msg.settings;
                    if (s.boardSize   !== undefined) this.goladConfig.boardSize  = s.boardSize;
                    if (s.birth)                     this.goladConfig.birth      = s.birth;
                    if (s.survive)                   this.goladConfig.survive    = s.survive;
                    if (s.p1Type)                    this.goladConfig.p1Type     = s.p1Type;
                    if (s.p2Type)                    this.goladConfig.p2Type     = s.p2Type;
                    if (s.p1Color)                   this.goladConfig.p1Color    = s.p1Color;
                    if (s.p2Color)                   this.goladConfig.p2Color    = s.p2Color;
                    if (s.cellShape)                 this.goladConfig.cellShape  = s.cellShape;
                    if (s.hints       !== undefined)  this.goladConfig.hints       = s.hints;
                    if (s.animations  !== undefined)  this.goladConfig.animations  = s.animations;
                    if (s.showCursor  !== undefined)  this.goladConfig.showCursor  = s.showCursor;
                    if (s.showPreview !== undefined)  this.goladConfig.showPreview = s.showPreview;
                    if (s.name)                       this.goladConfig.name        = s.name;
                    this.refreshMetadata();
                    // Push changes to game clients so labels/behaviour update immediately
                    this.broadcast('settings_changed', {
                        p1Type:      this.goladConfig.p1Type,
                        p2Type:      this.goladConfig.p2Type,
                        showCursor:  this.goladConfig.showCursor,
                        showPreview: this.goladConfig.showPreview,
                    });
                    this._checkAutoStart();
                }
            });
        }

        this.onMessage('make_move',    (client, data) => this.handleMove(client, data));
        this.onMessage('request_state',(client)       => this.sendFullState(client));
        this.onMessage('start_game',   ()             => {
            if (this.goladState.gamePhase === 'waiting') this.startGoladGame();
        });
        this.onMessage('cursor_move',  (client, data) => {
            if (this.goladConfig.showCursor)
                this.broadcast('opponent_cursor', { x: data.x, y: data.y }, { except: client });
        });
        this.onMessage('preview_update', (client, data) => {
            if (this.goladConfig.showPreview)
                this.broadcast('opponent_preview', data, { except: client });
        });
    }

    onJoin(client, options) {
        const isAdmin   = !!(options && options.isAdmin);
        const assigned  = [...this.playerTeams.values()].filter(t => t >= 0).length;
        const teamIndex = isAdmin ? -1 : (assigned < 2 ? assigned : -1);
        this.playerTeams.set(client.sessionId, teamIndex);

        client.send('assigned_team', {
            teamIndex,
            boardSize:  this.goladConfig.boardSize,
            birth:      this.goladConfig.birth,
            survive:    this.goladConfig.survive,
            p1Color:    this.goladConfig.p1Color,
            p2Color:    this.goladConfig.p2Color,
            p1Type:      this.goladConfig.p1Type,
            p2Type:      this.goladConfig.p2Type,
            cellShape:   this.goladConfig.cellShape,
            hints:       this.goladConfig.hints,
            animations:  this.goladConfig.animations,
            showCursor:  this.goladConfig.showCursor,
            showPreview: this.goladConfig.showPreview,
        });

        if (this.goladState.gamePhase !== 'waiting') this.sendFullState(client);

        this._checkAutoStart();
        this.refreshMetadata();
    }

    refreshMetadata() {
        this.setMetadata({
            name:       this.goladConfig.name,
            type:       'GOLAD',
            gameState:  this.goladState.gamePhase,
            maxPlayers: this.maxClients,
            clients:    this.clients.length
        });
        if (this.presence) {
            const players = this.clients.map(c => ({
                id: c.sessionId, teamIndex: this.playerTeams.get(c.sessionId) ?? -1
            }));
            this.presence.publish('admin_update', {
                roomId:   this.roomId,
                name:     this.goladConfig.name,
                state:    this.goladState.gamePhase,
                gameType: 'GOLAD',
                config: {
                    boardSize:  this.goladConfig.boardSize,
                    birth:      this.goladConfig.birth,
                    survive:    this.goladConfig.survive,
                    p1Type:     this.goladConfig.p1Type,
                    p2Type:     this.goladConfig.p2Type,
                    p1Color:    this.goladConfig.p1Color,
                    p2Color:    this.goladConfig.p2Color,
                    cellShape:  this.goladConfig.cellShape,
                    hints:      this.goladConfig.hints,
                    animations: this.goladConfig.animations,
                },
                players
            });
        }
    }

    startGoladGame() {
        if (this.goladState.gamePhase !== 'waiting') return;

        const bs = this.goladConfig.boardSize;
        this.goladState.cells = new Array(bs * bs).fill(0); // resize if boardSize changed
        const cells = this.goladState.cells;
        const total = bs * bs;

        for (let i = 0; i < Math.floor(total / 2); i++) {
            const r = Math.random();
            if (r < 0.25)      { cells[i] = 1; cells[total-1-i] = 2; }
            else if (r < 0.5)  { cells[i] = 2; cells[total-1-i] = 1; }
        }

        this.goladState.gamePhase   = 'playing';
        this.goladState.currentTurn = 0;
        this.countCells();
        this.state.gameState = 'playing';
        this.refreshMetadata();

        this.broadcast('game_started', { ...this._payload(), currentTurn: 0,
            birth: this.goladConfig.birth, survive: this.goladConfig.survive });
        console.log(`GoladRoom ${this.roomId}: game started (${bs}×${bs})`);

        this.scheduleAIMove();
    }

    handleMove(client, data) {
        const teamIndex = this.playerTeams.get(client.sessionId);
        if (teamIndex === undefined || teamIndex < 0)  return;
        if (this.goladState.gamePhase !== 'playing')   return;
        if (this.goladState.currentTurn !== teamIndex) return;
        this._applyMove(teamIndex, data);
    }

    _applyMove(teamIndex, data, isAIMove = false) {
        const { action, cellIndex, ventricle1, ventricle2 } = data;
        const cells = this.goladState.cells;
        const ps    = teamIndex + 1; // cell value: 1 or 2

        if (cellIndex < 0 || cellIndex >= cells.length) return;

        if (action === 'place') {
            if (cells[cellIndex] !== 0)                               return;
            if (ventricle1 < 0 || ventricle1 >= cells.length)        return;
            if (ventricle2 < 0 || ventricle2 >= cells.length)        return;
            if (cells[ventricle1] !== ps || cells[ventricle2] !== ps) return;
            if (ventricle1 === ventricle2)                            return;
            if (ventricle1 === cellIndex || ventricle2 === cellIndex) return;
            cells[cellIndex] = ps; cells[ventricle1] = 0; cells[ventricle2] = 0;
        } else if (action === 'remove') {
            if (cells[cellIndex] === 0) return;
            cells[cellIndex] = 0;
        } else { return; }

        this.stepGolad();
        this.countCells();

        const t0 = this.goladState.team0Count;
        const t1 = this.goladState.team1Count;

        if (t0 === 0 || t1 === 0) {
            const w = (t0===0 && t1>0)?1 : (t1===0 && t0>0)?0 : 2;
            this.goladState.gamePhase = 'finished';
            this.goladState.winner    = w;
            this.state.gameState = 'finished';
            this.refreshMetadata();
            this.broadcast('game_over', { winner:w, cells:Array.from(cells), team0Count:t0, team1Count:t1 });
        } else {
            this.goladState.currentTurn = teamIndex === 0 ? 1 : 0;
            const payload = {
                cells: Array.from(cells), currentTurn: this.goladState.currentTurn,
                team0Count: t0, team1Count: t1
            };
            const replayMode = !isAIMove && !this.goladConfig.showCursor && !this.goladConfig.showPreview;
            if (replayMode) {
                // Send state immediately to mover; animate move for everyone else first
                const mover = this.clients.find(c => this.playerTeams.get(c.sessionId) === teamIndex);
                if (mover) mover.send('state_update', payload);
                const sequence = data.action === 'place'
                    ? [data.ventricle1, data.ventricle2, data.cellIndex]
                    : [data.cellIndex];
                this.broadcast('ai_cursor_sequence', { sequence, team: teamIndex }, mover ? { except: mover } : {});
                setTimeout(() => this.broadcast('state_update', payload, mover ? { except: mover } : {}), 1800);
            } else {
                this.broadcast('state_update', payload);
            }
            this.scheduleAIMove();
        }
    }

    _checkAutoStart() {
        if (this.goladState.gamePhase !== 'waiting') return;
        const humanCount   = [...this.playerTeams.values()].filter(t => t >= 0).length;
        const neededHumans = (this.goladConfig.p1Type !== 'human' ? 0 : 1)
                           + (this.goladConfig.p2Type !== 'human' ? 0 : 1);
        if (neededHumans > 0 && humanCount >= neededHumans) {
            setTimeout(() => this.startGoladGame(), 1500);
        }
    }

    scheduleAIMove() {
        const turn    = this.goladState.currentTurn;
        const aiType  = turn === 0 ? this.goladConfig.p1Type : this.goladConfig.p2Type;
        if (!aiType || aiType === 'human') return;

        const myState = turn + 1;
        const cells   = this.goladState.cells.slice();
        const bs      = this.goladConfig.boardSize;
        const birth   = this.goladConfig.birth;
        const survive = this.goladConfig.survive;

        const move = (aiType === 'dumb')
            ? goladDumbAI(cells, bs, myState)
            : goladOkayAI(cells, bs, myState, birth, survive);

        if (!move) return;

        // Send cursor animation sequence to all clients before applying move
        const sequence = move.action === 'place'
            ? [move.ventricle1, move.ventricle2, move.cellIndex]
            : [move.cellIndex];
        this.broadcast('ai_cursor_sequence', { sequence, team: turn });

        setTimeout(() => {
            if (this.goladState.gamePhase !== 'playing') return;
            if (this.goladState.currentTurn !== turn) return;
            this._applyMove(turn, move, true);
        }, 1800);
    }

    stepGolad() {
        const bs=this.goladConfig.boardSize, birth=this.goladConfig.birth,
              survive=this.goladConfig.survive, cells=this.goladState.cells;
        const next = new Array(cells.length).fill(0);
        for (let y=0;y<bs;y++) {
            for (let x=0;x<bs;x++) {
                const idx=y*bs+x;
                let t0n=0,t1n=0,gn=0;
                for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
                    if (!dx&&!dy) continue;
                    const nx=x+dx,ny=y+dy;
                    if (nx>=0&&nx<bs&&ny>=0&&ny<bs) {
                        const ns=cells[ny*bs+nx];
                        if(ns===1)t0n++;else if(ns===2)t1n++;else if(ns===3)gn++;
                    }
                }
                const tot=t0n+t1n+gn, cur=cells[idx];
                if (cur===0) { if(birth.indexOf(tot)>=0) next[idx]=t0n>t1n?1:t1n>t0n?2:3; }
                else         { next[idx]=survive.indexOf(tot)>=0?cur:0; }
            }
        }
        for (let i=0;i<cells.length;i++) cells[i]=next[i];
    }

    countCells() {
        let t0=0,t1=0;
        for (const c of this.goladState.cells) { if(c===1)t0++;else if(c===2)t1++; }
        this.goladState.team0Count=t0; this.goladState.team1Count=t1;
    }

    _payload() {
        return {
            cells:      Array.from(this.goladState.cells),
            boardSize:  this.goladConfig.boardSize,
            p1Type:     this.goladConfig.p1Type,
            p2Type:     this.goladConfig.p2Type,
            p1Color:    this.goladConfig.p1Color,
            p2Color:    this.goladConfig.p2Color,
            cellShape:  this.goladConfig.cellShape,
            hints:       this.goladConfig.hints,
            animations:  this.goladConfig.animations,
            showCursor:  this.goladConfig.showCursor,
            showPreview: this.goladConfig.showPreview,
            team0Count:  this.goladState.team0Count,
            team1Count:  this.goladState.team1Count,
        };
    }

    sendFullState(client) {
        client.send('full_state', {
            ...this._payload(),
            currentTurn: this.goladState.currentTurn,
            gamePhase:   this.goladState.gamePhase,
            winner:      this.goladState.winner,
            birth:       this.goladConfig.birth,
            survive:     this.goladConfig.survive,
        });
    }

    onLeave(client) {}

    onDispose() {
        if (this.presence) this.presence.unsubscribe(`room_${this.roomId}`);
        console.log(`GoladRoom ${this.roomId} disposed`);
    }
}

// ── CentauriRoom ──────────────────────────────────────────────────────────────
class CentauriRoom extends Room {
    onCreate(options) {
        console.log('CentauriRoom created:', options.name || options.roomId);
        this.autoDispose = false;
        this.players   = [];   // { sessionId, peerId, teamId, name }
        this.nextPeerId = 1;
        this.gameConfig = {
            name:            options.name            || 'Centauri',
            thrustPower:     options.thrustPower     ?? 1000.0,
            thrustDepletion: options.thrustDepletion ?? 10.0,
            fuelEfficiency:  options.fuelEfficiency  ?? 0.5,
            fuelRecovery:    options.fuelRecovery    ?? 2.0,
            tickSpeed:       options.tickSpeed       ?? 1.0,
            sessionDuration: options.sessionDuration ?? 120.0,
            mapJson:         options.mapJson         ?? null,
            teamColors: options.teamColors ?? [
                { color: 0x00ffff, name: 'cyan'    },
                { color: 0xff00ff, name: 'magenta' },
                { color: 0x00ff00, name: 'lime'    },
                { color: 0xffcc00, name: 'gold'    },
            ],
        };
        this.setMetadata({ name: this.gameConfig.name, type: 'Centauri', state: 'waiting' });

        this.presence.subscribe(`room_${this.roomId}`, (data) => {
            if (data.type === 'update_settings') {
                const s = data.settings;
                if (s.thrustPower      !== undefined) this.gameConfig.thrustPower      = s.thrustPower;
                if (s.thrustDepletion  !== undefined) this.gameConfig.thrustDepletion  = s.thrustDepletion;
                if (s.fuelEfficiency   !== undefined) this.gameConfig.fuelEfficiency   = s.fuelEfficiency;
                if (s.fuelRecovery     !== undefined) this.gameConfig.fuelRecovery     = s.fuelRecovery;
                if (s.tickSpeed        !== undefined) this.gameConfig.tickSpeed        = s.tickSpeed;
                if (s.sessionDuration  !== undefined) this.gameConfig.sessionDuration  = s.sessionDuration;
                if (s.mapJson          !== undefined) this.gameConfig.mapJson          = s.mapJson;
                if (s.teamColors       !== undefined) this.gameConfig.teamColors       = s.teamColors;
                this.broadcast('settings_update', { config: this.gameConfig });
            }
            if (data.type === 'start_game') {
                this.setMetadata({ name: this.gameConfig.name, type: 'Centauri', state: 'playing' });
                this.broadcast('game_start', { config: this.gameConfig, startAt: Date.now() + 10000 });
            }
            if (data.type === 'assign_team') {
                const p = this.players.find(x => x.sessionId === data.playerId);
                if (p) {
                    p.teamId = data.teamIndex;
                    this.broadcast('player_team_changed', { peerId: p.peerId, teamId: p.teamId });
                    this._publishAdminUpdate();
                }
            }
        });

        this.onMessage('request_config', (client) => {
            client.send('settings_update', { config: this.gameConfig });
        });

        this.onMessage('game_event', (client, data) => {
            // Relay game events (food delivery, inventory changes) to all other clients.
            // The sender already updated their own state locally.
            this.broadcast('game_event', data, { except: client });
        });

        this.onMessage('change_name', (client, data) => {
            const p = client.userData;
            if (!p) return;
            const clean = String(data.name || '').replace(/\s/g, '').slice(0, 14);
            if (!clean) return;
            p.name = clean;
            this.broadcast('player_name_changed', { peerId: p.peerId, name: clean });
            this._publishAdminUpdate();
        });
    }

    onJoin(client, options) {
        if (options?.isAdmin) {
            client.send('settings_update', { config: this.gameConfig });
            this._publishAdminUpdate();
            return;
        }
        const peerId = this.nextPeerId++;
        const teamId = this.players.length % this.gameConfig.teamColors.length;
        const player = {
            sessionId: client.sessionId,
            peerId,
            teamId,
            name: options?.name || `Player ${peerId}`,
        };
        client.userData = player;
        this.players.push(player);

        // Tell the joining client its peer ID and host status
        client.send('host_assigned', { peerId, isHost: peerId === 1 });
        // Send current config
        client.send('settings_update', { config: this.gameConfig });
        // Tell everyone (including new client) about all players
        this.broadcast('player_joined', {
            peerId, teamId, name: player.name, sessionId: client.sessionId,
        });
        // Tell the new client about players who joined before them
        for (const p of this.players) {
            if (p.sessionId !== client.sessionId) {
                client.send('player_joined', {
                    peerId: p.peerId, teamId: p.teamId, name: p.name, sessionId: p.sessionId,
                });
            }
        }
        this._publishAdminUpdate();
        console.log(`CentauriRoom ${this.roomId}: ${player.name} joined as peer ${peerId}`);
    }

    onLeave(client) {
        const p = client.userData;
        if (!p) return;
        this.players = this.players.filter(x => x.sessionId !== client.sessionId);
        this.broadcast('player_left', { peerId: p.peerId });
        this._publishAdminUpdate();
        console.log(`CentauriRoom ${this.roomId}: peer ${p.peerId} left`);
    }

    _publishAdminUpdate() {
        this.presence.publish('admin_update', {
            roomId:      this.roomId,
            players:     this.players.map(p => ({
                id: p.sessionId, sessionId: p.sessionId, name: p.name, team: p.teamId, peerId: p.peerId,
            })),
            state:       this.metadata?.state || 'waiting',
            playerCount: this.clients.length,
            metadata:    this.metadata || {},
            config:      this.gameConfig,
        });
    }

    onDispose() {
        this.presence.unsubscribe(`room_${this.roomId}`);
        console.log(`CentauriRoom ${this.roomId} disposed`);
    }
}

class AdminRoom extends Room {
    onCreate(options) {
        console.log('AdminRoom created');

        const state = new RoomState();
        this.setState(state);

        this.roomStates = new Map();

        this.onMessage('create_room', async (client, data) => {
            try {
                console.log('Creating room with options:', data.options);

                // Use the imported matchMaker directly
                const room = await matchMaker.createRoom('constellation', data.options);

                console.log('✓ Room created:', room.roomId);

                client.send('room_created', {
                    success: true,
                    roomId: room.roomId,
                    gameUrl: `/game/${room.roomId}`
                });

                setTimeout(() => this.updateRoomsList(), 300);

            } catch (error) {
                console.error('❌ Error creating room:', error);
                client.send('room_created', {
                    success: false,
                    error: error.message
                });
            }
        });

        this.onMessage('request_rooms_list', async (client) => {
            await this.updateRoomsList();
        });

        this.onMessage('start_game', async (client, data) => {
            try {
                if (!this.presence) {
                    throw new Error('Presence not available');
                }
                await this.presence.publish(`room_${data.roomId}`, {
                    type:         'start_game',
                    gs:           data.gs           || null,
                    polytopePath: data.polytopePath || null,
                });
                client.send('game_started', { success: true, roomId: data.roomId });
            } catch (error) {
                console.error('Error starting game:', error);
                client.send('game_started', { success: false, roomId: data.roomId, error: error.message });
            }
        });

        this.onMessage('delete_room', async (client, data) => {
            try {
                if (!this.presence) {
                    throw new Error('Presence not available');
                }
                await this.presence.publish(`room_${data.roomId}`, { type: 'force_dispose' });
                client.send('room_deleted', { success: true, roomId: data.roomId });
                setTimeout(() => this.updateRoomsList(), 300);
            } catch (error) {
                client.send('room_deleted', { success: false, roomId: data.roomId, error: error.message });
            }
        });

        // NEW: team assignment and kicking via admin room
        this.onMessage('assign_team', async (client, data) => {
            try {
                if (!this.presence) {
                    throw new Error('Presence not available');
                }
                await this.presence.publish(`room_${data.roomId}`, { type: 'assign_team', playerId: data.playerId, teamIndex: data.teamIndex });
            } catch (error) {
                console.error('Error assigning team via AdminRoom:', error);
            }
        });

        this.onMessage('kick_player', async (client, data) => {
            try {
                if (!this.presence) {
                    throw new Error('Presence not available');
                }
                await this.presence.publish(`room_${data.roomId}`, { type: 'kick_player', playerId: data.playerId });
            } catch (error) {
                console.error('Error kicking player via AdminRoom:', error);
            }
        });

        this.onMessage('update_settings', async (client, data) => {
            try {
                if (!this.presence) {
                    throw new Error('Presence not available');
                }
                await this.presence.publish(`room_${data.roomId}`, { type: 'update_settings', settings: data.settings });
            } catch (error) {
                console.error('Error updating settings via AdminRoom:', error);
            }
        });

        this.onMessage('pause_game', async (client, data) => {
            console.log('AdminRoom received pause_game for room:', data.roomId);
            try {
                if (!this.presence) {
                    console.error('Presence not available for pause_game');
                    client.send('game_paused', { success: false, roomId: data.roomId, error: 'Presence not available' });
                    return;
                }
                if (!data.roomId) {
                    console.error('No roomId provided for pause_game');
                    client.send('game_paused', { success: false, roomId: data.roomId, error: 'No roomId provided' });
                    return;
                }
                this.presence.publish(`room_${data.roomId}`, { type: 'pause_game', reason: data.reason || '' });
                client.send('game_paused', { success: true, roomId: data.roomId });
                console.log('AdminRoom successfully published pause_game');
            } catch (error) {
                console.error('Error pausing game:', error);
                client.send('game_paused', { success: false, roomId: data.roomId, error: error.message });
            }
        });

        this.onMessage('resume_game', async (client, data) => {
            console.log('AdminRoom received resume_game for room:', data.roomId);
            try {
                if (!this.presence) {
                    console.error('Presence not available for resume_game');
                    client.send('game_resumed', { success: false, roomId: data.roomId, error: 'Presence not available' });
                    return;
                }
                if (!data.roomId) {
                    console.error('No roomId provided for resume_game');
                    client.send('game_resumed', { success: false, roomId: data.roomId, error: 'No roomId provided' });
                    return;
                }
                this.presence.publish(`room_${data.roomId}`, { type: 'resume_game' });
                client.send('game_resumed', { success: true, roomId: data.roomId });
                console.log('AdminRoom successfully published resume_game');
            } catch (error) {
                console.error('Error resuming game:', error);
                client.send('game_resumed', { success: false, roomId: data.roomId, error: error.message });
            }
        });

        // Listen for room updates
        if (this.presence) {
            this.presence.subscribe('admin_update', (data) => {
                this.roomStates.set(data.roomId, data);
                this.broadcast('player_update', data);
            });
        }

        // Periodic updates
        this.updateInterval = setInterval(() => this.updateRoomsList(), 5000);
        setTimeout(() => this.updateRoomsList(), 500);
    }

    async updateRoomsList() {
        try {
            const results = await Promise.all(
                Object.keys(SERVER_GAME_TYPES).map(name => matchMaker.query({ name }))
            );
            const rooms = results.flat();
            const roomsData = rooms.map(room => {
                const roomState = this.roomStates.get(room.roomId);
                return {
                    roomId: room.roomId,
                    clients: room.clients,
                    metadata: room.metadata || {},
                    state: roomState?.state || 'waiting',
                    players: roomState?.players || [],
                    playerCount: roomState?.playerCount || 0,
                    config: roomState?.config || {}
                };
            });

            this.broadcast('rooms_update', roomsData);
            console.log(`✓ Rooms list updated: ${rooms.length} rooms`);
        } catch (error) {
            console.error('Error updating rooms list:', error);
        }
    }

    onJoin(client, options) {
        console.log(`Admin client ${client.sessionId} joined`);
        this.updateRoomsList();
    }

    onLeave(client, consented) {
        console.log(`Admin client ${client.sessionId} left`);
    }

    onDispose() {
        if (this.updateInterval) clearInterval(this.updateInterval);
        console.log('AdminRoom disposed');
    }
}



// Add Colyseus Monitor with basic auth and custom columns for metadata
const basicAuthMiddleware = basicAuth({
    users: { admin: 'admin' },
    challenge: true,
});
app.use('/colyseus', basicAuthMiddleware, monitor({
    columns: [
        'roomId',
        'name',
        'clients',
        'maxClients',
        'locked',
        'elapsedTime',
        { metadata: 'name' },
        { metadata: 'gameState' },
        { metadata: 'type' },
    ],
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
function setCOEPHeaders(_req, res, next) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
}
app.get('/', setCOEPHeaders, (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/other', (_req, res) => res.sendFile(path.join(__dirname, 'other.html')));
app.get('/admin', setCOEPHeaders, (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
// color.html is iframed inside admin.html which has COEP:require-corp —
// the iframe document must also carry COEP or the browser blocks it as cross-origin
app.get('/color.html', setCOEPHeaders, (_req, res) => res.sendFile(path.join(__dirname, 'color.html')));
app.get('/game/:roomId',  (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/golad/:roomId', (req, res) => res.sendFile(path.join(__dirname, 'golad.html')));
let _colyseusJsCache = null;
app.get('/colyseus.js', async (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (_colyseusJsCache) return res.send(_colyseusJsCache);
    try {
        const r = await axios.get('https://unpkg.com/colyseus.js@0.15.24/dist/colyseus.js');
        _colyseusJsCache = r.data;
        res.send(_colyseusJsCache);
    } catch (e) {
        console.error('Failed to fetch colyseus.js from CDN:', e.message);
        res.status(503).send('// colyseus.js unavailable');
    }
});
function godotHeaders(_req, res, next) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
}
app.use('/centauri',      godotHeaders, express.static(path.join(__dirname, 'centauri-web')));
app.get('/centauri/:roomId', godotHeaders, (_req, res) => res.sendFile(path.join(__dirname, 'centauri-web/index.html')));
app.use('/centauri-web',      godotHeaders, express.static(path.join(__dirname, 'centauri-web')));
app.use('/centauri-mapmaker', godotHeaders, express.static(path.join(__dirname, 'centauri-mapmaker')));

// Geobridge — static React build served at /geobridge/
app.use('/geobridge', express.static(path.join(__dirname, 'geobridge/build')));
app.get('/geobridge/*', (_req, res) => res.sendFile(path.join(__dirname, 'geobridge/build/index.html')));

// C4D — 4D polytope claiming game
// setCOEPHeaders required: admin.html loads c4d in an iframe and admin has COEP:require-corp
app.use('/c4d/lib', express.static(path.join(__dirname, 'c4d-lib')));
app.use('/c4d', setCOEPHeaders, express.static(path.join(__dirname, 'c4d')));
app.get('/c4d', setCOEPHeaders, (_req, res) => res.sendFile(path.join(__dirname, 'c4d/index.html')));
app.get('/c4d/:roomId', setCOEPHeaders, (_req, res) => res.sendFile(path.join(__dirname, 'c4d/index.html')));

// TTClub player tracking API — admin panel polls this to show who's in the room
app.get('/ttclub-api/room/:code/players', (req, res) => {
    const code = req.params.code.toUpperCase();
    const room = ttclubRooms.get(code);
    if (!room) return res.json({ players: [] });
    const players = [];
    for (const [id, info] of room.players) {
        players.push({ id, color: info.color, name: info.name, isHost: info.isHost, joinedAt: info.joinedAt });
    }
    res.json({ players });
});

// TTClub player name registration — join page POSTs here to set a custom name
app.post('/ttclub-api/room/:code/name', express.json(), (_req, res) => {
    // This is best-effort; the peer may not have connected yet.
    // Store pending name by fingerprint (IP) so it can be applied on connect.
    res.json({ ok: true });
});

// Debug log collector from seepcards.html console intercept
const fs_dbg = require('fs');
const _dbgLog = require('path').join(__dirname, 'ttclub_debug.log');
app.post('/debug-log', (req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
        const lines = body.split('\n').filter(l => l.trim());
        lines.forEach(l => {
            const entry = new Date().toISOString().substring(11,19) + ' ' + l;
            process.stdout.write('[GDDBG] ' + entry + '\n');
            fs_dbg.appendFileSync(_dbgLog, entry + '\n');
        });
        res.json({ ok: true, count: lines.length });
    });
});

// Tabletop Club web export — needs COOP/COEP headers for SharedArrayBuffer (WASM threads)
app.use('/ttclub2', (_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
}, express.static(path.join(__dirname, 'ttclub2')));
app.use(express.static(path.join(__dirname), { index: false }));

// Server setup
const server = createServer(app);
const gameServer = new Server({ server, express: app });

// ── BaseGameRoom ──────────────────────────────────────────────────────────────
// All game rooms extend this.  Subclass only needs to implement:
//   getPlayers()    → [{id, sessionId, name, ...}]
//   getConfig()     → current settings object
//   getPhase()      → string phase name  ('waiting' | 'playing' | ...)
//   applySettings(s) → mutate internal config from admin update_settings message
//
// Then call super.onCreate(options) and super.onJoin/onLeave.
class BaseGameRoom extends Room {
    // ── Subclass interface ────────────────────────────────────────────────────
    getPlayers()      { return this.clients.map(c => ({ id: c.sessionId, sessionId: c.sessionId })); }
    getConfig()       { return {}; }
    getPhase()        { return this.state?.gameState || 'waiting'; }
    applySettings(_s) {}

    // ── Base lifecycle ────────────────────────────────────────────────────────
    onCreate(_options) {
        this._setupBasePresence();
    }

    onJoin(_client, _options) {
        this._publishAdminUpdate();
    }

    onLeave(_client, _consented) {
        this._publishAdminUpdate();
    }

    // ── Presence handlers shared by all rooms ─────────────────────────────────
    // Handles: force_dispose, update_settings (delegates to applySettings)
    // Subclass can call this.presence.subscribe() again for game-specific messages.
    _setupBasePresence() {
        if (!this.presence) return;
        this.presence.subscribe(`room_${this.roomId}`, (msg) => {
            if (!msg?.type) return;
            if (msg.type === 'force_dispose') {
                this.disconnect();
            } else if (msg.type === 'update_settings' && msg.settings) {
                this.applySettings(msg.settings);
                this.broadcast('settings_update', { config: this.getConfig() });
                this._publishAdminUpdate();
            }
        });
    }

    // ── Admin sync ────────────────────────────────────────────────────────────
    _publishAdminUpdate() {
        if (!this.presence) return;
        this.presence.publish('admin_update', {
            roomId:      this.roomId,
            players:     this.getPlayers(),
            state:       this.getPhase(),
            playerCount: this.clients.length,
            metadata:    this.metadata || {},
            config:      this.getConfig(),
        });
    }
}

// ── Geobridge room ────────────────────────────────────────────────────────────
class GeobridgeRoom extends BaseGameRoom {
    // ── BaseGameRoom interface ────────────────────────────────────────────────
    getPlayers() {
        return this.playerSlots
            .map((sessionId, i) => sessionId ? {
                id: sessionId, sessionId,
                name: `Player ${i + 1}`,
                connected: this.geoState?.players[i]?.connected ?? true,
            } : null)
            .filter(Boolean);
    }
    getConfig()  { return this.settings; }
    getPhase()   { return this.geoState?.phase || 'lobby'; }
    applySettings(s) { Object.assign(this.settings, s); }

    onCreate(options) {
        super.onCreate(options);
        this.maxClients = options.maxPlayers || 3;
        this.autoDispose = false;
        this.settings = {
            timerDuration: 10, biddingTimerDuration: 20, playTimerDuration: 20,
            cardsToPlay: 8, extraCards: 2, numRounds: 3,
            eclipseEnabled: true, alliancePenaltyAmount: 5, bidPenaltyAmount: 20,
            ...(options.settings || {}),
            // Accept flat options from admin panel (adapter sends top-level keys)
            ...(options.timerDuration        !== undefined ? { timerDuration:        options.timerDuration }        : {}),
            ...(options.biddingTimerDuration !== undefined ? { biddingTimerDuration: options.biddingTimerDuration } : {}),
            ...(options.playTimerDuration    !== undefined ? { playTimerDuration:    options.playTimerDuration }    : {}),
            ...(options.cardsToPlay          !== undefined ? { cardsToPlay:          options.cardsToPlay }          : {}),
            ...(options.extraCards           !== undefined ? { extraCards:           options.extraCards }           : {}),
            ...(options.numRounds            !== undefined ? { numRounds:            options.numRounds }            : {}),
            ...(options.eclipseEnabled       !== undefined ? { eclipseEnabled:       options.eclipseEnabled }       : {}),
            ...(options.alliancePenaltyAmount!== undefined ? { alliancePenaltyAmount:options.alliancePenaltyAmount}: {}),
            ...(options.bidPenaltyAmount     !== undefined ? { bidPenaltyAmount:     options.bidPenaltyAmount }     : {}),
        };
        this.playerSlots = [null, null, null]; // slot index → sessionId
        this._handResolved = false;
        this.geoState = {
            phase: 'lobby',
            players: [null, null, null],
            currentPlayer: 0,
            playerCountries: { player1: [], player2: [], player3: [] },
            claimedCountries: { player1: [], player2: [], player3: [] },
            biddingCurrentBidderIdx: 0,
            biddingHighBid: null,
            biddingConsecPasses: 0,
            biddingWinner: null,
            biddingLog: [],
            eclipseRegion: 'Europe',
            playedCards: {},
            playCurrentPlayer: 0,
            playRoundWinner: null,
            playRoundsCompleted: 0,
            currentRound: 1,
            handsWon: { player1: 0, player2: 0, player3: 0 },
            alliancesSent: {},
            alliancePenalties: { player1: 0, player2: 0, player3: 0 },
            bidPenalties: { player1: 0, player2: 0, player3: 0 },
        };
        this.onMessage('selectCountry', this._onSelectCountry.bind(this));
        this.onMessage('bid',           this._onBid.bind(this));
        this.onMessage('pass',          this._onPass.bind(this));
        this.onMessage('playCard',      this._onPlayCard.bind(this));
        this.onMessage('resolveHand',   this._onResolveHand.bind(this));
        this.onMessage('alliance',      this._onAlliance.bind(this));
        this.setMetadata({ gameType: 'geobridge', sessionCode: options.sessionCode || null });
    }

    onJoin(client, options) {
        const slot = this.playerSlots.findIndex(s => s === null);
        if (slot === -1) { client.leave(); return; }
        this.playerSlots[slot] = client.sessionId;
        this.geoState.players[slot] = { sessionId: client.sessionId, connected: true };
        console.log(`Geobridge: slot ${slot} joined (${client.sessionId})`);
        client.send('joined', { playerIdx: slot, state: this.geoState, settings: this.settings });
        this.broadcast('stateUpdate', { state: this.geoState, settings: this.settings }, { except: client });
        if (this.playerSlots.every(s => s !== null)) {
            this.geoState.phase = 'country_selection';
            this._broadcast();
        }
        super.onJoin(client, options); // publishes admin_update
    }

    onLeave(client, consented) {
        const slot = this.playerSlots.indexOf(client.sessionId);
        if (slot >= 0 && this.geoState.players[slot]) this.geoState.players[slot].connected = false;
        this._broadcast();
        super.onLeave(client, consented); // publishes admin_update
    }

    _slot(client)    { return this.playerSlots.indexOf(client.sessionId); }
    _broadcast()     { this.broadcast('stateUpdate', { state: this.geoState, settings: this.settings }); }
    _key(i)          { return `player${i + 1}`; }

    _onSelectCountry(client, { countryCode }) {
        const idx = this._slot(client);
        if (idx < 0 || this.geoState.phase !== 'country_selection') return;
        if (idx !== this.geoState.currentPlayer) return;
        const taken = new Set(Object.values(this.geoState.playerCountries).flat());
        if (taken.has(countryCode)) return;
        this.geoState.playerCountries[this._key(idx)].push(countryCode);
        const needed = (this.settings.cardsToPlay || 8) + (this.settings.extraCards || 2);
        const allDone = [0,1,2].every(i => this.geoState.playerCountries[this._key(i)].length >= needed);
        if (allDone) {
            this._startBidding();
        } else {
            this.geoState.currentPlayer = (idx + 1) % 3;
        }
        this._broadcast();
    }

    _startBidding() {
        this.geoState.phase = 'bidding';
        this.geoState.biddingCurrentBidderIdx = 0;
        this.geoState.biddingHighBid = null;
        this.geoState.biddingConsecPasses = 0;
        this.geoState.biddingWinner = null;
        this.geoState.biddingLog = [];
        this.geoState.eclipseRegion = 'Europe';
    }

    _onBid(client, { amount, category, eclipseRegion }) {
        const idx = this._slot(client);
        if (idx < 0 || this.geoState.phase !== 'bidding') return;
        if (idx !== this.geoState.biddingCurrentBidderIdx) return;
        const min = this.geoState.biddingHighBid ? this.geoState.biddingHighBid.amount + 1 : 1;
        const amt = Math.max(amount || 1, min);
        const cat = category || 'gdp';
        this.geoState.biddingHighBid = { teamIdx: idx, amount: amt, category: cat };
        this.geoState.biddingConsecPasses = 0;
        if (eclipseRegion) this.geoState.eclipseRegion = eclipseRegion;
        this.geoState.biddingLog.push({ teamIdx: idx, type: 'bid', amount: amt, category: cat, eclipseRegion: this.geoState.eclipseRegion });
        this.geoState.biddingCurrentBidderIdx = (idx + 1) % 3;
        this._broadcast();
    }

    _onPass(client) {
        const idx = this._slot(client);
        if (idx < 0 || this.geoState.phase !== 'bidding') return;
        if (idx !== this.geoState.biddingCurrentBidderIdx) return;
        this.geoState.biddingConsecPasses++;
        this.geoState.biddingLog.push({ teamIdx: idx, type: 'pass' });
        const hasBid = this.geoState.biddingHighBid !== null;
        const passes = this.geoState.biddingConsecPasses;
        const ended = hasBid ? passes >= 2 : passes >= 3;
        if (ended) {
            if (!hasBid) {
                this.geoState.biddingWinner = { teamIdx: -1, amount: 0, category: '' };
                this.geoState.biddingLog.push({ teamIdx: -1, type: 'nowin' });
            } else {
                const w = this.geoState.biddingHighBid;
                this.geoState.biddingWinner = { ...w };
                this.geoState.biddingLog.push({ teamIdx: w.teamIdx, type: 'win', amount: w.amount, category: w.category });
            }
            this._broadcast();
            setTimeout(() => { this._startPlay(); this._broadcast(); }, 3500);
        } else {
            this.geoState.biddingCurrentBidderIdx = (idx + 1) % 3;
            this._broadcast();
        }
    }

    _startPlay() {
        const w = this.geoState.biddingWinner;
        this.geoState.phase = 'play';
        this.geoState.playCurrentPlayer = (w && w.teamIdx >= 0) ? w.teamIdx : 0;
        this.geoState.playedCards = {};
        this.geoState.playRoundWinner = null;
        this.geoState.playRoundsCompleted = 0;
        this.geoState.handsWon = { player1: 0, player2: 0, player3: 0 };
        this._handResolved = false;
    }

    _onPlayCard(client, { countryCode }) {
        const idx = this._slot(client);
        if (idx < 0 || this.geoState.phase !== 'play') return;
        if (idx !== this.geoState.playCurrentPlayer) return;
        const key = this._key(idx);
        if (!this.geoState.playerCountries[key].includes(countryCode)) return;
        if (this.geoState.playedCards[idx] !== undefined) return;
        this.geoState.playerCountries[key] = this.geoState.playerCountries[key].filter(c => c !== countryCode);
        this.geoState.claimedCountries[key].push(countryCode);
        this.geoState.playedCards[idx] = countryCode;
        const allIn = [0,1,2].every(i => this.geoState.playedCards[i] !== undefined);
        if (allIn) {
            this.geoState.phase = 'resolving';
            this._handResolved = false;
        } else {
            this.geoState.playCurrentPlayer = (idx + 1) % 3;
        }
        this._broadcast();
    }

    _onResolveHand(client, { winnerIdx }) {
        if (this.geoState.phase !== 'resolving' || this._handResolved) return;
        this._handResolved = true;
        this.geoState.playRoundWinner = winnerIdx;
        const key = this._key(winnerIdx);
        if (key in this.geoState.handsWon) this.geoState.handsWon[key]++;
        this.geoState.playRoundsCompleted++;
        this._broadcast();
        // Advance after clients show the 5-second winner overlay
        setTimeout(() => { this._advanceHand(); }, 5500);
    }

    _advanceHand() {
        const done = this.geoState.playRoundsCompleted >= (this.settings.cardsToPlay || 8);
        if (done) {
            const w = this.geoState.biddingWinner;
            if (w && w.teamIdx >= 0) {
                const wk = this._key(w.teamIdx);
                if ((this.geoState.handsWon[wk] || 0) < w.amount) {
                    this.geoState.bidPenalties[wk] = (this.geoState.bidPenalties[wk] || 0) + (this.settings.bidPenaltyAmount || 20);
                }
            }
            if (this.geoState.currentRound < (this.settings.numRounds || 3)) {
                this.geoState.currentRound++;
                this._resetRound();
            } else {
                this.geoState.phase = 'game_over';
            }
        } else {
            this._handResolved = false;
            this.geoState.phase = 'play';
            this.geoState.playedCards = {};
            this.geoState.playRoundWinner = null;
            const w = this.geoState.biddingWinner;
            this.geoState.playCurrentPlayer = (w && w.teamIdx >= 0) ? w.teamIdx : 0;
        }
        this._broadcast();
    }

    _resetRound() {
        this.geoState.phase = 'country_selection';
        this.geoState.currentPlayer = 0;
        this.geoState.playerCountries = { player1: [], player2: [], player3: [] };
        this.geoState.biddingHighBid = null;
        this.geoState.biddingWinner = null;
        this.geoState.biddingLog = [];
        this.geoState.handsWon = { player1: 0, player2: 0, player3: 0 };
        this.geoState.playedCards = {};
        this.geoState.playRoundWinner = null;
        this.geoState.playRoundsCompleted = 0;
        this._handResolved = false;
    }

    _onAlliance(client, { action, targetIdx }) {
        const idx = this._slot(client);
        if (idx < 0) return;
        const k = `${idx}-${targetIdx}`, rk = `${targetIdx}-${idx}`;
        if (action === 'send') {
            this.geoState.alliancesSent[k] = true;
        } else if (action === 'rescind') {
            delete this.geoState.alliancesSent[k];
        } else if (action === 'accept') {
            this.geoState.alliancesSent[k] = true;
            this.geoState.alliancesSent[rk] = true;
            const pen = this.settings.alliancePenaltyAmount || 5;
            this.geoState.alliancePenalties[this._key(idx)]       = (this.geoState.alliancePenalties[this._key(idx)]       || 0) + pen;
            this.geoState.alliancePenalties[this._key(targetIdx)] = (this.geoState.alliancePenalties[this._key(targetIdx)] || 0) + pen;
        } else if (action === 'break') {
            delete this.geoState.alliancesSent[k];
            delete this.geoState.alliancesSent[rk];
            const pen = 10;
            this.geoState.alliancePenalties[this._key(idx)]       = (this.geoState.alliancePenalties[this._key(idx)]       || 0) + pen;
            this.geoState.alliancePenalties[this._key(targetIdx)] = (this.geoState.alliancePenalties[this._key(targetIdx)] || 0) + pen;
        }
        this._broadcast();
    }
}

// ─── C4D Room ─────────────────────────────────────────────────────────────────
class C4DRoom extends BaseGameRoom {
    // ── BaseGameRoom interface ────────────────────────────────────────────────
    getPlayers() {
        return this.clients.map(c => ({
            id: c.sessionId, sessionId: c.sessionId,
            name: `Player ${(this._playerIndexMap.get(c.sessionId) ?? 0) + 1}`,
        }));
    }
    getConfig() { return this.c4dConfig; }
    getPhase()  { return this.c4dPhase; }
    applySettings(s) {
        if (s.teamCount     !== undefined) this.c4dConfig.teamCount     = s.teamCount;
        if (s.wMode         !== undefined) this.c4dConfig.wMode         = s.wMode;
        if (s.ownerMode     !== undefined) this.c4dConfig.ownerMode     = s.ownerMode;
        if (s.scoring       !== undefined) this.c4dConfig.scoring       = s.scoring;
        if (s.victory       !== undefined) this.c4dConfig.victory       = s.victory;
        if (s.fogOfWar      !== undefined) this.c4dConfig.fogOfWar      = s.fogOfWar;
        if (s.claimsPerTurn !== undefined) this.c4dConfig.claimsPerTurn = s.claimsPerTurn;
        if (s.teamColors    !== undefined) this.c4dConfig.teamColors    = s.teamColors;
        if (s.name          !== undefined) this.c4dConfig.name          = s.name;
        if (s.polytopePath  !== undefined && s.polytopePath !== this.c4dPolytopePath) {
            this.c4dPolytopePath = s.polytopePath;
            this.broadcast('polytope_select', { path: s.polytopePath });
        }
        this._refreshMeta();
    }

    onCreate(options) {
        super.onCreate(options); // registers force_dispose + update_settings handlers
        this.autoDispose = false;
        this.maxClients  = options.maxPlayers || 20;

        const state = new RoomState();
        state.gameState = 'waiting';
        this.setState(state);

        this.c4dConfig = {
            name:          options.name || options.roomName || `C4D ${this.roomId.substring(0, 6)}`,
            gameType:      'C4D',
            teamCount:     options.teamCount     || 2,
            wMode:         options.wMode         || 'oscillate',
            ownerMode:     options.ownerMode     || 'permanent',
            scoring:       options.scoring       || [1, 3, 9, 27],
            victory:       options.victory       || 'last-plane',
            fogOfWar:      options.fogOfWar      || false,
            claimsPerTurn: options.claimsPerTurn || 1,
            teamColors:    options.teamColors    || [],
        };

        this.c4dGS            = null;
        this.c4dPhase         = 'waiting';
        this.c4dPolytopePath  = null;
        this._playerIndexMap  = new Map(); // sessionId → join-order index
        this._nextPlayerIndex = 0;

        this._refreshMeta();

        // C4D-specific presence messages (start_game)
        if (this.presence) {
            this.presence.subscribe(`room_${this.roomId}`, (msg) => {
                if (msg?.type === 'start_game' && this.c4dPhase === 'waiting') {
                    this.c4dPhase = 'playing';
                    state.gameState = 'playing';
                    if (msg.gs)           this.c4dGS           = msg.gs;
                    if (msg.polytopePath) this.c4dPolytopePath = msg.polytopePath;
                    this.broadcast('game_started', {
                        config:       this.c4dConfig,
                        gs:           this.c4dGS,
                        polytopePath: this.c4dPolytopePath,
                    });
                    this._refreshMeta();
                    this._publishAdminUpdate();
                }
            });
        }

        this.onMessage('state_sync', (client, data) => {
            if (!data.gs) return;
            this.c4dGS = data.gs;
            if (data.phase) { this.c4dPhase = data.phase; state.gameState = data.phase; this._refreshMeta(); }
            this.broadcast('state_update', { gs: this.c4dGS, phase: this.c4dPhase }, { except: client });
        });

        this.onMessage('request_state', (client) => {
            const playerIndex = this._playerIndexMap.get(client.sessionId) ?? 0;
            client.send('game_config', { config: this.c4dConfig, playerIndex, sessionId: client.sessionId });
            if (this.c4dPolytopePath) client.send('polytope_select', { path: this.c4dPolytopePath });
            if (this.c4dGS) client.send('state_update', { gs: this.c4dGS, phase: this.c4dPhase });
        });
    }

    onJoin(client, options) {
        const playerIndex = this._nextPlayerIndex++;
        this._playerIndexMap.set(client.sessionId, playerIndex);
        client.send('game_config', {
            config:      this.c4dConfig,
            playerIndex,
            sessionId:   client.sessionId,
        });
        if (this.c4dPolytopePath) client.send('polytope_select', { path: this.c4dPolytopePath });
        if (this.c4dGS) client.send('state_update', { gs: this.c4dGS, phase: this.c4dPhase });
        this._refreshMeta();
        super.onJoin(client, options); // publishes admin_update
    }

    onLeave(client, consented) {
        this._playerIndexMap.delete(client.sessionId);
        this._refreshMeta();
        super.onLeave(client, consented); // publishes admin_update
    }

    _refreshMeta() {
        this.setMetadata({
            name:       this.c4dConfig.name,
            type:       'C4D',
            gameState:  this.c4dPhase,
            createdAt:  this.metadata?.createdAt || new Date().toISOString(),
            maxPlayers: this.maxClients,
            clients:    this.clients.length,
        });
    }
}

// ── Room registry ─────────────────────────────────────────────────────────────
// To add a new game: create a Room class above, then add one entry here.
// filterBy restricts matchmaking to clients with matching metadata keys.
const SERVER_GAME_TYPES = {
    constellation: { Room: ConstellationRoom },
    golad:         { Room: GoladRoom },
    centauri:      { Room: CentauriRoom },
    geobridge:     { Room: GeobridgeRoom, filterBy: ['sessionCode'] },
    c4d:           { Room: C4DRoom },
};

// AdminRoom is infrastructure, not a player-facing game — define it separately.
gameServer.define('admin', AdminRoom);

for (const [name, { Room, filterBy }] of Object.entries(SERVER_GAME_TYPES)) {
    const def = gameServer.define(name, Room);
    if (filterBy) def.filterBy(filterBy);
}

// Start server
const port = process.env.PORT || 2567;

gameServer.listen(port).then(() => {
    console.log('\n========================================');
    console.log(`✓ Server running on http://localhost:${port}`);
    console.log(`✓ Admin: http://localhost:${port}/admin`);
    console.log('========================================\n');

    // Route /ttclub-lobby WebSocket upgrades to our signaling server,
    // let Colyseus handle everything else.
    const colyseusUpgradeListeners = server.listeners('upgrade').slice();
    server.removeAllListeners('upgrade');
    server.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url, `http://localhost`).pathname;
        if (pathname === '/ttclub-lobby') {
            ttclubWss.handleUpgrade(request, socket, head, (ws) => {
                ttclubWss.emit('connection', ws, request);
            });
        } else if (pathname.startsWith('/centauri-godot/')) {
            const roomId = pathname.split('/')[2];
            centauriGodotWss.handleUpgrade(request, socket, head, (ws) => {
                centauriGodotWss.emit('connection', ws, roomId);
            });
        } else {
            for (const listener of colyseusUpgradeListeners) {
                listener.call(server, request, socket, head);
            }
        }
    });
    console.log(`✓ TTClub signaling: ws://localhost:${port}/ttclub-lobby`);
}).catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});