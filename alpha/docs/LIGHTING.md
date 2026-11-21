# Lighting 3.0

Two kinds of light, never confused, and a camera that only moves when you move it.

## The Sun (`Sun` component)

One per scene. It lights the ground, the sky, the clouds and the haze, draws its
disc, and casts the cascaded shadows. **Create ▸ Sun** makes it, or selects it if
the scene already has one. Everything about it is in its Inspector:

| Section | What it holds |
|---|---|
| Position in the Sky | **By rotation** (turn it with the rotate tool, or the Elevation / Azimuth sliders) or **By time of day** (hour, date, latitude, longitude, UTC offset, north, clock speed in Play). The *Moment* buttons (Dawn … Night) work in both. |
| Light | Illuminance in lux (the real sun ≈ 120,000 above the air), temperature (5800 K) and a colour filter. |
| In the Sky | Show disc, angular size (0.53° is the real sun). |
| Shadows & Air | Cast shadows, light shafts (need humidity on the Weather object). |

If two objects carry a Sun, the first enabled one lights the scene and the other
lights nothing. Its Inspector says so by name, and the Environment window warns.

## Lights (`Light` component)

A lamp, either **Point** or **Spot**. It is never the sun. **Create ▸ Light ▸ Point / Spot**.
Power is in lumens (a 60 W bulb is 800 lm), colour is a temperature times a filter,
and it has a range, a source radius, cone angles (spot), shadows and a volumetric amount.

There is no Directional light any more. It was the second way to make a sun, and
the source of two lights both claiming the sky.

## The camera's exposure

Manual only: **EV100** (sunny day 15, overcast 12, a lit interior 7, a street at
night 3) plus **compensation** in stops, plus a cinematic camera's own offset.
Nothing adapts by itself, so what the editor shows is what the game shows.

- **Expose for the light** (Environment ▸ Camera) reads the sun and sky on a white
  card once, as an incident light meter would, and sets EV100. It is a button,
  not a mode.
- In scripts: `Camera.SetExposure(ev)`, `Camera.Exposure()`, `Camera.ExposeForLight()`.
  A day that runs into night sets its exposure from a script or a sequence.

## The Environment window

Opened by the sun button on the viewport toolbar, **Window ▸ Environment**, or
Ctrl+P (each page is also its own command: "exposure" lands on Camera). It is a
window of its own, not docked, with pages: Sun & Lights · Sky · Fog · Weather &
Wind · Ambient Light · Camera · Color Grading · Effects · Renderer.

It holds what belongs to the scene as a whole. The Sun's settings are on the Sun
and a lamp's settings are on the lamp; the *Sun & Lights* page shows which object
is the sun and lists the lamps, and a click selects them.

## Old scenes

Converted when they load. Nothing has to be done by hand:

- A directional Light that was the sun (Atmosphere Sun on) becomes the **Sun**,
  keeping its lux, colour, disc, size, shadows and shafts. A Time of Day on the
  same object becomes the Sun's clock.
- Any other directional light (a moon, a fill) loses its light component, and the
  log names it. The object stays.
- The oldest `Sun` objects and environment-block suns load as the Sun at the
  brightness they were drawn with.
- A scene saved with **Auto** exposure takes the EV the light reads over its first
  frames (the exposure it was being edited at), logs it, and is manual from then on.
  Saving keeps that EV.

## Realism: what the big engines do, and where it is here

Built 2026-10-23 and 24. The request was to improve the lighting that exists, not
to replace it: take the techniques Unreal, Unity and the published research use,
in their architecture, and test them in the Animation Lab. The lab has a hall for
it (x 16..26, z 2..10): windows, a skylight, a polished floor, rows of gold and
plastic spheres, a lamp, a neon sign, and a puddle outside the door.

| What | Where the idea comes from | Here |
|---|---|---|
| The sky's multiple scattering | Hillaire 2020, *A Scalable and Production Ready Sky and Atmosphere* (Unreal's Sky Atmosphere) | `Shaders/AtmoMultiScatter.frag` |
| The ground below the horizon, lit by the sky | the same paper's ground term | `SkyAtmosphere::SetGroundLight`, `FZE_GroundSeen` |
| The sky light only lights what can see it | Unreal's Distance Field AO / Lumen sky occlusion, Unity's Adaptive Probe Volumes sky occlusion | `Renderer/SkyVisibility` |
| Thin walls stay walls at every distance | NVIDIA's voxel cone tracing (Crassin 2011), directional mips | `Shaders/SkyOccupancyMip.comp` |
| Probes do not leak through walls | Unity APV: validity and normal-side weighting | `FZE_SkyVisSH` in `lib/Lighting.glsl` |
| Reflections of everything glossy | Unity HDRP's forward path: normal + roughness target, SSR, reflection hierarchy | `Framebuffer(surfaceInfo)`, `SSR.frag`, `SSRFilter.frag` |
| Wet surfaces reflect the sky | Filament's clear-coat IBL | `FZE_LightSurface` |
| A dark room and a bright window both readable | Unreal 5's local exposure (bilateral) | `LocalExposure.frag`, `Composite.frag` |

### The sky and the ground

The multiple-scattering table multiplied by 4π where Hillaire's reference divides
by the sample count. The sky's light on the ground came out at 35% of the sun's
share; the reference puts it near 10% (9.7% measured after the fix). The aerosol
absorption is the paper's 0.444e-3 per km.

Below the horizon the sky view already held the sunlit ground. What it lacked
was the same ground lit by the sky, which is now added, so the lower half of the
reflection is no longer black.

### Sky light occlusion (`Renderer/SkyVisibility.h`)

1. **Occupancy.** The scene's opaque meshes are voxelised round the camera:
   128 × 48 × 128 cells of 37.5 cm.
2. **Directional mips.** Three chains, the cover seen along x, y and z. A plain
   average turned a 40 cm wall into a quarter of a wall at the width a cone reads
   it. A closed room then saw 23% of the sky through its own walls; now it sees
   3%.
3. **Probes.** 64 × 24 × 64 probes, 75 cm apart. Each marches 24 cones up the
   hemisphere and keeps what it saw as L1 spherical harmonics.
4. **Shading.** Each pixel reads the eight probes round it by hand. A probe
   inside a solid, or behind the surface, counts for almost nothing, so the
   street's sky does not leak into the room's corner.

The grid is rebuilt when the scene changes (at most twice a second) or the
camera moves away, a quarter of the probes per frame.

`FZESkyVisibilityTest` measures it on the GPU against hand-worked numbers:

| Case | Measured |
|---|---|
| Open sky, no solids | 0.999 |
| Floor inside a closed room | 0.029 |
| Under a 2 × 2 m skylight 4 m up | 0.062 (0.07 by hand) |
| Ground 4.6 m from a 4.4 m wall | 0.77 (0.9 by hand) |

The last row is the method's known cost: a wide cone grazing a wall's edge is
partly blocked by a wall it never reaches. The same width lets a closed room's
corner see 8% of the sky.

⚠️ **The standard program never had it.** It is set up inline in the lit pass,
not by `BindLitPass`. Terrain, foliage, characters and node materials had sky
occlusion, but every ordinary mesh was lit by the open sky. Both are bound
there now.

### Screen-space reflections for every glossy surface

The main view's framebuffer carries a second target. While the lit pass draws
opaque surfaces it writes the octahedral normal, the roughness and a flag
(`o_SurfaceInfo`).

The post pass then:

1. traces one mirror ray per pixel at half size;
2. widens it by roughness, without crossing edges of depth or normal;
3. hands it back to the renderer.

The next frame's lit pass reprojects it to the same point. It takes the
reflection's place where the trace found something; the probe or the sky fills
the rest. This is the hierarchy of Unreal's and Unity's reflection environment.

- **Each lobe takes it by its own roughness.** A wet film mirrors the street
  while the rough stone under it stays matt.
- **A ray that leaves through a window returns the sky on screen** (HDRP's
  Reflect Sky).
- **A hit must be a crossing:** the sample before was in front of the surface.
  Without that, a ray out through a window, risen behind the wall above it, came
  back as that wall, and a window in a polished floor was its dark frame.

Views without the target (a picture-in-picture, a preview) keep the old
wet-ground pass.

### Wet surfaces and clear coat

The coat (rain, varnish, car paint) had a sun highlight and no reflection. The
sky's reflection came only from the rough layer under it, so a puddle under the
open sky showed no sky. The film now reflects at its own roughness. Everything
beneath is seen through what the film lets pass, as in Filament.

### Local exposure

The picture's brightness is split into a base (smoothed at an eighth of the
size, without crossing edges of more than about an EV) and the detail on it. The
base's distance from mid-grey is shortened (highlights 0.85, shadows 0.65) and
the detail is put back. It never moves on its own.

**Environment ▸ Camera:** Local Exposure, Highlight Contrast, Shadow Contrast,
Detail Strength.

The eighth-size base is not stretched back blindly: each pixel weighs the four
base texels round it by how close their brightness is to its own (Unreal's
bilateral grid, sliced by the pixel), so a wall beside a bright window keeps the
wall's base instead of a dark band eight pixels wide that crawled with the camera.

### Stability: what moved when nothing should (2026-10-31)

Nabras saw ripples and "conflicting" light in the Lab, worst while walking. Frame
bursts (`--fixed-dt 16.6667 --shot-display --look-at-move ...`, change between
frames measured over the whole picture, each feature switched off in turn) found
three causes; Local Exposure, which he suspected, was the smallest.

| Cause | Measured before | Fix |
|---|---|---|
| **The bounce volume** (Voxel GI) followed the camera exactly, rebuilt three times a second. Its cells are 82 cm, the Lab's walls 15 - 30 cm: a few centimetres walked moved a wall into the next cell | the only jumps in every moving burst (up to 2.7 x the normal change; 13,039 pixels over 3 levels in one frame); none with GI off | the box moves in whole cells and only when the camera is an eighth of it from its centre (`VoxelizeScene`); the bounce fades over its last two cells (`Bounce.frag`) |
| **8-bit banding.** A lit wall spans two or three levels of 255; sky occlusion, bounce and local exposure are all smooth gradients, drawn as flat rings up to 183 px wide that slid when the light shifted | longest flat run on the hall wall 183 px | a fixed triangular dither of one level before the screen's 8 bits (`Composite.frag`, Unreal's Grain Quantization): 26 px |
| **The sky-visibility grid** moved (12 m from its centre) and was taken in one frame | - | the probes both grids cover ease across over 0.6 s, as a rebuild in place does (`SkyVisibilityBlend.comp`, `u_FromOffset`) |

After: the moving burst's biggest change 1.22 -> 0.60 (lower than with GI off,
0.65), the slow drift 0.44 -> 0.20, no jumps; walking in Play, none with GI on or
off. A still camera was steady before and after (0.15 of a level).

**Then the light that went off and on (2026-11-01).** Walking in Play, single
faces - the Lab's cover wall, the 80 cm jump block, the end of a corridor wall -
switched between two brightnesses from one frame to the next, about 5 levels
apart. Bursts at the REAL frame rate (fixed timing hid most of it), one feature
off at a time: only ambient occlusion stopped it - not temporal AA, dynamic
resolution, instancing, contact shadows, parallax or the AI standing there. A dump
of the AO pass showed its output on the wall alternating (157 and 218 of 255) over
a depth identical to six decimals, and GTAO replayed in Python on that depth
reproduced the shader exactly and named the line: `n`, the normal's angle in the
slice, took its sign from the slice direction instead of that direction squared
to the view ray (Jimenez et al. 2016). This camera is 121 degrees across; at the
sides of the picture the slice direction runs half along the ray, a step of the
camera flipped the sign, and the occlusion of a whole face jumped (0.29 / 0.85 on
one pixel in consecutive frames). With the direction squared to the ray: the wall
moves by at most 1 level a frame, 0 frames of the walk switch state (16 and 18
before), the same as with AO off.

`--step "parallax 0|1"` switches every material's parallax for such A/Bs, and
`FZE_LITDEBUG=8` / `9` show the screen AO and contact shadow a surface reads.

(Temporal AA, which the next paragraph's memory belonged to, was removed on
2026-11-07: see docs/RENDERING-FEATURES.md.)

**Then the dots on thin edges, and the sparkling puddle (2026-11-01).** With the
editor camera still, dots and dashes switched on and off along the room's wall
tops, the stairs' noses, the corridor posts' edges and far objects. Per-pixel
analysis of 40-frame bursts (a pixel counts when it jumps away and back by more
than 12 levels): 3,018 such pixels, repeating exactly every 8 frames - the
temporal AA's jitter cycle - and 0 on those edges with TAA off. A thin feature (a
wall's sunlit top far off, under a pixel tall) is in some of the eight jitter
positions and not in others. Where it is not, nothing in the pixel's 3 x 3
neighbourhood is bright and the resolve clipped the history to the dark; where it
came back, its depth matched no stored distance and it came in at half weight. A
wall-top pixel read 43, 83, 81, 102, 100, 41, 83, 82 and again, where TAA off
holds 48. `Shaders/TemporalAA.frag` now keeps a memory per pixel (a third
target, RGBA16F): how often its depth has switched between surfaces lately, the
other surface's distance, and the range of brightness its neighbourhood showed
over about one cycle. While the camera stands still, a pixel that keeps switching
- or sits beside one that does - is held inside that range (colour too) and takes
the new frame by a thirty-second, half of it the neighbourhood's tent. Only depth
switches count, and only a stopped camera settles anything: a walking character,
waves and clouds keep the tight box (walking behind the character, the first
version judged "still" per pixel and the character went translucent - the camera
now decides). `FZETemporalAATest` adds a sub-pixel line (largest jump 0.252 ->
0.011), a light switched off (followed in four frames) and a block moving past a
still camera (no trail).

The puddle in front of the hall sparkled for another reason: the mirror's
reflection rays move their march offset every frame and a ray that slips past a
wall's edge is a dot of sky - 947 pixels, 7 with reflections off. The trace's
result is now held from frame to frame (`Shaders/SSRTemporal.frag`): a dot
brighter than all eight round it is brought down to them, and last frame's
reflection, reprojected and clamped, takes a sixth of this frame. The puddle's
average picture is unchanged (53.7 -> 53.5).

| From the editor camera of the Lab, 40 frames | Before | After | TAA off |
|---|---|---|---|
| Room's wall tops | 839 | 11 | 0 |
| Puddle | 947 | 17 | 2,681 |
| Far stairs and posts | 309 | 61 | 0 |
| Whole picture | 3,018 | 226 | 2,755 |
| The stairs, close | 953 | 42 | 10 |

### Controls

| Page | Settings |
|---|---|
| Environment ▸ Ambient Light | Sky Light Occlusion (on), Occlusion Strength, Bounce Light (GI), Bounce Strength |
| Environment ▸ Effects | Screen-space reflections |

### Costs

Measured on Intel UHD 620 at 1026 × 372, hall view. Each feature was A/B'd
against the same build with it off:

| Feature | Cost |
|---|---|
| Sky occlusion in the lit pass | about 1 ms |
| Reflections pass | 0.7 ms |
| Local exposure | 0.2 – 0.3 ms |
| Sky-visibility probes | only when rebuilt, spread over four frames |

### Finding faults

| Tool | What it shows |
|---|---|
| `FZE_LITDEBUG=n` | One term alone: 1 direct, 2 sky diffuse, 3 reflections, 4 bounce, 5 emission, 6 roughness, 7 the screen reflection this point reads, 8 the screen ambient occlusion it reads, 9 its contact shadow |
| `FZE_SSRDIAG=1` | The picture is what the trace found (after it is held from frame to frame) |
| `FZE_TAADEBUG=1` | What the temporal AA decided per pixel: red taken as new (half weight), green known as thin geometry, blue how often its depth has switched |
| `FZE_SKYVIS_DIAG=1` | Logs how much of the volume is solid |
| `--step "env <key> 0\|1"` | Switch one feature: `gi`, `skyocc`, `ssr`, `localexp`, `contact`, `ssao`, `bloom`, `fxaa` |

⚠️ **The editor reads `build/bin/Shaders`, a copy the build makes.** An edit
under `Shaders/` reaches it only after a build. Tests run from the repository
root and read the originals.
