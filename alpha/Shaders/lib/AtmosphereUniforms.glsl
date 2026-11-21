// ============================================================================
//  The atmosphere's parameters, as uniforms, declared once.
//
//  Five shaders need the same fourteen numbers - the three LUT builders, the sky
//  and the aerial-perspective pass - and a set of parameters copied into five
//  files is a set of parameters that will disagree. Include this and call
//  FZE_AtmosphereFromUniforms(); SkyAtmosphere.cpp uploads them from one place.
// ============================================================================

#ifndef FZE_ATMOSPHERE_UNIFORMS_GLSL
#define FZE_ATMOSPHERE_UNIFORMS_GLSL

#include "Atmosphere.glsl"

uniform float u_AtmoBottomRadius;      // km
uniform float u_AtmoTopRadius;         // km
uniform vec3  u_AtmoRayleighScatter;   // 1/km
uniform float u_AtmoRayleighHeight;    // km
uniform vec3  u_AtmoMieScatter;        // 1/km
uniform vec3  u_AtmoMieAbsorb;         // 1/km
uniform float u_AtmoMieHeight;         // km
uniform float u_AtmoMieG;
uniform vec3  u_AtmoOzoneAbsorb;       // 1/km
uniform float u_AtmoOzoneCentre;       // km
uniform float u_AtmoOzoneWidth;        // km
uniform vec3  u_AtmoGroundAlbedo;
// ⚠️ THE TABLES HOLD THE SKY PER UNIT OF SUNLIGHT. The sky-view and aerial
// tables are built with a sun of luminance 1 (its colour only), so a camera
// adapting or a sun being dimmed does not rebuild them - or the ambient bake
// that reads them, which cost 60 ms of CPU stall a time and ran on every
// half-stop step of the eye. Whatever samples them multiplies by this: the
// sun's lux times the camera's pre-exposure.
uniform float u_AtmoRadianceScale;
// The planet's surface: what leaves it toward the sky, per unit of sunlight
// (its albedo x (sun + sky) / pi - SkyAtmosphere::SetGroundLight).
uniform vec3  u_AtmoGroundLight;

FZEAtmosphere FZE_AtmosphereFromUniforms() {
    FZEAtmosphere a;
    a.BottomRadius        = u_AtmoBottomRadius;
    a.TopRadius           = u_AtmoTopRadius;
    a.RayleighScattering  = u_AtmoRayleighScatter;
    a.RayleighScaleHeight = u_AtmoRayleighHeight;
    a.MieScattering       = u_AtmoMieScatter;
    a.MieAbsorption       = u_AtmoMieAbsorb;
    a.MieScaleHeight      = u_AtmoMieHeight;
    a.MieAnisotropy       = u_AtmoMieG;
    a.OzoneAbsorption     = u_AtmoOzoneAbsorb;
    a.OzoneCentre         = u_AtmoOzoneCentre;
    a.OzoneWidth          = u_AtmoOzoneWidth;
    a.GroundAlbedo        = u_AtmoGroundAlbedo;
    return a;
}

// The planet's ground seen along `dir` from `viewHeight` (km from the centre):
// its own light through the air in front of it, in the same units as the
// tables times u_AtmoRadianceScale. Zero for a ray that misses the planet.
// The air is taken at its sea-level density, which a viewer standing on the
// ground looks through to its horizon (a few km): the far ground goes blue.
vec3 FZE_GroundSeen(FZEAtmosphere atmo, float viewHeight, vec3 dir) {
    float t = FZE_RaySphere(vec3(0.0, viewHeight, 0.0), dir, atmo.BottomRadius);
    if (t < 0.0) return vec3(0.0);
    vec3 extinction = atmo.RayleighScattering + atmo.MieScattering + atmo.MieAbsorption;   // 1/km
    return u_AtmoGroundLight * exp(-extinction * t) * u_AtmoRadianceScale;
}

#endif  // FZE_ATMOSPHERE_UNIFORMS_GLSL
