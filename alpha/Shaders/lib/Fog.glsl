// ---------------------------------------------------------------
//  Fiona Zi Engine — atmospheric fog
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// ONE PLACE WHERE THIS ENGINE DECIDES HOW FAR YOU CAN SEE.
//
// ⚠️ It was three, and they did not agree. Lit.frag, Terrain.frag and
// Foliage.frag each carried their own `1 - exp(-density * distance)`; two of them
// linearised the fog colour and the third did not, so a tree and the ground it
// stood on faded towards measurably different greys. That is not a fog bug anyone
// files - it reads as "the foliage looks pasted on".
//
// ⚠️ AND THE FOG HAD NO HEIGHT. Air is not a uniform slab: its density falls off
// exponentially with altitude, which is the entire reason distance reads as
// distance in a landscape. With a uniform slab a mountain top 400 m up is hazed
// exactly as much as the valley floor beneath it, so the two sit at the same
// apparent depth and the range flattens into a painted backdrop. It is also why
// the crepuscular rays had nothing to light: shafts need air that is DENSE LOW
// DOWN and thin above, or every sample along the ray returns the same number and
// the beam has no shape.
//
// The density profile:
//
//     rho(y) = FogDensity * exp(-(y - FogBaseHeight) / FogHeightFalloff)
//
// FogDensity is the extinction (per metre) at FogBaseHeight; FogHeightFalloff is
// the altitude over which it drops by 1/e. Setting the falloff to 0 restores the
// uniform slab exactly, which is what every scene authored before this file gets
// on load - no scene changes appearance until someone types a height into it.
//
// The optical depth along a segment is INTEGRATED, not sampled. Height y is
// linear in t along a straight segment, so the integral of an exponential in a
// linear argument has a closed form and costs two exp() calls - no ray march, no
// step count, no banding, and correct for a camera above the fog looking down
// into it as well as the usual case.
// ---------------------------------------------------------------

uniform vec3  u_FogColor;
uniform float u_FogDensity;         // extinction per metre, AT u_FogBaseHeight
uniform float u_FogHeightFalloff;   // metres per 1/e; 0 = uniform slab (legacy)
uniform float u_FogBaseHeight;      // metres; where u_FogDensity is the density

// exp() of a large positive number overflows to inf, and inf * 0 later is NaN -
// a black pixel instead of a white one. Anything past e^40 is already "fully
// fogged" a hundred times over, so the clamp costs nothing visible.
const float FZE_FOG_MAX_EXP = 40.0;

// Optical depth between two world points. Multiply-free of any view assumption:
// works for camera->surface, and for surface->light if anything ever needs it.
float FZE_FogDepth(vec3 fromP, vec3 toP) {
    float d = distance(fromP, toP);
    if (u_FogDensity <= 0.0 || d <= 0.0) return 0.0;

    if (u_FogHeightFalloff <= 0.0)
        return u_FogDensity * d;                       // uniform slab

    float H = u_FogHeightFalloff;
    float a = clamp((fromP.y - u_FogBaseHeight) / H, -FZE_FOG_MAX_EXP, FZE_FOG_MAX_EXP);
    float b = clamp((toP.y   - u_FogBaseHeight) / H, -FZE_FOG_MAX_EXP, FZE_FOG_MAX_EXP);
    float dy = b - a;

    // integral over t in [0,1] of exp(-(a + t*dy)) = (e^-a - e^-b) / dy,
    // and its limit as dy -> 0 is e^-a. The branch is the limit, not a hack:
    // evaluating the quotient near zero cancels two nearly equal numbers and the
    // result loses every significant digit it had.
    float integral = (abs(dy) < 1e-4) ? exp(-a) : (exp(-a) - exp(-b)) / dy;
    return u_FogDensity * d * integral;
}

// Optical depth from a point along a direction that never hits anything - the
// sky. This is the d -> infinity limit of FZE_FogDepth, and it is the reason the
// horizon DISSOLVES instead of ending in a line: as the ray flattens, dir.y goes
// to zero and the depth goes to infinity, so the sky at the horizon reaches the
// fog colour exactly while the zenith above it stays clear.
float FZE_FogDepthSky(vec3 fromP, vec3 dir) {
    if (u_FogDensity <= 0.0) return 0.0;
    // ⚠️ A UNIFORM SLAB DOES NOT FOG THE SKY, AND THAT IS A COMPATIBILITY CHOICE
    // RATHER THAN PHYSICS. Taken literally, infinite uniform air means infinite
    // optical depth, so the entire sky would become the fog colour - which is
    // exactly what would happen to every scene already authored with a falloff of
    // zero, WaterLab included, the moment this function shipped. Fog with no
    // height is not an atmosphere; it is an artistic distance fade, and a
    // distance fade has nothing to say about a dome at infinity. Type a falloff
    // in and the sky joins in.
    if (u_FogHeightFalloff <= 0.0) return 0.0;

    float H = u_FogHeightFalloff;
    float a = clamp((fromP.y - u_FogBaseHeight) / H, -FZE_FOG_MAX_EXP, FZE_FOG_MAX_EXP);
    if (dir.y <= 1e-4) return 1e6;                     // level or downward: no escape
    return u_FogDensity * H * exp(-a) / dir.y;
}

// Transmittance: the fraction of the surface's own light that survives the trip.
float FZE_FogTransmittance(float depth) {
    return exp(-clamp(depth, 0.0, FZE_FOG_MAX_EXP));
}

// The composite. `fogRadiance` must be in the SAME space as `color` - see the
// call sites: surfaces work in linear radiance and linearise the picked colour,
// the sky works in display values and does not.
vec3 FZE_ApplyFog(vec3 color, vec3 fogRadiance, float depth) {
    return mix(fogRadiance, color, FZE_FogTransmittance(depth));
}

// ---------------------------------------------------------------------------
//  Directional inscattering — the fog knows where the sun is
// ---------------------------------------------------------------------------
//
// ⚠️ WITHOUT THIS, FOG IS A GREY WALL AND IT IS THE SAME GREY IN EVERY
// DIRECTION. Real haze is bright when you look towards the sun and dark when
// you look away from it, by a factor of tens — that difference is what makes a
// misty morning read as MORNING rather than as a low-contrast filter, and it is
// the whole reason a sunset paints the air rather than just the sky.
//
// It is also the missing ingredient under the crepuscular rays. A shaft is
// light scattered towards the eye by whatever is in its path; drawn on top of
// air that does not scatter, it is an additive smear with nothing underneath it
// to belong to. The rays were tuned brighter twice to compensate, which is
// treating the symptom.
//
// The single scattering approximation: one Henyey-Greenstein lobe pointed along
// the sun direction, added to the fog's own colour and weighted by exactly the
// same (1 - transmittance) the fog is. No march, no shadowing — the shafts pass
// already handles what BLOCKS the light. g is fixed at 0.72: dust and water
// droplets are strongly forward-scattering, and one more slider that every
// scene would leave at its default is not a control, it is a liability.

uniform vec3  u_FogSunDir;      // direction TOWARDS the sun, normalised
uniform vec3  u_FogSunColor;    // sun radiance; uploaded identically everywhere,
                                // because Sky.frag and Lit.frag disagree about
                                // whether u_LightColor carries the intensity
uniform float u_FogInscatter;   // single-scattering albedo, 0 = off (the default)
// ⚠️ THE SKY'S LIGHT ON THE AIR, which the fog colour only TINTS. The authored
// colour used to be the fog's radiance itself, in display units - so the same
// grey haze glowed at midnight as at noon, and once the lights were physical
// the camera, opened up for the night, showed it as a lit wall. What a patch
// of fog sends is the sky's light it scatters: the irradiance of the sky on a
// white card (from the ambient bake) times the colour, pre-exposed like every
// light.
uniform vec3  u_FogAmbient;

// Water droplets and dust scatter strongly FORWARD. 0.72 is in the usual range
// for atmospheric haze; one more slider that every scene would leave at its
// default is not a control, it is a liability.
const float FZE_FOG_G = 0.72;

// Henyey-Greenstein, normalised over the sphere: its integral is 1, so it is a
// redistribution of light rather than a gain, and 0.72 concentrates about 64x
// more of it towards the sun than away from it.
float FZE_HenyeyGreenstein(float cosTheta, float g) {
    float gg = g * g;
    float d  = max(1.0 + gg - 2.0 * g * cosTheta, 1e-4);
    return (1.0 - gg) / (4.0 * 3.14159265 * d * sqrt(d));
}

// The fog's own radiance towards the eye, looking along `viewDir` (eye -> point).
//
// baseFog is the ambient term: sky light scattered from every direction, which
// is what the authored fog colour has always been. The added term is the SUN,
// scattered once by the same air - so the two are not two greys, they are the
// two light sources that air actually has. u_FogInscatter is the single
// scattering albedo: about 0.9 for water droplets, 0 for "leave it alone".
vec3 FZE_FogRadiance(vec3 baseFog, vec3 viewDir) {
    baseFog *= u_FogAmbient;
    if (u_FogInscatter <= 0.0) return baseFog;
    float ph = FZE_HenyeyGreenstein(dot(normalize(viewDir), u_FogSunDir), FZE_FOG_G);
    return baseFog + u_FogInscatter * ph * u_FogSunColor;
}
