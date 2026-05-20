# Adding a New Multiplayer Game — Integration Guide

This document is the authoritative checklist for connecting any new game to the admin platform.
Read it top-to-bottom once before touching any code.  Every section maps to one file.

---

## Architecture overview

```
game-registry.js          ← single source of truth (schema, URLs, bot capability)
server.js                 ← BaseGameRoom + SERVER_GAME_TYPES registry
admin.html                ← ADMIN_SETTINGS_ADAPTERS + GAME_PANEL_MAP
<your-game>/index.html    ← game client — receives settings_update, sends messages
```

The rule: **a new game is fully integrated when it has one entry in each of the four places above.**
Nothing else needs to change.

---

## Step 1 — `game-registry.js`

Add one block to `GAME_REGISTRY`.  Copy the C4D block as a template:

```javascript
MyGame: {
  label: 'My Game',                          // shown in dropdown
  description: 'One-line description',
  roomType: 'mygame',                        // must match gameServer.define() name
  joinPath: (roomId) =>
    `${location.protocol}//${location.host}/mygame/${roomId}`,
  teamSupport: true,   // false if game manages its own colours
  maxPlayers: 4,
  fields: [
    // Each field drives the settings panel UI and is read by your adapter.
    // Types: number | text | checkbox | select | url
    { key: 'rounds',    type: 'number', label: 'Rounds', default: 5, min: 1, max: 20 },
    { key: 'timeLimit', type: 'number', label: 'Time Limit', sublabel: 'seconds', default: 60, min: 10, max: 300 },
    { key: 'mode',      type: 'select', label: 'Mode', default: 'classic',
      options: [
        { value: 'classic', label: 'Classic' },
        { value: 'blitz',   label: 'Blitz' },
      ]},
    { key: 'fogOfWar',  type: 'checkbox', label: 'Fog of War', default: false },
  ],
  botContext: null,  // set to { types: ['random', 'greedy'] } when bots are implemented
},
```

### joinPath signature

```
joinPath(roomId, cfg, runtime) => string
```

- `cfg` — current settings object (from your adapter's `readSettings()`)
- `runtime` — per-room transient state `{ sessionCode, ... }` (from `roomRuntimeState`)

For games that embed settings in the URL (like Geobridge), use `cfg` and `runtime`:

```javascript
joinPath: (roomId, cfg = {}, runtime = {}) => {
  const p = new URLSearchParams({ sessionCode: runtime.sessionCode, ...cfg });
  return `${location.protocol}//${location.host}/mygame?${p}`;
},
```

For games where the URL is just the roomId (most cases), the one-liner is enough.

### `teamSupport`

`true` → the team manager panel is shown and `cfg.teamColors` is automatically injected into
`getGameJoinUrl()` as `[{ color: 0xRRGGBB, rgb: [r,g,b] }, ...]`.
Your `joinPath` and your Room's `applySettings` can then use `cfg.teamColors` / `s.teamColors`.

### `botContext`

Reserved for future server-side `BotPlayer` support.  Set `null` for now.
When you implement bots, populate:

```javascript
botContext: {
  types: ['random', 'greedy'],
  // Pure functions — no side effects, no mutation:
  moveGenerator(gs, teamIdx)  { return []; },      // legal moves from state
  stateEvaluator(gs, teamIdx) { return 0; },       // score for teamIdx (higher = better)
  applyMove(gs, move)         { return gs; },      // new state after move
  isTerminal(gs)              { return false; },   // true when game is over
  moveToMessage(move)         { return { type: 'claim', data: move }; }, // Colyseus msg
},
```

---

## Step 2 — `server.js`

### 2a. Create a Room class

Extend `BaseGameRoom`.  You must implement four methods:

```javascript
class MyGameRoom extends BaseGameRoom {

  // Return the current config/settings as a plain object.
  getConfig() { return this.config; }

  // Return the current game phase string.
  getPhase()  { return this.phase; }

  // Return the player list for the admin panel.
  getPlayers() {
    return this.clients.map(c => ({
      id:        c.sessionId,
      sessionId: c.sessionId,
      name:      c.userData?.name || c.sessionId.substring(0, 6),
      team:      c.userData?.team,
    }));
  }

  // Apply a settings update from the admin panel (called by BaseGameRoom automatically).
  applySettings(s) {
    Object.assign(this.config, s);
    // Broadcast to connected clients so their UI refreshes:
    this.broadcast('settings_update', { config: this.config });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onCreate(options) {
    super.onCreate(options); // REQUIRED — wires force_dispose + update_settings

    this.autoDispose = false;
    this.maxClients  = options.maxPlayers || 4;
    this.phase       = 'waiting';
    this.config = {
      rounds:    options.rounds    || 5,
      timeLimit: options.timeLimit || 60,
      mode:      options.mode      || 'classic',
      fogOfWar:  options.fogOfWar  || false,
      teamColors: options.teamColors || [],
    };

    this.setMetadata({
      name:      options.name || `MyGame ${this.roomId.substring(0, 6)}`,
      type:      'MyGame',       // must match GAME_REGISTRY key
      gameState: 'waiting',
      createdAt: new Date().toISOString(),
    });

    // Register your game-specific messages:
    this.onMessage('my_action', (client, data) => {
      // handle action ...
      // after any state change that affects the admin panel, call:
      this._publishAdminUpdate();
    });
  }

  onJoin(client, options) {
    // game-specific join logic ...
    super.onJoin(client, options); // REQUIRED — calls _publishAdminUpdate()
  }

  onLeave(client, consented) {
    // game-specific leave logic ...
    super.onLeave(client, consented); // REQUIRED — calls _publishAdminUpdate()
  }
}
```

**Key rules:**
- Always call `super.onCreate(options)` first — it registers the `force_dispose` and
  `update_settings` presence handlers that the admin panel depends on.
- Always call `super.onJoin` and `super.onLeave` — they publish `admin_update` to keep
  the player list live.
- `applySettings(s)` is called automatically when the admin changes settings. You only
  need to mutate `this.config` and optionally broadcast to clients.
- Call `this._publishAdminUpdate()` any time game state changes that the admin should see.

### 2b. Register the room

Find `SERVER_GAME_TYPES` (near the bottom of server.js) and add one line:

```javascript
const SERVER_GAME_TYPES = {
  constellation: { Room: ConstellationRoom },
  golad:         { Room: GoladRoom },
  centauri:      { Room: CentauriRoom },
  geobridge:     { Room: GeobridgeRoom, filterBy: ['sessionCode'] },
  c4d:           { Room: C4DRoom },
  mygame:        { Room: MyGameRoom },   // ← add this
};
```

`filterBy` is optional — use it only when matchmaking should filter on a metadata field
(like Geobridge's `sessionCode`).

### 2c. Add static file serving

After the existing `app.use('/c4d', ...)` block, add:

```javascript
app.use('/mygame', express.static(path.join(__dirname, 'mygame')));
app.get('/mygame/:roomId', (_req, res) =>
  res.sendFile(path.join(__dirname, 'mygame/index.html')));
```

---

## Step 3 — `admin.html`

### 3a. Add an HTML settings panel

Copy a simple existing panel (e.g. `#c4d-settings`) and adapt it.
Element IDs must follow the `{prefix}-{key}` convention where prefix matches your
adapter entry (see 3b).  For a new game use `mg-` (or any unique prefix):

```html
<!-- MyGame Panel (shown only for MyGame rooms) -->
<div id="mygame-settings" class="settings-section" style="display:none;">
    <h3>MyGame Settings</h3>
    <div class="settings-grid">
        <div class="form-group">
            <label>Rounds</label>
            <input type="number" id="mg-rounds" value="5" min="1" max="20"
                   oninput="sendSettingsUpdate()">
        </div>
        <div class="form-group">
            <label>Time Limit <span class="sublabel">(seconds)</span></label>
            <input type="number" id="mg-timeLimit" value="60" min="10" max="300"
                   oninput="sendSettingsUpdate()">
        </div>
        <div class="form-group">
            <label>Mode</label>
            <select id="mg-mode" oninput="sendSettingsUpdate()">
                <option value="classic">Classic</option>
                <option value="blitz">Blitz</option>
            </select>
        </div>
        <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="mg-fogOfWar" onchange="sendSettingsUpdate()"
                       style="width:auto;margin:0;">
                <span>Fog of War</span>
            </label>
        </div>
    </div>
    <div style="margin-top:4px;font-size:12px;color:#666;">
        <span id="mygame-settings-status">Settings saved automatically</span>
    </div>
</div>
```

Place this block inside the `<!-- Game-specific panels -->` section, alongside the other panels.

### 3b. Add to GAME_PANEL_MAP

```javascript
const GAME_PANEL_MAP = {
  'Tabletop Club': 'ttclub-panel',
  'GOLAD':         'golad-settings',
  'Centauri':      'centauri-settings',
  'Geobridge':     'geobridge-settings',
  'C4D':           'c4d-settings',
  'MyGame':        'mygame-settings',   // ← add this
};
```

### 3c. Add to ADMIN_SETTINGS_ADAPTERS

```javascript
MyGame: {
  readSettings() {
    return {
      rounds:    parseInt(document.getElementById('mg-rounds').value)   || 5,
      timeLimit: parseInt(document.getElementById('mg-timeLimit').value) || 60,
      mode:      document.getElementById('mg-mode').value               || 'classic',
      fogOfWar:  document.getElementById('mg-fogOfWar').checked,
      // teamColors is automatically injected by getGameJoinUrl() when teamSupport=true
    };
  },
},
```

### 3d. Add to SETTINGS_STATUS_ELS (optional)

If you added a status span, register it so save confirmations work:

```javascript
const SETTINGS_STATUS_ELS = {
  GOLAD:     'golad-settings-status',
  Centauri:  'centauri-settings-status',
  Geobridge: 'geobridge-settings-status',
  C4D:       'c4d-settings-status',
  MyGame:    'mygame-settings-status',   // ← add this
};
```

### 3e. Add the game type to the dropdown

```html
<select id="game-type">
  <option value="Constellation">Constellation</option>
  <option value="GOLAD">GOLAD</option>
  <option value="Centauri">Centauri</option>
  <option value="Geobridge">Geobridge</option>
  <option value="C4D">C4D (4D Polytope)</option>
  <option value="MyGame">My Game</option>   <!-- add this -->
  <option value="No game focus">No game focus</option>
</select>
```

---

## Step 4 — Game client (`mygame/index.html`)

The game client receives settings and syncs state through Colyseus messages.
Connect only when a roomId is present in the URL:

```javascript
// At the bottom of index.html, before </body>
(async function () {
  const roomId = new URLSearchParams(location.search).get('roomId')
    || location.pathname.split('/').pop();
  if (!roomId || roomId.length < 8) return; // standalone mode, no multiplayer

  const client = new Colyseus.Client(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  const room   = await client.joinById(roomId);

  // Receive settings from admin panel
  room.onMessage('settings_update', ({ config }) => {
    applyConfig(config);
  });

  // Receive start signal
  room.onMessage('game_started', ({ config }) => {
    applyConfig(config);
    startGame();
  });

  function applyConfig(config) {
    if (config.rounds    !== undefined) GAME_CONFIG.rounds    = config.rounds;
    if (config.timeLimit !== undefined) GAME_CONFIG.timeLimit = config.timeLimit;
    if (config.mode      !== undefined) GAME_CONFIG.mode      = config.mode;
    if (config.fogOfWar  !== undefined) GAME_CONFIG.fogOfWar  = config.fogOfWar;
    if (config.teamColors && config.teamColors.length) applyTeamColors(config.teamColors);
    refreshUI();
  }

  function applyTeamColors(teamColors) {
    // teamColors = [{ color: 0xRRGGBB, name: 'red', displayName: 'Red' }, ...]
    teamColors.forEach((tc, i) => {
      const r = (tc.color >> 16) & 0xff;
      const g = (tc.color >>  8) & 0xff;
      const b =  tc.color        & 0xff;
      TEAMS[i] = { ...TEAMS[i], color: `rgb(${r},${g},${b})`, name: tc.displayName };
    });
  }
})();
```

---

## Step 5 — Auto-rendered settings panels (optional)

`game-registry.js` `fields[]` entries drive the **settings panel HTML and adapter** if you choose to generate them automatically via `buildSettingsPanelFromRegistry()`. However, **existing games use hand-authored panels** with non-standard ID prefixes (`geo-`, `golad-`, `centauri-`) that predate this system. New games should follow the `{prefix}-{key}` convention where `prefix` is a short lowercase abbreviation of your game name.

### Why hand-authored panels still exist

The built-in `fields[]` types cover `number`, `text`, `checkbox`, `select`, and `url`. Custom field types — `map` (Constellation's map picker), `multipliers` (score weights), and `ai-bots` — are hand-rendered because they require bespoke HTML. If your game needs fields beyond the five standard types, write the panel by hand and skip the auto-render path.

### Auto-render path (for simple games)

If all your fields are standard types:

1. Add your entry to `GAME_REGISTRY` with `fields[]` populated
2. Write the adapter — auto-render does **not** generate it
3. Skip step 3a entirely; the panel HTML will be built at runtime

The auto-render function builds elements with IDs `{prefix}-{key}` and `oninput="sendSettingsUpdate()"` or `onchange="sendSettingsUpdate()"`.

---

## Step 6 — Restoring settings when a room is selected (`restoreSettings`)

When the admin panel selects an existing room, `selectRoom()` calls `applyConfig(config)` to push the room's current config back into the form fields. If your adapter does not implement `restoreSettings(cfg)`, the form will show stale default values even though the room is running different settings.

Add a `restoreSettings(cfg)` function to your adapter entry:

```javascript
MyGame: {
  readSettings() {
    return {
      rounds:    parseInt(document.getElementById('mg-rounds').value)   || 5,
      timeLimit: parseInt(document.getElementById('mg-timeLimit').value) || 60,
      mode:      document.getElementById('mg-mode').value               || 'classic',
      fogOfWar:  document.getElementById('mg-fogOfWar').checked,
    };
  },
  restoreSettings(cfg) {
    if (cfg.rounds    !== undefined) document.getElementById('mg-rounds').value    = cfg.rounds;
    if (cfg.timeLimit !== undefined) document.getElementById('mg-timeLimit').value = cfg.timeLimit;
    if (cfg.mode      !== undefined) document.getElementById('mg-mode').value      = cfg.mode;
    if (cfg.fogOfWar  !== undefined) document.getElementById('mg-fogOfWar').checked = cfg.fogOfWar;
  },
},
```

`restoreSettings` is called inside `selectRoom()` just after the settings panel is shown:

```javascript
// In selectRoom(), after switching GAME_PANEL_MAP panel:
const adapter = ADMIN_SETTINGS_ADAPTERS[gameType];
if (adapter?.restoreSettings && metadata?.config) {
    adapter.restoreSettings(metadata.config);
}
```

Without `restoreSettings`, reconnecting to a running room always shows defaults. With it, the form instantly reflects the live room config.

---

## Step 7 — Bot player infrastructure (`botContext`)

`botContext` in the registry is a **capability declaration**, not an execution engine. It tells AI tooling (and future infrastructure) that this game can support server-side bots and what interface those bots expose.

### Current state

Only Constellation has working bots. They run inside `ConstellationRoom` as local objects, not via a generic `BotPlayer` class.

### How to implement bots for a new game

1. **Populate `botContext`** in the registry with pure functions:

```javascript
botContext: {
  types: ['random', 'greedy'],
  moveGenerator(gs, teamIdx)   { return []; },       // legal moves from state
  stateEvaluator(gs, teamIdx)  { return 0; },        // score for teamIdx (higher = better)
  applyMove(gs, move)          { return gs; },        // pure state transition
  isTerminal(gs)               { return false; },    // true when game is over
  moveToMessage(move)          { return { type: 'action', data: move }; },
},
```

2. **In your Room class**, add bot support to `onCreate`:

```javascript
onCreate(options) {
  super.onCreate(options);
  this.bots = [];
  if (options.aiBots && options.aiBots.length) {
    const ctx = GAME_REGISTRY.MyGame.botContext;
    this.bots = options.aiBots.map(b => ({
      teamIdx: b.teamIdx,
      type:    b.type || 'random',
      ctx,
    }));
  }
}
```

3. **After each turn**, check if the active team is a bot and schedule its move:

```javascript
function maybeRunBot() {
  const bot = this.bots.find(b => b.teamIdx === this.gs.activeTeam);
  if (!bot) return;
  setTimeout(() => {
    const moves = bot.ctx.moveGenerator(this.gs, bot.teamIdx);
    if (!moves.length) return;
    const move = bot.type === 'random'
      ? moves[Math.floor(Math.random() * moves.length)]
      : greedyPick(moves, this.gs, bot.teamIdx, bot.ctx);
    const msg = bot.ctx.moveToMessage(move);
    this.gs = bot.ctx.applyMove(this.gs, move);
    this.broadcast(msg.type, msg.data);
    this._publishAdminUpdate();
    this.maybeRunBot();  // chain if next team is also a bot
  }, 600);
}
```

Keep all `botContext` functions **pure** (no mutations, no side effects). The server calls them serially so there is no concurrency concern, but purity makes them testable in isolation.

---

## Checklist

- [ ] `game-registry.js` — new entry with `label`, `roomType`, `joinPath`, `teamSupport`, `maxPlayers`, `fields`, `botContext`
- [ ] `server.js` — `class MyGameRoom extends BaseGameRoom` with `getConfig/getPhase/getPlayers/applySettings` + `super.onCreate/onJoin/onLeave` calls
- [ ] `server.js` — entry in `SERVER_GAME_TYPES`
- [ ] `server.js` — `app.use` + `app.get` static routes
- [ ] `admin.html` — `<div id="mygame-settings">` panel HTML
- [ ] `admin.html` — entry in `GAME_PANEL_MAP`
- [ ] `admin.html` — entry in `ADMIN_SETTINGS_ADAPTERS` with `readSettings()` and `restoreSettings(cfg)`
- [ ] `admin.html` — entry in `SETTINGS_STATUS_ELS`
- [ ] `admin.html` — `<option>` in `#game-type` dropdown
- [ ] Game client — Colyseus connect + `settings_update` / `game_started` handlers

---

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Settings panel flashes back to Constellation | `roomType` in registry doesn't match `SERVER_GAME_TYPES` key, so `updateRoomsList` doesn't find the room | Make them identical |
| Admin panel shows 0 players | `super.onJoin/onLeave` not called, or `getPlayers()` returns wrong data | Check both |
| Settings don't reach the game | `applySettings()` not implemented, or game client not listening for `settings_update` | Implement both |
| Join URL is wrong | `joinPath` not returning correct URL, or `roomType` in registry points to wrong route | Check registry entry |
| `update_settings` not received by room | `super.onCreate(options)` was not called | Call it first in `onCreate` |
| createGame() creates wrong room type | `roomType` in registry is wrong | Must match `gameServer.define()` name in `SERVER_GAME_TYPES` |

---

## Constellation — pending feature notes

### Randomized wormhole / black hole `req` values

Currently `req` (connections needed to activate) is always `min_value` for every wormhole and black hole, set in `loadMap()` (`index.html:5738`). The range `[min_value, max_value]` encoded in the map JSON is unused.

**Goal:** Roll a random `req` per special star when a game starts, synced identically to all clients.

**Server** — in `start_game` handler (`server.js`), before `broadcast('game_started', ...)`:

```js
const starRequirements = [];
if (this.gameConfig.customMap && Array.isArray(this.gameConfig.customMap.stars)) {
    this.gameConfig.customMap.stars.forEach((s, index) => {
        const mapType = s[2]; // 3=Wormhole, 4=BlackHole
        if (mapType === 3 || mapType === 4) {
            const isBlackHole = mapType === 4;
            const minVal = s[3] !== undefined ? s[3] : 2;
            const maxVal = s[4] !== undefined ? s[4] : (isBlackHole ? 4 : 3);
            const req = minVal === maxVal ? minVal : Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;
            starRequirements.push({ index, req });
        }
    });
}
// spread into broadcast:
...(starRequirements.length > 0 && { starRequirements })
```

**Client** — in `game_started` handler (`index.html`), after `precomputeStaticData()` and before `calcScores()`:

```js
if (data.starRequirements && Array.isArray(data.starRequirements)) {
    data.starRequirements.forEach(({ index, req }) => {
        if (index >= 0 && index < currentGame.st.length) {
            currentGame.st[index].req = req;
        }
    });
    if (data.starRequirements.length > 0) currentGame.needsStarRedraw = true;
}
```

**Why desync-safe:** Randomization is computed once on the server and embedded in the same `broadcast()` call received atomically by all clients. No client-side randomization. Only applies to multiplayer custom maps.
