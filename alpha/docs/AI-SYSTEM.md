# Fiona Zi AI — audit of the old system, and the migration to the new one

2026-10-02. Written before the first line of the new system, as the spec asked:
what exists, what overlaps, what goes, what stays, who depends on it, where it
is slow — and then the order the replacement lands in, without breaking the
game in between.

---------------------------------------------------------------------------
## Part 1 — Audit of the AI as it stands

### 1. The systems that exist

| Piece | Where | Size | What it is |
|---|---|---|---|
| `AIComponent` | `Engine/AI/AIComponent.h` | 166 lines, ~95 fields | One struct holding EVERYTHING an agent is: patrol route, speeds, ground snapping, vision/hearing ranges, memory (one last-known position), stuck detection, investigate state, personality, melee, ranged weapon (burst, accuracy, sound, muzzle bone), hit reactions, crowd separation, the current path, wander, animation slots, voice. Lives on the fat `Entity` as `HasAI` / `AI`. |
| `AISystem::Step` | `Engine/AI/AISystem.cpp` | 745 lines, ONE function of ~490 | Per agent per frame: personality jitter, animator construction, ground snap + slope lean, death, voice, hit reaction, perception, horde alert, hearing, a 7-state machine, crowd separation, path following, stuck/unstick, ranged fire (hit roll, VFX, audio, damage), melee swing, turning, acceleration, wall sliding against the nav grid, the transform write, animation driving. |
| Noise queue | `AISystem::PostNoise` (static vector) | — | Every noise is a position + loudness for one frame; heard within `HearingRange * loudness`, through any wall. |
| `NavGrid` | `Engine/AI/NavGrid.*` | ~330 lines | A 2D uniform grid rasterised from static colliders, A*, string-pulling, nearest-free-cell, line-clear. Single floor height (navY 0). |

### 2. Systems that overlap

* **Movement and collision, twice.** The AI moves `Transform` itself, snaps to
  the ground with its own raycasts, slides along nav-grid cells to avoid
  walls, steps up 45 cm — all things the Character Controller now does in
  Jolt for the player (stairs, slopes, walls, pushing, other characters).
  Two implementations of "walk without passing through walls", and the AI
  one can still be pushed into geometry.
* **Animation, twice.** `SetupAnimator` builds its own 7-state animator from
  clip names, alongside the Locomotion graph / `SkinnedMeshSystem` that drives
  the player from the Character Controller's velocity.
* **Damage, three times.** The AI subtracts from `Health.Current` directly
  (melee and ranged), the projectile system does, and the `Damage` node does —
  so an AI hit raises no event and nothing hears about it.
* **Communication, ad hoc.** "Horde alert" is a hard-coded scan of every
  agent inside `AlertRadius`, copying the last known position instantly.
* **Hearing vs. the acoustic world.** Sound now propagates through walls and
  round doors (`AcousticGrid`, 1c90a58); AI hearing ignores walls entirely.

### 3. Duplicated work
* Three full entity scans per agent per frame (nearest player, horde, separation).
* A ground raycast per agent per frame, although the agent could be a character.
* Path replanning every 0.35 s per chasing agent with no global limit.

### 4. What must be deleted
* `AIComponent` and `HasAI` on the fat `Entity` (the God struct).
* `AISystem::Step` (the God function), the static noise queue.
* Direct `Transform` motion, the AI's own ground snapping and wall sliding.
* Direct `Health` subtraction from inside the AI.
* The dependency on `HasPlayerTag` — "the player" is whoever has a Player
  Controller, and targets are decided by team attitude, not by a tag.
* The omniscience: `FindNearestPlayer` reads the player's true position every
  frame, seen or not, and the melee attack transition uses that distance
  without sight.

### 5. What can be reused
* `NavGrid` (A*, smoothing, nearest-free, line-clear) — wrapped by the new
  navigation system, given costs, dynamic obstacles and a request budget.
* The ranged hit model in `FireRound` (accuracy against distance and the
  target's speed, misses that fly past) — becomes the combat system's aim model.
* `SetupAnimator`'s clip lookup and the muzzle-bone lookup — move to a
  presentation adapter that is NOT part of the AI's decisions.
* The behaviours the tests pin down (chase around a wall, a soldier firing
  bursts that cover and distance defeat) — re-run against the new system.
* The Character Controller (3f00756) — the AI drives the same body as the player.

### 6. Dependencies today
`Scene.h` includes `AI/AIComponent.h` (the one `Scene -> AI` line in the layering
baseline). `AISystem.cpp` reaches into Scene, Animation (SkeletalMesh, BoneNames,
SkinnedMeshSystem), Audio (AudioEngine) and Effects (VfxWorld) — decision code
playing sounds and spawning blood.

### 7. Performance hot spots
* O(agents × entities) per frame from the three scans.
* One unbudgeted line-of-sight ray per agent per frame, through
  `Scene::RaycastClosest`, which itself loops over every entity and runs
  triangle tests on mesh colliders — so O(agents × entities × triangles).
* `NavGrid::BuildAuto` over the whole scene every 2 seconds (a periodic spike).
* Unbounded A* (each chasing agent, every 0.35 s), with vector reallocations.
* No LOD: an agent 300 m away costs what one in your face costs.

### 8. The API the rest of Fiona Zi uses
| Caller | Uses |
|---|---|
| `SceneSerializer` | the `"ai"` block (≈60 fields) read and written |
| `EditorLayer` | `m_AI.Step` in Play, the AI Agent inspector, the AI debug overlay (`m_ShowAI`), the Tools > AI menu, the outliner icon |
| `RuntimeLayer` | `m_AI.Step`; `PostNoise` on weapon fire |
| Graphs / C# | `AI.SetAIParam`, `AI.GetAIState`, `AI.AISeesTarget`, `AI.MakeNoise`; `Revive` and `Damage` reset/adjust AI fields |
| `SceneAPI` | the `"ai"` / `"aiagent"` component flag |
| `Scene.cpp` | picking radius; "enemy" for the crosshair |
| `AcousticWorld` | skips agents when baking walls |
| `tools/fps_game.cpp` | builds the Outpost's 8 soldiers |
| Content | `Outpost.fzescene` (8 agents); 3 tutorial games use "AI Agent" |
| Tests | `FZEAIChaseTest` (15), `FZESoldierAITest` (20), `FZEAITest`, `FZEEnemyTest`, `FZENavGridTest` |

---------------------------------------------------------------------------
## Part 2 — The new architecture

Everything lives in `Engine/AI` under `namespace FZE::AI`. The dependency
direction is the spec's §23, enforced by who includes whom:

```
FZAI (core: registry, scheduler, LOD, budgets, events, profiling)
  └ AIAgent (component: what the agent IS — definition, team, squad, role)
      ├ Perception  (senses → stimuli)          never decides
      ├ Memory      (stimuli → beliefs)          never decides
      ├ Blackboard  (typed facts the brain reads)
      ├ Brain       (IDecisionModel: Behavior Tree | Utility | State Machine | Rules)
      │   └ tasks ask Tactical / Cover / Combat for answers, issue intents
      ├ Squad / Communication (shared beliefs, orders — delayed, partial)
      ├ Navigation  (path requests, following, replanning)   never chooses where
      └ AIController (intents → Character Controller commands)
           └ Character Controller (Jolt) → physics          knows nothing of AI
```

* Agents are dense records addressed by `AgentHandle` (index + generation),
  never by pointer; per-agent memory, blackboard and BT state are fixed-size
  so a tick allocates nothing.
* Definitions are DATA (`.fzeai` JSON): Perception, Movement, Combat (+weapon),
  Tactical, Squad and Behavior profiles. Recruit / Soldier / Elite / Sniper /
  Heavy / Medic / Commander / Civilian / Zombie / Animal ship as built-in
  definitions with the same schema.
* Behaviour trees are DATA (`.fzebt` JSON) with composites, decorators,
  services and a task library; a Utility selector is a BT composite, so the
  two are used together.
* The AI never knows what it has not perceived: targets come from memory;
  the true position of the player is read only by perception, through a
  line-of-sight test.
* Hearing uses the acoustic world when there is one: a shot behind a wall is
  heard quieter, and from the doorway it came round.
* Animation, voices, muzzle flashes and blood are a PRESENTATION adapter that
  reads what the agent did; damage goes through one damage function that
  raises a `TookDamage` event.

---------------------------------------------------------------------------
## Part 3 — Migration, in stages that each leave the game working

| Stage | Lands | The old system |
|---|---|---|
| **1. Foundation** | `FZAI` core (registry, scheduler with LOD levels and budgets, event bus, deterministic per-agent RNG, profiling); `AIAgent` component; data-driven definitions; typed `AIBlackboard`; `AIMemory`; `AINavigationSystem` (NavGrid wrapped: request budget, path following, replanning, unreachable); `AIController` driving the Character Controller; a Jolt ray query for the AI. | Untouched — old `HasAI` agents still run. |
| **2. Perception** | Vision (FOV + peripheral, detection meter with delay and confidence, budgeted line-of-sight), hearing (events, attenuation, acoustic occlusion), damage perception, world events. | Untouched. |
| **3. Brain** | `IDecisionModel`; Behavior Tree (Sequence/Selector/Parallel; Condition/Inverter/Cooldown/Timeout/Repeat/Abort; MoveTo/LookAt/Attack/Reload/TakeCover/Investigate/Follow/Patrol/Flee/Search/Wait; services); Utility AI (considerations, curves, weights, cooldowns) as a BT composite; built-in trees. | Untouched. |
| **4. Combat, Cover, Tactics** | Target selection and threat from memory, weapon profiles, aim model, burst/reload/ammo, suppression; cover discovery from the level, scoring, reservation, peek/crouch/stand, lost-cover; tactical position queries (flank, advance, retreat, regroup, search). | Untouched. |
| **5. Squads** | Squads, leader, roles, formation, shared target via delayed communication, orders, cover assignment; the communication system (radio, alerts, sightings, deaths). | Untouched. |
| **6. Switch-over** | Debug tools (overlay: FOV, rays, hearing, path, cover, squad; inspector: state, BT node, blackboard, utility scores, LOD, cost); presentation adapter; old `"ai"` scenes migrate to `AIAgent` + a definition on load; Outpost converted; graph/C# nodes ported; then `AIComponent`, `HasAI`, `AISystem` deleted and the tutorials' AI/Health games rewritten. | Deleted. |

Each stage is a commit with its own test program measuring what it promises.
