# Build & Export

How a Fiona Zi project becomes a game a player can run: the audit of what was
there, the pipeline that replaced it, and what it does not do yet.

## 1. The audit

| What there was | What was wrong with it | Decision |
|---|---|---|
| `GameExporter::Export` — one function: copy FZEPlayer.exe, a hard-coded DLL list, Shaders/, Assets/ (optionally trimmed by reference), Config/, the start scene; run registered steps (C#, extensions); write `game.integrity`. | Ran **inside the editor** (frozen for the whole export); wrote **straight into the folder it replaced** (a failure halfway left half a game); shipped the editor's per-machine files (`hub.json`, `session.txt`) and every shader's `.meta`; copied every asset again every time; "verified" only that files existed; one configuration; every game wore the engine's icon. | **REFACTOR** into `Build/BuildPipeline`; `GameExporter` stays as a front door (same API) and its steps are the pipeline's Code stage. The trimming logic is kept. |
| `FZEExport` CLI | A wrapper around the same function. | **REFACTOR**: the build program. The editor runs it as a child process. |
| File > Build/Export dialog | A modal that blocked the editor. | **REMOVE** → Build menu + Build window. |
| Player | Never loaded a shipped game's `Config/project.fzesettings` (only with `--project`) — every double-clicked game ran on default settings. | **FIX**, plus the intro, the build configuration, `--smoke-test`. |
| `Integrity` | The game's own shader cache (`Cache/`) and `imgui.ini`, written on first run, would read as tampering. | **FIX**: excluded. |
| Asset catalogue in FZEExport | Never scanned — every "what does this scene need" answered *nothing*, so dependency trimming and checks were silently no-ops outside the editor. | **FIX**: the pipeline scans it. |

## 2. The pipeline

```
FZEditor ── Build ──► FZEExport (a process of its own)
                          Validate → Collect → Cook → Shaders → Code → Dependencies
                          → Stage → Verify → Package
                                                  │
                                         Builds/<target>/<config>/<Game>/   (+ .zip)
```

| Stage | Does |
|---|---|
| **Validate** | Target available; Product Name; start scene (id, path, or bare name); duplicate asset ids; paths that will exceed Windows' 260; Safe Mode's scan (scenes that do not parse, graphs that do not compile, missing references, missing engine shaders); every object in every scene (`ValidateScene`, the check Play makes); enabled extensions' health and the lock file. Prints the table (`Project.... OK`). Any error stops here — nothing is written. |
| **Collect** | What ships: everything a scene, material, prefab, graph or Project Settings names (dependency closure from the catalogue **and** a token scan, because graphs name assets in string pins), plus Audio/ and UI/. `.cs` never ships. |
| **Cook** | Scenes, materials, prefabs, animations, UI and graphs are re-written compactly (same document, **key order kept**). Through the **build cache** (`.fze/BuildCache/<target>-<config>/`, keyed by size, time, cooker and cooker version): unchanged = not cooked again. Formats the runtime reads as they are (models, images, sounds) are **not** "cooked" — pretending would be a copy with a new name; unchanged ones are hard-linked from the previous build. |
| **Shaders** | Every `#include` resolved (a missing one is an error now, not on the player's machine); the editor's `.meta` sidecars dropped. Compiled for real by the smoke test. |
| **Code** | FZEPlayer copied and named for the game; debug symbols in Development (or when asked); the **game's icon** written into the .exe's resources and as the window's icon set; the registered steps — C# compiled and shipped, extensions' runtime modules. |
| **Dependencies** | The executable's and extensions' **import tables are read** (PE): a non-system DLL beside the engine is shipped, a missing one is an error; DLLs loaded by name at run time are listed by the target; the Visual C++ and .NET runtimes are recorded as *required on the player's machine*. |
| **Stage** | Project Config without the editor's files; `Config/build.json` (what the Player is told it is); `game.fzescene`; README; `game.integrity`; **`BuildManifest.fze`** (game, version, company, FZE version, configuration, target, build id, asset version, timestamp, required runtime, extensions, package). |
| **Verify** | On the **staged** copy, before it replaces anything: the exe exists and is the target's machine type; its imports resolve; every asset every shipped scene depends on is in the build; no `.cs`, no Shipping symbols, no editor caches; the runtime contains no editor code; and then the **smoke test** — the built game is started, runs 90 frames, and reports through its exit code (runtime did not start / N shaders failed on this driver). Whatever the game wrote while it ran is removed again. `BUILD VERIFIED`. |
| **Package** | One rename swaps the staged folder in (the old build moves aside first, and is put back if the rename fails); optional `.zip` beside it. |

A failed or cancelled build removes its staging folder and **never touches the
previous build**.

**Configurations** (the engine is compiled once; the configuration is what is
shipped and what the Player is told):

| | Development | Test | Shipping |
|---|---|---|---|
| Debug symbols | yes | if asked | if asked |
| Player log | everything | warnings + | errors only |
| F3 stats overlay | yes | yes | no |
| Default trimming | off (iterate fast) | on | on |
| Default zip | no | no | yes |

**Profiles** live in `Config/BuildProfiles.json` (Development-Windows, Test-Windows,
Shipping-Windows on first use): target, configuration, output, start scene, game
name, cook, shaders, trim, compress, verify, smoke test, symbols, integrity.

**Targets** are a layer (`IBuildTarget`): Windows x64 is real; Linux and Android
are listed and refuse with the reason (no runtime for them exists yet).

**Logs**: `Builds/BuildLogs/<date_time>.log` (INFO / WARNING / ERROR / FATAL) and a
`.report.json` beside it, which the editor reads.

**Trimming** keeps what a scene, material, prefab, graph or Project Settings names, and `Audio/` and `UI/` at the
top of Assets. A game whose scripts build names themselves (`"Audio/" + name`) cannot be seen by that: a file
called `.fzeship` in a folder ships that folder whole.

## 3. The game's face

Project Settings > General > *The game's face*:

- **Game Icon** — one image; the build makes the .exe's icon (PNG-compressed .ico,
  16–256 px, squared on transparent, downscaled by area) and the window's.
- **Studio Logo**, **Studio Intro**, **Intro Length** — before the game: black, the
  logo, "Developed by", the Company; faded in and out; a click or a key skips it.
  **The engine's name is never shown.** The game does not start under it — scripts,
  music and the clock begin when it ends — so it is also the loading screen.

## 4. In the editor

**Build** menu: Build Project, Build & Run, Build Settings..., Build Profile ▸,
Clean Build, Rebuild, Open Build Folder, Cancel Build. The **Build window**: profiles
(new, delete, defaults), the profile's settings, the game's face (with a jump to
Project Settings), the buttons, the nine stages lighting up as they pass, the
issues worst-first (click: the asset in the Content Browser, or the object if its
scene is open), the log. The open scene is saved first; an untitled one stops
the build with a sentence. Build & Run starts the built game, not Play.

## 5. CLI

```
FZEExport --project <dir> [--profile <name>] [--config Development|Test|Shipping]
          [--target windows-x64] [--scene <name|path>] [--out <dir>] [--name <Game>]
          [--trim|--no-trim] [--zip] [--no-verify] [--no-smoke] [--symbols]
          [--clean] [--rebuild] [--report <file>] [--progress]
```

Exit code 0 built, 1 failed. `--progress` prints `@@stage / @@fraction / @@line /
@@report` for a watcher.

## 6. Tests

`FZEBuildTest` (37 checks) builds a project it makes: a broken start scene stops at
Validate with nothing written; a good build has its runtime, cooked compact scene
(key order kept), shaders without sidecars, no editor config, a correct manifest
and build.json, and **its smoke test started the built game**; nothing the smoke
run wrote stays; the second build cooks nothing; a changed scene is cooked alone;
a failed build leaves the previous one byte for byte; Clean removes output and
cache; profiles and reports round-trip; PE imports are read.

## 7. Not done, and why

- **Packed content (`.pak`).** The runtime reads loose files; packing them needs a
  virtual file system in the engine first. The Package stage is where a packager
  goes; today it makes a folder and a zip.
- **Converting cookers** (meshes to a runtime mesh format, textures to compressed
  GPU formats). The runtime has no such formats yet; a converter is a new
  `IAssetCooker` once it does.
- **Shader variants.** The engine has no variant system to strip; shaders are
  checked and shipped, and compiled for real by the smoke test.
- **Per-configuration engine code.** One Release engine serves all three
  configurations; what differs is what ships and what the Player enables.
- **Version resources** (Company/Copyright in the .exe's file properties). The icon
  is written; the version block is not yet.
- **Linux / Android.** No runtime exists for them; the targets say so.
