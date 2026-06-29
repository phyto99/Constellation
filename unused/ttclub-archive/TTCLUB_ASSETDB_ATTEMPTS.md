# TTClub AssetDB HTML5 Fix — Attempt Archive

Two attempts to fix `_import_asset` for HTML5. Attempt 1 got to working state (230+ assets loaded, game enters room). Attempt 2 broke it with a GDScript scope error. **Read this before touching AssetDB.gd again.**

---

## Attempt 1 — Working (Clean Rebuild, April 2026)

**Result**: 230+ assets loaded into DB. Game auto-hosts. Table and pieces visible.

### What the working AssetDB.gd HTML5 changes look like

#### `_import_asset` — HTML5 file copy bypass
```gdscript
# Original structure that worked:
var to: String
if OS.get_name() == "HTML5":
    to = from   # pre-baked in PCK, no copy needed
else:
    var dir = _get_asset_dir(pack, type)
    to = dir.get_current_dir() + "/" + from.get_file()
    var import_err = _import_file(from, to)
    if not (import_err == OK or import_err == ERR_ALREADY_EXISTS):
        return import_err
```

**Why it worked despite `import_err` being "undefined" on HTML5:**
GDScript 3 block-scopes `var` — `import_err` declared inside the `else` block is null outside it. The later check `if import_err == ERR_ALREADY_EXISTS` evaluates `null == 7` → false → `file_was_read` stays false → geometry always recalculated. Silent, correct behavior.

**Why the `.box` cache write doesn't crash on HTML5:**
The geo file path is `to + ".box"` = `"res://prebaked_assets/.../Piece.gltf.box"`. `geo_file.open(..., File.WRITE)` on a `res://` path in the PCK returns an error code — it does NOT crash, it just logs an error and continues. The geometry was calculated correctly even without the cache.

#### `_is_valid_path` — accept `res://prebaked_assets/`
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

#### `_catalog_assets_from_manifest` — file names only, all required keys
```gdscript
func _catalog_assets_from_manifest() -> Dictionary:
    var total_files = 0
    var packs = {}
    for pack_name in PREBAKED_MANIFEST:
        var pack_path = "res://prebaked_assets/" + pack_name
        var pack_file_count = 0
        var types = {}
        for type_name in PREBAKED_MANIFEST[pack_name]:
            var files_raw: Array = PREBAKED_MANIFEST[pack_name][type_name]
            var file_list = []
            for file_name in files_raw:
                if VALID_EXTENSIONS.has(file_name.get_extension()):
                    file_list.append(file_name)   # names ONLY — _import_all prepends the path
            types[type_name] = {
                "config_file": false,
                "stacks_file": false,
                "files": file_list,
                "file_count": file_list.size()
            }
            pack_file_count += file_list.size()
        packs[pack_name] = {
            "path": pack_path,
            "types": types,
            "file_count": pack_file_count
        }
        total_files += pack_file_count
    return {
        "packs": packs,
        "file_count": total_files,
        "asset_dir_exists": true
    }
```

**Critical: `files` must contain file names only** (e.g. `"Bishop White.gltf"`), NOT full paths. `_import_all` builds the full path as `type_path + "/" + file`.

#### `start_importing_sync` — manual signal drain
```gdscript
func start_importing_sync() -> void:
    _import_err_mutex.lock()
    _import_err_dict.clear()
    _import_err_source = ""
    _import_err_mutex.unlock()
    _import_mutex.lock()
    _import_stop = false
    _import_mutex.unlock()
    _tr_locales = []
    _import_all(null)
    # _process() never runs during sync — drain the signal manually
    _import_mutex.lock()
    var has_signal = _import_send_signal
    var send_completed = _import_file_path.empty()
    var dir_found = _import_dir_found
    _import_send_signal = false
    _import_mutex.unlock()
    if has_signal and send_completed:
        emit_signal("completed", dir_found)
```

#### `_import_all` — HTML5 uses manifest, skips old-asset removal
```gdscript
var catalog = _catalog_assets_from_manifest() if OS.get_name() == "HTML5" else _catalog_assets()
if OS.get_name() != "HTML5":
    _send_importing_file_signal(tr("Cleaning old files..."), 0, 1)
    _remove_old_assets(catalog)
```

#### `get_asset_paths` — HTML5 early return
```gdscript
func get_asset_paths() -> Array:
    if OS.get_name() == "HTML5":
        return ["res://prebaked_assets"]
    ...
```

#### Games companion texture (Fix 6) — PREBAKED_MANIFEST lookup instead of file_exists
```gdscript
if type == "games":
    if OS.get_name() == "HTML5":
        var from_base = from.get_file().get_basename()
        var pack_name_dir = from.get_base_dir().get_base_dir().get_file()
        var type_files: Array = PREBAKED_MANIFEST.get(pack_name_dir, {}).get(type, [])
        for file_name in type_files:
            if file_name.get_basename() == from_base and VALID_TEXTURE_EXTENSIONS.has(file_name.get_extension()):
                entry["texture_path"] = to.get_base_dir() + "/" + file_name
                break
        if not entry.has("texture_path"):
            entry["texture_path"] = ""
    else:
        # original File.file_exists() code
```

---

## Attempt 2 — Broken (This Session, April 2026)

**What was attempted**: "Properly" fix the `import_err` undefined variable and cards back texture `dir` undefined variable.

**What broke it**: GDScript 3 block-scopes `var`. Moving `var import_err` outside the `else:` block causes `dir` (still declared inside `else:`) to be unreachable at the cards back-face section. Parse error: `"The identifier 'dir' isn't declared in the current scope."` PCK built with parse error → AssetDB.gd script fails to load → nothing works.

### The actual scope problem

```gdscript
# BROKEN — dir is block-scoped to the else, not visible later
var import_err: int = OK     # ← moved outside
var to: String
if OS.get_name() == "HTML5":
    to = from
else:
    var dir = _get_asset_dir(pack, type)   # ← dir only lives in this else block
    ...

# Much later, in cards back-face section:
var back_to = dir.get_current_dir() + ...  # ← PARSE ERROR: dir not in scope
```

### Why Attempt 1 didn't have this parse error

In Attempt 1, `var import_err` was also inside the `else:` block. GDScript never encountered an out-of-scope reference because nothing moved. The "undefined `import_err`" was a logical issue (null comparison), not a parse error.

---

## What Still Needs Fixing (do this properly, not in a rush)

### Issue A — `import_err` undefined on HTML5 (logical, not breaking)
On HTML5, `import_err` is null (uninitialized). `null == ERR_ALREADY_EXISTS` = false, so the `.box` cache is never read. Geo is always recalculated. This is **correct behavior** — it works, just slightly slower. No fix needed urgently.

### Issue B — `.box` cache write fails silently on HTML5 (not breaking)
`geo_file.open("res://...box", File.WRITE)` returns an error on HTML5 (res:// is read-only). The error is logged but execution continues. Geo was calculated correctly. **Not breaking.** If you want to suppress the log spam, guard with `if OS.get_name() != "HTML5":` around the open/store/close block only — NOT the whole geo calculation.

### Issue C — Cards `dir` reference (not reached on HTML5)
The cards back-face code (`var back_to = dir.get_current_dir()...`) is inside `else: # Objects`. Cards are `ASSET_TEXTURE` type, so they go through the `elif asset_type == ASSET_TEXTURE:` branch, not `else: # Objects`. **This code is never reached for cards on any platform.** It's for objects that happen to be named with type "cards" in config — which don't exist in the default asset pack. Not a real issue.

### How to fix B cleanly (when ready, in a separate session)
```gdscript
# In the ASSET_SCENE branch, inside "if not file_was_read:"
# After calculating geo_data, guard only the file write:
if OS.get_name() != "HTML5":
    var err = geo_file.open(geo_file_path, File.WRITE)
    if err == OK:
        geo_file.store_var([ avg_point, bounding_box_min, bounding_box_max ])
        geo_file.close()
    else:
        _log_error("Failed to open '%s'! (error: %d)" % [geo_file_path, err])
# No changes to dir, import_err, or anything else
```
This is the ONLY change needed. It suppresses the write-error log. Everything else already works.

---

## Restore Procedure (if AssetDB.gd is broken again)

1. `cd tabletop-club && git diff game/Scripts/AssetDB.gd` — see what's changed
2. Find where `var import_err` and `var dir` are declared
3. Both must be inside the same `else:` block (non-HTML5 path), not lifted out
4. Re-export: `godot.windows.opt.tools.64.exe --path game --export-pack HTML5 ".../ttclub2/seepcards.pck"`
5. Update `fileSizes.seepcards.pck` in `seepcards.html` to match actual file size (`ls -la seepcards.pck`)
6. Verify shim still in seepcards.html: `grep -c "ttclub-lobby" seepcards.html` → must be 2

---

## Export Command (canonical)

```
c:/Users/Phyto/Downloads/godot/bin/godot.windows.opt.tools.64.exe \
  --path "c:/Users/Phyto/Downloads/tabletop-club/game" \
  --export-pack HTML5 \
  "c:/Users/Phyto/Downloads/Constellation project att 3 - Copy/ttclub2/seepcards.pck"
```

Output path is `ttclub2/seepcards.pck`. No other path. Never `--export`. Never `tabletop.pck`.

After export, update `fileSizes` in `ttclub2/seepcards.html`:
```
"fileSizes":{"seepcards.pck": ACTUAL_BYTES, "seepcards.wasm":19796835}
```
Get actual bytes: `ls -la ttclub2/seepcards.pck | awk '{print $5}'`
