# The Sun

Rebuilt on 2026-10-16/17 (Nabras: "the sun is a mess - rebuild it the way the big engines do, stable, and right with the clouds and the weather").

## What was wrong

- **A lens flare on every shot into the sun**: six diffraction spikes, a spray of fine rays and six hexagon ghosts, always on. An eye has no flare; good glass has little. It was the "mess" round the sun.
- **Rays only with clouds, and in bands**: the god rays were a 24-tap march inside the composite, run only when a cloud layer existed (a clear sky behind trees had none), and 24 samples over the whole way to the sun left 24 steps in every beam.
- **A fixed glow**: the aureole round the disc was one constant, the same in clear air and in haze, at noon and at sunset.

## What the big engines do

- **God rays** (Mitchell, *Volumetric Light Scattering as a Post-Process*, GPU Gems 3; Unreal's Light Shafts): a mask of the open sky, blurred radially toward the sun in several passes, each a fraction of the last one's reach, at reduced resolution.
- **Glare** (Spencer, Shirley, Zimmerman & Greenberg, *Physically-Based Glare Effects for Digital Images*, SIGGRAPH 1995): the eye's measured point-spread function, the reason a bright light has a veil round it.
- **Lens flare** (Hullin et al. 2011): a property of a camera, chosen per shot. Unreal and Unity leave it to the artist.
- **Aureole**: forward Mie scattering by aerosols, much sharper than the atmosphere's phase function, and it grows with the haze and with the air the sunlight crosses.

## What this engine does

| Part | Where | What |
|---|---|---|
| Disc | `Shaders/Sky.frag` | Radiance = illuminance / solid angle, with limb darkening; through the air's transmittance, so it reddens and dims at the horizon. |
| Aureole | `Shaders/Sky.frag` | The excess of a sharp aerosol lobe (Henyey-Greenstein g 0.95) over the sky table's own (g 0.8), times the haze's Mie depth times the air mass at the sun's height (Kasten & Young 1989). Clear air gives a small hard glow, humid air a big soft one, the horizon a wide red blaze. |
| God rays | `Shaders/SunShafts.frag`, `PostProcessor.cpp` | Half resolution. Pass 0: open sky (far depth, above the horizon, not covered by cloud), brightest round the disc. Then three radial blurs of 16 samples at 0.9, 0.9/16 and 0.9/256 of the way to the sun (only the long one fades with distance): 4096 evenly spaced samples' worth for 48 reads a pixel. No clouds needed. Coloured by the sunlight that crossed the air; faded as the sun leaves the frame. |
| Glare | `Shaders/Composite.frag`, `SunGlare` | Spencer's spread (the 62% outside the core), scaled to a screen, times the sun's light through the air, times how much of the disc is seen: hidden sun, no glare; a cloud dims it while the cloud glows. |
| Lens flare | `Shaders/Composite.frag`, `LensFlare` | Off by default. Subtle: two faint ghosts. Cinematic: spikes, spray and six ghosts. |
| Visibility | `Shaders/SunVisibility.frag` | One pixel: how much of the disc the lens sees past geometry and clouds. Glare and flare are scaled by it. |

On the **Sun** component: *Light Shafts* (the rays' strength), *Glare* (0-3, 1 = as an eye sees it), *Lens Flare* (Off / Subtle / Cinematic). Old scenes load with the flare Off.

Probe steps for checking it: `sun-set <pitch> <yaw> [degrees]`, `sun-look <shafts> <glare> <flare>`, `weather <cover> <kind> <rate>` (makes a Weather object if there is none). `FZE_SUNDIAG=1` logs the light the sun sends into the lens.
