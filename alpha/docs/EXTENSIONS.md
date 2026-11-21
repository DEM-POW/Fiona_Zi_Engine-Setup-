# Extensions

How Fiona Zi is extended without touching its core: what an extension is, how
one is loaded, what it may reach, how it is installed, shipped and removed — and
the audit the Extensions specification asked for before any of it was written.

## 1. The audit (Phase 0)

| Area | What the code had | Decision |
|---|---|---|
| `Engine/Extensions/Extension.*` | A descriptor (`extension.fzeext`): id, name, version, type, load phase, minimum engine version, dependency ids. No code loading of any kind. | **REFACTOR** → `ExtensionManifest` (`extension.json`, version ranges, API version, modules, capabilities, permissions, critical, priority). The old file still loads (`Legacy`). |
| `ExtensionRegistry` | Discovery from engine + project folders; dependency closure on Enable; Disable refused while needed; topological load order naming cycles; per-project enabled list. Correct, headless, tested. | **KEEP** the rules; **REFACTOR**: four locations (Development, Project, User, Engine), version-aware dependencies and conflicts, API/platform/architecture/renderer checks, deterministic order (dependencies, then priority, then id — never the folder listing), Safe Mode, lock file. |
| `Extensions/fze.water`, `fze.terrain`, `fze.networking`, `fze.cinematics` | Descriptors for systems compiled into the engine. Toggling them changed nothing — no code read the flag. | **REMOVE.** A switch that does nothing is worse than no switch. |
| `Assets/PackageManager` | Unzipped registry "packages" (asset packs) into `Assets/<Name>/`. | **MERGE** into `ExtensionPackages`: extension packages install as extensions; the old asset packs still install into Assets, now with an optional SHA-256. |
| `ExtensionManagerPanel` | Installed + Repository tabs over the above. | **REBUILD** (Installed / Repository / Diagnostics, see §5). |
| Components (`Scene/Component.h`) | `IComponent` + `ComponentRegistry` by type name. **A type nobody registered was dropped on load — and saving made the loss permanent.** | **REFACTOR**: `SchemaComponent` (a component declared as data), `UnresolvedComponent` (kept, written back byte for byte), registry `owner` + `Unregister`. |
| Systems | `RuntimeScheduler` (named systems in fixed phases) already shared by editor Play and the Player. | **KEEP**: extension systems join it by phase. |
| Editor UI | `CommandRegistry` (panels as toggles, actions), hand-written menus, `ComponentInspectors` by type name. | **ADAPT**: extension panels/commands go through the registry (`Remove` added); menus and Add Component draw extension items; inspector falls back to the schema. |
| Build | `GameExporter` with registered `ExportStep`s. | **ADAPT**: an "Extensions" step ships runtime modules. |
| Layers | `Extensions` rank 1 (Core/Platform below it). | The loader and the context need Scene and the runtime, so `ExtensionManager` lives in **Runtime/** (rank 6). Scene, Renderer and Physics never include it. |

## 2. Architecture

```
Engine/Extensions/SDK/FZEExtensionSDK.h   the ONLY header an extension includes (no engine headers)
Engine/Extensions/ExtensionManifest       extension.json, SemVer, VersionRange, validation
Engine/Extensions/ExtensionRegistry       discovery, compatibility, dependencies, order, Safe Mode, lock
Engine/Extensions/ExtensionPackages       install / update / rollback / uninstall / verify / repair / pack
Engine/Platform/SharedLibrary             LoadLibrary + GuardedCall (structured-exception guard)
Engine/Scene/SchemaComponent              components as data; unresolved data kept
Engine/Runtime/ExtensionManager           lifecycle, contexts, runtime services, Play hook, export step
Engine/Editor/ExtensionEditor             IEditor + IUI (panels, menus, commands, inspectors)
Engine/Editor/ExtensionManagerPanel       the window
cmake/FZEExtensions.cmake                 fze_register_extension(), Extensions/*/CMakeLists.txt
tools/fze_cli.cpp                         fze extension ... (CI)
Extensions/com.fionazi.testextension      the proof-of-concept extension
Extensions/com.fionazi.uidecor            dresses the editor: themes, frames, animated decorations
```

**ABI.** C entry points (`FZE_ExtensionApiVersion`, `FZE_CreateExtension`,
`FZE_DestroyExtension`), COM-shaped interfaces (pure virtuals, no data, no
virtual destructor in the table), no STL across the boundary (UTF-8 `const char*`
in, caller-owned buffers out), nobody frees what the other allocated, no
exception crosses, things in the world are `EntityHandle`s. A new function is
appended to the end of its interface; anything else bumps
`FZE_EXTENSION_API_VERSION` and the loader refuses the old DLLs *by asking the
DLL*, not the manifest.

**Capabilities.** `IContext::Scene()/Assets()/Renderer()/Audio()/Physics()/Scripts()/Editor()`
are null unless the manifest asked for them. `Editor()` is also null in a runtime
module and in the Player — a runtime module that reached for the editor would
work in the editor and crash in the shipped game.

**Components as data.** An extension registers a schema (fields, types,
defaults, ranges, version, optional migration). The engine owns the values:
saves, copies for Play, undoes, draws them in the Inspector. Saved data carries
`"extension"` and `"version"`; an old version is migrated by the extension's
callback (the test extension renames v1's `Rate` to v2's `Speed`).

**Lifecycle.** Discovered → Validated → Ready (dependency-checked) → Loaded →
Initialized (`OnLoad` accepted) → Started → Running → Stopping → Stopped →
Unloaded, or Failed with the reason. Load and start are timed; per-frame system
time is smoothed and shown. Unloading takes back, *before* the DLL is released:
systems (and their scheduler entries), event subscriptions, settings (values
kept), asset types, shaders, components (live ones become `UnresolvedComponent`),
panels/menus/commands/inspectors.

**Fault containment, honestly.** Every call into extension code goes through
`ExtensionManager::Call` → `GuardedCall`: an access violation, divide-by-zero or
C++ exception inside it is caught, the extension is marked Failed and never
called again this session, and the person is told the fault was contained *but
the editor may be unstable — save and restart*. A corrupted heap, a stack
overflow or `abort()` still end the process; for those, a **crash journal**
(`.fze/extensions-journal.json`, written before each lifecycle step) names the
extension at the next start, and twice in a row leaves it off.

**Safe Mode.** `FZEditor --safe-mode` (or *Withhold project extensions now* in
Diagnostics) withholds every non-engine extension without changing the project's
choices; switching one on lets it back in for the session.

**Packages.** `.fzepkg` = zip. Install: SHA-256 (refused on mismatch, before
anything is written) → extract into `<root>/.staging/` → read + validate +
compatibility + dependencies → `.install.json` (source, trust, per-file hashes)
→ the old copy moved to `.backup/` → one rename into place → re-validated (old
copy restored if not). Installing never enables. Uninstall is refused while
another extension depends on it or a scene/prefab holds its data (found by
reading the files), unless forced — and forced, the data stays in the scenes.
Verify compares every file with its install record; Repair reinstalls from
`.fze/PackageCache`; Rollback restores `.backup/`.

**Trust.** Official (shipped with the engine), Verified (SHA-256 matched its
registry), Community (installed from a package), Unknown (a folder that
appeared). Where it came from — not how good it is. Native code from anything
but Official/Verified is labelled *untrusted native code*. Permissions are
displayed as declared; a DLL cannot be held to them and the UI says so.

**Shipping.** The export's "Extensions" step copies, for each enabled extension:
its manifest, its runtime module, `Resources/` and `Shaders/`. Never the editor
module; an editor-only extension ships nothing. The Player in a shipped folder
loads exactly what is in `<game>/Extensions`, before reading the scene.

**Load order.** Dependency graph first; among the rest, higher `priority`, then
the id. Two machines load the same set in the same order.

## 3. Writing one

```json
{
  "id": "com.mystudio.weather", "name": "Weather", "version": "1.2.0",
  "engineVersion": ">=0.1.0", "apiVersion": 1,
  "entryPoints": { "runtime": "Bin/WeatherRuntime.dll", "editor": "Bin/WeatherEditor.dll" },
  "dependencies": [ { "id": "com.mystudio.sky", "version": "^2.0.0" } ],
  "capabilities": ["scene", "renderer", "editor"],
  "permissions": [], "platforms": ["Windows"], "critical": false
}
```

```cmake
fze_register_extension(
    ID      com.mystudio.weather
    PATH    ${CMAKE_CURRENT_LIST_DIR}
    RUNTIME WeatherRuntime Source/Runtime.cpp
    EDITOR  WeatherEditor  Source/Editor.cpp)
```

`Extensions/*/CMakeLists.txt` (engine and sample project) are found
automatically; other folders via `-DFZE_EXTENSION_DIRS=...`. *Extensions >
Create...* writes this skeleton. See `Extensions/com.fionazi.testextension`.

### Dressing the editor

An editor module may decorate the editor's own windows (appended to `IEditor`
in API 1; `Extensions/com.fionazi.uidecor` uses all of it):

- `RegisterDecorator(id, fn, user)`: called once a frame for every editor
  window on screen (panels, floating windows, menus, popups, tooltips, the menu
  bar), after it is drawn. It gets a `WindowInfo` (title, kind, rectangle, title
  or tab height, focused / hovered / docked, time) and two `IPainter`s:
  - `below` is for a glow or a shadow round the window;
  - `above` draws on the window's contents.

  Both stay with the window, so a menu opened over it still covers them. Pens
  draw lines, rectangles (plain, rounded, gradient), circles, triangles,
  polylines, convex polygons, text, and pictures (straight or turned, a frame
  of an animated one), inside clip rectangles.
- `SetStyleColor(name, rgba)` and `SetStyleValue(name, v)`: the editor's
  colours by ImGui's names, and its borders (`...BorderSize` 0 takes a frame
  away), rounding and alpha. The editor's own style is kept, and the live one
  is always that base with every extension's overrides laid on. Switching one
  extension off leaves the others' changes; switching them all off leaves
  exactly the editor's own.
- `LoadImage(path, framesAcross)` and `ImageInfo`: a PNG, JPG, TGA or BMP from
  the extension's folder, or an animated GIF (its frames and frame time). A
  sprite strip is cut into frames.

All of it is taken back when the extension stops: decorators, style overrides
and textures. Every decorator call goes through the same guard as any other
call into extension code.

## 4. CLI (CI/CD)

```
fze extension list | install <pkg> [--sha256 H] [--user] | update <pkg> | remove <id> [--force]
              enable <id> | disable <id> | verify [<id>] | check | lock | restore --registry <src>
              pack <folder> <out.fzepkg>
```

`check` exits 1 on any error in an enabled extension or a lock mismatch. `restore`
installs exactly the versions in `extension-lock.json` from a registry. The CLI
loads no DLL.

## 5. The window (File > Extensions...)

**Installed** — every extension with its state word (running / on / off / blocked
/ failed / safe mode / on demand), source and trust; details: the switch and why
it is grey, lifecycle, modules loaded, load/start time, per-frame cost, what it
added to the editor, requirements with installed versions, who needs it,
services and declared permissions; Load now, Verify, Repair, Roll back, Pack
.fzepkg, Show in Explorer, Remove. Install from file / folder, Create, Rescan.
**Repository** — official registry, a registry file, or a URL; Install / Update
(a running extension is stopped first and restarted after; if the new version
does not start, the old one is put back). **Diagnostics** — health check, load
order, lock file, Safe Mode.

## 6. Acceptance tests

`FZEExtensionTest` (98 checks), against real manifests on disk and the real Test
Extension's DLLs:

| # | Test | Where |
|---|---|---|
| 1 | Starts with no extensions | §Test 1 |
| 2 | Discovers a valid one | §Test 2 |
| 3 | Loads it | §Test 3 (both modules, Running) |
| 4 | It registers a component | §Test 4 |
| 5 | The component is in the editor | §Test 5 (+ editor capture: Inspector draws its fields) |
| 6 | It registers a panel | §Test 6 (+ menu item runs; panel draws through IUI) |
| 7 | Runtime extension works in the Player | §Test 7 (runtime module only; system ticks and turns the object) + exported game run |
| 8 | Editor extension not in a shipping build | §Test 8+20 |
| 9 | Missing dependency caught | §Test 9 |
| 10 | Dependency conflict caught | §Test 10 (+ ranges, closure, cycle, order) |
| 11 | Incompatible API refused | §Test 11 (manifest API 99; a DLL without the entry points) |
| 12 | Damaged manifest refused safely | §Test 12 |
| 13 | Missing extension's scene data kept | §Test 13 (unloaded, re-read, re-saved: values intact) |
| 14 | Installing it resolves the component | §Test 14 (+ v1 → v2 migration) |
| 15 | Disable stops loading, keeps files | §Test 15 |
| 16 | Uninstall checks dependents and references | §Test 16 |
| 17 | Package integrity | §Test 17 (+ verify, tamper, update, rollback, repair) |
| 18 | A failing extension does not take the editor down | §Test 18 (a real access violation inside the DLL, contained) |
| 19 | Safe Mode opens without extensions | §Test 19 (+ crash journal, critical failure) |
| 20 | Build includes only the runtime extensions needed | §Test 8+20 (+ the exported game folder) |

## 7. Not done, and why

- **Signing.** SHA-256 proves the bytes match what a registry promised, not who
  published them. Real publisher signatures need keys and a trust root; the
  trust levels are named so a fourth one can be added, and nothing claims to be
  signed today.
- **Hot reload.** Disable/enable unloads and reloads a DLL in a running editor
  (every registration is taken back first), which covers rebuilding an
  extension. Swapping a module *while its objects are live* is the specification's
  "later" — not attempted.
- **Asset importers and asset editors.** An extension can register a file type
  (it then appears as a known asset) but not yet a converter that runs during
  import, nor a dedicated editor window per asset type (its components get a
  custom inspector).
- **Toolbar buttons, gizmos, property widgets, scene tools.** The editor API has
  panels, menus, commands, inspectors and window decorations; the rest needs
  stable extension points in the viewport first.
- **Hub integration.** The CLI, the lock file and registries are the pieces the
  Hub would use; the Hub does not list a project's extensions yet.
- **Extension-registered tests, ExtensionTask (async jobs).** Not started.
- **Sandboxing.** Not claimed. A native DLL can do anything this process can.
