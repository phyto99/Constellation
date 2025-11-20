# Colyseus Integration Setup Guide

## Prerequisites
No special API keys or environment variables needed! Just the dependencies.

## Installation

```bash
npm install
```

This installs:
- `colyseus` (^0.15.0)
- `@colyseus/schema` (^2.0.0)
- `express`, `cors`

## Running the Server

```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

Server will start on: `http://localhost:2567`

## Testing the Integration

### 1. Open other.html
Navigate to: `http://localhost:2567/other.html`

### 2. Create a Game
- Enter your player name
- Click "CONNECT" (connects to ws://localhost:2567)
- Click "CREATE GAME"
- Configure game settings (moves, rounds, etc.)

### 3. Test Multiplayer Features

#### Team Assignment
- Players are automatically assigned to balanced teams
- Drag and drop players between team slots
- Team colors: CYAN, MAGENTA, LIME, GOLD, BLUE, RED, DARK GREEN

#### Move Allocation
- Total moves (default: 15) are split evenly among teammates
- Example: 12 moves ÷ 3 teammates = 4 moves each
- Each player sees their allocated moves in the game view

#### Multiplayer Cursors
- Once in game, move your mouse on the canvas
- Other players see your cursor with:
  - Colored pointer (your team color)
  - Name label
  - Real-time position updates

### 4. Join from Another Browser/Tab
- Open another browser tab to `http://localhost:2567/other.html`
- Enter a different player name
- Click "BROWSE LOBBIES"
- Join the existing game
- You'll see both players' cursors moving in real-time

## How It Works

### Client Side (other.html)
- Connects via `new Colyseus.Client('ws://localhost:2567')`
- Creates/joins rooms: `client.create('constellation', options)`
- Sends cursor updates: `room.send('cursor_move', { x, y, color, name })`
- Receives updates via: `room.onMessage('cursor_move', callback)`

### Server Side (server.js)
- Uses Colyseus Schema for state synchronization
- `Player` schema tracks: id, name, team, ready, connected
- `RoomState` schema contains: players map, gameState, config
- Broadcasts cursor movements to all clients except sender

## Key Features Implemented

✅ Real-time player synchronization
✅ Team assignment with drag-and-drop
✅ Move allocation split across teammates
✅ Multiplayer cursor tracking with colors
✅ Player name labels on cursors
✅ Automatic team balancing
✅ Game state management (waiting → playing)

## Troubleshooting

**Can't connect?**
- Ensure server is running on port 2567
- Check browser console for errors
- Verify WebSocket connection: `ws://localhost:2567`

**Players not syncing?**
- Check server logs for Schema errors
- Ensure `@colyseus/schema` is installed
- Verify room state is properly initialized

**Cursors not showing?**
- Check that game view is active (after clicking START GAME)
- Verify canvas ref is properly set
- Check browser console for cursor_move messages
