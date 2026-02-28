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
                        message: `Team ${teamIndex} wins by connecting wormholes!`
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
                        message: `Team ${teamIndex} wins by connecting wormholes!`
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
                        message: `Team ${teamIndex} wins by connecting wormholes!`
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
                await this.presence.publish(`room_${data.roomId}`, { type: 'start_game' });
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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/other', (req, res) => res.sendFile(path.join(__dirname, 'other.html')));
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