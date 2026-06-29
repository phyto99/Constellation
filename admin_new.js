// ============================================================================
// CONSTELLATION ADMIN PANEL - CLEAN COLYSEUS IMPLEMENTATION
// ============================================================================
// This uses the EXACT same pattern as other.html which works perfectly
// No complex admin room, no polling - just simple, direct Colyseus operations
// ============================================================================

// Global state
let colyseusClient = null;
let rooms = [];
let selectedRoomId = null;
let scenarioExpanded = true;
let adminAIBots = [];
let deploymentTimestamp = null;

// AI Bot types
const AI_BOT_TYPES = {
    HAL: { name: 'HAL', description: 'Steady and logical', icon: '🤖' },
    CAESAR: { name: 'Caesar', description: 'Tactical', icon: '👑' },
    ATHENA: { name: 'Athena', description: 'Aggressive', icon: '⚡' },
    ROBIN_HOOD: { name: 'Robin Hood', description: 'Opportunistic', icon: '🏹' },
    EINSTEIN: { name: 'Einstein', description: 'Wormhole focused', icon: '🧠' },
    LORENZ: { name: 'Lorenz', description: 'Chaotic', icon: '🌪️' }
};

// ============================================================================
// CONNECTION MANAGEMENT
// ============================================================================

async function connectToColyseus() {
    try {
        console.log('Connecting to Colyseus...');
        updateStatus('Connecting...', '#f59e0b');
        
        // Create client - dynamic URL based on current host
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const host = window.location.host;
        colyseusClient = new Colyseus.Client(`${protocol}://${host}`);
        
        // Test connection - EXACT same as other.html
        await colyseusClient.getAvailableRooms('constellation');
        
        console.log('✓ Connected successfully');
        updateStatus('Connected', '#10b981');
        
        // Load deployment info
        await loadDeploymentInfo();
        
        // Load rooms immediately
        await loadRooms();
        
        // Auto-refresh every 3 seconds
        setInterval(loadRooms, 3000);
        
        // Update deployment timestamp once per day (only shows days anyway)
        setInterval(updateDeploymentDisplay, 1000 * 60 * 60 * 24);
        
    } catch (error) {
        console.error('✗ Connection failed:', error);
        updateStatus('Connection Failed', '#ef4444');
        document.getElementById('reconnect-btn').style.display = 'inline-block';
    }
}

async function loadRooms() {
    if (!colyseusClient) return;
    
    try {
        const availableRooms = await colyseusClient.getAvailableRooms('constellation');
        
        rooms = availableRooms.map(room => ({
            roomId: room.roomId,
            name: room.metadata?.roomName || room.metadata?.name || `Room ${room.roomId.substring(0, 6)}`,
            host: room.metadata?.hostName || 'Unknown',
            players: room.clients,
            maxPlayers: room.maxClients,
            mode: room.metadata?.gameMode || 'competitive',
            state: room.metadata?.gameState || 'waiting',
            createdAt: room.createdAt || new Date().toISOString(),
            metadata: room.metadata || {},
            sessionNumber: room.metadata?.sessionNumber || null
        }));
        
        updateUI();
        
    } catch (error) {
        console.error('Failed to load rooms:', error);
    }
}

async function loadDeploymentInfo() {
    try {
        const response = await fetch('/api/deployment-info');
        const data = await response.json();
        deploymentTimestamp = new Date(data.deployedAt);
        updateDeploymentDisplay();
    } catch (error) {
        console.error('Failed to load deployment info:', error);
        document.getElementById('deployment-timestamp').textContent = 'Deployment info unavailable';
    }
}

function updateDeploymentDisplay() {
    if (!deploymentTimestamp) return;
    
    const now = new Date();
    const diffMs = now - deploymentTimestamp;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    let displayText = '';
    if (diffDays === 1) {
        displayText = 'Updated 1 day ago';
    } else {
        displayText = `Updated ${diffDays} days ago`;
    }
    
    const timestampEl = document.getElementById('deployment-timestamp');
    if (timestampEl) {
        timestampEl.textContent = displayText;
        timestampEl.title = `Server started: ${deploymentTimestamp.toLocaleString()}`;
    }
}

function updateStatus(text, color) {
    const statusEl = document.getElementById('connection-status');
    if (statusEl) {
        statusEl.textContent = text;
        statusEl.style.color = color;
    }
}

function manualReconnect() {
    document.getElementById('reconnect-btn').style.display = 'none';
    connectToColyseus();
}

// ============================================================================
// ROOM OPERATIONS
// ============================================================================

async function createGame() {
    const sessionName = document.getElementById('game-name').value.trim();
    const gameType = document.getElementById('game-type').value;

    if (!sessionName) {
        alert('Please enter a session name');
        return;
    }

    if (!colyseusClient) {
        alert('Not connected to server');
        return;
    }

    const createButton = document.querySelector('button[onclick="createGame()"]');
    const originalText = createButton.textContent;
    createButton.textContent = 'Creating...';
    createButton.disabled = true;

    try {
        // Collect configuration
        const config = {
            roomName: sessionName,
            type: gameType,
            hostName: 'Admin',
            maxPlayers: 4,
            gameMode: 'competitive',
            movesPerRound: parseInt(document.getElementById('edit-movesPerRound').value) || 15,
            rounds: parseInt(document.getElementById('edit-rounds').value) || 10,
            roundTime: parseInt(document.getElementById('edit-roundTime').value) || 30,
            countdownTime: parseInt(document.getElementById('edit-countdownTime').value) || 5,
            stealLimit: parseInt(document.getElementById('edit-stealLimit').value) || 15,
            hqMax: parseInt(document.getElementById('edit-hqMax').value) || 2,
            multipliers: {
                count: parseInt(document.getElementById('edit-countMultiplier').value) || 500,
                distance: parseInt(document.getElementById('edit-distanceMultiplier').value) || 1,
                hq: parseInt(document.getElementById('edit-hqMultiplier').value) || 10,
                destruction: parseInt(document.getElementById('edit-destructionMultiplier').value) || 1
            },
            aiBots: adminAIBots.slice()
        };

        // Parse map JSON if provided
        const mapJsonText = document.getElementById('edit-mapJson').value.trim();
        if (mapJsonText) {
            try {
                config.mapJson = JSON.parse(mapJsonText);
            } catch (e) {
                alert('Invalid JSON in map data field');
                return;
            }
        }

        // Create room - EXACT same as other.html
        const room = await colyseusClient.create('constellation', config);
        
        console.log('✓ Room created:', room.roomId);
        document.getElementById('game-name').value = '';
        
        // Reload rooms to show the new one
        await loadRooms();
        
        // Select the new room
        selectGame(room.roomId);

    } catch (error) {
        console.error('Failed to create game:', error);
        alert('Failed to create game: ' + error.message);
    } finally {
        createButton.textContent = originalText;
        createButton.disabled = false;
    }
}

async function startGame() {
    const selectedRoom = rooms.find(r => r.roomId === selectedRoomId);
    if (!selectedRoom || selectedRoom.state !== 'waiting') return;

    try {
        // Join the room to send start command
        const room = await colyseusClient.joinById(selectedRoomId, { name: 'Admin' });
        room.send('start_game');
        
        console.log('✓ Game start command sent');
        
        // Leave immediately after sending command
        setTimeout(() => room.leave(), 1000);
        
        // Reload rooms to update status
        setTimeout(loadRooms, 1500);

    } catch (error) {
        console.error('Failed to start game:', error);
        alert('Failed to start game: ' + error.message);
    }
}

async function deleteGame() {
    const selectedRoom = rooms.find(r => r.roomId === selectedRoomId);
    if (!selectedRoom) return;

    if (!confirm(`Are you sure you want to delete "${selectedRoom.name}"?`)) return;

    try {
        // Note: Rooms auto-dispose when empty, so we just need to ensure no one is in it
        console.log('Room will be disposed when all players leave');
        
        // Reload rooms
        setTimeout(loadRooms, 1000);

    } catch (error) {
        console.error('Failed to delete game:', error);
        alert('Failed to delete game: ' + error.message);
    }
}

// ============================================================================
// UI MANAGEMENT
// ============================================================================

function updateUI() {
    updateGameCounts();
    updateGameLists();
    updateSelectedGame();
}

function updateGameCounts() {
    const pending = rooms.filter(r => r.state === 'waiting').length;
    const active = rooms.filter(r => r.state === 'playing').length;
    const past = rooms.filter(r => r.state === 'finished').length;

    document.getElementById('pending-count').textContent = pending;
    document.getElementById('active-count').textContent = active;
    document.getElementById('past-count').textContent = past;
}

function updateGameLists() {
    renderGameList('pending-games', rooms.filter(r => r.state === 'waiting'));
    renderGameList('active-games', rooms.filter(r => r.state === 'playing'));
    renderGameList('past-games', rooms.filter(r => r.state === 'finished'));
}

function renderGameList(containerId, gameList) {
    const container = document.getElementById(containerId);
    if (gameList.length === 0) {
        container.innerHTML = '<p style="font-size:12px;color:#666;margin:0">No games</p>';
        return;
    }

    container.innerHTML = gameList.map(game => {
        const displayId = game.sessionNumber ? `#${game.sessionNumber}` : game.roomId.substring(0, 6);
        return `
        <div class="game-item ${selectedRoomId === game.roomId ? 'selected' : ''}" 
             onclick="selectGame('${game.roomId}')">
            <div style="display:flex;align-items:center;gap:6px">
                <div class="status-dot" style="background-color:${getStatusColor(game.state)}"></div>
                <span>${game.name} (${displayId})</span>
            </div>
            <div style="font-size:10px;color:#666">
                <div>${formatDateTime(game.createdAt)}</div>
                <div>${game.players} players</div>
            </div>
        </div>
    `;
    }).join('');
}

function updateSelectedGame() {
    const selectedRoom = rooms.find(r => r.roomId === selectedRoomId);

    if (selectedRoom) {
        document.getElementById('no-game-selected').style.display = 'none';
        document.getElementById('game-content').style.display = 'block';

        document.getElementById('scenario-name').textContent = selectedRoom.name;
        document.getElementById('scenario-status').textContent = selectedRoom.state;

        const gameDirectLink = document.getElementById('game-direct-link');
        gameDirectLink.href = `${window.location.origin}/index.html?room=${selectedRoom.roomId}`;

        const startBtn = document.getElementById('start-btn');
        startBtn.disabled = selectedRoom.state !== 'waiting';

        if (selectedRoom.state === 'playing') {
            document.getElementById('active-game-banner').style.display = 'block';
            document.getElementById('active-game-id').textContent = selectedRoom.name;
            const gameUrl = document.getElementById('active-game-url');
            gameUrl.href = `${window.location.origin}/index.html?room=${selectedRoom.roomId}`;
            gameUrl.textContent = gameUrl.href;
        } else {
            document.getElementById('active-game-banner').style.display = 'none';
        }
    } else {
        document.getElementById('no-game-selected').style.display = 'block';
        document.getElementById('game-content').style.display = 'none';
        document.getElementById('active-game-banner').style.display = 'none';
    }
}

function selectGame(roomId) {
    selectedRoomId = roomId;
    updateUI();
}

function toggleScenario() {
    scenarioExpanded = !scenarioExpanded;
    const content = document.getElementById('scenario-content');
    const toggle = document.getElementById('scenario-toggle');

    if (scenarioExpanded) {
        content.style.display = 'block';
        toggle.textContent = '▼';
    } else {
        content.style.display = 'none';
        toggle.textContent = '▶';
    }
}

function updateTeamCount() {
    console.log('Team count updated');
}

function autoSetupTeams() {
    alert('Auto team setup not yet implemented for admin panel');
}

function assignPlayerToTeam(playerId, teamIndex) {
    console.log('Assign player to team:', playerId, teamIndex);
}

function removePlayerFromTeam(playerId) {
    console.log('Remove player from team:', playerId);
}

// ============================================================================
// AI BOT MANAGEMENT
// ============================================================================

function addAdminAIBot() {
    const botId = `bot_${Date.now()}`;
    const bot = {
        id: botId,
        type: 'HAL',
        team: null,
        aggression: 0.5
    };

    adminAIBots.push(bot);
    renderAdminAIBots();
}

function removeAdminAIBot(botId) {
    adminAIBots = adminAIBots.filter(bot => bot.id !== botId);
    renderAdminAIBots();
}

function renderAdminAIBots() {
    const container = document.getElementById('admin-ai-bots');
    if (adminAIBots.length === 0) {
        container.innerHTML = '<p style="font-size: 12px; color: #666; margin: 0;">No AI bots added</p>';
        return;
    }

    container.innerHTML = adminAIBots.map(bot => `
        <div style="background: #f0f0f0; border: 1px solid #ddd; border-radius: 4px; padding: 8px; margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
            <select onchange="updateBotType('${bot.id}', this.value)" style="font-size: 11px; padding: 2px;">
                ${Object.entries(AI_BOT_TYPES).map(([key, type]) =>
        `<option value="${key}" ${bot.type === key ? 'selected' : ''}>${type.icon} ${type.name}</option>`
    ).join('')}
            </select>
            <input type="range" min="0" max="1" step="0.1" value="${bot.aggression}" 
                   onchange="updateBotAggression('${bot.id}', this.value)"
                   style="width: 60px;" title="Aggression: ${bot.aggression}">
            <button onclick="removeAdminAIBot('${bot.id}')" 
                    style="background: #dc3545; color: white; border: none; padding: 2px 6px; border-radius: 2px; cursor: pointer; font-size: 10px;">×</button>
        </div>
    `).join('');
}

function updateBotType(botId, type) {
    const bot = adminAIBots.find(b => b.id === botId);
    if (bot) {
        bot.type = type;
        renderAdminAIBots();
    }
}

function updateBotAggression(botId, aggression) {
    const bot = adminAIBots.find(b => b.id === botId);
    if (bot) {
        bot.aggression = parseFloat(aggression);
        renderAdminAIBots();
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getStatusColor(state) {
    switch (state) {
        case 'waiting': return '#fbbf24';
        case 'playing': return '#10b981';
        case 'finished': return '#6b7280';
        default: return '#9ca3af';
    }
}

function formatDateTime(dateString) {
    try {
        const date = new Date(dateString);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return 'Unknown';
    }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', function () {
    console.log('Admin panel initializing...');
    renderAdminAIBots();
    
    // Connect to Colyseus
    setTimeout(connectToColyseus, 100);
});
