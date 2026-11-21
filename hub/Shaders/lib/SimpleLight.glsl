// =============================================================================
//  THE SIMPLE SURFACE'S LIGHT (Rendering Features > Simple Surfaces).
//
//  The sun with its shadow, one highlight, the sky, the sky in what is smooth or
//  metal, and the lamps. One function, so a wall and the ground it stands on are
//  lit alike. Beside the full surface on a street of brick, wood and asphalt the
//  picture is all but the same, and on a UHD 620 it costs half: see docs/LAB.md.
//
//  Include after lib/Lighting.glsl.
// =============================================================================
#ifndef FZE_SIMPLELIGHT_GLSL
#define FZE_SIMPLELIGHT_GLSL

vec3 FZE_SimpleLight(vec3 P, vec3 N, vec3 V, float eyeDist, vec3 albedo, float metal, float rough, float ao) {
    const float kPi = 3.14159265359;
    vec3 L = normalize(u_SunDir);
    float ndl = max(dot(N, L), 0.0);
#ifdef FZE_EXP_NO_SHADOW
    float shadow = 1.0;
#else
    float shadow = ndl > 0.0 ? SunShadowTapAt(P, eyeDist) : 0.0;
#endif
#ifdef FZE_EXP_NO_AIR
    vec3 sun = u_SunIlluminance;
#else
    vec3 sun = u_SunIlluminance * FZE_SunThroughAir(FZE_AtmosphereFromUniforms(), P, L);
#endif
    vec3 sky = u_HasIBL == 1 ? texture(u_IrradianceMap, N).rgb * u_IBLScale * u_SkyLightIntensity : vec3(0.0);
    float screenAO = u_HasSSAO == 1 ? texture(u_SSAOMap, gl_FragCoord.xy / u_ScreenSize).r : 1.0;
    metal = clamp(metal, 0.0, 1.0);
    rough = clamp(rough, 0.12, 1.0);
    vec3 f0 = mix(vec3(0.04), albedo, metal);
    vec3 color = albedo * (1.0 - metal) * (sun * ndl * shadow / kPi + sky * ao * screenAO);
    // The sun's highlight, one lobe of it. What is rough has none to speak of and saves the pow.
    if (rough < 0.9 && ndl * shadow > 0.0) {
        float a2 = rough * rough * rough * rough;
        float e = 2.0 / max(a2, 0.0008) - 2.0;
        color += sun * ndl * shadow * f0 * pow(max(dot(N, normalize(L + V)), 0.0), e) * (e + 8.0) / (8.0 * kPi);
    }
    // The sky in anything smooth or metal, stronger at a glance.
    if (u_HasIBL == 1 && (metal > 0.01 || rough < 0.6)) {
        float f = pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 sheen = textureLod(u_PrefilterMap, reflect(-V, N), rough * float(max(u_PrefilterMips - 1, 1))).rgb * u_IBLScale * u_SkyLightIntensity;
        color += sheen * (f0 + (max(vec3(1.0 - rough), f0) - f0) * f) * ao * screenAO;
    }
    // The lamps, the plain way: how much reaches this pixel and how square it lands.
#ifndef FZE_EXP_NO_LAMPS
    if (u_LightCount > 0) {
        uint cl = FZE_ClusterIndex(gl_FragCoord.xy, P);
        uvec2 range = fzeClusters[cl];
        int total = u_ClusterBypass == 1 ? u_LightCount : u_DirectionalCount + int(range.y);
        vec3 lamps = vec3(0.0);
        for (int k = u_ClusterBypass == 1 ? 0 : u_DirectionalCount; k < total; ++k) {
            int i = u_ClusterBypass == 1 ? k : int(fzeClusterItems[range.x + uint(k - u_DirectionalCount)]);
            vec3 Lp;
            float dist;
            float atten = FZE_LightAt(i, P, Lp, dist);
            if (atten > 0.0) lamps += fzeLights[i].Intensity.rgb * atten * max(dot(N, Lp), 0.0);
        }
        color += albedo * (1.0 - metal) * lamps / kPi;
    }
#endif
    return color;
}

#endif
