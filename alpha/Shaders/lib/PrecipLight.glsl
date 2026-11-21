// ---------------------------------------------------------------
//  Fiona Zi Engine — the light a falling particle shows
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//  A raindrop is a lens: it gathers light from most of the sphere round it
//  and sends it on (Garg & Nayar, "Photorealistic Rendering of Rain Streaks",
//  2006) - roughly the average brightness of its surroundings, plus a strong
//  forward lobe: a drop between the eye and a lamp lights up, which is why
//  rain is seen in a streetlight's cone and against a bright window and
//  hardly anywhere else at night. A flake scatters more evenly; dust and ash
//  are matte.
//
//  Computed once per particle per frame, in the simulation: the sky (the IBL
//  irradiance from above), every light in the light buffer - the sun among
//  the directional ones, shadowed by a ray through the weather map's heights -
//  and a lightning flash.
// ---------------------------------------------------------------
#ifndef FZE_PRECIPLIGHT_GLSL
#define FZE_PRECIPLIGHT_GLSL

#include "Lights.glsl"
#include "WeatherMap.glsl"

uniform samplerCube u_Irradiance;
uniform int   u_HasIBL;
uniform float u_SkyScale;          // sky light x the bake's scale (which carries the camera)
uniform vec3  u_FlashLight;        // lux x pre-exposure, toward u_FlashDir
uniform vec3  u_FlashDir;
uniform vec3  u_CameraPos;

float FZE_PrecipHG(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

// Radiance (pre-exposed) a particle at p shows the camera. g: its forward
// lobe (0.75 water, 0.35 snow, 0 dust); shine: how much light it catches.
vec3 FZE_PrecipLight(vec3 p, float g, float shine) {
    vec3 toEye = normalize(u_CameraPos - p);
    // The sky: what the ground under it would be lit by, as a drop's average.
    vec3 sky = u_HasIBL == 1 ? texture(u_Irradiance, vec3(0.0, 1.0, 0.0)).rgb * u_SkyScale : vec3(0.0);
    // Under a roof or in an alley the drop sees less of it.
    sky *= mix(0.35, 1.0, FZE_WeatherOpen(p, vec3(0.0, 1.0, 0.0)));
    // ⚠️ A DROP SHOWS THE SKY ABOVE IT, NOT THE GROUND'S AVERAGE: refracted,
    // the bright upper hemisphere fills most of what it sends on (Garg &
    // Nayar's environment map of a drop is mostly sky). Brighter than the
    // irradiance a matte surface takes - by the shine.
    vec3 L = sky * mix(0.6, 1.8, clamp(shine, 0.0, 1.0));
    int n = min(u_LightCount, 64);
    for (int i = 0; i < n; ++i) {
        FZELight li = fzeLights[i];
        int type = int(li.Intensity.w + 0.5);
        vec3 E;
        vec3 toLight;
        if (type == 2) {
            toLight = -li.DirCos.xyz;
            E = li.Intensity.rgb * FZE_WeatherOpen(p, toLight);
        } else {
            vec3 d = li.PosRange.xyz - p;
            float d2 = dot(d, d);
            float r = li.PosRange.w;
            if (d2 > r * r) continue;
            toLight = d * inversesqrt(max(d2, 1e-6));
            float x = d2 / (r * r);
            float win = (1.0 - x * x);
            E = li.Intensity.rgb * (win * win / max(d2, 0.04));
            if (type == 1) {
                float cd = dot(-toLight, li.DirCos.xyz);
                E *= smoothstep(li.DirCos.w, li.Params.x, cd);
            }
        }
        // Light arriving along -toLight, leaving toward the eye.
        float c = dot(-toLight, toEye);
        L += E * shine * (0.04 + 2.2 * FZE_PrecipHG(c, g));
    }
    if (dot(u_FlashLight, u_FlashLight) > 0.0)
        L += u_FlashLight * (0.08 + 1.2 * FZE_PrecipHG(dot(-u_FlashDir, toEye), g * 0.5));
    return L;
}

#endif // FZE_PRECIPLIGHT_GLSL
