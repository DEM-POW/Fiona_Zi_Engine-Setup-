// ============================================================================
//  Applying aerial perspective, in one place.
//
//  Four surface shaders need this - lit meshes, terrain, foliage and water - and
//  a distance-fade written four times is four things that will disagree about
//  where the horizon is. Terrain fading to one haze and the trees standing on it
//  fading to another is the exact seam this file exists to prevent.
//
//  The composite is not a mix. The air does two separate things to what is
//  behind it, and they are not opposites:
//
//      colour = colour * transmittance + inScattered
//
//  Transmittance is what is LEFT of the object, per channel, and in-scatter is
//  what the air ADDS on top. A lerp toward a fog colour conflates the two, which
//  is why fogged renders lose their blacks: a lerp brightens a shadow toward the
//  fog instead of leaving the little of it that survives and adding sky to it.
// ============================================================================

#ifndef FZE_AERIAL_GLSL
#define FZE_AERIAL_GLSL

#include "AtmosphereUniforms.glsl"

uniform int       u_AerialEnabled;
uniform sampler3D u_AerialScatter;
uniform sampler3D u_AerialTransmittance;
uniform float     u_AerialMaxDistance;   // world units the volume reaches
uniform float     u_AerialSlices;

// `screenUV` is gl_FragCoord.xy / screenSize; `distance` is world units from
// the camera to this fragment.
vec3 FZE_ApplyAerial(vec3 color, vec2 screenUV, float distanceUnits) {
    if (u_AerialEnabled != 1) return color;

    // ⚠️ THE SAME SQUARE-ROOT MAPPING THE VOLUME WAS FILLED WITH. The slices are
    // spaced by the square of the index, so reading them back linearly samples
    // the near field with the far field's data and puts the entire haze curve in
    // the wrong place - a mistake that looks like "the fog is too strong up
    // close", which is a thing anyone would then try to fix with a slider.
    float t = sqrt(clamp(distanceUnits / max(u_AerialMaxDistance, 1e-4), 0.0, 1.0));

    // Half a slice in, so the first and last slices are sampled at their centres
    // rather than clamped off the end of the volume.
    float w = clamp(t, 0.5 / u_AerialSlices, 1.0 - 0.5 / u_AerialSlices);
    vec3 uvw = vec3(screenUV, w);

    vec3 scatter = texture(u_AerialScatter, uvw).rgb * u_AtmoRadianceScale;   // per unit of sunlight
    vec3 trans   = texture(u_AerialTransmittance, uvw).rgb;

    // ⚠️ FADED OUT OVER THE FIRST SLICE. The volume's near plane is not the
    // camera, so a fragment a metre away would otherwise get a whole slice of
    // air applied to it and the player's own hands would be hazy. Below the
    // first slice there is no data, and the honest value there is "none".
    float near = smoothstep(0.0, 1.0 / u_AerialSlices, t);
    scatter *= near;
    trans = mix(vec3(1.0), trans, near);

    return color * trans + scatter;
}

#endif  // FZE_AERIAL_GLSL
