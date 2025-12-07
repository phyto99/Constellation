const { Server, Room, matchMaker } = require('colyseus');
const { MapSchema, Schema, type } = require('@colyseus/schema');
const { createServer } = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const basicAuth = require('express-basic-auth');
const { monitor } = require('@colyseus/monitor');

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
type('boolean')(Player.prototype, 'isHost');

class RoomState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.gameState = 'waiting';
        this.teams = new MapSchema();
        this.hostId = '';
    }
}

type({ map: Player })(RoomState.prototype, 'players');
type('string')(RoomState.prototype, 'gameState');
type({ map: 'any' })(RoomState.prototype, 'teams');
type('string')(RoomState.prototype, 'hostId');

// ConstellationRoom class
class ConstellationRoom extends Room {
    onCreate(options) {
        console.log('ConstellationRoom created with options:', options);

        const state = new RoomState();
        state.gameState = 'waiting';
        state.hostId = '';
        this.setState(state);

        this.maxClients = options.maxPlayers || 20;
        this.gameConfig = options || {};

        this.setMetadata({
            name: options.name || `Game ${this.roomId.substring(0, 6)}`,
            type: options.gameType || 'Constellation',
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
                            this.broadcast('game_started', { gameState: 'playing' });
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
                            player.team = (msg.teamIndex === null || msg.teamIndex === undefined) ? null : parseInt(msg.teamIndex, 10);
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
                this.broadcast('game_started', { gameState: 'playing' });
                // update monitor metadata to reflect new state
                this.setMetadata({ ...this.metadata, gameState: 'playing' });
                this.updateAdminRoom();
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

    updateAdminRoom() {
        if (this.presence) {
            this.presence.publish('admin_update', {
                roomId: this.roomId,
                players: Array.from(this.state.players.values()),
                state: this.state.gameState,
                playerCount: this.clients.length,
                metadata: this.metadata || {}
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
                    playerCount: roomState?.playerCount || 0
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

// Express setup
const app = express();
app.use(cors());
app.use(express.json());

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