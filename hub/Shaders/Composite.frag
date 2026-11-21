#version 460 core
#include "lib/Finite.glsl"     // one bad pixel never spreads (R0)

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_SSR;          // half-res ground reflection from SSR.frag
uniform int       u_HasSSR;
uniform sampler2D u_Volumetric;   // half-res inscatter from Volumetric.frag
uniform int       u_HasVolumetric;
uniform sampler2D u_Scene;
uniform sampler2D u_Bloom;
uniform float u_BloomNorm;        // 1 / the number of levels summed into u_Bloom
uniform float u_BloomIntensity;   // the share of light the lens scatters, 0..1

// Color grading (Lighting Studio).
#include "lib/Tonemap.glsl"

// ⚠️ ONE NUMBER, AND IT IS SMALL. The scene arrives already multiplied by
// the camera's pre-exposure (Renderer/Exposure.h); this is only what is left
// between that and the exposure the eye wants this frame - within half a
// stop of 1.
uniform float u_Exposure;
// Local exposure (LocalExposure.frag): the picture's base brightness, log2 of
// the scene's luminance before u_Exposure, smoothed without crossing edges.
uniform int       u_LocalExposure;
uniform sampler2D u_LocalBase;
uniform float     u_LEHighlights;   // contrast kept above mid-grey (1 = all)
uniform float     u_LEShadows;      // ... and below it
uniform float     u_LEDetail;       // the detail on the base, 1 = as it is
uniform int   u_ViewRaw;      // 1: the scene buffer as it is (the editor's buffer views)
uniform int   u_TonemapMode;  // 0 ACES, 1 Reinhard, 2 none
uniform float u_Saturation;   // 1 = unchanged
uniform float u_Contrast;     // 1 = unchanged
uniform vec3  u_ColorFilter;  // multiplicative tint
uniform float u_Vignette;     // 0 = off, 1 = strong

// Three-way grade + white balance — the standard colourist controls.
uniform vec3  u_WhiteBalance; // per-channel gain from temperature/tint
uniform vec3  u_Lift;         // shadows,   0 = neutral
uniform vec3  u_GammaC;       // midtones,  1 = neutral
uniform vec3  u_Gain;         // highlights,1 = neutral

// Anti-aliasing. The renderer has no MSAA, so every polygon edge is a hard
// staircase — and a staircase is only really obvious once the camera MOVES,
// because each frame snaps the step to a different pixel and the edge crawls.
// That crawling is what reads as "pixelated" while turning.
//
// FXAA rather than MSAA on purpose: MSAA multiplies the cost of every pixel of a
// forward renderer with shadows, SSAO and IBL, which a mid-range integrated GPU
// cannot spare. FXAA is one pass over the finished image and costs almost
// nothing. It runs HERE because it must operate on gamma-encoded pixels (its
// luma maths assumes display space) — and the scene buffer arrives already
// tonemapped and encoded, before this shader decodes it for grading.
uniform int  u_FXAA;
uniform float u_FXAASubpix;      // Rendering Features > FXAA > Lone Pixels: 0 none .. 1
uniform float u_Dither;           // levels of 255 before the 8 bits: 0 = none
uniform vec2 u_TexelSize;     // 1 / scene resolution

// ---- underwater ----
// The same Beer-Lambert absorption the water surface uses, applied to every pixel
// because below the surface the medium is not behind a plane, it is everywhere.
uniform int       u_Underwater;      // 0 = the camera is in air; everything below is skipped
uniform vec3      u_UwAbsorption;    // per-channel extinction, 1/metre
uniform vec3      u_UwScatterColor;
uniform float     u_UwScatterStrength;
uniform float     u_UwCameraDepth;   // how far below the surface the eye is
uniform sampler2D u_UwDepth;         // scene depth, for the distance to each pixel

// ---- the sun on screen (the lens flare's ghosts line up through it) ----
// The screen's sun shafts were removed (docs/SKY-PLAN.md, phase 2): beams of
// sunlight are drawn in the air by the Volumetric Light pass, from the shadow.
uniform vec2      u_SunScreen;       // where the sun is, in UV
uniform mat4      u_UwInvViewProj;
uniform vec3      u_UwCameraPos;

// The scene's own depth - what stands in front of the sky. The shafts used to
// read the UNDERWATER depth for this, which is only bound under water: above
// it they tested whatever the unit held from the pass before.
uniform sampler2D u_SceneDepth;
// For the depth-aware upsample below: pixel -> world, and where the eye is.
uniform mat4      u_InvViewProj;
uniform vec3      u_CameraPos;

// ============================================================================
//  A QUARTER-SIZE ANSWER, BROUGHT BACK TO FULL SIZE BY DEPTH.
//
//  The light in the air (Volumetric.frag, a quarter of the screen each way) and
//  the reflection in the wet ground (SSR.frag, half) are worked out small, for
//  what they cost. Stretched back with a plain bilinear filter, one small cell
//  that straddles the edge of a building mixed the air in front of the wall
//  with the air behind it: every silhouette facing the sun came out in steps
//  four pixels across - the "squares like pixels" around the rays. Each of the
//  four nearest cells is weighed here by how near its depth is to this pixel's
//  as well as by distance, so a pixel on the wall takes the wall's cells and a
//  pixel of sky the sky's. (A joint bilateral upsample.)
// ============================================================================
float DistanceAt(vec2 uv) {
    float d = texture(u_SceneDepth, uv).r;
    if (d >= 0.9999) return 1.0e6;                              // the sky: far away
    vec4 h = u_InvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return length(h.xyz / h.w - u_CameraPos);
}

vec4 UpsampleByDepth(sampler2D small, vec2 uv, float here) {
    vec2 size = vec2(textureSize(small, 0));
    vec2 p = uv * size - 0.5;
    vec2 base = floor(p);
    vec2 f = p - base;
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int j = 0; j < 2; ++j) {
        for (int i = 0; i < 2; ++i) {
            vec2 cell = clamp(base + vec2(float(i), float(j)), vec2(0.0), size - 1.0);
            float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
            float there = DistanceAt((cell + 0.5) / size);
            // A few per cent of the distance is "the same surface".
            float rel = abs(there - here) / max(min(here, there), 0.05);
            float w = bw * exp(-rel * 12.0) + 1e-5 * bw;
            acc += texelFetch(small, ivec2(cell), 0) * w;
            wsum += w;
        }
    }
    return acc / max(wsum, 1e-6);
}

// ---- the sun in front of the lens ----
uniform sampler2D u_SunVis;       // 1x1: how much of the disc is seen (SunVisibility.frag)
uniform int       u_SunInView;    // 1 while the sun is in front of the lens
uniform vec3      u_SunLight;     // its pre-exposed illuminance, through the air
uniform vec3      u_SunDirection; // toward it
uniform float     u_Glare;        // the eye's glare round it: 1 = as the eye sees it
uniform int       u_FlareMode;    // 0 none, 1 subtle, 2 cinematic
uniform float     u_FlareFade;    // 1 with the sun in the frame, 0 just past its edge
uniform float     u_Aspect;       // width / height

// ---- the look: how the finished picture is DRAWN (Renderer/Look.h) ----
uniform int   u_Outline;          // 1: ink round silhouettes and along creases
uniform float u_OutlineWidth;     // pixels
uniform vec3  u_OutlineColor;     // a display (sRGB) colour, like the ink
uniform float u_OutlineCrease;    // 0 = silhouettes only
uniform float u_OutlineFade;      // metres at which the ink has gone; 0 = never
uniform vec3  u_CameraFwd;        // the view's forward, for depth along it
uniform int   u_Posterize;        // colour levels per channel; 0/1 = off
uniform int   u_Pixelate;         // screen pixels per picture pixel; 1 = off
uniform float u_RetroLevels;      // the retro look's colours per channel; 0 = off

// Depth ALONG THE VIEW, metres; 0 for the sky.
float ViewDepth(vec2 uv) {
    float d = texture(u_SceneDepth, uv).r;
    if (d >= 0.9999) return 0.0;
    vec4 h = u_InvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return max(dot(h.xyz / h.w - u_CameraPos, u_CameraFwd), 1e-4);
}

// ============================================================================
//  INK, FROM DEPTH.
//
//  ⚠️ ON THE NEAR SIDE OF AN EDGE ONLY. A silhouette is where the surface
//  beside this pixel is much FARTHER than this one - so the line is drawn on
//  the object, one pen-width wide, never on the background behind it (which
//  doubled every outline and haloed the sky).
//
//  ⚠️ CREASES FROM 1/z. The reciprocal of view depth is LINEAR across any
//  plane on screen, so its second difference is exactly zero on every flat
//  face at any angle and only a fold - where the plane changes - leaves
//  anything. Depth itself is not linear on screen, and its second difference
//  draws false lines across every floor seen at a slant.
// ============================================================================
float Ink(vec2 uv) {
    float c = ViewDepth(uv);
    if (c <= 0.0) return 0.0;                        // the sky has no ink
    vec2 o = u_TexelSize * max(u_OutlineWidth, 0.5);
    float l = ViewDepth(uv - vec2(o.x, 0.0)), r = ViewDepth(uv + vec2(o.x, 0.0));
    float d = ViewDepth(uv - vec2(0.0, o.y)), u = ViewDepth(uv + vec2(0.0, o.y));
    const float kSky = 1.0e5;
    float L = l > 0.0 ? l : kSky, R = r > 0.0 ? r : kSky, D = d > 0.0 ? d : kSky, U = u > 0.0 ? u : kSky;
    float behind = max(max(L - c, R - c), max(D - c, U - c)) / c;
    float ink = smoothstep(0.035, 0.07, behind);
    if (u_OutlineCrease > 0.0 && l > 0.0 && r > 0.0 && d > 0.0 && u > 0.0) {
        float ic = 1.0 / c;
        float lap = abs(1.0 / l + 1.0 / r - 2.0 * ic) + abs(1.0 / d + 1.0 / u - 2.0 * ic);
        float k = lap / ic * u_OutlineCrease / max(u_OutlineWidth, 0.5);
        ink = max(ink, smoothstep(0.0025, 0.005, k));
    }
    if (u_OutlineFade > 0.0) ink *= 1.0 - smoothstep(u_OutlineFade * 0.6, u_OutlineFade, c);
    return ink;
}

float Luma(vec3 c) {
    // Reinhard first: see the note in main(). The constant is the standard
    // luma weighting; what changed is what it is fed.
    vec3 t = max(c, 0.0);
    t = t / (t + 1.0);
    return dot(t, vec3(0.299, 0.587, 0.114));
}

vec3 FXAA(sampler2D tex, vec2 uv, vec2 texel)
{
    vec3 rgbM = texture(tex, uv).rgb;
    vec3 rgbNW = texture(tex, uv + vec2(-1.0, -1.0) * texel).rgb;
    vec3 rgbNE = texture(tex, uv + vec2( 1.0, -1.0) * texel).rgb;
    vec3 rgbSW = texture(tex, uv + vec2(-1.0,  1.0) * texel).rgb;
    vec3 rgbSE = texture(tex, uv + vec2( 1.0,  1.0) * texel).rgb;

    float lM = Luma(rgbM);
    float lNW = Luma(rgbNW), lNE = Luma(rgbNE), lSW = Luma(rgbSW), lSE = Luma(rgbSE);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

    // Flat areas are left alone — blurring them would just soften texture detail
    // for nothing. Only pixels straddling a real luma edge get filtered.
    if (lMax - lMin < max(0.0312, lMax * 0.125)) return rgbM;

    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)),
                     ((lNW + lSW) - (lNE + lSE)));
    float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
    float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * texel;

    vec3 rgbA = 0.5 * (texture(tex, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
                       texture(tex, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(tex, uv + dir * -0.5).rgb +
                                     texture(tex, uv + dir *  0.5).rgb);
    // The wider tap is better on long edges but overshoots on thin features, so
    // fall back to the narrow one whenever it leaves the neighbourhood's range.
    float lB = Luma(rgbB);
    vec3 result = (lB < lMin || lB > lMax) ? rgbA : rgbB;

    // ⚠️ A LONE PIXEL IS NOT AN EDGE. A leaf smaller than a pixel lands on one
    // pixel alone - the dots round DREVAR's tree crowns - and the four corners
    // above all agree, so the direction is nothing and the pixel came out as it
    // went in. FXAA 3.11's sub-pixel step (Lottes 2011), from the four corners
    // this already read (its own uses the four sides too: 4 more reads of the
    // whole screen, 0.4 ms measured, for the same dots gone): how far this pixel
    // stands from the corners round it, against their range, eased in; that
    // share of it becomes the corners' colour. A lone dot is blended away (75%
    // at FXAA's default); a long edge, which the corners straddle, hardly at all.
    if (u_FXAASubpix > 0.0) {
        float around = 0.25 * (lNW + lNE + lSW + lSE);
        float c = clamp(abs(around - lM) / max(lMax - lMin, 1e-4), 0.0, 1.0);
        float d = (-2.0 * c + 3.0) * c * c;
        vec3 lowpass = 0.25 * (rgbNW + rgbNE + rgbSW + rgbSE);
        result = mix(result, lowpass, d * d * u_FXAASubpix);
    }
    return result;
}

// ============================================================================
//  GLARE: WHY YOU CANNOT LOOK AT THE SUN.
//
//  The eye's lens and cornea scatter a share of every bright light they see
//  into a veil round it. Spencer, Shirley, Zimmerman & Greenberg ("Physically-
//  Based Glare Effects for Digital Images", SIGGRAPH 1995) measured how: of the
//  light from a point, 38% stays in the point and the rest spreads as
//
//      0.478 * 20.91 / (t + 0.02)^3  +  0.138 * 72.37 / (t + 0.02)^2   per sr,
//
//  t the angle from it in DEGREES. The first term is the tight bright glow
//  hugging the disc; the second the wide, faint veil that lifts everything
//  near the sun - the "hot" sky in every photograph taken toward it. Both are
//  shares of the light the disc sends - its illuminance through the air,
//  times how much of it is seen - so a hidden sun has no glare, a cloud dims
//  it while the cloud itself glows, and a red setting sun has a red one.
//  At full strength it is what an eye sees; a camera sees less (u_Glare).
// ============================================================================
vec3 SunGlare(vec2 uv, float vis) {
    vec4 h = u_InvViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = normalize(h.xyz / h.w - u_CameraPos);
    float t = degrees(acos(clamp(dot(dir, u_SunDirection), -1.0, 1.0)));
    float a = t + 0.02;
    float psf = 0.478 * 20.91 / (a * a * a) + 0.138 * 72.37 / (a * a);
    // ⚠️ SCALED TO A SCREEN, NOT TO A RETINA. The measured spread at full
    // strength puts eight times the sun's illuminance a third of a degree off
    // the disc - right for an eye, a white wall on a display. 0.02 keeps the
    // falloff's shape and leaves the glow a few degrees across.
    return u_SunLight * vis * u_Glare * 0.02 * psf;
}

// ============================================================================
//  THE SUN IN THE LENS.
//
//  Looking towards the sun, a camera and an eye show three things that are not
//  in the scene at all, all of them made by the disc's light going through the
//  glass (Hullin et al., "Physically-Based Real-Time Lens Flare Rendering",
//  2011, for what each one is):
//    - GLARE: the lens's spread (the bloom above, mixed in by the share of light
//      it scatters), a veil that lifts everything near the sun;
//    - DIFFRACTION: light bending round the iris's straight blades, six of them
//      here, into six spikes; with them a spray of fine uneven rays from the
//      dust on the glass and the eye's own lashes (the ciliary corona);
//    - GHOSTS: light bouncing between the glass elements lands as faint images
//      of the aperture - hexagons - along the line from the sun through the
//      middle of the frame, each tinted by its coating.
//  Each is a fraction of the light arriving from the disc, so each scales with
//  how strong the sun is (its illuminance through the air: a red, weak setting
//  sun gives red, weak rays) and with how much of the disc is SEEN - behind a
//  wall they go, behind a thin cloud they fade while the cloud itself glows.
//  Drawn from formulas at full resolution: nothing here has pixels to show.
// ============================================================================
float Hash1(float x) { return fract(sin(x * 127.1 + 11.7) * 43758.5453); }
float AngleNoise(float a, float cells) {
    float x = (a / 6.2831853 + 0.5) * cells;
    float i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(Hash1(mod(i, cells)), Hash1(mod(i + 1.0, cells)), f);
}
float HexDist(vec2 p, float r) {
    vec2 q = abs(p);
    return max(q.x * 0.8660254 + q.y * 0.5, q.y) / r;
}
//  ⚠️ OFF UNLESS ASKED FOR. A lens flare is a property of a CAMERA, and of a
//  cheap one: the eye has none, good glass has little, and a game that looks
//  through eyes shows none. Drawn by default it put spikes, a spray of rays and
//  six hexagons over every shot toward the sun - the "mess" round the sun.
//  Subtle: the two faintest ghosts and no spikes (a well-coated lens).
//  Cinematic: all of it (a film lens shot into the sun on purpose).
vec3 LensFlare(vec2 uv, float vis) {
    vec3 E = u_SunLight * vis;
    if (dot(E, vec3(1.0)) <= 1e-7) return vec3(0.0);
    vec2 d = (uv - u_SunScreen) * vec2(u_Aspect, 1.0);   // screen heights, round
    float r = length(d);
    float ang = atan(d.y, d.x);
    vec3 L = vec3(0.0);
    bool cinematic = u_FlareMode >= 2;
    if (cinematic) {
        // Diffraction: six spikes, fixed to the lens (they turn with the camera,
        // not with the sun), thin at the disc and widening as they fade.
        const float kSpokes = 6.0;
        float a = mod(ang + 0.26, 6.2831853 / kSpokes) - 3.14159265 / kSpokes;
        float across = r * abs(sin(a));
        float width = 0.0015 + r * 0.006;
        float fall = pow(0.01 / (r + 0.01), 1.3) * exp(-r * 5.0);
        // ⚠️ SIZED FROM THE LIGHT, NOT BY EYE. About half a per cent of what the
        // disc sends lands in the six spikes - some 0.008 sr of frame - so they
        // average ~0.6 E and reach several E beside the disc; the first try used
        // ~0.07 E there and the rays drowned in the glow they sit in.
        L += E * 5.0 * fall * exp(-(across * across) / (width * width));
        // ...and the spray of fine rays, each its own length.
        float n1 = AngleNoise(ang, 173.0), n2 = AngleNoise(ang + 1.7, 97.0);
        L += E * 1.0 * pow(n1, 6.0) * exp(-r / (0.04 + 0.22 * n2)) * (0.02 / (r + 0.02));
    }

    // Ghosts: along the axis from the sun through the centre (t = 1 is the
    // centre, 2 the sun's mirror image). Each channel's ghost is a slightly
    // different size - the glass bends colours differently - so the edges fringe.
    vec2 axis = vec2(0.5) - u_SunScreen;
    const int kGhosts = 6;
    const float gT[kGhosts]    = float[](0.28, 0.55, 0.85, 1.30, 1.60, 2.10);
    const float gSize[kGhosts] = float[](0.020, 0.045, 0.018, 0.075, 0.030, 0.120);
    // A ghost carries 1e-4..1e-3 of the disc's light over its own few
    // thousandths of a steradian: a few hundredths of E - plain against the
    // ground, faint against the sky, as in any photograph into the sun.
    const float gGain[kGhosts] = float[](0.08, 0.03, 0.09, 0.02, 0.05, 0.01);
    const vec3  gTint[kGhosts] = vec3[](vec3(1.0, 0.75, 0.35), vec3(0.45, 1.0, 0.6),
                                        vec3(0.6, 0.5, 1.0),   vec3(0.35, 0.55, 1.0),
                                        vec3(1.0, 0.6, 0.45),  vec3(0.5, 0.9, 0.7));
    const float gSubtle[kGhosts] = float[](0.0, 0.35, 0.0, 0.5, 0.0, 0.0);
    for (int k = 0; k < kGhosts; ++k) {
        float gain = cinematic ? 1.0 : gSubtle[k];
        vec2 p = (uv - (u_SunScreen + axis * gT[k])) * vec2(u_Aspect, 1.0);
        vec3 edge = vec3(HexDist(p, gSize[k] * 1.03), HexDist(p, gSize[k]), HexDist(p, gSize[k] * 0.97));
        vec3 shape = 1.0 - smoothstep(vec3(0.82), vec3(1.0), edge);
        // A coated element's ghost is brighter at its rim than across its face.
        shape *= 0.65 + 0.35 * smoothstep(vec3(0.5), vec3(0.95), edge);
        L += E * gTint[k] * (gGain[k] * gain) * shape;
    }
    return L;
}

void main()
{
    // Big pixels: every sample below is taken at the centre of its block, so
    // the whole picture - light, bloom, reflections - steps together.
    vec2 uv = v_UV;
    if (u_Pixelate > 1) {
        vec2 px = u_TexelSize * float(u_Pixelate);
        uv = (floor(v_UV / px) + 0.5) * px;
    }
    // The retro look's picture is small and stretched: hard pixels, not a blur.
    else if (u_RetroLevels > 0.0) uv = (floor(v_UV / u_TexelSize) + 0.5) * u_TexelSize;
    // ⚠️ A BUFFER VIEW IS SHOWN AS IT IS. Base colour, normals, roughness: values,
    // not light - exposure and the tone curve would change what they say.
    if (u_ViewRaw == 1) { FragColor = vec4(texture(u_Scene, uv).rgb, 1.0); return; }
    // ⚠️ THE SCENE ARRIVES AS RADIANCE. No decode: nothing upstream encoded it
    // any more. Everything that is LIGHT - bloom, the reflection, the inscatter,
    // the shafts - is added here in linear, and the whole sum meets the tone
    // curve once, at the bottom of this function.
    // ⚠️ FXAA NOW EDGE-DETECTS ON A COMPRESSED LUMA. Its maths assumes display
    // space - the whole method is "find pixels whose luma differs from their
    // neighbours' by more than a threshold", and in HDR a threshold in the
    // shadows and a threshold in a highlight are not the same thing at all. The
    // Luma() below runs its value through x/(x+1) first, which is monotonic and
    // compresses the range the way the eye does. Running FXAA as its own pass
    // after the tone curve would be more correct and costs a full-screen target.
    vec3 color = max(FZE_Finite(u_FXAA == 1 ? FXAA(u_Scene, uv, u_TexelSize) : texture(u_Scene, uv).rgb), 0.0);
    // ⚠️ MIXED, NOT ADDED: the lens moves light, it does not make it. What it
    // scatters is taken from where it was going and spread round it, so a dim
    // frame stays as dim and only the sun, thousands of times anything near
    // it, shows a glow - wide and round, falling away smoothly.
    color = mix(color, max(texture(u_Bloom, uv).rgb, 0.0) * u_BloomNorm, u_BloomIntensity);

    // ================================================================
    //  UNDERWATER, IN LINEAR LIGHT AND BEFORE THE GRADE.
    //
    //  ⚠️ BEFORE, NOT AFTER. Absorption is something that happened to the light on
    //  its way to the camera; the grade is something a colourist does to the picture
    //  afterwards. Fogging a graded image means the lift/gain are applied to light
    //  that never reached the lens, and the two fight each other — raise the shadows
    //  and the deep water gets brighter, which is exactly backwards.
    // ================================================================
    if (u_Underwater == 1) {
        // Distance from the eye to whatever this pixel is showing. Sky and anything
        // at the far plane get a long path, so the horizon disappears into the water
        // rather than hanging there as a clear band.
        float zN = texture(u_UwDepth, uv).r;
        float dist;
        if (zN >= 0.999999) {
            dist = 1000.0;                       // nothing here: infinitely far water
        } else {
            vec4 clip = vec4(uv * 2.0 - 1.0, zN * 2.0 - 1.0, 1.0);
            vec4 wp   = u_UwInvViewProj * clip;
            dist = length(wp.xyz / wp.w - u_UwCameraPos);
        }

        // ⚠️ THE CAMERA'S OWN DEPTH COUNTS TOO. Light had to travel DOWN to the diver
        // before it could travel across to them, so a torch-lit wall ten metres away
        // is not the same brightness at 2 m down and at 40 m down. Leaving this out is
        // why shallow and deep water look identical in most games.
        vec3 transmit = exp(-u_UwAbsorption * (dist + u_UwCameraDepth));

        // What the water itself sends back — saturating with distance, so far water
        // tends to a flat colour instead of to black.
        vec3 inscatter = u_UwScatterColor * u_UwScatterStrength
                       * (1.0 - exp(-u_UwAbsorption * dist))
                       * exp(-u_UwAbsorption * u_UwCameraDepth);

        color = color * transmit + inscatter;
    }

    // --- white balance (per-channel gain derived from temperature/tint) ---


    // ⚠️ ADDED, NOT BLENDED. Light in the air is light ARRIVING at the eye on top
    // of whatever the surface behind it sent - it does not replace or tint that,
    // it adds to it, which is why a shaft brightens a dark doorway instead of
    // fogging it grey.
    // ⚠️ ADDED, AND KEYED BY ITS OWN ALPHA. The reflection buffer carries how
    // confident the march was in its alpha - zero where the ray left the screen
    // or found nothing - so adding the colour alone would paint the whole ground
    // with whatever the last successful pixel found.
    float here = (u_HasSSR != 0 || u_HasVolumetric != 0) ? DistanceAt(uv) : 0.0;
    if (u_HasSSR != 0) {
        vec4 r = UpsampleByDepth(u_SSR, uv, here);
        color += r.rgb * r.a;
    }

    if (u_HasVolumetric != 0)
        color += UpsampleByDepth(u_Volumetric, uv, here).rgb;


    // The eye and the lens, after all the light in the scene and before the
    // camera's own settings - the white balance is applied to what reached
    // the sensor.
    if (u_SunInView == 1 && u_Underwater == 0) {
        float vis = texture(u_SunVis, vec2(0.5)).r;
        if (u_Glare > 0.0) color += SunGlare(uv, vis);
        if (u_FlareMode > 0 && u_FlareFade > 0.0) color += LensFlare(uv, vis) * u_FlareFade;
    }

    color *= u_WhiteBalance;

    // --- three-way grade: lift / gamma / gain ---
    // Lift is added where the image is DARK and fades out toward white, so it
    // tints the shadows without washing out the highlights.
    color = color * u_Gain + u_Lift * (1.0 - color);
    color = pow(max(color, 0.0), 1.0 / max(u_GammaC, vec3(0.01)));

    color *= u_ColorFilter;

    // Contrast pivots on 0.18 — mid-grey in LINEAR light. Pivoting on 0.5 (the
    // ENCODED mid-grey) crushes the shadows long before it touches highlights.
    color = (color - 0.18) * u_Contrast + 0.18;

    // Saturation, luma-preserving.
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, u_Saturation);

    // ================================================================
    //  ONE EXPOSURE, ONE CURVE, ONE ENCODE - AND ALL OF IT HERE.
    //
    //  ⚠️ EVERYTHING ABOVE THIS LINE IS LIGHT AND EVERYTHING BELOW IT IS A
    //  PICTURE. That is the whole point of the change: the surface shaders, the
    //  bloom, the reflection, the inscatter and the shafts all add radiance,
    //  and radiance is allowed to exceed 1. It is compressed to a display range
    //  exactly once, which is what makes a bloom threshold of 1.2 mean "brighter
    //  than white" instead of selecting nothing, and what makes a reflected lamp
    //  come back as bright as the lamp.
    // ================================================================
    color *= u_Exposure;
    // ⚠️ LOCAL EXPOSURE: THE BASE'S CONTRAST, NOT THE PICTURE'S. The base is the
    // smoothed brightness of this part of the frame; only its distance from
    // mid-grey is shortened, and the pixel's own detail over it is put back.
    // A room four stops under the sky comes up about one and a half (shadows
    // 0.65) and keeps every shadow inside it; the sky comes down a little.
    if (u_LocalExposure == 1) {
        float L = max(dot(color, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
        float logL = log2(L);
        // ⚠️ THE BASE IS AN EIGHTH OF THE PICTURE, AND IT IS NOT STRETCHED BLINDLY.
        // A plain bilinear read mixed the window's base into the wall pixels
        // beside it: a dark band round every bright edge, a stop too dark,
        // eight pixels wide - and it crawled as the camera moved, because the
        // eighth-size grid is fixed to the screen while the edge slides across
        // it. The four base texels round this pixel are weighted by how close
        // each one's brightness is to this pixel's own (Unreal's bilateral
        // grid, sliced by the pixel's luminance), so a wall pixel takes the
        // wall's base and a window pixel the window's.
        float logExposure = log2(max(u_Exposure, 1e-8));
        vec2 baseSize = vec2(textureSize(u_LocalBase, 0));
        vec2 st = v_UV * baseSize - 0.5;
        vec2 i0 = floor(st), fr = st - i0;
        float bsum = 0.0, wsum = 0.0;
        for (int k = 0; k < 4; ++k) {
            vec2 o = vec2(float(k & 1), float(k >> 1));
            ivec2 at = ivec2(clamp(i0 + o, vec2(0.0), baseSize - 1.0));
            float b = texelFetch(u_LocalBase, at, 0).r + logExposure;
            float wb = (o.x > 0.5 ? fr.x : 1.0 - fr.x) * (o.y > 0.5 ? fr.y : 1.0 - fr.y);
            float dEV = b - logL;
            // 1.5 EV: a texture's own light and dark stay one base; a lit window
            // against a shaded wall does not.
            float w = wb * (exp(-dEV * dEV / (2.0 * 1.5 * 1.5)) + 1e-3);
            bsum += w * b;
            wsum += w;
        }
        float base = bsum / max(wsum, 1e-8);
        const float mid = -2.4739312;                  // log2(0.18)
        float d = base - mid;
        float newBase = mid + d * (d > 0.0 ? u_LEHighlights : u_LEShadows);
        float newLog = newBase + (logL - base) * u_LEDetail;
        color *= exp2(clamp(newLog - logL, -8.0, 8.0));
    }
    color = FZE_Tonemap(color, u_TonemapMode);
    if (!FZE_TonemapEncodes(u_TonemapMode))
        color = pow(max(color, 0.0), vec3(1.0 / 2.2));

    // Few colours: steps in the encoded image, where the eye sees them evenly.
    if (u_Posterize > 1) {
        float n = float(u_Posterize - 1);
        color = floor(clamp(color, 0.0, 1.0) * n + 0.5) / n;
    }
    // A console's 15 bits, and the ordered dither that hid them. The matrix is
    // worked out from the pixel: this engine's Intel path goes black on GLSL arrays.
    if (u_RetroLevels > 1.0) {
        ivec2 p = ivec2(floor(uv / u_TexelSize));
        int v = (p.x ^ p.y) & 3, h = p.y & 3;
        int b = ((v & 1) << 3) | ((h & 1) << 2) | (v & 2) | ((h & 2) >> 1);
        float n = u_RetroLevels - 1.0;
        color = floor(clamp(color, 0.0, 1.0) * n + (float(b) + 0.5) / 16.0) / n;
    }
    // The ink is drawn on the finished picture, like a pen on a print.
    if (u_Outline == 1) color = mix(color, u_OutlineColor, Ink(uv));

    // Vignette is a lens effect, so it belongs on the encoded image.
    vec2 d = v_UV - 0.5;
    float vig = 1.0 - u_Vignette * dot(d, d) * 2.2;
    color *= clamp(vig, 0.0, 1.0);

    // ⚠️ DITHERED BEFORE THE SCREEN'S 8 BITS (Unreal's Grain Quantization, on
    // by default there). A lit wall in the Lab spans two or three levels of 255
    // across its width - sky occlusion, the bounce and the local exposure are
    // all smooth gradients - and 8 bits draw that as flat rings a hundred pixels
    // wide, measured, with a hard step between them. They read as ripples on the
    // wall, and they slide whenever the light shifts by a hair. A triangular
    // noise of one level spreads each step into the levels beside it, so the
    // eye averages a gradient again. Fixed per pixel, not animated: a grain that
    // changed every frame would be a shimmer of its own. Not on a posterized
    // look, whose steps are the point.
    if (u_Posterize <= 1 && u_RetroLevels <= 0.0 && u_Dither > 0.0) {
        vec2 px = gl_FragCoord.xy;
        float n1 = fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
        float n2 = fract(52.9829189 * fract(dot(px + vec2(47.0, 17.0), vec2(0.06711056, 0.00583715))));
        color += (n1 + n2 - 1.0) * u_Dither / 255.0;
    }
    FragColor = vec4(max(color, 0.0), 1.0);
}
