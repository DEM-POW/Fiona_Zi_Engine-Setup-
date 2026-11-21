// ============================================================================
//  Reading the sky, from the one place that knows what colour it is.
//
//  ⚠️ THE SKY GRADIENT WAS WRITTEN FOUR TIMES: Sky.frag drew it, IBLIrradiance
//  and IBLPrefilter each had their own copy so the lighting would agree with the
//  picture, and Clouds.frag had a fourth for its ambient term - with a comment
//  explaining that duplicating it was cheaper than a texture read. Every one of
//  those copies was `mix(u_SkyTop, u_SkyHorizon, exp(-h * 3.2))`, and every one
//  of them had to be found and changed the moment the sky stopped being a
//  gradient.
//
//  That is the failure this file exists to end. The atmosphere already computed
//  the answer into a 192x108 table; reading it is one fetch, which is cheaper
//  than the four exponentials it replaces, and there is now exactly one thing
//  that decides what the sky looks like. The world cannot be lit by a sky it is
//  not standing under.
// ============================================================================

#ifndef FZE_SKYSAMPLE_GLSL
#define FZE_SKYSAMPLE_GLSL

#include "Atmosphere.glsl"
#include "AtmosphereUniforms.glsl"   // u_AtmoRadianceScale

uniform int       u_SkyLutEnabled;
uniform sampler2D u_SkyViewLut;
uniform float     u_SkyLutViewHeight;   // km from the planet centre
uniform vec3      u_SkyLutSunDir;       // toward the sun

// Linear HDR radiance arriving from `dir`. Returns false through
// u_SkyLutEnabled when there is no atmosphere, so the callers can fall back to
// whatever they did before rather than going black.
vec3 FZE_SkyRadiance(FZEAtmosphere atmo, vec3 dir) {
    float viewHeight = max(u_SkyLutViewHeight, atmo.BottomRadius + 1e-4);
    vec2 uv = FZE_SkyViewUV(atmo, viewHeight, normalize(dir), normalize(u_SkyLutSunDir));
    // Below the horizon: the air in front of the ground, and the ground itself.
    return texture(u_SkyViewLut, uv).rgb * u_AtmoRadianceScale
         + FZE_GroundSeen(atmo, viewHeight, normalize(dir));
}

// ---------------------------------------------------------------------------
//  The sun, as it arrives.
//
//  /!\ THE LIGHT THAT REACHES THE GROUND IS NOT THE LIGHT THAT LEFT THE SUN,
//  and this is the last place in the engine where those two were the same
//  number. Every surface was lit by u_LightColor directly, so at sunset the sky
//  went orange, the clouds went copper and the ground stayed the same neutral
//  white it had at noon - the one object in the frame that had not noticed.
//
//  /!\ AND IT IS PER PIXEL, WHICH IS NOT A LUXURY. Transmittance depends on
//  the altitude the light is being measured at, so a peak two kilometres up is
//  lit through visibly less air than the valley floor below it. At sunset that
//  is the difference between a summit still catching gold and the shadowed
//  valley beneath it - a real effect, and free here because the shader already
//  knows where it is.
uniform int       u_SunTransEnabled;
uniform sampler2D u_SunTransLUT;

//
//  /!\ AND THE PLANET IS IN THE WAY ONCE THE SUN HAS SET. The table only holds
//  rays that miss the ground, so a lookup below the horizon clamps to the
//  horizon's own value - the reddest light of the day - and a sun five degrees
//  under the ground went on lighting every west-facing post in the scene a
//  glowing red. The fraction of the sun's disc still above this point's
//  geometric horizon is multiplied in; its angular radius is the soft edge.
float FZE_SunAboveHorizon(FZEAtmosphere atmo, float r, float mu) {
    float muHorizon = -sqrt(max(1.0 - (atmo.BottomRadius / r) * (atmo.BottomRadius / r), 0.0));
    const float sunRadius = 0.0047;          // the sun's angular radius, radians
    return smoothstep(muHorizon - sunRadius, muHorizon + sunRadius, mu);
}

vec3 FZE_SunThroughAir(FZEAtmosphere atmo, vec3 worldPos, vec3 sunDir) {
    float mu = clamp(sunDir.y, -1.0, 1.0);
    // With no atmosphere the ground is flat and there is no air to dim it.
    if (u_SunTransEnabled != 1) return vec3(smoothstep(-0.0047, 0.0047, mu));
    // World Y is metres above the surface; the table wants a radius in km.
    float r = atmo.BottomRadius + max(worldPos.y, 0.0) * 0.001;
    return FZE_TransmittanceLookup(atmo, u_SunTransLUT, r, mu) * FZE_SunAboveHorizon(atmo, r, mu);
}

#endif  // FZE_SKYSAMPLE_GLSL
