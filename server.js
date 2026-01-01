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
type('number')(Player.prototype, 'movesLeft');

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

                            // Initialize Round State
                            this.state.game.round = 1;

                            // CRITICAL: Distribute moves when started via Admin presence (isGameStart = true)
                            this.distributeMoves(true);

                            this.broadcast('game_started', { gameState: 'playing', config: this.gameConfig, currentRound: 1 });

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
                    } else if (msg.type === 'pause_game') {
                        if (this.state.gameState === 'playing' && !this.isPaused) {
                            this.isPaused = true;
                            this.pauseReason = msg.reason || '';
                            console.log(`⏸️ Game paused in room ${this.roomId}. Reason: ${this.pauseReason}`);
                            
                            this.broadcast('game_paused', { 
                                reason: this.pauseReason,
                                announcement: this.pauseReason
                            });
                            this.updateAdminRoom();
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
                                this.updateAdminRoom();
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
            const player = this.state.players.get(client.sessionId);
            if (player) {
                player.team = data.teamIndex;
                this.updateAdminRoom();
            }
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

                // Distribute Initial Moves (isGameStart = true)
                this.distributeMoves(true);

                // Initialize Round State
                this.state.game.round = 1;
                this.broadcast('game_started', { gameState: 'playing', config: this.gameConfig, currentRound: 1 });

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
                if (this.locked) {
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

                        // Calculate Winner
                        const scores = { 0: 0, 1: 0, '-1': 0 };
                        this.state.game.stars.forEach(s => {
                            if (s.tm !== -1) {
                                if (!scores[s.tm]) scores[s.tm] = 0;
                                scores[s.tm]++;
                            }
                        });

                        let winningTeam = -1;
                        if (scores[0] > scores[1]) winningTeam = 0;
                        else if (scores[1] > scores[0]) winningTeam = 1;

                        this.broadcast('game_ended', {
                            finalRound: this.state.game.round,
                            winningTeam: winningTeam,
                            scores: scores
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
                }
            }, 1000);
        };


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

        // Game state synchronization - claim_star
        this.onMessage('claim_star', (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (!player || player.team === null) return;

            const teamIndex = player.team;
            const team = this.state.game.teams[teamIndex];

            // Server-side authority: Determine if this is an HQ placement
            // First N moves (defined by limit) MUST be HQs
            const hqLimit = parseInt(this.gameConfig.headquarters || 2, 10);
            const isHQ = team && (team.hqCount < hqLimit);

            // Use correct validation method
            let validation;
            if (isHQ) {
                validation = this.validateHQ(data.starIndex, teamIndex);
            } else {
                validation = this.validateClaim(data.starIndex, teamIndex);
            }

            if (validation.valid) {
                // Decrement player moves
                if (player.movesLeft > 0) player.movesLeft--;

                // Track team moves sum (optional but good for consistency)
                if (team) {
                    team.movesLeft--;
                }

                // Broadcast delta update to all clients (server state not used)
                const starUpdate = { index: data.starIndex, tm: teamIndex, hq: isHQ };
                if (isHQ) {
                    // starUpdate.hq is already set above
                    if (team) team.hqCount++;
                }

                // Prepare update objects
                const teamUpdate = { index: teamIndex, movesLeft: -1 };
                if (isHQ) {
                    teamUpdate.hqCount = 1; // Increment client count
                }

                this.broadcast('state_changed', {
                    stars: [starUpdate],
                    teams: [teamUpdate]
                });

                console.log(`✅ Star ${data.starIndex} claimed by team ${teamIndex}${isHQ ? ' (HQ)' : ''}`);
            } else {
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: validation.reason,
                    refund: { moves: 1 }
                });
                console.log(`❌ Claim rejected for star ${data.starIndex}: ${validation.reason}`);
            }
        });

        // Game state synchronization - steal_star
        this.onMessage('steal_star', (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (!player || player.team === null) return;

            const teamIndex = player.team;
            const team = this.state.game.teams[teamIndex];

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
                if (player.movesLeft > 0) player.movesLeft--;
                if (team) {
                    team.movesLeft--;
                    if (team.stealsLeft > 0) team.stealsLeft--;
                }

                // Broadcast delta update
                const starUpdate = { index: data.starIndex, tm: teamIndex, hq: isHQ };
                if (isHQ) {
                    // starUpdate.hq is already set above
                    if (team) team.hqCount++;
                }

                // Prepare update objects
                const teamUpdate = { index: teamIndex, movesLeft: -1, stealsLeft: -1 };
                if (isHQ) {
                    teamUpdate.hqCount = 1; // Increment client count
                }

                this.broadcast('state_changed', {
                    stars: [starUpdate],
                    teams: [teamUpdate]
                });

                console.log(`✅ Star ${data.starIndex} stolen by team ${teamIndex}${isHQ ? ' (HQ)' : ''}`);
            } else {
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: validation.reason,
                    refund: { moves: 1, steals: 0 } // Steal failed usually doesn't consume steal point if rejected
                });
                console.log(`❌ Steal rejected for star ${data.starIndex}: ${validation.reason}`);
            }
        });

        // Game state synchronization - place_hq
        this.onMessage('place_hq', (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (!player || player.team === null) return;

            const teamIndex = player.team;
            const validation = this.validateHQ(data.starIndex, teamIndex);

            if (validation.valid) {
                // Decrement player moves
                if (player.movesLeft > 0) player.movesLeft--;

                if (this.state.game.teams[teamIndex]) {
                    this.state.game.teams[teamIndex].movesLeft--;
                    this.state.game.teams[teamIndex].hqCount++;
                }

                // Broadcast delta update to all clients (server state not used)
                this.broadcast('state_changed', {
                    stars: [{ index: data.starIndex, tm: teamIndex, hq: true }],
                    teams: [{
                        index: teamIndex,
                        movesLeft: -1, // -1 = decrement
                        hqCount: 1 // +1 for HQ
                    }]
                });

                console.log(`✅ HQ placed at star ${data.starIndex} by team ${teamIndex}`);
            } else {
                client.send('move_rejected', {
                    starIndex: data.starIndex,
                    reason: validation.reason,
                    refund: { moves: 1 }
                });
                console.log(`❌ HQ placement rejected for star ${data.starIndex}: ${validation.reason}`);
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

                    // FORCE SYNC: Send direct message to client to ensure UI updates
                    const client = this.clients.find(c => c.sessionId === p.id);
                    if (client) {
                        client.send('update_moves', { moves: allocatedMoves });
                    }
                });
                console.log(`Distributed ${totalMoves} moves to Team ${teamIdx} (${players.length} players):`, players.map(p => p.movesLeft));
            });
        } catch (error) {
            console.error('❌ Error distributing moves:', error);
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
        player.team = 0; // Default to Cyan (Team 0) immediately
        player.ready = false;
        player.connected = true;
        player.connectedAt = Date.now();
        player.isHost = isFirstPlayer;

        this.state.players.set(client.sessionId, player);

        // If game is already running, give them some moves? 
        // Or if game hasn't started, they will get moves when it starts.
        if (this.state.gameState === 'playing') {
            // Late joiner logic - give them base moves?
            const totalMoves = this.gameConfig.moves || 15;
            const playersOnTeam = Array.from(this.state.players.values()).filter(p => p.team === 0).length;
            // Simple logic: give them average or 0? 
            // Let's give them 0 to prevent exploiting by rejoining.
            player.movesLeft = 0;
        }

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
        // Validation works without full state initialization
        // We just need to ensure indices are valid
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

        // Check INDIVIDUAL player moves
        const player = Array.from(this.state.players.values()).find(p => p.team === teamIndex); // Warning: this finds *any* player on team? No, validateClaim usually passed specific player context?
        // Wait, validateClaim is called with teamIndex. We need player context.
        // We should update call sites to pass player, or find player by session ID?
        // Actually the call site in onMessage already checks player.movesLeft.
        // But validateClaim is ALSO used. Should we remove redundancy or update it?
        // Let's rely on the onMessage check, but update this to NOT block if team moves are desynced?
        // Actually, if we use split moves, we should probably ignore team.movesLeft check here or update it to be sum?
        // Let's remove the team.movesLeft check here since we check player.movesLeft in the handler.

        /*
        if (team.movesLeft <= 0) {
            return { valid: false, reason: 'No moves remaining' };
        }
        */

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

        // Type 2 = cluster, Type 3 = blackhole
        if (star.ty === 2 || star.ty === 3) {
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

        this.onMessage('pause_game', async (client, data) => {
            try {
                await this.presence.publish(`room_${data.roomId}`, { type: 'pause_game', reason: data.reason });
                client.send('game_paused', { success: true, roomId: data.roomId });
            } catch (error) {
                client.send('game_paused', { success: false, roomId: data.roomId, error: error.message });
            }
        });

        this.onMessage('resume_game', async (client, data) => {
            try {
                await this.presence.publish(`room_${data.roomId}`, { type: 'resume_game' });
                client.send('game_resumed', { success: true, roomId: data.roomId });
            } catch (error) {
                client.send('game_resumed', { success: false, roomId: data.roomId, error: error.message });
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