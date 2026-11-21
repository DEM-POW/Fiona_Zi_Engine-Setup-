// ---------------------------------------------------------------
//  Fiona Zi Engine — radiance to picture
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// ONE PLACE WHERE THIS ENGINE TURNS LIGHT INTO A PIXEL.
//
// ⚠️ IT WAS TWO, AND THEY WERE DIFFERENT CURVES. Lit.frag ran the Stephen Hill
// RRT+ODT fit; Terrain.frag ran the one-line Narkowicz approximation under the
// same name and the same `u_TonemapMode == 0`. Narkowicz tonemaps each channel on
// its own, so bright saturated colour hue-shifts - a red goes orange, a blue sky
// goes cyan - while the Hill fit runs through the ACES matrices and keeps the
// hue. The visible result was that the GROUND and everything STANDING on it
// rolled their highlights off differently: a lit slope and the rock resting on it
// disagreed about what "bright" looks like, and nobody would file that as a bug.
//
// It also has to be shared for the fog to work at all. Surfaces are shaded in
// linear radiance and tonemapped at the end; the sky is written straight out as
// display values with no tonemap. Fog has to reach the same colour on both or the
// horizon is a visible seam - so the sky asks THIS file what its fog colour looks
// like after the surface path is done with it, and the two meet exactly.
// ---------------------------------------------------------------

// ACES filmic, Stephen Hill's RRT+ODT fit.
const mat3 FZE_ACESInput = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777);
const mat3 FZE_ACESOutput = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602);

vec3 FZE_RRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
}

vec3 FZE_ACES(vec3 x) {
    vec3 c = FZE_ACESInput * max(x, 0.0);
    c = FZE_RRTAndODTFit(c);
    return clamp(FZE_ACESOutput * c, 0.0, 1.0);
}

// ---------------------------------------------------------------
//  AgX — the curve Blender and Godot moved to, and why it is here
//
//  ACES was built to grade film for cinema and it shows: it pushes saturated
//  colour towards its primaries as it brightens, so a bright red sign goes
//  ORANGE and a blue night sky goes cyan before either of them reaches white.
//  That is the "ACES look", and on a street of coloured signs and a deep blue
//  sky it is exactly the wrong instinct.
//
//  AgX does the opposite: it deliberately DESATURATES towards white as a colour
//  gets brighter, the way film and a real camera do, so a bright red stays red
//  and turns pale rather than turning orange. That is the whole reason it exists
//  and the reason it suits this scene.
//
//  ⚠️ THE TWO MATRICES ARE THE METHOD, NOT DECORATION. The inset matrix pulls
//  the primaries in before the curve so the sigmoid cannot push a channel off
//  on its own; the outset pushes them back afterwards. Apply the sigmoid without
//  them and you have an ordinary per-channel curve with all of ACES's hue
//  problems and none of its film response.
//
//  This is the standard published approximation (Troy Sobotka's AgX, in the
//  compact form Blender/Godot/three.js ship): inset, log2 over a fixed
//  exposure window, a 6th-order polynomial sigmoid, outset.
// ---------------------------------------------------------------
const mat3 FZE_AgXInset = mat3(
    0.8566271533, 0.1373190614, 0.1118982129,
    0.0951212405, 0.7612419251, 0.0767994186,
    0.0482516061, 0.1014390135, 0.8113023684);

const mat3 FZE_AgXOutset = mat3(
     1.1271005818, -0.1413297080, -0.1413297080,
    -0.1106066501,  1.1578237022, -0.1106066501,
    -0.0164970599, -0.0164970599,  1.2519364389);

// The window the log encoding covers, in stops. -12.47 to +4.03 is about
// sixteen and a half stops, which is what a modern sensor sees.
const float FZE_AgXMin = -12.47393;
const float FZE_AgXMax =   4.026069;

vec3 FZE_AgXSigmoid(vec3 x) {
    // 6th-order fit of the AgX contrast curve. Cheaper than the real spline and
    // indistinguishable at 8 bits.
    vec3 x2 = x * x;
    vec3 x4 = x2 * x2;
    return  15.5     * x4 * x2
          - 40.14    * x4 * x
          + 31.96    * x4
          -  6.868   * x2 * x
          +  0.4298  * x2
          +  0.1191  * x
          -  0.00232;
}

vec3 FZE_AgX(vec3 radiance) {
    vec3 v = FZE_AgXInset * max(radiance, vec3(0.0));
    // ⚠️ CLAMPED BEFORE THE LOG, because log2(0) is minus infinity and one black
    // pixel would take the whole channel with it.
    v = clamp(log2(max(v, 1e-10)), FZE_AgXMin, FZE_AgXMax);
    v = (v - FZE_AgXMin) / (FZE_AgXMax - FZE_AgXMin);
    v = FZE_AgXSigmoid(clamp(v, 0.0, 1.0));
    v = FZE_AgXOutset * v;
    // ⚠️ AgX ENDS IN DISPLAY SPACE. The sigmoid above already contains the
    // display response, so the caller must NOT apply gamma on top - doing so
    // washes the image out and is the most common way this curve is got wrong.
    // FZE_TonemapEncodes() below is how the caller knows.
    return clamp(v, 0.0, 1.0);
}

// True when the curve has already encoded for the display, so the caller skips
// its own gamma step.
bool FZE_TonemapEncodes(int mode) { return mode == 3; }

// mode: 0 ACES, 1 Reinhard, 2 none, 3 AgX — matching Environment::TonemapMode.
vec3 FZE_Tonemap(vec3 radiance, int mode) {
    if (mode == 0) return FZE_ACES(radiance);
    if (mode == 1) return radiance / (radiance + 1.0);
    if (mode == 3) return FZE_AgX(radiance);
    return radiance;
}

// ⚠️ WHAT A SURFACE SHADER WRITES IS LIGHT, NOT A PICTURE.
//
// This used to be FZE_Display(radiance, exposure, mode): exposure, tone curve
// and gamma, applied at the end of every surface shader. That made the scene
// buffer a display image, and everything downstream then worked on numbers that
// were no longer light - the bright pass thresholded a tonemapped signal where
// nothing can exceed 1, reflections returned tonemapped colour, and the
// volumetric inscatter was added to gamma-encoded values.
//
// The curve happens ONCE now, at the end of Composite.frag, after everything
// that is light has been added in linear. This is here so the call sites read
// as what they are: the scene's output, clamped against negatives and nothing
// else.
vec3 FZE_SceneOut(vec3 radiance) {
    return max(radiance, vec3(0.0));
}
