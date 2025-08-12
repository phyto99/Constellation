const { Server, Room } = require('colyseus');
const { MapSchema } = require('@colyseus/schema');
const { createServer } = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');

// Game room classes
class ConstellationRoom extends Room {
    onCreate(options) {
        console.log('ConstellationRoom created with options:', options);
        
        this.setState({
            players: new MapSchema(),
            gameState: 'waiting',
            config: options || {},
            teams: new MapSchema()
        });

        this.maxClients = options.maxPlayers || 20;
        
        // Store room metadata
        this.metadata = {
            name: options.name || `Game ${this.roomId}`,
            type: options.type || 'Constellation',
            config: options,
            gameState: 'waiting',
            createdAt: new Date().toISOString()
        };

        console.log('Room metadata set:', this.metadata);

        this.onMessage('join_team', (client, data) => {
            this.assignPlayerToTeam(client.sessionId, data.teamIndex);
        });

        this.onMessage('start_game', (client, data) => {
            if (this.state.gameState === 'waiting') {
                this.startGame();
            }
        });
    }

    onJoin(client, options) {
        console.log(`Player ${client.sessionId} joined room ${this.roomId}`);
        
        const player = {
            id: client.sessionId,
            name: options.name || `Player ${client.sessionId.substring(0, 6)}`,
            team: null,
            ready: false
        };

        this.state.players.set(client.sessionId, player);
        this.updateAdminRoom();
    }

    onLeave(client, consented) {
        console.log(`Player ${client.sessionId} left room ${this.roomId}`);
        this.state.players.delete(client.sessionId);
        this.updateAdminRoom();
    }

    assignPlayerToTeam(playerId, teamIndex) {
        const player = this.state.players.get(playerId);
        if (player) {
            player.team = teamIndex;
            this.updateAdminRoom();
        }
    }

    startGame() {
        this.state.gameState = 'playing';
        this.broadcast('game_started', { gameState: 'playing' });
        this.updateAdminRoom();
        console.log(`Game ${this.roomId} started`);
    }

    updateAdminRoom() {
        // Notify admin room of changes
        if (this.presence) {
            this.presence.publish('admin_update', {
                roomId: this.roomId,
                players: Array.from(this.state.players.values()),
                state: this.state.gameState,
                playerCount: this.clients.length
            });
        }
    }

    onDispose() {
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

        this.onMessage('create_room', async (client, data) => {
            console.log('Received create_room request:', data);
            
            try {
                console.log('Creating room with options:', data.options);
                
                // Ensure we have a presence system
                if (!this.presence) {
                    throw new Error('Presence system not available');
                }
                
                // Use the presence system to create room
                const room = await this.presence.create('constellation', data.options);
                console.log('Room created successfully:', room.roomId);
                
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
                const rooms = await this.presence.getRooms('constellation');
                const room = rooms.find(r => r.roomId === data.roomId);
                
                if (room) {
                    // Send start command to the room
                    await this.presence.publish(`room_${data.roomId}`, {
                        type: 'start_game'
                    });
                    
                    client.send('game_started', {
                        success: true,
                        roomId: data.roomId
                    });
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
                const rooms = await this.presence.getRooms('constellation');
                const room = rooms.find(r => r.roomId === data.roomId);
                
                if (room) {
                    // Force disconnect all clients and dispose room
                    await this.presence.publish(`room_${data.roomId}`, {
                        type: 'force_dispose'
                    });
                    
                    client.send('room_deleted', {
                        success: true,
                        roomId: data.roomId
                    });

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
                await this.presence.publish(`room_${data.roomId}`, {
                    type: 'assign_team',
                    playerId: data.playerId,
                    teamIndex: data.teamIndex
                });
            } catch (error) {
                console.error('Error assigning team:', error);
            }
        });

        // Listen for room updates
        this.presence.subscribe('admin_update', (data) => {
            this.broadcast('player_update', data);
        });

        // Periodically update rooms list
        this.updateRoomsInterval = setInterval(() => {
            this.updateRoomsList();
        }, 5000);
    }

    async updateRoomsList() {
        try {
            const rooms = await this.presence.getRooms('constellation');
            const roomsData = rooms.map(room => ({
                roomId: room.roomId,
                clients: room.clients,
                metadata: room.metadata || {},
                state: room.metadata?.gameState || 'waiting',
                createdAt: room.createdAt
            }));

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
        if (this.updateRoomsInterval) {
            clearInterval(this.updateRoomsInterval);
        }
        console.log('AdminRoom disposed');
    }
}

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Serve admin panel at root
app.get('/', (req, res) => {
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

// Register room handlers
gameServer.define('constellation', ConstellationRoom);
gameServer.define('admin', AdminRoom);

// Start server
const port = process.env.PORT || 2567;
gameServer.listen(port);

console.log(`Colyseus server listening on port ${port}`);
console.log(`Admin panel available at http://localhost:${port}`);
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);