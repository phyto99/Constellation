# Pending Features

## Randomized wormhole / black hole `req` values

Currently `req` (connections needed to activate) is always `min_value`, set in `loadMap()` (`index.html:5738`). The `[min_value, max_value]` range in the map JSON is unused.

**Goal:** Roll a random `req` per special star at game start, synced identically to all clients.

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

**Why desync-safe:** Rolled once on server, embedded in the same `broadcast()` all clients receive atomically. No client-side randomization. Only applies to multiplayer custom maps.

---

## Mid-game desync heartbeat

Periodic full-state broadcast on round boundaries to catch any mid-game dropped `state_changed` messages. Low priority — the `game_ended` star snapshot already covers the end-of-game case.
