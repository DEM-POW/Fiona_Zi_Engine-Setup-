# Terrain

Select a terrain object; its Inspector has five tabs.

## Sculpt

| Tool | What it does |
|---|---|
| Raise / Lower | Lifts or digs under the brush (Shift does the opposite). |
| Smooth | Softens bumps, ridges and steps. |
| Flatten | Levels to the height the stroke began on. |
| Height | Pulls to an exact height. **Ctrl+click** the ground to take its height. |
| Noise | Adds natural bumps (scale and seed). |
| Terrace | Cuts slopes into steps (step height). |
| Erode | Lets slopes steeper than the ground holds slide (sand ~30°, soil ~38°, rock 60°+). |

Brush: **Radius**, **Strength**, **Falloff**. In the viewport: `[` `]` change the
size, `Ctrl+[` `Ctrl+]` the strength.

## Paint

Click a layer swatch and paint. Each layer is a material (`.fzemat`) or a flat
colour, with its tiling. **Auto Paint** paints the whole terrain from its shape.

## Foliage

**Add Grass** / **Add Tree**, choose the model, then paint with the **Grass** or
**Trees** brush (Shift thins / removes). A new grass kind starts bare: paint it
on, or **Fill** to grow it everywhere its rules allow (layers, slope). Trees:
**Scatter** plants them in stands.

- **Cut Out Background** (grass, on by default): grass made of flat cards whose
  picture lost its transparency (an opaque export - an RGB PNG, an OPAQUE
  material) has its plain background cut out when it loads. The file is not
  changed; pictures with their own transparency are left alone.
- Grass whose blades are solid geometry (no cut-out cards) also thins out with
  distance, blade by blade.
- A model's `KHR_materials_specular` / `KHR_materials_ior` are honoured: a file
  that says "no specular" is not drawn as glossy plastic.
- **A tree in the wind** (`FZE_TreeLean`, `FZE_TreeBranches` in
  `Shaders/lib/Foliage.glsl`) moves as Crysis split it: the trunk leans with the
  wind and sways at about a third of a hertz on a 14 m pine (slower the taller),
  the branches bob as whole pieces on their own phase, and only the tips flutter,
  by a centimetre. Trees used to take the grass's wind: a 14 m pine leaned 2.8 m
  at 5 m/s, swayed 1.35 m three times a second, and its whole crown shook 30 cm.
  The cached sun shadow draws every tree at the wind's average lean, so its
  shadow does not jump when a level is redrawn. Rain weighs grass down, not trees.

## Water

**River** (click a course, Enter to finish) and **Pond** (click). Channels and
basins are cut into the ground and re-cut when it changes.

## Terrain

- **Shape:** size in metres, samples per side (129 ... 2049).
- **Generate:** Rolling Hills, Mountains (ridged), Island (with a sea at 0 m),
  Dunes (across a wind), Canyons (a plateau cut by channels, in strata). Seed,
  height, feature size, roughness, detail, warp; Auto Paint after. One undo step.
- **Erosion:** **Rain Erosion** runs droplets down the land (gullies, sediment
  fans, softened ridges), then the slopes settle; **Settle Slopes** only the
  slides.
- **Heightmap:** **Import** a 16-bit PNG, 8-bit PNG, `.r16`/`.raw` (16-bit
  little-endian, square) or `.r32` from World Machine, Gaea, Unreal, Unity...,
  stretched between the **Height Range**. **Export** writes a 16-bit PNG or
  `.r16` (and sets the range to the ground's). 16 bits keeps millimetre steps;
  8 bits terraces.
- **Flatten All.**

## Code

- `Engine/Terrain/Terrain.{h,cpp}` - the data, the brushes (`Terrain::Apply`).
- `Engine/Terrain/TerrainShaping.{h,cpp}` - generate, erode, heightmaps, noise.
- `Engine/Assets/HeightmapIO.{h,cpp}` - the files.
- `Engine/Editor/TerrainInspector.cpp` - the Inspector.
- Tests: `FZETerrainTest`, `FZETerrainShapingTest`, `FZEFoliageTest`.
- Probe steps: `--step "terrain-generate <kind 0-4> <seed> <height> [feature]"`,
  `"terrain-erode [droplets]"`, `"terrain-tab <0-4>"`, `"frame <pitch rad> <widths>"`,
  `"foliage-empty <kind>"`; `--terrain-tool height|noise|terrace|erode ...`.

## Simple drawing

Inspector: Terrain > Shape > Drawing. For a game whose ground fills the screen on a modest GPU.
`Shaders/TerrainSimple.frag` reads each layer once from straight above and lights it with the sun,
one shadow tap and the sky, without triplanar, detail maps, decals, rain or the full lighting
function. Measured on a UHD 620 at 360 lines: 106-125 ms became 7-9 ms. Heights, paint and physics
do not change. It is off by default.

**Mesh Coarseness** (`LodBias`) scales how much error the quadtree allows with distance. 1 keeps it within
about a pixel of a 720 line picture, and a low picture does not need that. Facing the heap on a UHD 620 at 360
lines: 14.3 ms at 1, 13.5 at 4, 12.1 at 16. It helps a little; what the ground really costs is per pixel, and
the largest part of that was the search for the sun's shadow level (`SunShadowTapAt` in `lib/Shadows.glsl`).
Trash Mountain, a game made for a dug heap (removed 2026-11-07, archived), used 2.

**Heap Layer** and **Heap Floor** make one layer show only above a height, so a heap is drawn where
its height really is, however it was painted. `TerrainDig` takes volume away exactly.

## What looking at the ground costs (2026-11-08)

Measured on the big Lab (UHD 620, 0.62 of 720 lines). ⚠️ The GPU timer called **Terrain** is every surface drawn on
the terrain (`Renderer.cpp`, `FZE_GPU_SCOPE("Terrain")` round every `SelfDrawnSurface::DrawLit`): the ground, the
grass, the trees, the water. The ground alone is Terrain less Foliage.

Leaving each part of the ground's shading out in turn (Simple Surfaces), from above: the detail textures, the side
projections, the rain and marks, the anisotropy (8, 4, 1) changed nothing; the light was the cost. The ground alone
was 16.7 ms, 4.6 without the lamps. **The lamps were 12 ms of it**: the light grid's depth slices ended at 300 m and
the last one ran to the horizon, so every screen tile's last cluster held every lamp of the city behind it (up to 64,
the rest dropped) and every far pixel looped over them. The grid is 32 x 18 tiles by 32 slices out to 2 km now
(`RendererData::Cluster*`): the ground alone 6.3 ms, the lit pass 50.8 to 31.4, the GPU 79 to 64. The same light:
against every lamp at every pixel (`FZE_NOCLUSTERS=1`) the street does not differ by a pixel, and from above the
differences (1,268 pixels) are the far windows that two identical runs already differ by, all but 22. A lamp's reach
is also read before the rest of it now (`FZE_LightAt`).

Under the full lighting (Simple Surfaces off) the ground alone is 12 ms on the hill and 3.7 unlit; the sun's
contact-hardening shadow is 2 of it (filter 2, 1, 0: 11.8, 10.0, 9.2 ms), the rest is what Simple Surfaces leaves out.

Grass and trees on it: in the field the grass is light (592 clumps near, 1,666 far); the cost was 522 pines between
1.5 and 5 heights at their middle level, 9,241 cut-out triangles each. With Far Trees as Pictures they are pictures
from **Pictures From** heights (`treepictures.from`, 3 by default): foliage 12.1 to 8.9 ms, the depth prepass 11.2
to 7.9, and a flight over the forest shows no new pops (docs/LAB.md, "Far trees").

## Heights that change while playing

`ScenePhysics::UpdateTerrain` sends a changed rectangle to Jolt's height field. Jolt stores the
grid in blocks of 2 samples, so the rectangle is widened to whole blocks, and its last row and
column cannot change: a grid of 2^n + 1 samples is one block wider than its data.

⚠️ Jolt's `SetHeights` was wrong for every grid of that size, and every terrain here is one: it
wrote the coarse levels of its hierarchy with the wrong stride, over ground nobody touched.
`tools/patches/jolt_heightfield.cmake` repairs `vendor/jolt` at configure time, and
`FZETerrainDigTest` checks the result with short rays. A long ray cannot see this bug: it enters
the box from above and reaches the ground anyway, so only something close to the surface finds
the hole, a character first of all.

**Shadow Follows Edits** (`EditShadowHold`, seconds) is for ground dug all day. Without it each edit
changes the terrain's revision, and every level of the sun's shadow is drawn again: seven levels
and 1500 draws, whoever is digging and wherever. With it an edit reaches only the levels it is in,
and each follows at its own pace, the hold doubling with each level out. Trash Mountain used 0.25 s.

`TerrainDig::Slump` is one moment of a slope settling: ground steeper than a limit moves to its lower
neighbours, a few centimetres at a time, and nothing is created or lost. `Terrain.DigSteep` leaves a
hole steeper than the limit, so its sides are seen to come down afterwards.

A scene can hold several terrains. `Scene::SampleGround` answers from the first one in the list
that contains the point, so a wide far terrain lying under a detailed one comes after it.
