# The Material Editor (node materials)

A material can be a graph of nodes. The graph is compiled to GLSL and built into
its own variant of the lit shader, so it is lit by the same sun, lamps, sky,
shadows, fog and shading models (Toon, Stylized...) as every other surface.

## Using it

- **Open:** double-click a `.fzemat` in the Content Browser (or right-click >
  *Open in Material Editor*). It opens in the main area beside the Viewport, like
  a Visual Script. *Tools > Material Editor* opens it empty, with **New Material**.
- **An ordinary material becomes a graph of itself** when opened: its colour,
  metal, roughness and colour map are wired in. It is a graph once saved.
- **Add nodes:** right-click or Space on the canvas, drag a wire into empty space
  (only nodes that fit the wire are offered), or drag from the palette on the
  right. Drop a picture from the Content Browser on the canvas and it becomes a
  Texture Sample of itself.
- **Edit on the node:** numbers beside unwired pins, colour swatches (click for a
  wheel picker), texture thumbnails (drop a texture on them), channel buttons,
  blend modes. The Details column (left) shows the same for the selected node,
  and the material's own settings (shading model, two-sided, emission, mask
  cutoff) when nothing is selected.
- **Live:** dragging a number changes values only - nothing recompiles. Rewiring
  builds a program after a short settle; a wiring built once is cached (in
  memory and on disk), so undo is instant. Every object wearing the asset changes
  with the preview. **Save** (Ctrl+S) writes the file; **Revert** puts the saved
  graph back, in the scene too.
- **Status row** under the graph: cost, value count, textures used (8 max). Click
  it for Problems (click one to jump to its node), Stats and the Generated GLSL.

## The nodes (66)

| Category | Nodes |
|---|---|
| Output | Material Output (Base Color, Metallic, Roughness, Normal, Ambient Occlusion, Emissive, Opacity, Opacity Mask, Reflectance) |
| Inputs | Texture Coordinate, World Position, World Normal, View Direction, Reflection Vector, Time, Fresnel, Screen Position, Camera Distance |
| Constants | Scalar, Vector 2, Vector 3, Color |
| Textures | Texture Sample, Normal Map, Triplanar Sample |
| Math | Add, Subtract, Multiply, Divide, Min, Max, Power, Lerp, Clamp, Saturate, One Minus, Negate, Abs, Floor, Ceil, Frac, Square Root, Round, Sign, Exp, Sine, Cosine, Modulo, Arctangent 2, If, Step, Smooth Step, Remap, Posterize |
| Vector | Dot, Cross, Normalize, Length, Distance, Split, Combine, Component Mask, Append |
| UV | Panner, Rotator, Polar Coordinates |
| Procedural | Gradient Noise, Fractal Noise, Voronoi, Checker |
| Color | Desaturate, Hue Shift, Brightness / Contrast, Blend (Overlay, Screen, Multiply, Add, Soft Light, Difference) |

Wires carry 1-4 numbers. A float fills a vector; a wider value is cut to fit; a
pin marked "anything" (Add, Lerp...) becomes as wide as what arrives.

## How it works

- `Engine/Materials/MaterialGraph.{h,cpp}` - the node library and the compiler.
  Each node writes a few lines of GLSL; the graph is walked from the Output in
  dependency order into one function, `FZE_Graph()`. Every number a person can
  drag lives in `u_GraphValues[]` (exactly as many as the graph uses), never in
  the code.
- `Engine/Materials/MaterialPrograms.{h,cpp}` - one shared `MaterialProgram` per
  asset (`Renderer/MaterialProgram.h`), updated in place; programs cached by
  their code. Installed at boot as the renderer's resolver.
- `Shaders/Lit.frag` - built with `FZE_GRAPH` defined, the
  `// @FZE_GRAPH_FUNCTION` line is replaced by the generated code and the graph
  decides the surface; everything after the surface is shared.
- Renderer: a draw whose material has a built program is shaded by it
  (`UseLitProgram`); the Output's shading model, two-sided and emission come from
  the program, not the entity's copy. A graph that drives Opacity is drawn with
  the glass; one with an Opacity Mask writes its own depth in the lit pass.
- `.fzemat` keeps the graph in a `"graph"` block beside the ordinary fields
  (which are written from the Output node, so older readers see the same
  surface). Saving a material's ordinary fields keeps the block.
- Scenes store `graphAsset` in a mesh renderer's material.

## Limits (today)

- Skinned meshes and the terrain draw node materials with the standard surface.
- An Opacity Mask cuts the surface but not its shadow.
- Building a new wiring takes about a second on an Intel UHD 620 (the whole lit
  shader is compiled); after that it is cached.

Tested by `FZEMaterialGraphTest` (every node compiles; a graph of all of them
builds on the GPU; values vs code; refusals; the asset round trip; in-place
updates and the program cache).
