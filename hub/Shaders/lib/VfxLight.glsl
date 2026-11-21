// ---------------------------------------------------------------
//  Fiona Zi Engine — the light an effect's particle receives
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//  ⚠️ SMOKE WAS ONE COLOUR. Every alpha sprite took the same "white card in
//  daylight" (Renderer::SpriteLighting): no sunlit side, no shadow under a
//  roof, no lamp reaching a smoke column at night. Here a particle is lit
//  where it is, once per vertex (the cost of a sprite, not of its pixels):
//
//    the sky      the IBL irradiance, from above and from the side it is
//                 seen from (a puff is lit all round, mostly from above);
//    the sun      through its shadow map at the particle - smoke in the shade
//                 of a wall is in the shade - with a forward lobe: smoke
//                 between the eye and the sun glows at its edges, the
//                 silver lining every reference photograph of smoke shows;
//    the lamps    the light clusters' list at the particle (the same lists
//                 the lit pass walks, so a street lamp lights its smoke);
//    a flash      lightning.
//
//  Radiance per unit of albedo, pre-exposed like every light. The sun is
//  kept apart so a sprite with a normal map can shape it per pixel.
// ---------------------------------------------------------------
#ifndef FZE_VFXLIGHT_GLSL
#define FZE_VFXLIGHT_GLSL

#include "Lights.glsl"
#include "Shadows.glsl"

uniform samplerCube u_Irradiance;
uniform int   u_HasIBL;
uniform float u_SkyScale;          // sky light x the bake's scale (which carries the camera)
uniform vec3  u_SunDir;            // toward the sun
uniform vec3  u_SunE;              // lux at the ground, through the air, pre-exposed (0: no sun)
uniform vec3  u_FlashLight;        // lux x pre-exposure, toward u_FlashDir
uniform vec3  u_FlashDir;
uniform float u_Scatter;           // the forward lobe: 0 matte dust .. 0.6 thin steam

const float FZE_INV_PI = 0.31830988618;

// Henyey-Greenstein, relative to an even scatter (1 = isotropic).
float FZE_VfxLobe(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
}

// `fragCoord`: where the particle lands on the target the clusters were
// built for (pixels). `ambient` gathers the sky, the lamps and a flash;
// `sun` the shadowed sun with its lobe, before any surface shaping.
void FZE_VfxLight(vec3 P, vec3 toEye, vec2 fragCoord, out vec3 ambient, out vec3 sun) {
    ambient = vec3(0.0);
    if (u_HasIBL == 1)
        ambient = (texture(u_Irradiance, vec3(0.0, 1.0, 0.0)).rgb * 0.55
                 + texture(u_Irradiance, toEye).rgb * 0.45) * u_SkyScale;

    sun = vec3(0.0);
    if (dot(u_SunE, u_SunE) > 0.0 && u_SunDir.y > -0.1) {
        float lobe = FZE_VfxLobe(dot(-u_SunDir, toEye), u_Scatter);
        sun = u_SunE * SunShadowTap(P) * FZE_INV_PI * mix(1.0, min(lobe, 6.0), 0.6);
    }

    uint cl = FZE_ClusterIndex(fragCoord, P);
    uvec2 range = fzeClusters[cl];
    int total = u_ClusterBypass == 1 ? min(u_LightCount, 32) : u_DirectionalCount + int(range.y);
    for (int k = 0; k < total; ++k) {
        int i = (k < u_DirectionalCount || u_ClusterBypass == 1)
              ? k : int(fzeClusterItems[range.x + uint(k - u_DirectionalCount)]);
        vec3 L;
        float dist;
        float atten = FZE_LightAt(i, P, L, dist);
        if (atten <= 0.0) continue;
        float lobe = FZE_VfxLobe(dot(-L, toEye), u_Scatter);
        ambient += fzeLights[i].Intensity.rgb * atten * FZE_INV_PI * mix(1.0, min(lobe, 6.0), 0.6);
    }

    if (dot(u_FlashLight, u_FlashLight) > 0.0)
        ambient += u_FlashLight * FZE_INV_PI * 0.6;
}

#endif
