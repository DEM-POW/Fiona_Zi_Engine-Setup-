# Play Mode — Runtime Preview

How pressing **Play** works in Fiona Zi: what was there, what changed, and the
numbers that decided it. Written as the audit the Play Mode specification asked
for, and kept up to date as the design document.

## 1. The audit (before the rebuild)

| Question | Answer found in the code |
|---|---|
| How is a Scene created for Play? | `EditorLayer::OnScenePlay` deep-copies the editor scene (`CreateRef<Scene>(*m_EditorScene)`) and runs the copy. The editor scene is never mutated. **Kept.** |
| Where is the game loop? | **Twice**: inline in `EditorLayer::OnUpdate` (Play) and inline in `RuntimeLayer::OnUpdate` (shipped Player). Plus the start sequence three times in each host (start, scene switch, stop). The lists had drifted — different orders, different systems. |
| How are scripts run? | `VisualScriptSystem` (graphs) + `CSharpScriptSystem` (C#), started at Play. C# compiled with `dotnet build` **synchronously inside the Play press** when a `.cs` changed — the editor froze for the compile. |
| How is physics created? | `JoltWorld::Start(scene)` on the copy, `Stop()` at Stop. Separate from editor tools. **Kept.** |
| How does AI start? | `FZAI::Start` — bakes the navigation grid from the physics every time (175 ms on Outpost). |
| How are assets loaded? | `ResourceManager` (async workers) + per-scene caches (`m_ModelCache`, `m_SkeletalCache`...) that the scene copy inherits. Textures cached by `Texture2D::Get`. Shaders compiled once at boot. |
| Is there an asset cache? | Yes — the scene caches and the ResourceManager. **No reload of meshes or textures happened on Play** (measured: 0–3 ms). |
| Is there a Build at Play? | Only the C# compile when a script changed. No asset or shader rebuild. |
| What was slow? | Measured stage by stage (below): **1.6 s re-reading and retargeting every soldier's animation library**, 175 ms navigation bake, 35 ms scripts. |

### Measured: Outpost (107 objects, 8 AI soldiers), Play pressed three times

| Stage | Before | After |
|---|---:|---:|
| Skinned meshes | 1 613 ms | 1 ms |
| AI (navigation bake) | 196 ms | 19 ms (reused) |
| Scripts | 35 ms | 46 ms |
| everything else | 11 ms | 12 ms |
| **Total (warm)** | **1 855 ms** | **78 ms** |

The first Play of a session (cold) is 264 ms: the navigation is baked once. The
shipped Player's cold start went from 3 946 ms to 2 143 ms (the soldiers' clips
are now built once and shared); what remains is the first import of the soldier
model itself, which belongs to the Build pipeline's asset cooking.

## 2. Decisions

| | What |
|---|---|
| **KEEP** | Editor World / runtime copy separation; `JoltWorld`, `FZAI`, the script systems; ResourceManager and the scene caches; shaders compiled once at boot. |
| **CREATE** | `Runtime/RuntimeWorld` — the running game: copy, physics, AI, staged & timed start, switch, stop. `Runtime/RuntimeScheduler` — the frame as named systems in fixed phases. `Runtime/SceneValidation` — the pre-Play (and pre-Build) check. The editor's `PlayState` machine. |
| **MERGE** | The editor's and the Player's start, switch, stop and frame → one `RuntimeWorld`. Both hosts now differ only in what they do around it (focus and cursor, the Player's pause menu and death screen). |
| **REFACTOR** | `EditorLayer::OnScenePlay/OnSceneStop/SwitchRuntimeScene`, `RuntimeLayer::OnAttach/SwitchScene/OnUpdate`; `Scene::ResolveSkinnedMeshes` (clips keyed by what built them); `AINavGrid::Build` (reuse when nothing static changed). |
| **REMOVE** | The inline loops and start lists in both hosts (≈ 200 lines). |
| **MOVE** | Nothing moved between layers: the runtime is `Engine/Runtime` (rank 6), under the Editor (7). |

## 3. How it works now

```
Press Play (toolbar)              EditorLayer::RequestPlay
   │  Preparing
   │    ├─ a .cs changed? compile it on a worker; the viewport says so
   │    │     └─ compile error → red card "All compiler errors have to be fixed…" → Stopped
   │    └─ ValidateScene(editor scene)
   │          ├─ errors   → red card (which object, why, "Select it") → Stopped
   │          └─ warnings → one yellow card; the game runs
   │  Initializing
   │    └─ copy the scene → RuntimeWorld::Start (each stage timed)
   │          └─ a stage throws → undone, red card "Play failed: it stopped at …" → Stopped
   │  Playing
   │    └─ every frame: RuntimeWorld::Tick → RuntimeScheduler (phases below)
   │          └─ a C++ exception → red card, Stop, editor untouched
   │  Stopping → RuntimeWorld::Stop → Stopped (the editor scene was never touched)
```

**Phases of a frame** (both hosts): Input → AI → Physics → Animation → Effects →
Scripts → Gameplay → Presentation → Audio. A system is registered into a phase by
name (`Scheduler().Add(RuntimePhase::Scripts, "Legacy weapons", fn)`), each is
timed per frame — the Profiler reads `Entries()` — and an extension adds its own
systems the same way.

**Start stages**: Meshes, Skinned meshes, UI textures, Reset run state, Rendering,
Audio, Scripts, Components, Physics, Acoustics, AI, Effects, Network — logged as
`[runtime] cold|warm start in N ms (stage ms, …)` and kept in
`RuntimeWorld::StartupProfile()`.

**Incremental invalidation** where it was measured to matter:
- an entity's retargeted clips are keyed by model + library files + their write
  times; equal key → not read again;
- the navigation grid is keyed by every collider and rigidbody (their own
  serialization), each object's world transform, the terrain's heights, character
  positions to the metre, and the bake settings; equal key → reused. A moved wall
  is re-baked (tested, with a negative control).

**Validation** (`SceneValidation`) — errors stop Play: duplicate ids, a transform
that is not a number. Warnings let it run: missing model / rigged model / sound /
effect / graph files, a Rigidbody with no Collider, a Collider with no size, a
Player Controller with nothing to drive, an AI definition that does not exist, a C#
class that is not compiled, a C# object field or graph variable aimed at an object
that is not in the scene, more than one Player Controller.

## 4. Not done, and why

- **No new parallel asset or shader cache.** The audit found textures, meshes and
  shaders are not reloaded on Play; adding `FZAssetCache`/`FZShaderCache` beside
  the existing ResourceManager and caches would be a second source of truth for
  no measured gain. The measured costs were fixed where they were.
- **Initialization stays on the main thread.** Its stages create GL objects and
  physics bodies, and the whole warm start is 78 ms; the one long step that could
  move — the C# compile — now runs on a worker while the viewport says so.
- **Apply Runtime Changes** is not implemented (the design allows it: the runtime
  copy and the editor scene share entity ids, so a value can be copied back by id).
