// ============================================================================
//  THE SKY AS THE IBL SEES IT - one copy, for the capture and the daylight
//  readout (Renderer/IBL). It was written out twice, in the irradiance and the
//  prefilter shaders, and both evaluated it for every sample they took.
//
//  Matches Sky.frag's low frequencies: the exact same gradient curve + sun
//  tint, plus the two things that matter to ambient light - an HDRI is sampled
//  directly (that's what makes image-based lighting image-based), and cloud
//  cover dims/desaturates the dome. Per-texel cloud SHAPES are deliberately
//  absent: after a hemisphere convolution they only survive as this average
//  anyway.
// ============================================================================

#include "SkySample.glsl"
#include "AtmosphereUniforms.glsl"

#ifndef PI
#define PI 3.14159265359
#endif

uniform int   u_SkyMode;        // 0 procedural, 1 HDRI
uniform sampler2D u_Skybox;
uniform float u_SkyboxRotation; // radians
uniform float u_SkyboxIntensity;
uniform float u_CloudCover;     // 0 = clear, otherwise CloudCoverage

vec3 Sky(vec3 d) {
    if (u_SkyMode == 1) {
        float cr = cos(u_SkyboxRotation), sr = sin(u_SkyboxRotation);
        vec3 rd = vec3(cr * d.x - sr * d.z, d.y, sr * d.x + cr * d.z);
        vec2 uv = vec2(atan(rd.z, rd.x) / (2.0 * PI) + 0.5,
                       acos(clamp(rd.y, -1.0, 1.0)) / PI);
        return textureLod(u_Skybox, uv, 3.0).rgb * u_SkyboxIntensity;
    }
    // /!\ THE WORLD IS LIT BY THE SKY IT IS ACTUALLY STANDING UNDER. Sky.frag
    // and this read the same table, so when the sun drops and the sky goes
    // orange the light in the scene goes with it - not because anything tints
    // the ambient, but because that IS the ambient. In the same pre-exposed
    // units as every light. With the atmosphere switched off there is no air
    // to scatter anything: the sky is black, as it is in space.
    //
    // ⚠️ NO SUN IN HERE. A "sun lobe" of 0.8 used to be added to this sky, so
    // every glossy surface reflected the sun twice - once through this map and
    // once from the sun's own light in the lit pass - and the second copy was
    // a number nobody could relate to the first.
    vec3 c = u_SkyLutEnabled == 1 ? FZE_SkyRadiance(FZE_AtmosphereFromUniforms(), d) : vec3(0.0);
    // Overcast: ambient flattens toward grey and loses energy.
    float grey = dot(c, vec3(0.333));
    c = mix(c, vec3(grey) * 0.72, u_CloudCover * 0.65);
    return c;
}
