const { Server, Room } = require('colyseus');
const { MapSchema, Schema, type } = require('@colyseus/schema');
const { createServer } = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');

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
    }
}

type('string')(Player.prototype, 'id');
type('string')(Player.prototype, 'name');
type('number')(Player.prototype, 'team');
type('boolean')(Player.prototype, 'ready');
type('boolean')(Player.prototype, 'connected');
type('number')(Player.prototype, 'connectedAt');

class RoomState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.gameState = 'waiting';
        this.teams = new MapSchema();
    }
}

type({ map: Player })(RoomState.prototype, 'players');
type('string')(RoomState.prototype, 'gameState');
type({ map: 'any' })(RoomState.prototype, 'teams');

// Game room classes
class ConstellationRoom extends Room {
    onCreate(options) {
        console.log('ConstellationRoom created with options:', options);
        
        const state = new RoomState();
        state.gameState = 'waiting';
        this.setState(state);

        this.maxClients = options.maxPlayers || 20;
        
        // Store config separately (not in Schema state)
        this.gameConfig = options || {};
        
        // Set room metadata using setMetadata method
        this.setMetadata({
            name: options.name || `Game ${this.roomId}`,
            type: options.type || 'Constellation',
            gameState: 'waiting',
            createdAt: new Date().toISOString(),
            maxPlayers: this.maxClients,
            gameMode: options.gameMode || 'competitive',
            hostName: options.hostName || 'Unknown'
        });

        console.log('Room created successfully');

        this.onMessage('join_team', (client, data) => {
            this.assignPlayerToTeam(client.sessionId, data.teamIndex);
        });

        this.onMessage('start_game', (client, data) => {
            if (this.state.gameState === 'waiting') {
                this.startGame();
            }
        });

        this.onMessage('cursor_move', (client, data) => {
            // Broadcast cursor position to all other clients
            this.broadcast('cursor_move', {
                sessionId: client.sessionId,
                x: data.x,
                y: data.y,
                color: data.color,
                name: data.name
            }, { except: client });
        });

        // Enhanced message handlers for cross-room communication
        this.setupCrossRoomMessageHandlers();
    }

    onJoin(client, options) {
        console.log(`Player ${client.sessionId} joined room ${this.roomId}`);
        
        const player = new Player();
        player.id = client.sessionId;
        player.name = options.name || `Player ${client.sessionId.substring(0, 6)}`;
        player.team = null;
        player.ready = false;
        player.connected = true;
        player.connectedAt = Date.now();

        this.state.players.set(client.sessionId, player);
        
        console.log(`✓ Player joined: ${player.name}`);
        
        // Enhanced admin room notification
        this.updateAdminRoom();
        this.notifyPlayerConnection(player);
    }

    onLeave(client, consented) {
        console.log(`Player ${client.sessionId} left room ${this.roomId}`);
        
        // Notify admin room before removing player
        this.notifyPlayerDisconnection(client.sessionId);
        
        this.state.players.delete(client.sessionId);
        this.updateAdminRoom();
    }

    assignPlayerToTeam(playerId, teamIndex) {
        const player = this.state.players.get(playerId);
        if (player) {
            const oldTeam = player.team;
            player.team = teamIndex;
            player.lastTeamChange = Date.now();
            
            console.log(`Player ${playerId} moved from team ${oldTeam} to team ${teamIndex}`);
            
            // Broadcast to all clients in the room
            this.broadcast('player_team_changed', {
                playerId,
                oldTeam,
                newTeam: teamIndex,
                timestamp: Date.now()
            });
            
            this.updateAdminRoom();
        }
    }

    startGame() {
        const previousState = this.state.gameState;
        this.state.gameState = 'playing';
        
        // Update metadata using setMetadata
        const currentMetadata = this.metadata || {};
        this.setMetadata({
            ...currentMetadata,
            gameState: 'playing',
            startedAt: new Date().toISOString()
        });
        
        this.broadcast('game_started', { 
            gameState: 'playing',
            startedAt: new Date().toISOString()
        });
        
        // Enhanced admin room notification
        this.notifyGameStateChange(previousState, 'playing');
        this.updateAdminRoom();
        
        console.log(`Game ${this.roomId} started`);
    }

    // Enhanced admin room update with comprehensive data
    updateAdminRoom() {
        if (this.presence) {
            const currentMetadata = this.metadata || {};
            const updateData = {
                roomId: this.roomId,
                players: Array.from(this.state.players.values()),
                state: this.state.gameState,
                playerCount: this.clients.length,
                metadata: {
                    ...currentMetadata,
                    lastUpdate: Date.now(),
                    activeClients: this.clients.length
                },
                teams: this.getTeamSummary(),
                timestamp: Date.now()
            };

            this.presence.publish('admin_update', updateData);
        }
    }

    // Notify admin room of player connection
    notifyPlayerConnection(player) {
        if (this.presence) {
            this.presence.publish('player_connected', {
                roomId: this.roomId,
                player: player,
                timestamp: Date.now()
            });
        }
    }

    // Notify admin room of player disconnection
    notifyPlayerDisconnection(playerId) {
        if (this.presence) {
            this.presence.publish('player_disconnected', {
                roomId: this.roomId,
                playerId: playerId,
                timestamp: Date.now()
            });
        }
    }

    // Notify admin room of game state changes
    notifyGameStateChange(oldState, newState) {
        if (this.presence) {
            this.presence.publish('game_state_changed', {
                roomId: this.roomId,
                oldState: oldState,
                gameState: newState,
                metadata: this.metadata || {},
                timestamp: Date.now()
            });
        }
    }

    // Get team summary for admin display
    getTeamSummary() {
        const teams = new Map();
        
        for (const player of this.state.players.values()) {
            if (player.team !== null && player.team !== undefined) {
                if (!teams.has(player.team)) {
                    teams.set(player.team, {
                        teamIndex: player.team,
                        players: [],
                        playerCount: 0
                    });
                }
                
                const team = teams.get(player.team);
                team.players.push({
                    id: player.id,
                    name: player.name,
                    ready: player.ready,
                    connected: player.connected
                });
                team.playerCount++;
            }
        }
        
        return Array.from(teams.values());
    }

    // Setup cross-room message handlers
    setupCrossRoomMessageHandlers() {
        // Listen for admin commands via presence system
        this.presence.subscribe(`room_${this.roomId}`, (message) => {
            this.handleAdminCommand(message);
        });
    }

    // Handle commands from admin room
    handleAdminCommand(message) {
        try {
            switch (message.type) {
                case 'start_game':
                    if (this.state.gameState === 'waiting') {
                        this.startGame();
                    }
                    break;
                    
                case 'assign_team':
                    this.assignPlayerToTeam(message.playerId, message.teamIndex);
                    break;
                    
                case 'force_dispose':
                    console.log(`Force disposing room ${this.roomId} by admin command`);
                    this.disconnect();
                    break;
                    
                case 'sync_state_request':
                    // Send current state to admin room
                    this.updateAdminRoom();
                    break;
                    
                default:
                    console.warn(`Unknown admin command: ${message.type}`);
            }
        } catch (error) {
            console.error(`Error handling admin command in room ${this.roomId}:`, error);
        }
    }

    onDispose() {
        // Notify admin room of disposal
        if (this.presence) {
            this.presence.publish('room_disposed', {
                roomId: this.roomId,
                timestamp: Date.now()
            });
        }
        
        console.log(`Room ${this.roomId} disposed`);
    }
}

// Admin room for managing game sessions
class AdminRoom extends Room {
    onCreate(options) {
        console.log('AdminRoom created');

        this.setState({
            rooms: new MapSchema()
        });

        // Enhanced state tracking for comprehensive synchronization
        this.roomStates = new Map(); // Track detailed room states
        this.lastSyncTime = new Map(); // Track last sync time for each room
        this.syncErrors = new Map(); // Track sync errors for recovery
        this.cleanupQueue = new Set(); // Queue for rooms needing cleanup

        // Enhanced message handlers for better state management
        this.onMessage('create_room', async (client, data) => {
            console.log('Received create_room request:', data);
            
            try {
                console.log('Creating room with options:', data.options);
                
                // Use global gameServer reference to access matchMaker
                const room = await global.gameServer.matchMaker.createRoom('constellation', data.options);
                console.log('Room created successfully:', room.roomId);
                
                // Initialize room state tracking
                this.initializeRoomState(room.roomId, data.options);
                
                // Send immediate response
                client.send('room_created', {
                    success: true,
                    roomId: room.roomId,
                    gameUrl: `/game/${room.roomId}`
                });

                // Update rooms list after a short delay to ensure room is fully initialized
                setTimeout(() => {
                    this.updateRoomsList();
                }, 200);
                
            } catch (error) {
                console.error('Error creating room:', error);
                console.error('Error stack:', error.stack);
                
                client.send('room_created', {
                    success: false,
                    error: error.message || 'Unknown error occurred'
                });
            }
        });

        this.onMessage('start_game', async (client, data) => {
            try {
                const rooms = await global.gameServer.matchMaker.query({ name: 'constellation' });
                const room = rooms.find(r => r.roomId === data.roomId);
                
                if (room) {
                    // Update local state before sending command
                    this.updateRoomState(data.roomId, { gameState: 'starting' });
                    
                    // Send start command to the room
                    await this.presence.publish(`room_${data.roomId}`, {
                        type: 'start_game'
                    });
                    
                    client.send('game_started', {
                        success: true,
                        roomId: data.roomId
                    });

                    // Force immediate sync after state change
                    this.syncRoomState(data.roomId);
                } else {
                    client.send('game_started', {
                        success: false,
                        roomId: data.roomId,
                        error: 'Room not found'
                    });
                }
            } catch (error) {
                console.error('Error starting game:', error);
                client.send('game_started', {
                    success: false,
                    roomId: data.roomId,
                    error: error.message
                });
            }
        });

        this.onMessage('delete_room', async (client, data) => {
            try {
                const rooms = await global.gameServer.matchMaker.query({ name: 'constellation' });
                const room = rooms.find(r => r.roomId === data.roomId);
                
                if (room) {
                    // Mark room for cleanup
                    this.cleanupQueue.add(data.roomId);
                    
                    // Force disconnect all clients and dispose room
                    await this.presence.publish(`room_${data.roomId}`, {
                        type: 'force_dispose'
                    });
                    
                    client.send('room_deleted', {
                        success: true,
                        roomId: data.roomId
                    });

                    // Clean up local state
                    this.cleanupRoomState(data.roomId);
                    this.updateRoomsList();
                } else {
                    client.send('room_deleted', {
                        success: false,
                        roomId: data.roomId,
                        error: 'Room not found'
                    });
                }
            } catch (error) {
                console.error('Error deleting room:', error);
                client.send('room_deleted', {
                    success: false,
                    roomId: data.roomId,
                    error: error.message
                });
            }
        });

        this.onMessage('assign_team', async (client, data) => {
            try {
                // Update local state optimistically
                this.updatePlayerTeamAssignment(data.roomId, data.playerId, data.teamIndex);
                
                await this.presence.publish(`room_${data.roomId}`, {
                    type: 'assign_team',
                    playerId: data.playerId,
                    teamIndex: data.teamIndex
                });

                // Broadcast immediate update to all admin clients
                this.broadcastRoomUpdate(data.roomId);
            } catch (error) {
                console.error('Error assigning team:', error);
                // Revert optimistic update on error
                this.syncRoomState(data.roomId);
            }
        });

        // Enhanced message handler for room state requests
        this.onMessage('request_room_state', async (client, data) => {
            try {
                const roomState = this.roomStates.get(data.roomId);
                if (roomState) {
                    client.send('room_state_response', {
                        roomId: data.roomId,
                        state: roomState,
                        timestamp: Date.now()
                    });
                } else {
                    // Force sync if we don't have the state
                    await this.syncRoomState(data.roomId);
                }
            } catch (error) {
                console.error('Error handling room state request:', error);
            }
        });

        // Enhanced cross-room communication listeners
        this.setupCrossRoomCommunication();

        // Periodic room status updates and cleanup mechanisms
        this.setupPeriodicUpdates();
    }

    // Initialize room state tracking
    initializeRoomState(roomId, options) {
        const initialState = {
            roomId,
            gameState: 'waiting',
            players: new Map(),
            teams: new Map(),
            config: options || {},
            metadata: {
                name: options?.name || `Game ${roomId}`,
                type: options?.type || 'Constellation',
                createdAt: new Date().toISOString(),
                lastUpdate: Date.now()
            },
            playerCount: 0,
            connectionStatus: 'active'
        };

        this.roomStates.set(roomId, initialState);
        this.lastSyncTime.set(roomId, Date.now());
        console.log(`Initialized state tracking for room ${roomId}`);
    }

    // Update room state with enhanced tracking
    updateRoomState(roomId, updates) {
        const currentState = this.roomStates.get(roomId);
        if (!currentState) {
            console.warn(`Attempted to update non-existent room state: ${roomId}`);
            return;
        }

        // Merge updates with current state
        const updatedState = {
            ...currentState,
            ...updates,
            metadata: {
                ...currentState.metadata,
                ...updates.metadata,
                lastUpdate: Date.now()
            }
        };

        this.roomStates.set(roomId, updatedState);
        this.lastSyncTime.set(roomId, Date.now());
        
        console.log(`Updated state for room ${roomId}:`, updates);
    }

    // Update player team assignment optimistically
    updatePlayerTeamAssignment(roomId, playerId, teamIndex) {
        const roomState = this.roomStates.get(roomId);
        if (!roomState) return;

        const player = roomState.players.get(playerId);
        if (player) {
            player.team = teamIndex;
            player.lastUpdate = Date.now();
            this.updateRoomState(roomId, { players: roomState.players });
        }
    }

    // Setup cross-room communication for real-time updates
    setupCrossRoomCommunication() {
        // Listen for room updates from game rooms
        this.presence.subscribe('admin_update', (data) => {
            this.handleRoomUpdate(data);
        });

        // Listen for player connection events
        this.presence.subscribe('player_connected', (data) => {
            this.handlePlayerConnection(data);
        });

        // Listen for player disconnection events
        this.presence.subscribe('player_disconnected', (data) => {
            this.handlePlayerDisconnection(data);
        });

        // Listen for game state changes
        this.presence.subscribe('game_state_changed', (data) => {
            this.handleGameStateChange(data);
        });

        // Listen for room disposal events
        this.presence.subscribe('room_disposed', (data) => {
            this.handleRoomDisposal(data);
        });

        console.log('Cross-room communication listeners established');
    }

    // Handle room updates from game rooms
    handleRoomUpdate(data) {
        try {
            const { roomId, players, state, playerCount, metadata } = data;
            
            // Update local room state
            this.updateRoomState(roomId, {
                players: new Map(players?.map(p => [p.id, p]) || []),
                gameState: state,
                playerCount: playerCount || 0,
                metadata: metadata
            });

            // Broadcast update to all admin clients
            this.broadcastRoomUpdate(roomId);
            
        } catch (error) {
            console.error('Error handling room update:', error);
            this.syncErrors.set(data.roomId, error);
        }
    }

    // Handle player connection events
    handlePlayerConnection(data) {
        try {
            const { roomId, player } = data;
            const roomState = this.roomStates.get(roomId);
            
            if (roomState) {
                roomState.players.set(player.id, {
                    ...player,
                    connected: true,
                    connectedAt: Date.now()
                });
                roomState.playerCount = roomState.players.size;
                
                this.updateRoomState(roomId, {
                    players: roomState.players,
                    playerCount: roomState.playerCount
                });

                this.broadcastRoomUpdate(roomId);
            }
        } catch (error) {
            console.error('Error handling player connection:', error);
        }
    }

    // Handle player disconnection events
    handlePlayerDisconnection(data) {
        try {
            const { roomId, playerId } = data;
            const roomState = this.roomStates.get(roomId);
            
            if (roomState && roomState.players.has(playerId)) {
                const player = roomState.players.get(playerId);
                player.connected = false;
                player.disconnectedAt = Date.now();
                
                // Remove player after grace period or immediately if room is disposing
                setTimeout(() => {
                    if (roomState.players.has(playerId) && !roomState.players.get(playerId).connected) {
                        roomState.players.delete(playerId);
                        roomState.playerCount = roomState.players.size;
                        this.updateRoomState(roomId, {
                            players: roomState.players,
                            playerCount: roomState.playerCount
                        });
                        this.broadcastRoomUpdate(roomId);
                    }
                }, 30000); // 30 second grace period

                this.broadcastRoomUpdate(roomId);
            }
        } catch (error) {
            console.error('Error handling player disconnection:', error);
        }
    }

    // Handle game state changes
    handleGameStateChange(data) {
        try {
            const { roomId, gameState, metadata } = data;
            
            this.updateRoomState(roomId, {
                gameState,
                metadata: {
                    ...metadata,
                    gameState
                }
            });

            this.broadcastRoomUpdate(roomId);
            
            // Trigger cleanup if game is finished
            if (gameState === 'finished') {
                setTimeout(() => {
                    this.scheduleRoomCleanup(roomId);
                }, 300000); // 5 minutes after game finishes
            }
        } catch (error) {
            console.error('Error handling game state change:', error);
        }
    }

    // Handle room disposal events
    handleRoomDisposal(data) {
        try {
            const { roomId } = data;
            this.cleanupRoomState(roomId);
            this.broadcastRoomUpdate(roomId, true); // true indicates room was disposed
        } catch (error) {
            console.error('Error handling room disposal:', error);
        }
    }

    // Broadcast room update to all admin clients
    broadcastRoomUpdate(roomId, disposed = false) {
        try {
            const roomState = this.roomStates.get(roomId);
            
            if (disposed || !roomState) {
                this.broadcast('room_disposed', { roomId });
                return;
            }

            const updateData = {
                roomId,
                players: Array.from(roomState.players.values()),
                state: roomState.gameState,
                playerCount: roomState.playerCount,
                metadata: roomState.metadata,
                timestamp: Date.now()
            };

            this.broadcast('player_update', updateData);
            this.broadcast('room_state_change', {
                roomId,
                state: roomState.gameState,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('Error broadcasting room update:', error);
        }
    }

    // Setup periodic room status updates and cleanup mechanisms
    setupPeriodicUpdates() {
        // Periodic rooms list update (every 5 seconds)
        this.updateRoomsInterval = setInterval(() => {
            this.updateRoomsList();
        }, 5000);

        // Periodic state synchronization (every 10 seconds)
        this.stateSyncInterval = setInterval(() => {
            this.performPeriodicStateSync();
        }, 10000);

        // Periodic cleanup check (every 30 seconds)
        this.cleanupInterval = setInterval(() => {
            this.performPeriodicCleanup();
        }, 30000);

        // Health check interval (every 60 seconds)
        this.healthCheckInterval = setInterval(() => {
            this.performHealthCheck();
        }, 60000);

        console.log('Periodic update intervals established');
    }

    // Perform periodic state synchronization
    async performPeriodicStateSync() {
        try {
            const rooms = await global.gameServer.matchMaker.query({ name: 'constellation' });
            const activeRoomIds = new Set(rooms.map(r => r.roomId));

            // Sync states for all tracked rooms
            for (const [roomId, roomState] of this.roomStates.entries()) {
                if (activeRoomIds.has(roomId)) {
                    // Check if room needs sync (hasn't been updated recently)
                    const lastSync = this.lastSyncTime.get(roomId) || 0;
                    const timeSinceSync = Date.now() - lastSync;
                    
                    if (timeSinceSync > 30000) { // 30 seconds
                        await this.syncRoomState(roomId);
                    }
                } else {
                    // Room no longer exists, mark for cleanup
                    this.scheduleRoomCleanup(roomId);
                }
            }
        } catch (error) {
            console.error('Error during periodic state sync:', error);
        }
    }

    // Sync individual room state
    async syncRoomState(roomId) {
        try {
            const rooms = await global.gameServer.matchMaker.query({ name: 'constellation' });
            const room = rooms.find(r => r.roomId === roomId);
            
            if (room) {
                // Request fresh state from the room
                await this.presence.publish(`room_${roomId}`, {
                    type: 'sync_state_request'
                });
                
                this.lastSyncTime.set(roomId, Date.now());
                console.log(`Requested state sync for room ${roomId}`);
            } else {
                // Room doesn't exist, schedule cleanup
                this.scheduleRoomCleanup(roomId);
            }
        } catch (error) {
            console.error(`Error syncing room state ${roomId}:`, error);
            this.syncErrors.set(roomId, error);
        }
    }

    // Perform periodic cleanup
    performPeriodicCleanup() {
        try {
            // Process cleanup queue
            for (const roomId of this.cleanupQueue) {
                this.cleanupRoomState(roomId);
                this.cleanupQueue.delete(roomId);
            }

            // Clean up old error records
            const now = Date.now();
            for (const [roomId, error] of this.syncErrors.entries()) {
                if (now - error.timestamp > 300000) { // 5 minutes
                    this.syncErrors.delete(roomId);
                }
            }

            console.log('Periodic cleanup completed');
        } catch (error) {
            console.error('Error during periodic cleanup:', error);
        }
    }

    // Perform health check
    async performHealthCheck() {
        try {
            const rooms = await global.gameServer.matchMaker.query({ name: 'constellation' });
            const trackedRooms = this.roomStates.size;
            const activeRooms = rooms.length;
            const errorCount = this.syncErrors.size;

            console.log(`Health check - Tracked: ${trackedRooms}, Active: ${activeRooms}, Errors: ${errorCount}`);

            // Broadcast health status to admin clients
            this.broadcast('health_status', {
                trackedRooms,
                activeRooms,
                errorCount,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('Error during health check:', error);
        }
    }

    // Schedule room for cleanup
    scheduleRoomCleanup(roomId) {
        this.cleanupQueue.add(roomId);
        console.log(`Scheduled room ${roomId} for cleanup`);
    }

    // Clean up room state
    cleanupRoomState(roomId) {
        this.roomStates.delete(roomId);
        this.lastSyncTime.delete(roomId);
        this.syncErrors.delete(roomId);
        this.cleanupQueue.delete(roomId);
        console.log(`Cleaned up state for room ${roomId}`);
    }

    async updateRoomsList() {
        try {
            const rooms = await global.gameServer.matchMaker.query({ name: 'constellation' });
            const roomsData = [];

            for (const room of rooms) {
                const roomState = this.roomStates.get(room.roomId);
                const roomData = {
                    roomId: room.roomId,
                    clients: room.clients,
                    metadata: room.metadata || {},
                    state: roomState?.gameState || room.metadata?.gameState || 'waiting',
                    createdAt: room.createdAt,
                    players: roomState ? Array.from(roomState.players.values()) : [],
                    playerCount: roomState?.playerCount || room.clients || 0,
                    lastUpdate: roomState?.metadata?.lastUpdate || Date.now()
                };
                roomsData.push(roomData);
            }

            this.broadcast('rooms_update', roomsData);
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
        // Clear all intervals
        if (this.updateRoomsInterval) {
            clearInterval(this.updateRoomsInterval);
        }
        if (this.stateSyncInterval) {
            clearInterval(this.stateSyncInterval);
        }
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }

        // Clean up all room states
        this.roomStates.clear();
        this.lastSyncTime.clear();
        this.syncErrors.clear();
        this.cleanupQueue.clear();

        console.log('AdminRoom disposed with comprehensive cleanup');
    }
}

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// Serve lobby at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'other.html'));
});

// Serve admin panel
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Serve game client
app.get('/game/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve static files (but not index.html since we handle routes above)
app.use(express.static(path.join(__dirname), {
    index: false  // Don't serve index.html automatically
}));

// Create HTTP server
const server = createServer(app);

// Create Colyseus server
const gameServer = new Server({
    server: server,
    express: app
});

// Store gameServer reference for rooms to access
global.gameServer = gameServer;

// Register room handlers
gameServer.define('constellation', ConstellationRoom);
gameServer.define('admin', AdminRoom);

// Start server
const port = process.env.PORT || 2567;
gameServer.listen(port);

console.log('\n========================================');
console.log(`✓ Server running on http://localhost:${port}`);
console.log(`✓ Lobby: http://localhost:${port}`);
console.log(`✓ Admin: http://localhost:${port}/admin`);
console.log('========================================\n');