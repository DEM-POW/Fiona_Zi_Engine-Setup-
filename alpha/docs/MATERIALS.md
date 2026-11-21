# Materials

The material system, extended rather than replaced, in two stages:

- **Stage 1** (2026-10-17, `e0b8f520`): placement in metres, relief, detail, cover and recipes.
- **Stage 2** (2026-10-24): realistic recipes, instances, one-file packages, the editor, real geometry, and the test in the Animation Lab.

The request was Nabras's *FZE Advanced Material Detail System* spec. It came with photographs of the target surfaces: a weathered brick wall, sand ripples, cracked limestone, pebbly soil and granite. The aim was materials that look three-dimensional on walls and floors, not a colour on a flat face.

## What a material is

A `.fzemat` (JSON) holds:

- **Maps:** albedo, normal, roughness, metallic, packed metal/rough, ambient occlusion, height, opacity, emissive, detail albedo and normal, cover albedo and normal. Every map is optional; a missing one uses the plain values.
- **Placement** (`MaterialDetail`, `Renderer/MaterialDetail.h`): mesh UVs, a world projection, or triplanar, sized in metres. The same tile size looks the same on any mesh.
- **Depth:**
  - normal map;
  - parallax occlusion with its steps, fade and self-shadow;
  - **real geometry** at Ultra (below).
- **Detail and breakup:** detail maps up close, colour variation, and a second turned copy so the repeat does not line up.
- **Layers:** a cover layer (snow, dust, moss) by slope, noise and height.
- **The recipe** it was made from, when it is procedural.

## Procedural materials (`Materials/ProceduralMaterial.h`)

A pattern and a handful of numbers, turned into the ordinary maps: albedo, normal, roughness, height and AO.

| Property | How |
|---|---|
| Patterns | Brick, Rock, Soil, Sand, Concrete, Snow, Wood, Asphalt, Tiles |
| Deterministic | Integer hashing; the same seed gives the same pixels on any machine |
| Tileable | Every noise wraps at the tile edge |
| Cached | By the recipe's hash; a second bake reuses the maps |
| Runtime cost | None: there is no procedural shader |

Twelve presets carry the spec's names: Brick Clean, Weathered and Damaged; Rock Rough; Sand Fine; Soil Dry and Wet; Concrete Cracked; Snow Fresh; Asphalt Worn; Wood Planks; Tiles Ceramic.

**Made against the photographs (stage 2).** Stage 1's brick was a ruled grid of flat red blocks on thin dark lines; the reference wall is not. The generator now uses:

- **Gradient noise** (Perlin) instead of value noise, which lined every mound up on a grid.
- **Domain warp**, so cracks wander and ripples fork.
- **Ridged multifractal** for weathered stone.
- **Voronoi with exact border distance** (Quilez), for cracks of an even width.
- **Brick:**
  - broken arrises and chips;
  - rounded corners;
  - tilted, pitted and spalled faces, with pale clay inside the breaks;
  - overfired odd bricks and lime bloom;
  - wide joints set well back in gritty mortar.
- **Rock:** a fracture network that opens unevenly, plates at different levels, iron stains, and a crystal speckle.
- **Sand:** asymmetric wind ripples with pale crests, coarse dark grains in the troughs, and a colour per grain.
- **Soil and asphalt:** stones of several kinds and sizes, sitting proud of the dirt or the binder.
- **A cavity pass:**
  - dirt in hollows, edges rubbed paler;
  - the occlusion map taken from the relief;
  - joints left pale, because mortar is set back, not filled with grime.

## Material Instances

Right-click a `.fzemat` and choose **Create Material Instance**, or use **Create Instance** in its Inspector.

- An instance's file holds only what differs from its parent: a merge patch, as Unreal's Material Instance and Unity's material variant do.
- Change the parent and every instance follows wherever it did not override.
- An instance can clear one of the parent's maps.
- An instance whose parent is missing still loads: its overrides on the defaults, with a warning.

## One file: the package

Use **Export Package** in the Inspector, or **Export as Package (.zip)** in the Content Browser.

- The `.zip` holds the material, every map it uses and its recipe, like the Ground Material Pack.
- An instance is flattened: its parent's values are written in.
- **Import Material** (Content Browser toolbar or right-click) brings it back whole, with every setting. The maps are re-registered in the receiving project.
- The same button imports a texture set's zip, a folder of maps, or one image of a set, as before.

Every `.fzemat` also writes its maps as file names beside it (`"files"`). A material copied from another project finds its maps by name when their ids mean nothing there.

## Real geometry (`Materials/Displacement.h`)

The spec's *Real Geometric Displacement*.

**What it does.** At Material Quality **Ultra**, a material with **Real Geometry** on is drawn on a copy of its mesh. The copy is divided every few centimetres and moved by the height map. The vertices are real, so the silhouette, the depth buffer and every shadow map contain the relief.

**Why not hardware tessellation.** Every pass that draws a mesh would need a tessellation variant: the depth prepass, three shadow kinds, the lit pass and picking. A mesh made once and cached costs only its triangles.

**How it stays in place:**

- The height is read exactly where the shader reads it: mesh UVs, world or triplanar, in metres, mirrored on negative faces. The raised geometry lines up with the texture.
- It pushes inward from the surface (white is the original surface, as parallax treats it).
- It fades to nothing at hard edges, so a box's faces do not part.
- Smoothly joined triangles share one division count, so no T-crack opens.

**Cost and limits:**

- One entry per object, rebuilt only once a change has held for twelve frames, so a gizmo or slider drag does not rebuild every frame.
- Applies to blockout shapes. An imported model keeps parallax.
- Measured: the lab's 3 m brick wall becomes 235 000 triangles in 130–150 ms, once. The gallery view costs 1.9 ms more GPU than at High.
- Below Ultra the same material is drawn with parallax.

`FZE_MATERIAL_QUALITY=0..3` forces the level for a test without touching a project's settings.

## The editor

**A material asset's Inspector** (select a `.fzemat` in the Content Browser):

- **Preview.** Drag to turn it, scroll to zoom. Shape: sphere, cube, plane or cylinder. View: Lit, Base Color, Normal, Roughness, Metallic, Height or Ambient Occlusion, showing what the surface really has after mapping (`u_MaterialView`). Light direction and background are adjustable.
- **Create Instance** and **Export Package**.
- **Procedural Controls** (when made from a recipe):
  - a preset to start from, pattern, seed, resolution, tile size and relief;
  - three colours, roughness, and the pattern's own numbers under the names it gives them.
  - The maps are remade when a control is let go, cached, and the texture caches are told the pixels changed.
  - **Make it procedural** turns an image-based material into a recipe.
- **Every section:** Surface, Texture Maps, UV Controls, Surface Depth (including Real Geometry, and which technique really draws it), Detail, Breakup, Material Layers, Performance, Clear Coat, Anisotropy and Emission.
- **Auto-saved** at the end of each gesture.
- **Linked objects follow.** Every object linked to the asset or its instances takes the new values at once. Opening a scene also refreshes linked objects from their assets.

**The Content Browser:**

- right-click a folder: **New Material from Preset** (all twelve) and **Import Material**;
- right-click a `.fzemat`: **Create Material Instance** and **Export as Package (.zip)**;
- material thumbnails now show their colour map (they were white).

## The test: the Animation Lab

`tools/animation_lab.cpp` bakes the presets into `Assets/Materials/Lab/` and builds a gallery along the west of the ground, at x −27 and z −15 to −40. Each bay is a wall of one material with a floor of another in front:

| Wall | Floor |
|---|---|
| Brick, weathered | Soil, dry |
| Brick, weathered, **maps only** (an instance: no height, AO or relief; the spec's basic-vs-enhanced comparison) | Sand |
| Brick, damaged | Asphalt, worn |
| Brick, clean | Concrete, cracked |
| Concrete, cracked | Rock |
| Rock | Snow, fresh |
| Tiles, ceramic | Wood planks |
| Brick, soot (an **instance**, darker, everything else inherited) | Soil, wet |

There is also a boulder (triplanar on a curved surface). The workshop is in weathered brick; the cover wall and jump block are in concrete. Weathered brick, damaged brick and rock ask for real geometry.

## Tests

| Test | What it checks |
|---|---|
| `FZEProceduralMaterialTest` | Every preset generates deterministically, tiles, has valid normals, and the recipe round-trips and caches |
| `FZEMaterialSystemTest` | Old materials load to their defaults. Instances save as differences, follow their parent, and keep their own values. A missing parent and an unknown map id are handled. Packages round-trip every setting. Presets are made, cached and remade. Displacement moves only inward, keeps a box's corners, sinks joints by the relief depth, repeats with the tile, and is Ultra-only |

## Still to do

- **More layers.** One cover layer at run time; the brick recipe bakes its own base, mortar, variation and wear. Arbitrary stacks of runtime layers are not here: the spec asks for a practical number, and baking.
- **Displacement on models.** Imported models keep parallax.
- **Breakup.** With Breakup above 0, the displaced geometry follows the main copy of the height only.
