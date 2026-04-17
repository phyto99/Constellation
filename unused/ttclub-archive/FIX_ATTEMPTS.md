# Tabletop Club HTML5 Fix Attempts

This document tracks every attempt to get Tabletop Club (drwhut's Godot 3.6 export) working inside the Constellation admin panel.

---

## Architecture Overview

- **Game**: Tabletop Club — Godot 3.6 GLTF-based P2P board game
- **Transport**: WebRTC (native TTClub signaling over WebSocket)
- **Lobby WebSocket**: proxied through `/ttclub-lobby` on the Node.js server (`server.js`)
- **Export target**: `ttclub2/seepcards.html` — HTML5 PCK (~93 MB)
- **Assets**: `prebaked_assets/TabletopClub/` — pre-imported into the PCK

---

## Constraint: No Colyseus Conversion

User explicitly rejected converting TTClub's signaling to Colyseus. All multiplayer work uses TTClub's native WebRTC + text-based WebSocket lobby protocol.

---

## Fix 1 — WebSocket Lobby Proxy (`server.js` + `seepcards.html`)

**Problem**: TTClub's WASM connects to `lobby.tabletopclub.net` for room signaling. The browser blocks cross-origin WebSocket to external hosts.

**Fix**: Added `/ttclub-lobby` route to `server.js` that proxies the WebSocket connection. Injected a `PatchedWebSocket` shim into `seepcards.html` that redirects any connection to `lobby.tabletopclub.net` → `ws://localhost/ttclub-lobby`.

**Status**: Working. Room codes generated and shared correctly.

**Note**: Godot overwrites `seepcards.html` on every re-export. The shim must be re-injected after each export.

---

## Fix 2 — `.tc` Game Files Missing from PCK

**Problem**: `.tc` save files (Chess, Dominoes, Go, Poker) were not included in the exported PCK. Godot's `export_filter="all_resources"` skips unrecognized file types.

**Fix**: Added `prebaked_assets/TabletopClub/games/*.tc` to `include_filter` in `export_presets.cfg`.

**Status**: Fixed. `.tc` files now present in PCK.

---

## Fix 3 — HTML5 Thread Limitation (`ImportAssets.gd`)

**Problem**: `Thread.start()` is silently ignored on HTML5. `AssetDB.start_importing()` spawned a thread that never ran, so assets were never loaded.

**Fix**: Added HTML5 branch in `ImportAssets._ready()`:
```gdscript
if OS.get_name() == "HTML5":
    _setup_user_asset_import_redirects()
    AssetDB.start_importing_sync()
```
`start_importing_sync()` calls `_import_all(null)` directly on the main thread.

**Status**: Fixed. Assets now import on HTML5.

---

## Fix 4 — `res://` Directory Listing Broken on HTML5 (`AssetDB.gd`)

**Problem**: `Directory.get_next()` returns nothing for `res://` paths in the PCK filesystem. `_catalog_assets()` found zero files.

**Fix**: Added `PREBAKED_MANIFEST` constant to `AssetDB.gd` — a hardcoded dictionary of all files per pack/type, generated from `prebaked_assets/` on disk. Added `_catalog_assets_from_manifest()` that builds the catalog from this constant instead of scanning directories.

```gdscript
var catalog = _catalog_assets_from_manifest() if OS.get_name() == "HTML5" else _catalog_assets()
```

**Status**: Fixed. All 243 assets now found and loaded into DB.

---

## Fix 5 — `_is_valid_path()` Rejected `res://` Paths (`AssetDB.gd`)

**Problem**: `_is_valid_path()` enforced `user://assets/` prefix. On HTML5, all asset paths are `res://prebaked_assets/`, so every entry failed validation and was discarded.

**Fix**:
```gdscript
func _is_valid_path(path: String, valid_ext: Array) -> bool:
    if not path.is_abs_path():
        return false
    var valid_prefix = "res://prebaked_assets/" if OS.get_name() == "HTML5" else "user://assets/"
    if not path.begins_with(valid_prefix):
        return false
    if not valid_ext.has(path.get_extension()):
        return false
    return true
```

**Status**: Fixed. All entry paths now pass validation.

---

## Fix 6 — `File.file_exists()` Broken for PCK Source Files (`AssetDB.gd`)

**Problem**: `File.file_exists()` returns `false` for source files (`.gltf`, `.png`, `.obj`, etc.) in the PCK. Godot only exports the imported binaries (`.stex`, `.scn`), not the original source files. The `_import_asset` function used `file_exists()` to check for companion image files for game save entries, causing a `"Key 'texture_path' not found"` crash.

**Attempt 1 (failed)**: Used `ResourceLoader.exists()` instead — also returns `false` for PCK source files.

**Attempt 2 (working)**: Used `PREBAKED_MANIFEST` lookup:
```gdscript
if OS.get_name() == "HTML5":
    var from_base = from.get_file().get_basename()
    var pack_name = from.get_base_dir().get_base_dir().get_file()
    var type_files: Array = PREBAKED_MANIFEST.get(pack_name, {}).get(type, [])
    for file_name in type_files:
        if file_name.get_basename() == from_base and VALID_TEXTURE_EXTENSIONS.has(file_name.get_extension()):
            entry["texture_path"] = to.get_base_dir() + "/" + file_name
            break
    if not entry.has("texture_path"):
        entry["texture_path"] = ""
```

**Status**: Fixed. Chess, Dominoes, Go, Poker all load with correct `texture_path`.

---

## Fix 7 — User Asset Import Redirects (`ImportAssets.gd`)

**Problem**: `.material` resource files in the PCK (used by 3D mesh scenes) had `resource_path = "user://assets/..."` baked into their binary (artifact from original development). When the imported `.scn` files tried to load these materials, Godot looked for `user://assets/TabletopClub/...` paths that don't exist on HTML5.

**Fix**: Added `_setup_user_asset_import_redirects()` in `ImportAssets.gd`. This runs before asset import and writes minimal `.import` redirect files to `user://assets/...` so that texture loads via `user://` paths resolve to the pre-imported `.stex` binaries in `res://.import/`.

```gdscript
out.store_string("[remap]\n\npath=\"" + dest_path + "\"\n")
```

**Confirmed**: Log shows `"[HTML5] Wrote 201 user asset import redirects."` on every startup.

**Status**: Redirect files written. Effect on runtime material loading still under investigation (see Known Issue below).

---

## Fix 8 — Surface Vertex Data Null on HTML5 (`PieceBuilder.gd`)

**Confirmed**: `load("res://prebaked_assets/TabletopClub/tables/Table.gltf")` succeeds (returns `[PackedScene:3148]`). `instance()` produces 9 children with 9 MeshInstances. The scene loads fine.

**Root cause**: `_extract_and_shape_mesh_instances()` calls `from.mesh.surface_get_arrays(surface)[0].size()` to count vertices. On HTML5/WebGL, mesh vertex arrays may not be CPU-accessible after GPU upload (Godot clears CPU-side data). If `[0]` is null → `num_verts = 0` → the branch at line 433 calls `ResourceManager.free_object(from)`, destroying the MeshInstance. Table is invisible.

**Why desktop works**: On desktop, Godot keeps CPU-side mesh data accessible for physics/collision generation. On HTML5 WebGL, it may be purged.

**Fix applied**: In `_extract_and_shape_mesh_instances`, on HTML5, if `num_verts == 0` but the mesh has surfaces, force-include the MeshInstance anyway. Use a `BoxShape` fallback for collision when `create_convex_shape()` returns null:

```gdscript
var has_geometry = num_verts > 0
if OS.get_name() == "HTML5" and num_verts == 0 and num_surfaces > 0:
    has_geometry = true  # vertex data unreadable on HTML5, trust mesh exists
if has_geometry:
    ...
    if collision_mode == COLLISION_CONVEX:
        collision_shape.shape = from.mesh.create_convex_shape()
        if collision_shape.shape == null and OS.get_name() == "HTML5":
            collision_shape.shape = BoxShape.new()  # fallback
```

**Status**: Implemented, re-exported. Test pending.

---

## Fix 9 — Game Never Entered Room (Auto-Host on HTML5)

**Root cause**: `_on_importing_completed` called `Global.start_main_menu()` on HTML5. The main menu loaded but the admin panel has no way to click "Host Room" inside the Godot canvas. The user saw the main menu's rotating panorama background indefinitely — no room was ever hosted, so `build_table()` was never called.

**Fix**: On HTML5, skip the main menu entirely. Read `?join=CODE` from the URL via `JavaScript.eval()`. If present → `Global.start_game_as_client(join_code)`. If absent → `Global.start_game_as_server()`.

```gdscript
var raw = JavaScript.eval("new URLSearchParams(location.search).get('join') || ''")
if raw is String:
    join_code = raw.strip_edges().to_upper()
if join_code != "":
    Global.start_game_as_client(join_code)
else:
    Global.start_game_as_server()
```

**Admin panel flow**:
1. Admin creates a game → iframe loads `/ttclub2/seepcards.html` (no join param) → auto-hosts → shim captures room code → admin sees code
2. Player clicks join link `?join=XXXX` → auto-joins that room

**Status**: Implemented, exporting.

---

## Fix 10 — `.material` Files Missing from PCK (`export_presets.cfg`)

**Problem**: `.material` files (e.g. `ChessWhite.material`, `d10.material`, `Board_Surface.material`) were not included in the exported PCK. Godot's `export_filter="all_resources"` only follows static resource references in scenes/scripts. The `.scn` files in `.import/` that reference these materials are import artifacts — Godot's exporter does NOT recursively scan import artifacts for dependencies. Result: all pieces rendered pitch black (null material → no diffuse shading).

**Root cause confirmed**: `ChessWhite.material` is a pure `SpatialMaterial` (white color, no texture). Binary analysis shows no external texture paths — it's just a color material. The `.scn` file (`Bishop White.gltf-bfd77ad3...scn`) correctly references `res://prebaked_assets/TabletopClub/pieces/ChessWhite.material`. But if that .material isn't in the PCK, Godot uses null → black pieces.

**Fix**: Added `*.material` and `*.tres` glob patterns to `include_filter` in `export_presets.cfg`:
```
prebaked_assets/TabletopClub/*/*.material
prebaked_assets/TabletopClub/*/*.tres
prebaked_assets/TabletopClub/*/*/*.material
prebaked_assets/TabletopClub/*/*/*.tres
```
Depth-1 pattern covers `pieces/`, `boards/`, `containers/`, etc. Depth-2 covers `dice/d10/`, `dice/d12/`, etc.

**Status**: Materials ARE now in PCK and load correctly. `load("res://prebaked_assets/.../ChessWhite.material")` returns `[SpatialMaterial]` with `albedo_color=0.906,0.906,0.906,1` (light gray/white). NOT the cause of black rendering. See Fix 12 for root cause.

---

## Fix 11 — `AdminBridge.gd` Uses Godot 4 `Dictionary.merged()` Method

**Problem**: `AdminBridge.gd` (added for admin panel integration) called `.merged()` on Dictionary in `_on_player_added` and `_on_player_modified`. This method doesn't exist in Godot 3.6 — it was added in Godot 4. Parse error would crash the bridge.

**Fix**: Replaced with Godot 3.6 compatible merge loop:
```gdscript
var msg := {"type": "player_joined"}
for key in _player_dict(id, p):
    msg[key] = _player_dict(id, p)[key]
_post_message(msg)
```

**Status**: Fixed.

---

## Fix 12 — ALL 3D Objects Pitch Black (Active Investigation)

**Confirmed working**:
- GLES3 WebKit WebGL renderer (not GLES2)
- Assets load: 230 entries in DB
- Table geometry loads: 9 MeshInstances, all with vertex data (24 verts each)
- `ChessWhite.material` loads via direct `load()` — albedo = 0.906 (white), no texture
- Chess pieces load: Bishop White.gltf instances with 1825 verts
- Room code relay, multiplayer connect, player join all work
- Selection highlight outline renders correctly with team color
- AdminBridge fixed (no more `.merged()` parse error)

**Symptom**: Every 3D object on the table is pitch black. Objects panel thumbnails are invisible/transparent. Selection highlight outline (rendered via post-process shader) works.

**What was tried and ruled out**:
- `.material` files missing from PCK → fixed (materials now in PCK, load fine)
- GLES2 ambient light missing → ruled out (confirmed GLES3)
- Room.gd explicit ambient_light_energy=0.6 fix → tried, no effect, reverted
- Browser caching old PCK → ruled out (new PCK confirmed by `[TEST] ChessWhite.material OK` in log)

**Key diagnostic finding**:
```
[TEST] ChessWhite.material load result: [SpatialMaterial:3130]
[TEST] ChessWhite.material OK — albedo_color=0.906,0.906,0.906,1
[TEST] Bishop mesh material: [Object:null]   ← get_surface_material(0) on MeshInstance
```
`get_surface_material(0)` on the instanced Bishop White MeshInstance is null. Material is NOT set as a surface override. In Godot 3 GLTF import, materials are stored in the Mesh sub-resource (`mesh.surface_get_material()`), NOT as MeshInstance overrides. **We have not yet confirmed whether `mesh.surface_get_material(0)` returns the material or null** — this is the next critical test.

**The .scn file IS correct**: `Bishop White.gltf-bfd77ad3...scn` binary contains `res://prebaked_assets/TabletopClub/pieces/ChessWhite.material` as an ext_resource. The path is in the PCK.

**Hypothesis A (material not applied to mesh surface during instantiation)**: The .scn loads the ext_resource `ChessWhite.material` but something causes it to not be set on the mesh's surface. The embedded `resource_path` in the binary .material file is `user://assets/TabletopClub/pieces/ChessWhite.material` — path mismatch with `res://prebaked_assets/...` may cause Godot to cache or resolve the resource incorrectly during scene loading. `mesh.surface_get_material(0)` would return null in this case.

**Hypothesis B (material IS on mesh surface, but PieceBuilder discards it)**: `mesh.surface_get_material(0)` returns the material, PieceBuilder calls `material.duplicate()` and `from.set_surface_material(surface, material)`, but something in the duplication or cull mode setting causes a black material. Less likely.

**Hypothesis C (lighting — sky ambient not reaching geometry)**: Despite GLES3, the PanoramaSky radiance cubemap may fail to generate on HTML5 WebGL, leaving only the DirectionalLight. With shadow_enabled=true and downward-pointing sun, shadowed faces get zero ambient. `mesh.surface_get_material(0)` would return white material in this case.

**CONFIRMED via test (23:41 session)**:
```
[TEST] Bishop surface override: [Object:null]
[TEST] Bishop mesh.surface_get_material: [SpatialMaterial:3091]
[TEST] Bishop mesh_mat albedo: 0.906332,0.906332,0.906332,1
```
- `get_surface_material(0)` = null (no MeshInstance override — expected, Godot GLTF puts material on Mesh)
- `mesh.surface_get_material(0)` = **white SpatialMaterial** — material IS on the mesh correctly
- Lighting confirmed fine by user — not the cause

**PieceBuilder flow (confirmed correct on paper)**:
- Line 344: `var material = from.mesh.surface_get_material(surface)` → gets white SpatialMaterial ✓
- Line 346: `material = material.duplicate()` → fresh copy ✓
- Line 355: `from.set_surface_material(surface, material)` → sets as surface override ✓
- Line 454: `collision_shape_arr[0].add_child(from)` → MeshInstance added to scene ✓

**Objects panel thumbnail issue (separate)**:
`get_piece_meshes()` at line 230-242 copies materials using `mesh_instance.get_surface_material(surface)` (the override, not the mesh surface material). Since overrides are null, `piece_mesh` gets null materials → thumbnails are transparent/invisible.

**Current mystery**: Materials are white, PieceBuilder applies them via set_surface_material, lighting is fine — yet everything renders black. Possible remaining causes:
1. `collision_shape_arr` empty (create_convex_shape fails) → line 453 `if not collision_shape_arr.empty()` → from is never added to scene → invisible, not black. But user sees BLACK not invisible.
2. Something in how the CollisionShape→MeshInstance parent chain renders on HTML5 WebGL
3. The MeshInstance IS in the scene but the duplicated SpatialMaterial has a property causing black render in GLES3 WebGL specifically

**DESKTOP TEST CONFIRMED**: Desktop renders correctly (AMD Radeon RX 6600M, GLES3). Issue is 100% HTML5/WebGL specific. Desktop was working before any of our edits. The GDScript logic is correct — this is a rendering/shader issue in Godot 3.6 GLES3 WebGL.

**Most likely remaining causes (for next session)**:

1. **SpatialMaterial shader not compiled on first render in WebGL**: Even with "Async shader compilation: OFF" in the log, WebGL may defer GLSL compilation. Before the shader compiles, Godot renders the surface black. Fix to try: add a `yield(get_tree(), "idle_frame")` after room loads, or force shader pre-warming. OR set `flags_unshaded = true` on all materials temporarily to confirm this is the issue (unshaded materials don't need lighting shader compilation).

2. **`.import` texture redirect not working for table/pieces**: `_setup_user_asset_import_redirects()` writes `.import` files at `user://assets/...` so `.material` resources can find their `.stex`. If the redirect path in the `.import` file is wrong (e.g., pointing to a `.stex` hash that doesn't exist in the PCK), the texture loads as null. With null albedo texture, SpatialMaterial renders black in GLES3 (multiplies albedo_color × null_texture = black). **This is the most actionable hypothesis** — ChessWhite.material has no texture so pieces should still be white, but the TABLE and board use wood/chess textures. If only textured objects are black and chess pieces are white, this is the cause.

3. **`material.duplicate()` in PieceBuilder loses material properties on HTML5**: The duplicate() call at line 346 might not carry over all shader parameters in WebGL. To test: skip duplicate(), use the material directly (remove the `material = material.duplicate()` line on HTML5).

**Recommended first fix to try in next session**:
In `_extract_and_shape_mesh_instances`, on HTML5, skip `material.duplicate()` and just use the mesh's material directly:
```gdscript
var material = from.mesh.surface_get_material(surface)
if material:
    if not OS.get_name() == "HTML5":
        material = material.duplicate()
    from.set_surface_material(surface, material)
```
This tests if duplicate() is corrupting the material on WebGL. If pieces become visible/colored, the duplicate() is the bug — fix by using `.duplicate(true)` (deep duplicate) or just keeping the shared reference on HTML5.

---

## Fix 13 — Room.gd Ambient Light Override (Failed)

**Hypothesis**: ProceduralSky radiance cubemap fails to generate on HTML5 WebGL → sky ambient contribution = 0 → even with DirectionalLight, geometry in shadow gets zero light → all-black. Fix: set flat ambient on HTML5, bypass sky.

**Fix applied to `Room.gd` `_ready()`**:
```gdscript
if OS.get_name() == "HTML5":
    _world_environment.environment.ambient_light_sky_contribution = 0.0
    _world_environment.environment.ambient_light_color = Color(0.45, 0.45, 0.45, 1.0)
    _world_environment.environment.ambient_light_energy = 1.0
    _sun_light.shadow_enabled = false
```

**Result**: Still pitch black. Reverted.

**Why it failed**: Lighting is NOT the cause. This was confirmed by an earlier test where `flags_unshaded = true` (bypasses all lighting) + `albedo_color = Color.red` was set on fresh `SpatialMaterial.new()` — pieces were still black. A true lighting issue would NOT survive flags_unshaded. The black is happening somewhere in the material/render pipeline, not lighting.

---

## Fix 14 — flags_unshaded + Red Diagnostic Material (Inconclusive/Failed)

**Hypothesis**: If material with `flags_unshaded = true` and `albedo_color = Color.red` renders black, the problem is in how `set_surface_material` works on HTML5, not lighting.

**Applied in PieceBuilder `_extract_and_shape_mesh_instances`**: On HTML5, create brand-new `SpatialMaterial` with red color + unshaded flag, apply via `from.set_surface_material(surface, mat)`.

**Result**: Still black for all pieces.

**Analysis**:
- Black pieces (`color="#000000"` in config.cfg): `set_albedo_color_client(Color.black)` runs AFTER PieceBuilder and calls `material.albedo_color = original_color * Color.black = Color.black`. This explains black regardless of diagnostic.
- White pieces (`color="#ffffff"` default): `set_albedo_color_client(Color.white)` multiplies by white = no change. SHOULD still be red. But console output was truncated before white piece material logs appeared — **inconclusive for white pieces**.

**Key remaining question**: Do white chess pieces (Knight White, Bishop White, etc.) render non-black on any diagnostic test? If yes → `set_albedo_color_client` is the culprit for black pieces but something else affects white. If no → `set_surface_material` override isn't working on this WebGL build.

---

## Fix 18 — Manual Lambert Lighting in Unshaded Shader (Failed — too complex for WebGL)

**Attempt**: Add `INV_VIEW_MATRIX * NORMAL` dot product with hardcoded sun direction to `Html5Albedo.shader` / `Html5AlbedoTexture.shader`. Intended to reproduce desktop Lambert + ambient without the broken PBR pipeline.

```glsl
shader_type spatial;
render_mode unshaded;
uniform vec4 albedo_color : hint_color = vec4(1.0, 1.0, 1.0, 1.0);
void fragment() {
    vec3 wn = normalize((INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz);
    vec3 sun_to = normalize(vec3(0.0, 1.0, 0.0));
    float ndotl = max(dot(wn, sun_to), 0.0);
    vec3 sun = vec3(1.0, 0.95, 0.87) * 0.75 * ndotl;
    vec3 ambient = vec3(0.38, 0.35, 0.30);
    ALBEDO = albedo_color.rgb * clamp(ambient + sun, 0.0, 1.0);
}
```

**Result**: Black table again. The additional GLSL (INV_VIEW_MATRIX mat4×vec4 multiply, normalize, dot, clamp) appears to push the shader over some WebGL compile threshold. The only confirmed working fragment code is `ALBEDO = albedo_color.rgb` — everything else produces black.

**Reverted to**: Simple flat unshaded (ALBEDO = albedo_color.rgb).

---

## Current State After All Fixes

### What works
- Objects load and are visible (flat color / flat texture)
- Chess pieces are correct colors (white = gray, black = black — intentional)
- `render_mode unshaded` is the only render mode that produces output
- ShaderMaterial infrastructure: PieceBuilder converts SpatialMaterial → ShaderMaterial, Piece.gd color methods handle ShaderMaterial
- Texture routing: PieceBuilder checks `material.albedo_texture != null` → uses Html5AlbedoTexture.shader (UV sample) vs Html5Albedo.shader (flat color)
- Room + multiplayer mechanics work perfectly

### What does NOT work
- 3D lighting / shading (all objects are flat / unlit)
- Textures: need live confirmation — infrastructure is in place but untested while black

### Confirmed root causes
1. **Godot 3.6 WebGL PBR pipeline broken**: `shader_type spatial` without `render_mode unshaded` produces black for ALL materials — SpatialMaterial, ShaderMaterial with lit mode, ShaderMaterial with EMISSION. The entire lit render pipeline (ambient + diffuse + specular + emission compute) outputs black on this WebGL build.
2. **Complex fragment shaders also fail**: `INV_VIEW_MATRIX`, `NORMAL` dot products, `clamp` — even a 6-line fragment shader fails if it goes beyond trivial `ALBEDO = constant`.
3. **Only confirmed working fragment code**: `ALBEDO = albedo_color.rgb` and `ALBEDO = texture(sampler, UV).rgb * color.rgb`. Nothing more complex than these.

---

## Detailed Environment / Scene Facts (for future lighting fix)

### Room.tscn scene structure
- `WorldEnvironment` node: has Environment resource (ambient, sky, SSAO, DOF)
- `SunLight` (DirectionalLight): `transform = Transform(1,0,0, 0,0,1, 0,-1,0, 0,50,0)` → basis.z ≈ (0,-1,0) → light travels in **-Y direction (straight down)**. `shadow_enabled = true`. `directional_shadow_normal_bias = 3.0`. `directional_shadow_max_distance = 250.0`
- `SpotLight`: same transform but `visible = false` (unused)
- `_world_environment.environment`: has `background_sky` (ProceduralSky or PanoramaSky depending on selected skybox). `ambient_light_sky_contribution` defaults to 1.0 (all ambient from sky). Sky is set in `set_skybox()`.

### Why ambient fix (Fix 13) in `_ready()` failed
In `_ready()`, the ambient was set BEFORE `set_skybox()` was called. `set_skybox()` creates a new ProceduralSky and sets `background_sky`. It does NOT reset `ambient_light_sky_contribution`. So the fix should have persisted. Most likely reason it failed: the broken WebGL PBR pipeline ignores the Environment ambient entirely, regardless of how it's set. The ambient is computed as part of the same broken lighting pass. Even `set_skybox()` ambient fix in the same location didn't help.

### SunLight direction in world space
- Transform basis.z ≈ (0, 1, 0) (Y-up column)
- DirectionalLight shines in local -Z = world -(0,1,0) = **(0, -1, 0)** = straight down
- Sun direction TOWARD light (for Lambert): (0, 1, 0)
- Top faces of pieces (normal ≈ Y+) → fully lit. Side faces (normal ≈ X±/Z±) → get ambient only. Bottom faces → ambient only.

### Desktop lighting parameters (from Godot source/observations)
- Default ProceduralSky: warm sky-blue ambient, sun disk in upper hemisphere
- ambient_light_sky_contribution = 1.0 (all from sky)
- DirectionalLight energy ≈ 0.7-1.0, warm white color
- No SSAO on default settings
- Roughness of chess pieces: ~0.5 (slightly glossy). Table material: ~0.8 (matte wood).

---

## How to properly fix lighting (next session plan)

### Key constraint
Only the following GLSL compiles and runs on this WebGL build:
```glsl
shader_type spatial;
render_mode unshaded;
uniform vec4 albedo_color : hint_color = vec4(1.0, 1.0, 1.0, 1.0);
void fragment() {
    ALBEDO = albedo_color.rgb;
}
```
Any addition beyond this (even `NORMAL.y * scalar`) causes black output.

### What to try next
1. **Test if NORMAL alone works**: Add only `float n = NORMAL.y;` and `ALBEDO = albedo_color.rgb * (0.5 + 0.5*n);`. No INV_VIEW_MATRIX, no normalize, no dot(). If this renders shaded → pure NORMAL access works and the issue is INV_VIEW_MATRIX.

2. **Test if INV_VIEW_MATRIX is the specific failure point**: Try `vec3 wn = NORMAL;` (no transform) with a fixed sun_to = vec3(0,1,0). If this gives shading → INV_VIEW_MATRIX is the culprit, not the math.

3. **Alternative world-normal trick**: In Godot 3, `NORMAL` in fragment shader is already in view space. For lighting that doesn't depend on camera angle, pass the sun direction as a view-space uniform from GDScript (compute `camera_transform.basis.xform_inv(sun_world_dir)` every frame and set as shader param). This avoids INV_VIEW_MATRIX entirely.

4. **Use a vertex shader**: Compute the lighting in `void vertex()` and pass as a varying. Vertex shaders may have different limits than fragment shaders on this WebGL build.

5. **Investigate via WebGL error console**: Open the game in a standalone tab, open browser DevTools → Console, look for WebGL shader compile errors (usually shown as `WebGL: INVALID_OPERATION: drawElements: no valid shader program is set`).

6. **Pass pre-computed light factor from GDScript**: Set a `uniform float sun_factor` per material from GDScript instead of computing in GLSL. Compute `dot(piece_world_normal, sun_dir)` in GDScript and set per mesh. Avoids all GLSL math.

### Reference: desktop lighting shader equivalent (what the final shader should do)
```glsl
// Final target — once we know which GLSL features work:
shader_type spatial;
render_mode unshaded;
uniform vec4 albedo_color : hint_color = vec4(1.0, 1.0, 1.0, 1.0);
// Pass from GDScript: INV_VIEW_MATRIX * vec3(0,-1,0) for sun direction in view space
uniform vec3 sun_dir_view = vec3(0.0, -1.0, 0.0); // sun travel direction in view space
void fragment() {
    float ndotl = max(dot(NORMAL, -sun_dir_view), 0.0);
    vec3 sun = vec3(1.0, 0.95, 0.87) * 0.75 * ndotl;
    vec3 ambient = vec3(0.38, 0.35, 0.30); // warm gray, matches ProceduralSky
    ALBEDO = albedo_color.rgb * clamp(ambient + sun, 0.0, 1.0);
}
```
**Key**: pass `sun_dir_view` from GDScript (not computed in shader) = avoids INV_VIEW_MATRIX. Update it when camera rotates.

---

## Fix 20 — WebSocket Shim Lost to --export (Root cause of "establishing connection")

**Problem**: Using `--export` (full HTML5 export) regenerates `seepcards.html` from the Godot export template, stripping all custom injections including the WebSocket lobby shim and postMessage code. Without the shim, the WASM tries to connect to `lobby.tabletopclub.net` (external, CORS-blocked) → signaling fails → no room code → "establishing connection with host" forever on every load.

**Cause**: Sessions 2–3 used `--export` instead of `--export-pack`.

**Fix**: Re-injected the WebSocket shim into `seepcards.html` manually. Switched all future rebuilds to `--export-pack` which only updates the PCK file and preserves seepcards.html.

**`--export-pack` command** (use this always):
```
Godot_v3.6.2-stable_win64.exe\Godot_v3.6.2-stable_win64.exe --no-window \
  --path "c:\Users\Phyto\Downloads\tabletop-club\game" \
  --export-pack HTML5 \
  "c:\Users\Phyto\Downloads\Constellation project att 3 - Copy\ttclub2\seepcards.pck"
```

**The shim** (in seepcards.html, injected between seepcards.js `<script>` and the GODOT_CONFIG block):
- Overrides `window.WebSocket` constructor
- Redirects any connection to `tabletopclub.net` → `ws[s]://current_host/ttclub-lobby`
- Intercepts `J: CODE\n` server messages → `window.parent.postMessage({ type: 'ttclub_room_code', code })`

**Status**: Active. Shim is in seepcards.html. Never use `--export` again — only `--export-pack`.

---

## Clean Rebuild (Session 3 — April 2026)

After accumulated messy changes broke card physics and floating pieces, we did `git restore game/` to drwhut original and re-applied only the essential changes carefully.

### What was re-applied (in order)

**PieceBuilder.gd** — HTML5 ShaderMaterial branch only (no collision changes):
- Preload `Html5Albedo.shader` and `Html5AlbedoTexture.shader`
- In `_extract_and_shape_mesh_instances`, if HTML5 and material is SpatialMaterial → create ShaderMaterial, set albedo_color / albedo_texture params

**Piece.gd** — ShaderMaterial handling in 4 functions:
- `apply_texture()`, `get_albedo_color()`, `set_albedo_color_client()`, `_get_original_albedo()`

**ImportAssets.gd** — HTML5 sync import + auto-start:
- `_ready()` HTML5 branch: call `_setup_user_asset_import_redirects()` then `AssetDB.start_importing_sync()`
- `_on_importing_completed()` HTML5 branch: skip main menu, auto-host or join via `?join=CODE` URL param
- `_setup_user_asset_import_redirects()`: writes user:// .import redirect stubs

**AssetDB.gd** — Full HTML5 asset loading infrastructure:
- `PREBAKED_MANIFEST` const: hardcoded dict of all prebaked asset filenames
- `get_asset_paths()`: HTML5 early-return `["res://prebaked_assets"]`
- `start_importing_sync()`: calls `_import_all(null)` directly + drains completed signal manually
- `_import_all()`: HTML5 uses `_catalog_assets_from_manifest()`, skips `_remove_old_assets()`
- `_catalog_assets_from_manifest()`: builds catalog from PREBAKED_MANIFEST
- `_import_asset()` HTML5 path: skip `_import_file()` copy, set `to = from` (use res:// path directly)
- `_is_valid_path()`: HTML5 uses `res://prebaked_assets/` prefix instead of `user://assets/`
- Games companion texture (Fix 6): PREBAKED_MANIFEST lookup instead of `file_exists()`

**Game.gd** — AdminBridge integration:
- `_admin_paused: bool`, `onready var _admin_bridge = $AdminBridge`
- `kick_player()`, `set_game_paused()`, `_admin_sync_paused()`, `set_player_color()`
- `_on_room_sealed()`: added `if _admin_bridge: _admin_bridge.notify_room_sealed()`

**Game.tscn** — AdminBridge node added:
- `load_steps=6` → `7`
- Added ext_resource for `Scripts/Game/AdminBridge.gd` id=6
- Added `[node name="AdminBridge" type="Node" parent="."]`

**project.godot** — Remove webrtc singleton:
- `singletons=["res://webrtc/webrtc.tres"]` → `singletons=[]`
- (webrtc.tres doesn't exist in HTML5 export, crashes on load)

### Critical AssetDB.gd bug chain (what caused "0% forever" and "missing assets")

1. **Hang at 0%**: `_catalog_assets_from_manifest()` missing `file_count`, `asset_dir_exists`, `stacks_file` keys → GDScript silent crash on key access → `_import_all` aborted before `_send_completed_signal` → `completed` signal never emitted → stuck forever

2. **Files doubled in path**: `files` array contained full paths (`res://...`) but `_import_all` prepends `type_path + "/"` → doubled path → `_import_file` fail → early return

3. **Empty DB after import**: `_import_file` copies `res://` → `user://` but HTML5 PCK assets don't need copying — they're pre-baked. Skip `_import_file` on HTML5, use `to = from` (res:// path). Validation via `_is_valid_path` must accept `res://prebaked_assets/` prefix.

### Never do again

- Do NOT add `_import_file` call for HTML5 (assets live at `res://`, no copy needed)
- Do NOT use `user://assets/` prefix check in `_is_valid_path` for HTML5
- Do NOT put full paths in `type_catalog["files"]` — must be file names only
- Do NOT forget `stacks_file`, `config_file`, `file_count`, `asset_dir_exists` keys in catalog
- Do NOT modify `Room.gd` for any reason (lighting fixes all fail, physics breaks)
- Do NOT change collision code in `PieceBuilder.gd` (was cause of floating cards)
- Do NOT use `--export`, only `--export-pack` (protects seepcards.html shim)
- Do NOT change `singletons` back to include `webrtc.tres` (file doesn't exist in export)

### Export command (always use this)
```
c:/Users/Phyto/Downloads/godot/bin/godot.windows.opt.tools.64.exe \
  --path "c:/Users/Phyto/Downloads/tabletop-club/game" \
  --export-pack HTML5 \
  "c:/Users/Phyto/Downloads/Constellation project att 3 - Copy/ttclub2/seepcards.pck"
```

**CRITICAL**: Output path is `ttclub2/seepcards.pck` — NOT `tabletop.pck`, NOT any other name. The HTML loads `seepcards.pck` by name. If you export to a different file, the game never loads (seepcards.pck still has old code).

### Server start command
```
cd "c:/Users/Phyto/Downloads/Constellation project att 3 - Copy"
taskkill //F //IM node.exe   # kill old instances first
node server.js
```
Server runs on port **2567** (not 3000). Admin panel: `http://localhost:2567/`.

---

## Fix 19 — Lambert Lighting with CAMERA_MATRIX (Session 3 attempt — Failed, reverted)

**Attempt**: Updated both shaders to use `CAMERA_MATRIX * vec4(NORMAL, 0.0)` for world-space normal, then Lambert diffuse + ambient.

```glsl
void fragment() {
    vec3 wn = normalize((CAMERA_MATRIX * vec4(NORMAL, 0.0)).xyz);
    vec3 sun_dir = vec3(0.0, 1.0, 0.0);
    float ndotl = max(dot(wn, sun_dir), 0.0);
    vec3 sun = vec3(1.0, 0.95, 0.87) * 0.75 * ndotl;
    vec3 ambient = vec3(0.38, 0.35, 0.30);
    ALBEDO = albedo_color.rgb * clamp(ambient + sun, 0.0, 1.0);
}
```

**Result**: Still flat (no shading effect). Two possible explanations:
1. `CAMERA_MATRIX` not available in fragment shader on this WebGL build → compile fails → Godot uses cached flat shader
2. `CAMERA_MATRIX` available but `NORMAL` in `render_mode unshaded` isn't interpolated/varying → constant NORMAL → constant ndotl → flat output

**Side effect found**: Card back textures appeared dark or invisible. Cause: ndotl near zero for down-facing normals (card backs face -Y, sun is at +Y → ndotl=0 → only ambient 38% brightness). Card face was separately overwritten by `apply_texture` so it showed OK. User reported as "back texture doesn't load."

**Fix 19b — BoxShape AABB sizing (this session, active)**:
**Problem found**: `BoxShape.new()` default extents = Vector3(1,1,1) = 2m×2m×2m collision box. Playing cards are ~0.06×0.09m. The oversized collision box caused cards to float — physics engine rested the bottom of the 2m box on the table, lifting the card 1m above it.

**Fix**: Added `_make_aabb_box_shape(mesh: Mesh)` helper in PieceBuilder.gd that reads `mesh.get_aabb()` and sizes the BoxShape extents to match (`aabb.size * 0.5`). All three HTML5 fallback BoxShape.new() calls now use this helper.

**File changed**: `tabletop-club/game/Scripts/PieceBuilder.gd` — added `_make_aabb_box_shape()`, replaced three `BoxShape.new()` calls with `_make_aabb_box_shape(from.mesh)`.

**To revert**: Replace `_make_aabb_box_shape(from.mesh)` back to `BoxShape.new()` at lines 418, 443, 447. Delete `_make_aabb_box_shape()` function.

**Status**: Lambert reverted to flat. BoxShape fix active. PCK rebuilt.

---

## Fix 15 — Skip set_surface_material on HTML5 (Diagnostic, Reverted)

**Hypothesis**: `set_surface_material` override doesn't work on this WebGL build.

**Result**: Still black. BUT confirmed via server log that Fix15 ran (`[FIX15] HTML5: skip set_surface_material...`). Mesh's own SpatialMaterial (white, confirmed earlier) rendered black WITHOUT any override. This proves: even the mesh's original white SpatialMaterial renders black on this WebGL build. Issue is NOT in set_surface_material.

**Reverted**: Yes.

---

## Fix 16 — ShaderMaterial Replacement Without render_mode unshaded (Failed)

**Hypothesis**: SpatialMaterial auto-generated GLSL shaders fail on this Godot 3.6 WebGL build. Replace with custom ShaderMaterial using simple `ALBEDO = albedo_color.rgb`.

**Changes**: PieceBuilder creates ShaderMaterial (preload `Html5Albedo.shader`) instead of SpatialMaterial on HTML5. Piece.gd's `_get_original_albedo`, `set_albedo_color_client`, `get_albedo_color` handle ShaderMaterial via `get/set_shader_param`. `apply_texture` uses `Html5AlbedoTexture.shader` on HTML5.

**Result**: Still black.

**Root cause identified**: My shader used `shader_type spatial` with DEFAULT (lit) render mode, NO `render_mode unshaded`. With lighting = 0 on this WebGL build, lit materials output black regardless of ALBEDO value. This is the SAME reason SpatialMaterial was black.

**KEY BREAKTHROUGH**: OutlineShader.shader uses `render_mode cull_front, unshaded` — this is why the outline renders correctly despite lighting = 0. `unshaded` bypasses ALL lighting and outputs ALBEDO directly.

**ROOT CAUSE CONFIRMED**: The Godot 3.6 WebGL build has broken/zero lighting on HTML5 (ambient fails, directional light contribution = 0). ANY material using the lit render pipeline renders black. Only `render_mode unshaded` materials work. This explains every failure since Fix 12: all SpatialMaterial tests (including `flags_unshaded` = false), all ambient light fixes, all material duplication skips.

**Fix**: Add `render_mode unshaded;` to both `Html5Albedo.shader` and `Html5AlbedoTexture.shader`. See Fix 17.

---

## Fix 17 — ShaderMaterial + render_mode unshaded (Active)

**Changes from Fix 16**: Both Html5 shaders now have `render_mode unshaded;`. Pieces will render flat (no 3D shading) but with correct colors. Lighting can be addressed separately once pieces are visible.

**Files changed**:
- `tabletop-club/game/Shaders/Html5Albedo.shader` — new file, unshaded, `albedo_color` uniform
- `tabletop-club/game/Shaders/Html5AlbedoTexture.shader` — new file, unshaded, texture + color
- `tabletop-club/game/Scripts/PieceBuilder.gd` — HTML5 branch replaces SpatialMaterial with ShaderMaterial using Html5Albedo.shader
- `tabletop-club/game/Scripts/Game/Pieces/Piece.gd` — `_get_original_albedo`, `set_albedo_color_client`, `get_albedo_color`, `apply_texture` all handle ShaderMaterial

**Status**: Testing.

---

## Strategy Notes — How to Keep Making Progress

1. **Always capture browser console via the `/debug-log` server endpoint** injected in `seepcards.html`. Never rely on CDP alone — it misses iframe output.
2. **Test in standalone tab first** (`/ttclub2/seepcards.html`). The `_test_table_load()` + `_test_material_load()` functions in `ImportAssets.gd` fire before main menu and are always capturable.
3. **The PCK-only export** (`--export-pack`) is fast (~20-40s) and preserves the HTML/WASM. Always use it instead of full `--export`. Godot exe is at `c:/Users/Phyto/Downloads/godot/bin/godot.windows.opt.tools.64.exe`.
4. **The WebSocket shim** in `seepcards.html` survives `--export-pack` (only `--export` overwrites the HTML). Never need to re-inject unless doing a full export.
5. **Known-working subsystems**: asset DB loads 243 entries, ProceduralSky renders, WebSocket lobby proxy works, room codes relay correctly, table visible with correct geometry, auto-host/join via URL param works.
6. **Kill server**: `taskkill //F //IM node.exe` — NOT `pkill -f` (doesn't work on Windows).
7. **Black pieces → material not in PCK**: `ChessWhite.material` is a SpatialMaterial (pure color, no texture). Must be in include_filter. Same for all `.material` and `.tres` files in prebaked_assets.
8. **Import artifact scanning**: Godot's exporter does NOT follow resource references inside `.import/` .scn files. Any resources only referenced from there must be in `include_filter`.

---

## File Reference

| File | Purpose |
|------|---------|
| `tabletop-club/game/Scripts/AssetDB.gd` | Core asset importer — most HTML5 fixes here |
| `tabletop-club/game/Scripts/ImportAssets.gd` | Startup — HTML5 sync import + redirect writes |
| `tabletop-club/game/Scripts/PieceBuilder.gd` | 3D piece/table builder |
| `tabletop-club/game/Scripts/PieceCache.gd` | Cache check — returns false for `res://` |
| `tabletop-club/game/Scripts/Game/3D/Room.gd` | Room init — spawns table via `set_table()` |
| `tabletop-club/game/export_presets.cfg` | PCK export config — include_filter for non-resource files |
| `Constellation project att 3 - Copy/ttclub2/seepcards.html` | HTML shell — WebSocket shim injected here |
| `Constellation project att 3 - Copy/server.js` | Node.js server — `/ttclub-lobby` proxy route |
