# Tabletop Club — Web Integration Rebuild Strategy

**Written before touching any code. Do not start coding until this is reviewed.**

---

## What We Have & What's Broken

### Current state (messy)
The `tabletop-club` folder has accumulated months of experimental changes across 7+ scripts. Many of those changes have introduced bugs (card gravity, texture issues, debug prints everywhere). The PCK has been rebuilt with the wrong Godot binary multiple times. The WebSocket shim was accidentally wiped by using `--export` instead of `--export-pack`. The export presets path was changed, then changed back.

### What actually needs to work
1. Tabletop Club game loads in browser (HTML5 WebGL) — table, pieces, cards visible
2. Multiplayer works — host creates room, players join by URL
3. Admin panel shows the game in an iframe, displays room code + join link
4. Admin panel can see connected players (names, colors)
5. Admin panel can kick players, pause/resume game, set player colors

### What was working before this session got messy
According to the FIX_ATTEMPTS.md history (Fixes 1–17), these things were confirmed working:
- Asset DB loaded 243 entries
- Table and pieces rendered (flat color, visible)
- WebSocket lobby proxy worked (room codes generated)
- Room codes relayed to admin panel via postMessage
- Auto host/join via `?join=CODE` URL parameter

---

## Root Causes of Current Problems

### 1. PieceBuilder.gd — collision shape fallbacks broke card physics
The original code: `if num_verts > 0: [create collision]`
My change: override on HTML5 to trust `num_surfaces > 0` even when `num_verts = 0` → creates `BoxShape.new()` (2m cube) → cards float.
**Fix**: Revert collision changes entirely. On HTML5, if no CPU vertex data, trust it — the GLES3 renderer still renders the mesh from GPU data. The collision shape creation path should stay unmodified from original drwhut.

### 2. --export wiped seepcards.html WebSocket shim
Every `--export` regenerates the HTML from Godot's export template, stripping all injections.
**Fix**: Always use `--export-pack` (updates PCK only, HTML untouched).

### 3. Debug prints everywhere
Not a bug but pollutes the console and slows down parsing of real errors.
**Fix**: Remove all `print(...)` lines that were added for debugging. Keep only prints that are part of the original game.

### 4. Standard Godot 3.6.2 used for PCK rebuild
The WASM (`seepcards.wasm`) is the custom drwhut TTClub build. The PCK built by standard Godot 3.6.2 should be compatible (GDScript is text-based, stored as-is in PCK). The two are compatible as long as the GDScript doesn't reference module-specific classes that only exist in the custom build.

---

## Rebuild Plan

### Step 1 — Restore tabletop-club to clean state
```
cd tabletop-club
git restore game/
```
This restores all modified tracked files to the drwhut original. Untracked files (prebaked_assets, shaders, AdminBridge.gd) are NOT affected.

### Step 2 — Re-apply ONLY these changes, cleanly

#### 2a. New files (already exist, keep as-is)
- `game/Shaders/Html5Albedo.shader` — flat color unshaded shader
- `game/Shaders/Html5AlbedoTexture.shader` — flat texture unshaded shader
- `game/Scripts/Game/AdminBridge.gd` — admin bridge (already clean)
- `game/prebaked_assets/` — pre-baked game assets (already correct)
- `game/prebaked_manifest.json` — asset manifest
- `game/gen_manifest.js` — manifest generator utility

#### 2b. ImportAssets.gd — 3 changes only
1. `_ready()`: HTML5 branch → call `_setup_user_asset_import_redirects()` then `AssetDB.start_importing_sync()`
2. `_on_importing_completed()`: HTML5 branch → auto-start as server or join via `?join=CODE`
3. `_setup_user_asset_import_redirects()`: new function (keep, it works)
4. Remove `_test_table_load()` entirely (was debug only)
5. Remove debug `print` from `_on_importing_completed`

#### 2c. AssetDB.gd — 3 changes only
1. `PREBAKED_MANIFEST` constant at top (keep, required for HTML5 asset enumeration)
2. `start_importing_sync()` function (keep, called by ImportAssets on HTML5)
3. `_catalog_assets_from_manifest()` function (keep, HTML5 directory listing workaround)
4. HTML5 override for `get_asset_paths()` return (keep)
5. HTML5 skip for `_remove_old_assets()` (keep)
6. Remove any debug prints added during debugging

#### 2d. PieceBuilder.gd — MATERIAL ONLY, no collision changes
```gdscript
const _HTML5_ALBEDO_SHADER = preload("res://Shaders/Html5Albedo.shader")
```
In the material loop, ONE new branch:
```gdscript
if OS.get_name() == "HTML5" and material is SpatialMaterial:
    var smat = ShaderMaterial.new()
    if material.albedo_texture != null:
        smat.shader = preload("res://Shaders/Html5AlbedoTexture.shader")
        smat.set_shader_param("albedo_texture", material.albedo_texture)
    else:
        smat.shader = _HTML5_ALBEDO_SHADER
    smat.set_shader_param("albedo_color", material.albedo_color)
    smat.set_meta("original_color", material.albedo_color)
    from.set_surface_material(surface, smat)
else:
    # original code unchanged
```
**DO NOT touch**: `num_verts` counting, `has_geometry`, collision shape creation, `build_table`, anywhere else.

#### 2e. Piece.gd — ShaderMaterial handling only
4 functions need ShaderMaterial branches:
- `apply_texture()` — HTML5 uses ShaderMaterial + Html5AlbedoTexture.shader
- `_get_original_albedo()` — untype parameter, handle ShaderMaterial via get_shader_param
- `set_albedo_color_client()` — ShaderMaterial uses set_shader_param
- `get_albedo_color()` — ShaderMaterial uses get_shader_param

No other changes.

#### 2f. Game.gd — AdminBridge only
Add exactly what the diff shows:
- `_admin_paused` variable
- `onready var _admin_bridge = $AdminBridge`
- `kick_player()`, `set_game_paused()`, `_admin_sync_paused()`, `set_player_color()` functions
- `_on_room_sealed()` notifies bridge
No other changes.

#### 2g. Game.tscn — AdminBridge node only
Add `AdminBridge` node as child of root with `AdminBridge.gd` script. Exactly 3 lines in the diff.

#### 2h. project.godot — ONE change only
Remove `singletons=["res://webrtc/webrtc.tres"]` → `singletons=[]`
(The webrtc.tres singleton doesn't exist in the export and crashes on load)

#### 2i. Room.gd — remove my ambient change
My HTML5 ambient override was documented as not helping (the lit pipeline is broken anyway). Revert it. Room.gd should be identical to drwhut original.

### Step 3 — Export PCK only
```
Godot_v3.6.2-stable_win64.exe --no-window \
  --path "tabletop-club/game" \
  --export-pack HTML5 \
  "Constellation project att 3 - Copy/ttclub2/seepcards.pck"
```
**Never use --export (full).** Only --export-pack.

### Step 4 — Verify seepcards.html has shim
After every PCK export, check the HTML has the WebSocket shim. If it was ever accidentally overwritten, re-inject it.

The shim must:
1. Redirect `new WebSocket("wss://lobby.tabletopclub.net/...")` → `ws[s]://current_host/ttclub-lobby`
2. Intercept incoming `J: CODE\n` messages → `window.parent.postMessage({type:'ttclub_room_code', code})`

---

## Multiplayer Architecture (WebRTC via our server)

The original TTClub uses drwhut's `lobby.tabletopclub.net` WebSocket server to exchange WebRTC SDP/ICE candidates between peers. We replace this with our own server at `/ttclub-lobby`.

**We do NOT need Colyseus for TTClub.** The game's multiplayer is native Godot WebRTC — it just needs a signaling server to exchange connection parameters. Our Node.js server handles that with `ttclubWss` on the `/ttclub-lobby` route.

**Flow:**
1. Host iframe loads `seepcards.html` (no ?join param) → WASM starts → WebSocket connects to `/ttclub-lobby` → server creates room → sends `J: CODE\n` → shim intercepts → postMessage to admin panel → room code displayed
2. Admin panel shows room code + join URL (`/ttclub2/seepcards.html?join=CODE`)
3. Player opens join URL → WASM starts → WebSocket connects to `/ttclub-lobby` → sends `J: CODE\n` → server relays peer IDs → WebRTC P2P established

**Colyseus is NOT used for TTClub.** It's only used for Constellation rooms. Keep them separate.

---

## Admin Panel Integration (already in server.js + admin.html)

### What server.js already has (keep, don't change)
- `ttclubWss` — WebSocket signaling server
- `ttclubRooms` — room state map
- `/ttclub-lobby` WebSocket upgrade handler
- `/ttclub-api/room/:code/players` — player polling endpoint
- `/ttclub2` route with COOP/COEP headers for SharedArrayBuffer

### What admin.html already has (keep, don't change)
- TTClub panel with room code display, join URL display
- `loadTTClubIframe()`, `reloadTTClubIframe()`
- `onTTClubRoomCode()` — receives room code from postMessage
- `startTTClubPlayerPolling()` / `renderTTClubPlayers()`
- `syncTTClubPlayersToColorManager()` — integrates with color manager

---

## Files That Must NOT Be Changed (ever)
- `ttclub2/seepcards.wasm` — custom TTClub Godot engine, not rebuildable without full Godot compile
- `ttclub2/seepcards.js` — Emscripten runtime for the WASM
- `ttclub2/seepcards.html` — only inject into this, never full-export-overwrite

---

## Checklist Before Each PCK Rebuild
- [ ] All changes are in `tabletop-club/game/` source files
- [ ] No debug `print()` calls left in code
- [ ] Using `--export-pack` not `--export`
- [ ] seepcards.html WebSocket shim is present after rebuild
- [ ] Node.js server killed before starting: `taskkill //F //IM node.exe`
- [ ] Server restarted after PCK update

---

## What We're NOT Doing
- Not converting TTClub multiplayer to Colyseus (unnecessary, WebRTC works)
- Not rebuilding the custom Godot WASM (no Godot build toolchain available)
- Not changing the physics/collision code in PieceBuilder (was working before, don't touch)
- Not adding lighting (confirmed impossible on this Godot 3.6 WebGL build without render_mode unshaded breaking)
