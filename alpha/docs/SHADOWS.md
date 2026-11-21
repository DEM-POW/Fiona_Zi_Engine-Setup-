# Shadows

The sun's shadow was rebuilt from scratch on 2026-10-16 (Nabras: "rebuild the shadow system, organised, strong and stable, as the big engines do it").

## What the big engines do

- **Unreal 5 — Virtual Shadow Maps**: the directional light gets *clipmap* levels around the camera, each covering twice the distance of the last; the maps are split into pages that are **cached between frames** unless something inside them moves or the light moves. Soft edges come from SMRT (samples along a ray toward the light's disc), so a shadow is sharp where it touches and soft further away (contact hardening).
- **Unity's pipelines** filter shadow maps with a **tent** (5×5, 7×7): each texel weighted by the area of a 45° tent over it, read as bilinear comparisons placed between texel pairs — smooth, no noise, a fixed number of fetches.

## What this engine does

| Part | Where | What |
|---|---|---|
| Clipmap | `Engine/Renderer/Shadows/SunClipmap.{h,cpp}` | Levels around the camera, each twice the last (8 m, 16 m, 32 m ... radius). Turning the camera changes nothing; a level re-centres in whole-texel steps of a quarter of its radius, and keeps its centre until the camera is a whole step away (no flip-flopping at a rounding edge). The sun is taken in steps of 0.05°. |
| Caching | `SunClipmap::Due` | A level is drawn again only when it scrolled, the sun moved, or the casters **inside that level** changed (each level keeps its own signature). The two nearest always go; the rest wait in a budget (3 a frame), stalest first, and are sampled through the matrix they were drawn with. A still scene draws no shadows. A surface that draws itself says what each level sees of it (`RevisionInLevel`): the grass, grown round the camera, is drawn into and changes only the levels up to 16 m; the trees are all the terrain's casting trees, by each level's box, the full tree up to 32 m and the light one beyond. Before that the grass re-drew three levels on every frame of a walk, out to the 512 m one: 15 ms of GPU that a still camera never paid (docs/LAB.md). |
| Drawing | `Renderer.cpp`, the sun pass | 16-bit depth array (a level's depth range is four radii: half a millimetre at level 0). Depth clamp ("pancaking": casters above the box still cast) and slope-scaled polygon offset. Casters culled against each level's box with its sun side open. |
| Sampling | `Shaders/lib/Shadows.glsl` | The finest level a point is well inside; the next one blended in near a level's edge (no seams); a fade past the last. Normal-offset bias derived from the level's texel. |
| Filter | `FZE_TentShadow` | Unity's tent from 4 (sharp) or 16 (soft) bilinear comparisons. |
| Contact hardening | `FZE_SunLevelShadow` | A 12-tap fixed blocker search; the penumbra is the sun's angular size times the distance below the blocker. A penumbra wider than a level's tent is read from a coarser level, where the same tent covers more ground — softness without more samples or noise. |
| Everyone else | `DirectionalShadow`, `SunShadowTap` | Lit surfaces, characters, water, foliage, the fog's shafts and the bounce-light volume all read the same levels. |

Quality tiers (Governor): levels 4–7, 1024–2048 texels, filter 0 sharp / 1 soft / 2 soft with contact hardening. `FZE_SHADOWFILTER=0|1|2` overrides the filter to compare; `FZE_SHADOWDIAG=1` logs which levels each frame draws.

Tested by `FZESunShadowTest`: levels double and surround the camera; turning or moving under a step leaves every level bit-identical; a scroll moves a level by whole texels; pacing across a rounding edge places a level once; only the level whose casters changed is due; the budget; a level that waits keeps its matrix; small sun movements draw nothing, visible ones draw everything.

Next: per-object high-detail shadows for a hero character (Unreal's per-object/inset shadows), and a level debug view.
