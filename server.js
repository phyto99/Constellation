const { Server, Room, matchMaker } = require('colyseus');
const { MapSchema, Schema, type } = require('@colyseus/schema');
const { createServer } = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const basicAuth = require('express-basic-auth');
const { monitor } = require('@colyseus/monitor');
const fs = require('fs');
const { StarSchema, TeamSchema, GameStateSchema } = require('./game-schema');

const app = express();
app.use(cors());
app.use(express.json());

// Map endpoints
const MAPS_DIR = path.join(__dirname, 'CONSTELLATION MAPS');

app.get('/api/maps', (req, res) => {
    if (!fs.existsSync(MAPS_DIR)) {
        return res.json([]);
    }
    fs.readdir(MAPS_DIR, (err, files) => {
        if (err) {
            console.error('Error reading maps directory:', err);
            return res.status(500).json({ error: 'Failed to list maps' });
        }
        // Filter for .json files
        const maps = files.filter(f => f.endsWith('.json'));
        res.json(maps);
    });
});

app.get('/api/maps/:filename', (req, res) => {
    const filename = req.params.filename;
    // Basic security to prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }

    const filePath = path.join(MAPS_DIR, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Map not found' });
    }

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading map file:', err);
            return res.status(500).json({ error: 'Failed to read map' });
        }
        try {
            const json = JSON.parse(data);
            res.json(json);
        } catch (e) {
            res.status(500).json({ error: 'Invalid JSON in map file' });
        }
    });
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
    }
}

type('string')(Player.prototype, 'id');
type('string')(Player.prototype, 'name');
type('number')(Player.prototype, 'team');
type('boolean')(Player.prototype, 'ready');
type('boolean')(Player.prototype, 'connected');
type('number')(Player.prototype, 'connectedAt');
type('string')(Player.prototype, 'studentId');

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

        const state = new RoomState();
        state.gameState = 'waiting';
        state.hostId = '';
        this.setState(state);

        // Prevent room from disappearing when page is refreshed (empty room)
        this.autoDispose = false;

        this.maxClients = options.maxPlayers || 20;
        // Ensure gameConfig has defaults so clients receive full settings
        this.gameConfig = {
            name: options.name || `Game ${this.roomId.substring(0, 6)}`,
            gameType: options.gameType || 'Constellation',
            roundLength: options.roundLength || 30,
            rounds: options.rounds || 10,
            countdownLength: options.countdownLength || 5,
            steals: options.steals || 50,
            headquarters: options.headquarters || 2,
            multipliers: options.multipliers || { count: 500, distance: 1, hq: 10, destruction: 1 },
            aiBots: options.aiBots || []
        };

        this.setMetadata({
            name: this.gameConfig.name,
            type: this.gameConfig.gameType,
            gameState: 'waiting',
            createdAt: new Date().toISOString(),
            maxPlayers: this.maxClients,
            clients: 0
        });

        // Listen for admin presence commands so the admin UI doesn't need to join game rooms
        if (this.presence) {
            this.presence.subscribe(`room_${this.roomId}`, (msg) => {
                try {
                    if (!msg || !msg.type) return;
                    if (msg.type === 'start_game') {
                        if (this.state.gameState === 'waiting') {
                            this.state.gameState = 'playing';
                            this.broadcast('game_started', { gameState: 'playing', config: this.gameConfig, currentRound: 1 });
                            this.setMetadata({ ...this.metadata, gameState: 'playing' });
                            this.updateAdminRoom();
                        }
                    } else if (msg.type === 'force_dispose') {
                        // lock and disconnect all clients, the room will auto-dispose
                        this.locked = true;
                        this.clients.forEach((c) => { try { c.leave(0); } catch (e) { console.error('Error forcing client leave:', e); } });
                        setTimeout(() => this.updateAdminRoom(), 200);
                    } else if (msg.type === 'assign_team') {
                        const player = this.state.players.get(msg.playerId);
                        if (player) {
                            player.team = (msg.teamIndex === null || msg.teamIndex === undefined || msg.teamIndex === '') ? null : parseInt(msg.teamIndex, 10);
                            this.updateAdminRoom();
                        }
                    } else if (msg.type === 'kick_player') {
                        const target = this.clients.find((c) => c.sessionId === msg.playerId);
                        if (target) {
                            try { target.leave(0); } catch (e) { console.error('Error kicking player:', e); }
                        }
                        // Also remove from state if present
                        if (this.state.players.has(msg.playerId)) {
                            this.state.players.delete(msg.playerId);
                        }
                        this.updateAdminRoom();
                    } else if (msg.type === 'update_settings') {
                        // Merge provided settings into gameConfig
                        if (msg.settings) {
                            // Deep merge multipliers if provided
                            if (msg.settings.multipliers) {
                                this.gameConfig.multipliers = { ...this.gameConfig.multipliers, ...msg.settings.multipliers };
                                delete msg.settings.multipliers;
                            }
                            // Merge other top-level settings
                            Object.assign(this.gameConfig, msg.settings);

                            // Broadcast update to all clients in the room
                            this.broadcast('settings_update', { config: this.gameConfig });
                            console.log(`Settings updated for room ${this.roomId}:`, this.gameConfig);
                        }
                    }
                } catch (e) {
                    console.error('Error handling presence message for room', this.roomId, e);
                }
            });
        }

        this.onMessage('join_team', (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (player) {
                player.team = data.teamIndex;
                this.updateAdminRoom();
            }
        });

        this.onMessage('start_game', (client, data) => {
            if (this.state.gameState === 'waiting') {
                this.state.gameState = 'playing';
                this.broadcast('game_started', { gameState: 'playing', config: this.gameConfig, currentRound: 1 });
                // update monitor metadata to reflect new state
                this.setMetadata({ ...this.metadata, gameState: 'playing' });
                this.updateAdminRoom();
            }
        });

        // Broadcast cursor movements to all other players
        this.onMessage('cursor_move', (client, data) => {
            this.broadcast('cursor_move', {
                playerId: client.sessionId,
                x: data.x,
                y: data.y,
                teamIndex: data.teamIndex
            }, { except: client });
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

        // Game state synchronization - claim star
        this.onMessage('claim_star', (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (!player || player.team === null) return;

            const teamIndex = player.team;
            const validation = this.validateClaim(data.starIndex, teamIndex);

            if (validation.valid) {
                // Apply move to server state
                this.state.game.stars[data.starIndex].tm = teamIndex;
                this.state.game.teams[teamIndex].movesLeft--;

                // Broadcast delta update to all clients
                this.broadcast('state_changed', {
                    stars: [{ index: data.starIndex, tm: teamIndex }],
                    teams: [{ index: teamIndex, movesLeft: this.state.game.teams[teamIndex].movesLeft }]
                });
            } else {
                // Send rejection with reason - client will rollback and refund
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: validation.reason,
                    refund: { moves: 1 }
                });
            }
        });

        // Game state synchronization - steal star
        this.onMessage('steal_star', (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (!player || player.team === null) return;

            const teamIndex = player.team;
            const validation = this.validateSteal(data.starIndex, teamIndex);

            if (validation.valid) {
                // Apply steal to server state
                this.state.game.stars[data.starIndex].tm = teamIndex;
                this.state.game.teams[teamIndex].movesLeft--;
                this.state.game.teams[teamIndex].stealsLeft--;

                // Broadcast delta update to all clients
                this.broadcast('state_changed', {
                    stars: [{ index: data.starIndex, tm: teamIndex }],
                    teams: [{
                        index: teamIndex,
                        movesLeft: this.state.game.teams[teamIndex].movesLeft,
                        stealsLeft: this.state.game.teams[teamIndex].stealsLeft
                    }]
                });
            } else {
                // Send rejection with reason - client will rollback and refund
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: validation.reason,
                    refund: { moves: 1, steals: 1 }
                });
            }
        });

        // Game state synchronization - place HQ
        this.onMessage('place_hq', (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (!player || player.team === null) return;

            const teamIndex = player.team;
            const validation = this.validateHQ(data.starIndex, teamIndex);

            if (validation.valid) {
                // Apply HQ placement to server state
                this.state.game.stars[data.starIndex].tm = teamIndex;
                this.state.game.stars[data.starIndex].hq = true;
                this.state.game.teams[teamIndex].movesLeft--;
                this.state.game.teams[teamIndex].hqCount++;

                // Broadcast delta update to all clients
                this.broadcast('state_changed', {
                    stars: [{ index: data.starIndex, tm: teamIndex, hq: true }],
                    teams: [{
                        index: teamIndex,
                        movesLeft: this.state.game.teams[teamIndex].movesLeft,
                        hqCount: this.state.game.teams[teamIndex].hqCount
                    }]
                });
            } else {
                // Send rejection with reason - client will rollback and refund
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: validation.reason,
                    refund: { moves: 1 }
                });
            }
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
                    // Initialize stars
                    data.stars.forEach((starData, index) => {
                        const star = new StarSchema();
                        star.x = starData.x;
                        star.y = starData.y;
                        star.ty = starData.ty;
                        star.tm = starData.tm !== null && starData.tm !== undefined ? starData.tm : -1;
                        star.hq = starData.hq || false;
                        star.pr = starData.pr || false;
                        star.destroyed = starData.destroyed || false;
                        star.req = starData.req || 0;
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
                } else {
                    console.log(`⚠️ Game state already initialized or invalid data for room ${this.roomId}`);
                }
            } catch (error) {
                console.error(`❌ Error initializing game state for room ${this.roomId}:`, error);
                console.error('Error stack:', error.stack);
                // Don't disconnect client, just log the error
            }
        });

        // Allow admin-side deletion by forcing all clients to leave (room will auto-dispose)
        this.onMessage('force_dispose', () => {
            try {
                this.locked = true;
                // Disconnect all clients
                this.clients.forEach((c) => {
                    try { c.leave(0); } catch (e) { console.error('Error forcing client leave:', e); }
                });
                setTimeout(() => this.updateAdminRoom(), 200);
            } catch (e) {
                console.error('Failed to force dispose room:', e);
            }
        });

        setTimeout(() => this.updateAdminRoom(), 100);
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
        player.team = null;
        player.ready = false;
        player.connected = true;
        player.connectedAt = Date.now();
        player.isHost = isFirstPlayer;

        this.state.players.set(client.sessionId, player);
        // keep monitor metadata in sync with game state
        this.setMetadata({ ...this.metadata, clients: this.clients.length });
        this.updateAdminRoom();
    }

    onLeave(client, consented) {
        console.log(`Player ${client.sessionId} left room ${this.roomId}`);
        this.state.players.delete(client.sessionId);
        // update monitor metadata clients count
        this.setMetadata({ ...this.metadata, clients: this.clients.length });
        this.updateAdminRoom();
    }

    // Validation methods for server-authoritative game state
    validateClaim(starIndex, teamIndex) {
        if (!this.state.game.initialized) {
            return { valid: false, reason: 'Game state not initialized' };
        }

        if (starIndex < 0 || starIndex >= this.state.game.stars.length) {
            return { valid: false, reason: 'Invalid star index' };
        }

        const star = this.state.game.stars[starIndex];
        const team = this.state.game.teams[teamIndex];

        if (star.destroyed) {
            return { valid: false, reason: 'Star is destroyed' };
        }

        if (star.tm !== -1) {
            return { valid: false, reason: 'Star already owned' };
        }

        if (team.movesLeft <= 0) {
            return { valid: false, reason: 'No moves remaining' };
        }

        return { valid: true };
    }

    validateSteal(starIndex, teamIndex) {
        if (!this.state.game.initialized) {
            return { valid: false, reason: 'Game state not initialized' };
        }

        if (starIndex < 0 || starIndex >= this.state.game.stars.length) {
            return { valid: false, reason: 'Invalid star index' };
        }

        const star = this.state.game.stars[starIndex];
        const team = this.state.game.teams[teamIndex];

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

        // Type 2 = cluster, Type 3 = blackhole
        if (star.ty === 2 || star.ty === 3) {
            return { valid: false, reason: 'Cannot steal cluster or blackhole' };
        }

        if (team.stealsLeft <= 0) {
            return { valid: false, reason: 'No steals remaining' };
        }

        if (team.movesLeft <= 0) {
            return { valid: false, reason: 'No moves remaining' };
        }

        return { valid: true };
    }

    validateHQ(starIndex, teamIndex) {
        if (!this.state.game.initialized) {
            return { valid: false, reason: 'Game state not initialized' };
        }

        if (starIndex < 0 || starIndex >= this.state.game.stars.length) {
            return { valid: false, reason: 'Invalid star index' };
        }

        const star = this.state.game.stars[starIndex];
        const team = this.state.game.teams[teamIndex];

        if (star.destroyed) {
            return { valid: false, reason: 'Star is destroyed' };
        }

        if (star.tm !== -1 && star.tm !== teamIndex) {
            return { valid: false, reason: 'Cannot place HQ on enemy star' };
        }

        // Assuming HQ limit is 2 (from gameConfig.headquarters)
        const hqLimit = this.gameConfig.headquarters || 2;
        if (team.hqCount >= hqLimit) {
            return { valid: false, reason: 'HQ limit reached' };
        }

        if (team.movesLeft <= 0) {
            return { valid: false, reason: 'No moves remaining' };
        }

        return { valid: true };
    }

    updateAdminRoom() {
        if (this.presence) {
            console.log(`📡 Room ${this.roomId} publishing admin_update (Players: ${this.clients.length})`);
            this.presence.publish('admin_update', {
                roomId: this.roomId,
                players: Array.from(this.state.players.values()),
                state: this.state.gameState,
                playerCount: this.clients.length,
                metadata: this.metadata || {},
                config: this.gameConfig
            });
        }
    }

    onDispose() {
        console.log(`Room ${this.roomId} disposed`);
    }
}

// AdminRoom class
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
                await this.presence.publish(`room_${data.roomId}`, { type: 'start_game' });
                client.send('game_started', { success: true, roomId: data.roomId });
            } catch (error) {
                client.send('game_started', { success: false, roomId: data.roomId, error: error.message });
            }
        });

        this.onMessage('delete_room', async (client, data) => {
            try {
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
                await this.presence.publish(`room_${data.roomId}`, { type: 'assign_team', playerId: data.playerId, teamIndex: data.teamIndex });
            } catch (error) {
                console.error('Error assigning team via AdminRoom:', error);
            }
        });

        this.onMessage('kick_player', async (client, data) => {
            try {
                await this.presence.publish(`room_${data.roomId}`, { type: 'kick_player', playerId: data.playerId });
            } catch (error) {
                console.error('Error kicking player via AdminRoom:', error);
            }
        });

        this.onMessage('update_settings', async (client, data) => {
            try {
                await this.presence.publish(`room_${data.roomId}`, { type: 'update_settings', settings: data.settings });
            } catch (error) {
                console.error('Error updating settings via AdminRoom:', error);
            }
        });

        // Listen for room updates
        this.presence.subscribe('admin_update', (data) => {
            this.roomStates.set(data.roomId, data);
            this.broadcast('player_update', data);
        });

        // Periodic updates
        this.updateInterval = setInterval(() => this.updateRoomsList(), 5000);
        setTimeout(() => this.updateRoomsList(), 500);
    }

    async updateRoomsList() {
        try {
            const rooms = await matchMaker.query({ name: 'constellation' });
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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'other.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/game/:roomId', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(path.join(__dirname), { index: false }));

// Server setup
const server = createServer(app);
const gameServer = new Server({ server, express: app });

// Define rooms
gameServer.define('constellation', ConstellationRoom);
gameServer.define('admin', AdminRoom);

// Start server
const port = process.env.PORT || 2567;

gameServer.listen(port).then(() => {
    console.log('\n========================================');
    console.log(`✓ Server running on http://localhost:${port}`);
    console.log(`✓ Admin: http://localhost:${port}/admin`);
    console.log('========================================\n');
}).catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});