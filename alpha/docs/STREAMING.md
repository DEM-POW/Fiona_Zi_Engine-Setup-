# Seamless Streaming

Added 2026-10-17. Nabras: "moving between scenes during play with no black loading screen, the way GTA and God of War do it - switching inside a tunnel or a narrow canyon so the player never notices - our own technique, driven from C# and visual scripting."

## The idea

Large games never stop to load once you are playing. The world is cut into pieces; the ones near you are in memory, and the next is read while you walk toward it through a place built for it: a tunnel, a crevice you squeeze through, a door that takes a moment to lift, a long corridor. Unreal calls the pieces *streaming levels*, driven by *Level Streaming Volumes* and Blueprint "Load Stream Level". Here they are **stream layers**: any `.fzescene`, loaded *into* the running scene.

## How a layer comes in (`Engine/Runtime/SceneStreaming.cpp`)

| Stage | Where the cost goes |
|---|---|
| **Reading** | The file parsed into objects on a worker thread (JSON and every component; nothing needing the GPU). Never on the frame. |
| **Fetching** | Every model, rigged model and texture it needs (`Scene::AssetRefs`) asked of the asset threads at once; the frame only uploads, inside the asset manager's own budget. Each is then held so nothing evicts it before the layer is shown. |
| **Ready** | All of it resident. `Preload` stops here: ready to show at once. |
| **Activating** | The objects copied into the world parent-first, within about 1 ms a frame, with their ids reserved up front so references between them are right from the first copy. They arrive **dormant**: their physics bodies are built (spreading that cost across the same frames) but nothing is drawn, lit, scripted or heard. |
| **Active** | Revealed in **one frame**, never half a building. Then their scripts start (Begin Play / OnStart), sounds and effects that play on start do, components get OnPlay, and the world around them is rebuilt off the frame: the AI's walkable grid and cover a few milliseconds a frame (the old one serves until the swap), the sound lattice on a worker thread. |

And out again: hidden in one frame, sounds faded, effects stopped, components stopped, objects destroyed a few hundred a frame (scripts get End Play), then whatever only that layer used released from memory.

A layer's own **sun and weather stay behind**: the world has one sky.

## What a level designer places (`Engine/Runtime/StreamingComponents.h`)

- **Streaming Volume**: a box. As the player comes within *Load Margin* of it, its scenes load; once the player is beyond *Load Margin + Unload Margin*, they go (the gap stops a player pacing at an edge from loading and unloading the same thing over and over). *Preload Only* keeps them ready but hidden. The editor draws volumes in the viewport (teal; the load margin faintly when selected).
- **Stream Gate**: on an object with a Box Collider across the narrowest point of a passage. The collider is **solid while anything it lists is not yet in the world**, and becomes a trigger (passable) the moment all of it is. On a fast machine the player never knows it was shut; on a slow one they wait at a wall instead of walking into an empty world. *Load On Start* asks for its scenes when the game starts.

The streaming source is the player (an object with a Player Controller or the Player tag), else the live camera.

## From scripts

C# (`ScriptCore/Generated/EngineAPI.g.cs`) and the node palette (under *Scene*):

```csharp
Streaming.Load("Canyon");          // in, and shown when it is all here
Streaming.Preload("Canyon");       // in, kept ready, not shown
Streaming.Unload("Canyon");
bool shown  = Streaming.IsActive("Canyon");
bool loaded = Streaming.IsLoaded("Canyon");   // ready or showing
float p     = Streaming.Progress("Canyon");   // 0..1
string s    = Streaming.State("Canyon");      // unloaded, loading, ready, active, unloading
```

Graphs also get the **On Stream Layer** event (*Layer*, *State*: "active" or "unloaded") on every object. A layer a script loads is held until the script unloads it, whatever the volumes say. Names are resolved like Load Scene: "Canyon", "Assets/Scenes/Canyon" and the full path are the same layer.

## Measured (Samples/StreamingDemo, Intel UHD 620)

`FZEStreamingDemo <dir>` builds the sample: a world with a yard and a 44 m tunnel through a cliff, a volume round the tunnel, a gate in its middle, and a 407-object canyon town as the layer.

- Read on a worker: 52-105 ms (off the frame).
- Brought in over 3 frames, at most 1.0-1.2 ms each; revealed in 0.5-1.2 ms.
- World rebuild started in 2-3.5 ms on the frame; the AI grid rebuilt at about 3 ms a frame; the sound lattice (227 ms) entirely on a worker.
- Walking away: unloaded in one step, gate shut, the walkable grid back to exactly its original 235,221 cells.

The first version rebuilt the AI grid, cover and sound lattice in one go: a 728 ms frame, the very freeze the system exists to remove. That is why those three are now spread out or moved off the frame.

## Fixed on the way

Opening a gate (a static collider becoming a trigger) crashed Jolt: the backend runs a static sensor as kinematic, and a static body is made without the motion state that needs. Any static collider whose *Is Trigger* changed during play would have done it. A static body that must change its motion or its sensor flag is now made again (`ScenePhysics::Sync`), and the backend refuses such a change instead of writing into memory the body does not have.

## Tested

`FZEStreamingTest`: nothing is asked for far away; the gate is solid; the layer becomes active; every object arrives, roofs under their own houses even though the file lists them first; ids unique; dormant until all of it is there; the layer's sun stays out; the gate opens on the frame of the reveal; a script asking by either name sees it active; walking away unloads it all and shuts the gate; a script's Load holds it and its Unload takes it out.
