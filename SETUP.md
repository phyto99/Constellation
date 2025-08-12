# Constellation Admin Panel Setup

This admin panel has been completely rewritten with Colyseus integration for real-time game session management.

## Features

- **Real-time Connection**: Uses Colyseus WebSocket client for live updates
- **Game Session Management**: Create, start, and delete game sessions
- **Team Management**: Assign players to teams with live updates
- **AI Bot Configuration**: Add and configure AI bots with different personalities
- **Live Player Tracking**: See connected players and their status in real-time
- **Game Configuration**: Set game parameters like rounds, time limits, and scoring

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Colyseus Server

```bash
npm start
```

Or for development with auto-restart:

```bash
npm run dev
```

### 3. Access the Admin Panel

Open your browser and go to:
- **Admin Panel**: http://localhost:2567
- **Game Sessions**: http://localhost:2567/game/{roomId}

## How It Works

### Architecture

1. **Colyseus Server** (`server.js`): Manages game rooms and admin connections
2. **Admin Panel** (`admin.html`): Web interface for managing games
3. **Game Rooms**: Individual game sessions that players can join

### Admin Panel Features

- **Sidebar**: Shows pending, active, and past game sessions
- **Game Creation**: Create new sessions with custom configurations
- **Team Management**: Assign players to teams (Cyan, Magenta, Lime)
- **AI Bots**: Add AI players with different personalities and aggression levels
- **Real-time Updates**: All changes are reflected immediately across all connected clients

### Connection Status

The admin panel shows connection status at the bottom of the sidebar:
- **Connected**: Successfully connected to Colyseus server
- **Disconnected**: Connection lost or server unavailable

## Troubleshooting

### Connection Issues

1. Make sure the Colyseus server is running on port 2567
2. Check browser console for WebSocket connection errors
3. Verify firewall settings allow connections to port 2567

### Game Creation Issues

1. Ensure all required fields are filled
2. Check JSON syntax if using custom map data
3. Verify server logs for detailed error messages

## Development Notes

- The admin panel uses Colyseus client library loaded from CDN
- Real-time updates are handled through WebSocket messages
- Game state is synchronized automatically between admin and game clients
- The server supports multiple concurrent game sessions

## Next Steps

To connect this to your existing game logic:
1. Modify the `ConstellationRoom` class in `server.js` to include your game mechanics
2. Update the client-side game code to connect to Colyseus rooms
3. Implement proper game state synchronization between server and clients