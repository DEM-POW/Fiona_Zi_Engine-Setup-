# Looks: a game's visual identity

The same engine runs games that look nothing alike. What makes Fortnite, Genshin
Impact, Minecraft with shaders, Elden Ring or a racing replay unmistakable is
drawn on top of the lighting maths. In FZE that is three layers.

## 1. Shading models (per material)

Material Inspector ▸ **Shading ▸ Model**:

| Model | What it draws | Settings |
|---|---|---|
| Standard | Physically based (metallic-roughness). Follows the scene's look. | — |
| Toon | Cel shading: light in flat bands with hard edges, the shade a *colour* rather than darkness, a hard highlight, a rim of light. Cast shadows are the same shade colour. | Bands (1–4), Edge Softness, Shade Colour, Highlight, Rim Light |
| Stylized | Painterly: light wraps round the form, the terminator is soft, colour stays rich in the shade. The highlight is the standard one. | Wrap, Shade Colour, Rim Light |
| Unlit | Its colour (and emission) whatever the light. | — |

Saved in the scene and in `.fzemat` as a `shading` block. A Standard material
writes nothing, so old files are unchanged.

## 2. The scene's look (Environment ▸ Look)

**Scene shading** draws every surface whose material says *Standard* (meshes,
terrain, grass, imported characters) as Toon or Stylized. A material that names
its own model keeps it.

**Ink**: an outline round every silhouette and along every fold, computed from
depth and drawn on the finished picture (the same pen width near and far). Folds
come from the second difference of 1/z, which is exactly zero on any flat face, so
floors seen at a slant don't get false lines.

**Picture**: Colour Levels (posterize) and Pixel Size (big pixels). For a voxel or
pixel-art game, also give its textures **Filter: Point** in their import settings.

## 3. Presets and `.fzelook`

The gallery's cards apply a preset from neutral (presets never pile up):

Realistic · Stylized · Anime · Comic · Voxel · Dark Fantasy · Sci-Fi · Cinematic · Retro

Each writes the grade, bloom, occlusion and the look block. **Save look as…**
writes a `.fzelook` (the same fields as JSON) that every scene of a game can load.
The palette has every preset as a command too: Ctrl+P ▸ `Look: Anime`.

Code: `Engine/Renderer/Look.h` (presets, JSON), `Shaders/lib/Material.glsl`
(`FZE_ShadeToon`, `FZE_ShadeStylized`, `FZE_ShadeLight`), `Shaders/lib/Lighting.glsl`
(scene shading), `Shaders/Composite.frag` (ink, posterize, pixelate).
Test: `FZEStyleTest`, which also compiles every shader the styles touch on the GPU.
