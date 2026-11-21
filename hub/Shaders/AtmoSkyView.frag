#version 460 core

// ============================================================================
//  SKY-VIEW LUT — the whole sky, as one small picture.
//
//  192 x 108, rebuilt when the sun moves or the camera changes altitude, and
//  that is the entire cost of the sky: the fullscreen pass that draws it later
//  is one texture fetch per pixel.
//
//  ⚠️ IT IS A MAP AROUND THE VIEWER, NOT A CUBEMAP AND NOT A SCREEN-SPACE
//  BUFFER. A cubemap wastes most of its area on parts of the sky nothing is
//  looking at and puts seams through the horizon; a screen-space buffer has to
//  be rebuilt every time the camera TURNS, which is constantly. Latitude and
//  longitude around the viewer, with the sun pinned at longitude zero, is
//  invariant to where the camera is pointing - so turning your head costs
//  nothing at all.
//
//  Latitude is warped so half the rows sit within a few degrees of the horizon
//  (see FZE_SkyViewUV): that is where all the interesting variation is, and a
//  linear map bands there badly enough to see.
// ============================================================================

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_TransmittanceLUT;
uniform sampler2D u_MultiScatterLUT;

uniform vec3  u_SunDir;            // toward the sun, normalised
uniform vec3  u_SunIlluminance;    // HDR, linear
uniform float u_ViewHeight;        // km from the planet centre
uniform int   u_Steps;             // quality

// ⚠️ NO DITHER AT ALL, AND BOTH OF THE OTHER ANSWERS WERE WORSE.
//
// A dither exists to break the banding a stepped integral leaves behind. The
// first attempt offset the whole table by one number and changed it each
// rebuild: that hides banding perfectly on a still image and shimmers the entire
// sky the moment the sun moves - measured at 2.2 to 3.3 out of 255 between
// consecutive frames across 60% of the sky.
//
// The second attempt moved the offset into SPACE, a different value per texel.
// That fixed the shimmer (0.17 to 0.24) and broke the picture, which the
// measurement did not look at: this table is 192 texels wide and it is magnified
// to the whole screen through a mapping whose rows are latitude around the sun.
// Per-texel noise in it therefore arrives as RAYS radiating from the sun. It was
// reported as "the sky is streaky" before it was noticed here, because the test
// asked how much the frame changed and never asked what the frame looked like.
//
// The right answer is the midpoint rule and enough steps. Sampling each segment
// at its centre is the correct quadrature rather than a fallback, the table is
// smooth to begin with, and its own bilinear magnification blurs what banding
// remains. Measured on the same view: high-frequency energy fell from 0.912/255
// to the figure in the commit, and the temporal difference stayed where the
// spatial dither had put it.


#include "lib/AtmosphereUniforms.glsl"

void main()
{
    FZEAtmosphere atmo = FZE_AtmosphereFromUniforms();
    float viewHeight = max(u_ViewHeight, atmo.BottomRadius + 1e-4);

    float cosViewZenith, cosAzimuth;
    FZE_SkyViewFromUV(atmo, viewHeight, v_UV, cosViewZenith, cosAzimuth);

    // Rebuild a direction in the frame the LUT is defined in: the sun sits in
    // the +X half of the XY plane, so azimuth is measured from it.
    float sinViewZenith = sqrt(max(1.0 - cosViewZenith * cosViewZenith, 0.0));
    float sinAzimuth    = sqrt(max(1.0 - cosAzimuth * cosAzimuth, 0.0));
    vec3 viewDir = vec3(sinViewZenith * cosAzimuth, cosViewZenith,
                        sinViewZenith * sinAzimuth);

    float cosSunZenith = clamp(u_SunDir.y, -1.0, 1.0);
    vec3 sunDir = vec3(sqrt(max(1.0 - cosSunZenith * cosSunZenith, 0.0)),
                       cosSunZenith, 0.0);

    vec3 pos = vec3(0.0, viewHeight, 0.0);

    // ⚠️ A RAY THAT LEAVES THE ATMOSPHERE CONTRIBUTES NOTHING AND MUST SAY SO.
    // From high altitude, most of the sky is empty space; marching it anyway
    // produces a faint uniform wash where there should be black, and the IBL
    // bake then lifts the whole scene's ambient off it.
    bool hitGround;
    if (FZE_AtmoRayLength(atmo, pos, viewDir, hitGround) <= 0.0) {
        FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    FZEScatterResult r = FZE_IntegrateScatteredLuminance(
        atmo, u_TransmittanceLUT, u_MultiScatterLUT,
        pos, viewDir, sunDir, u_SunIlluminance,
        max(u_Steps, 4), -1.0, true, true, 0.5, true);

    FragColor = vec4(r.Luminance, 1.0);
}
