# Rendering Features

Every rendering technique in the engine is the game developer's choice. None of
them is a worker that has to run because the engine started: each has its own
switch and its own settings, in one place, and a technique that is off does not
run. A fast shooter, a stylised puzzle game and a slow walk through a town do not
want the same frame.

## Where to set them

**Project Settings > Engine > Rendering Features.** One row per technique, grouped,
with its own settings indented under it. Hover a row for what it does, when a game
wants it off, and its cost. Press Save: the choice is written to
`Config/settings.json`, which the editor and the shipped game both read.

**From the game's code, while it runs** (a graphics menu, a cutscene, one heavy
level). C# and the node editor are the same functions, under Rendering:

```csharp
Rendering.SetFeature("ssr", false);            // off for now
if (Rendering.IsFeatureOn("bloom")) { ... }
Rendering.SetFeatureValue("dither.levels", 1.0f);
Rendering.ResetFeature("ssr");                 // back to the project's choice
Rendering.ResetAllFeatures();
```

What code sets is never saved, and ends when Play stops. A wrong name logs the list
of right ones.

**For one scene:** the Environment window can still refuse what the project allows
(this level has no bloom).

**For a measurement:** `--step "feature ssr 0"`, `--step "feature dither.levels 1"`.

## The order

1. The project: may this game use it at all.
2. The game's code, while it runs.
3. The scene: it can only refuse.

A technique with a parent needs the parent on: with Screen-Space Reflections off,
Reflection Hold does not run, keeps its choice, and says so on the page.

## What starts on

What the engine already drew with stays on, so an existing scene does not change.
What is new, and what changes the picture by itself while the game runs, starts off
and is switched on by whoever wants it: Dynamic Resolution, Adaptive Quality.

| Group | Id | Technique | Starts |
|---|---|---|---|
| Edges and Detail | `fxaa` | FXAA | on |
| | `dither` | Banding Dither | on |
| Light in the Corners | `ao` | Ambient Occlusion | on |
| | `contact` | Contact Shadows | on |
| | `skyocc` | Sky Light Occlusion | on |
| | `bounce` | Bounce Light | on (each scene decides) |
| Reflections | `ssr` | Screen-Space Reflections | on |
| | `reflhold` | Reflection Hold (needs `ssr`) | on |
| The Lens | `localexp` | Local Exposure | on |
| | `bloom` | Bloom | on |
| | `dof` | Depth of Field | on (cameras ask for it) |
| | `shafts` | Sun Shafts | on |
| | `volumetric` | Volumetric Light | on |
| Changes the Picture by Itself | `dynres` | Dynamic Resolution | off |
| | `adaptive` | Adaptive Quality | off |
| A Whole Look | `retro` | Retro Console Look | off |
| | `simplelit` | Simple Surfaces | off |
| | `smallcull` | Small Things Far Away | off |
| | `occlusion` | Hidden Behind Solids | off |
| | `farcells` | Far Blocks as Batches | off |
| | `treepictures` | Far Trees as Pictures | off |
| | `treefade` | Trees Change Detail Softly | off |
| | `softfoliage` | Soft Foliage Far Away | off (the Lab turns it on) |
| | `lodfade` | LOD Changes Softly | off |
| | `grassground` | Ground Under Grass | off (the Lab and DREVAR turn it on) |

Values: `dither.levels`, `reflhold.frame`, `retro.lines`, `retro.colours`, `retro.snap`, `retro.affine`, `smallcull.pixels`.

## What off does

The pass does not run. The large targets that exist only for it (the reflections)
are released, and come back when it is switched on. AO's
small targets and the bounce light's voxel texture, made once with the renderer,
stay.

## Retro Console Look

A whole look, off by default, for a game that wants a 1990s console and nothing else. The scene really is drawn small (240 lines by default), which makes it light on the GPU rather than a filter over a full frame. It adds hard pixels when stretched, 15-bit colour with an ordered dither, vertices snapped to whole pixels, and textures that bend because they are not corrected for depth. Dynamic Resolution stands down while it is on: the look decides the picture's size.

Textures finish it: import them with Point filter and no mips. Texture swim needs small polygons, so build walls and floors from panels of a few metres. docs/SCRAP-SHIFT.md is a whole game made this way.

## Dynamic Resolution

Finds the size of picture this computer can draw a level at, and holds it. Off by
default; a game shipped to machines it was not tuned on wants it.

A change of size is seen all over the picture at once: with the camera still, one step
moved the fine detail of the whole picture 8 to 11% in a single frame, and 23% going
back up, and redrew every edge and the clouds. So the size is an answer for the level,
not for the frame:

- A level this computer has played starts at the size it was left at, and the player
  sees no change at all.
- A level it has not starts small, is measured once past the load's hitches, and goes
  in one step to the size that fits. A frame the CPU holds up does not count against
  the picture: fewer pixels would not help it.
- After that it holds. Only five seconds of a frame 20% over budget, the GPU's doing,
  lowers it, by one step, and the step is remembered.
- It never rises during play. Room that lasted twenty seconds is kept for the next run.

The sizes are this computer's, in `user.cfg`, one line for each level, and are never
written into the project. Deleting the line measures that level again.

## Adding a technique

One row in `kFeatureTable` (`Engine/Core/RenderFeatures.cpp`), one name in the enum,
and `RenderFeatures::On(...)` at the point of the pass. The page, C#, the nodes, the
saved file and the Player's load all come from that row. A technique that is new
starts off.

## Removed

Temporal Anti-Aliasing, and with it Thin Geometry Memory, Motion Vectors and Sharpen
After TAA, were removed on 2026-11-06 by the owner's decision: this engine aims at
mid-range games, and an image averaged over frames smeared what moved. Edges are FXAA's
now. Commit `12287f80` holds the last version with them.
