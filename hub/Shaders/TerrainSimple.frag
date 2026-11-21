#version 460 core

// =============================================================================
//  THE GROUND, SIMPLE - what a game chooses when the ground fills its screen.
//
//  Terrain.frag asks up to four layers for colour and detail from up to three
//  directions, and then runs the whole of lib/Lighting.glsl. On a UHD 620, with
//  a mountain in front of the camera, that was 106 ms of a 121 ms frame at 360
//  lines. This file asks one or two layers for colour from straight above, and
//  lights them with the sun, its shadow and the sky. Same heights, same grid,
//  same physics: only what happens at a pixel is different.
//
//  ⚠️ THE HEAP IS WHERE THE HEIGHT IS, NOT WHERE IT WAS PAINTED. A layer can be
//  named as the heap: it shows only above u_HeapFloor. So ground dug bare is bare
//  the moment it is dug, a loaded save agrees with its own heights, and nothing
//  can look like rubbish and turn out not to be there.
// =============================================================================

in vec3 v_WorldPos;
in vec2 v_Cell;
layout(location = 0) out vec4 FragColor;

uniform vec3  u_CameraPos;
uniform float u_CellSize;
uniform float u_Resolution;

uniform sampler2D      u_Height;
uniform sampler2D      u_Splat;
uniform sampler2DArray u_LayerAlbedo;
uniform int   u_LayerCount;
uniform vec4  u_LayerScale;
uniform vec4  u_LayerGrass[4];  // Ground Under Grass: per layer, the grass's colour (premultiplied) and cover
uniform int   u_HeapLayer;      // -1: none
uniform float u_HeapFloor;      // metres

#include "lib/Material.glsl"
#include "lib/Fog.glsl"
#include "lib/AerialPerspective.glsl"
#include "lib/SkySample.glsl"
#include "lib/AtmosphereUniforms.glsl"
#include "lib/Lighting.glsl"

void main() {
    o_SurfaceInfo = vec4(0.0, 0.0, 1.0, 0.0);
    vec3 P = v_WorldPos;
    vec2 texel = 1.0 / vec2(u_Resolution);
    vec2 uv = (v_Cell + 0.5) * texel;

    float h  = texture(u_Height, uv).r;
    float hr = texture(u_Height, uv + vec2(texel.x, 0.0)).r;
    float hu = texture(u_Height, uv + vec2(0.0, texel.y)).r;
    vec3 N = normalize(vec3(h - hr, u_CellSize, h - hu));

    vec4 w = texture(u_Splat, uv);
    if (u_HeapLayer >= 0 && h < u_HeapFloor) {
        w[0] += w[u_HeapLayer];
        w[u_HeapLayer] = 0.0;
    }

    vec3 tint = vec3(0.0);
    float sum = 0.0;
    if (w.x > 0.02) { tint += w.x * texture(u_LayerAlbedo, vec3(P.xz * u_LayerScale.x, 0.0)).rgb; sum += w.x; }
    if (w.y > 0.02) { tint += w.y * texture(u_LayerAlbedo, vec3(P.xz * u_LayerScale.y, 1.0)).rgb; sum += w.y; }
    if (w.z > 0.02) { tint += w.z * texture(u_LayerAlbedo, vec3(P.xz * u_LayerScale.z, 2.0)).rgb; sum += w.z; }
    if (w.w > 0.02) { tint += w.w * texture(u_LayerAlbedo, vec3(P.xz * u_LayerScale.w, 3.0)).rgb; sum += w.w; }
    vec3 albedo = pow(max(tint / max(sum, 0.001), vec3(0.0)), vec3(2.2));
    // Tone over tens of metres, read from a tiny mip of the heap's own picture, so a
    // field of one texture is not the same few metres repeated to the horizon.
    float tone = dot(textureLod(u_LayerAlbedo, vec3(P.xz * 0.0231, 1.0), 3.0).rgb, vec3(0.333));
    albedo *= clamp(tone * 3.0, 0.72, 1.2);

    // The ground under grass, as Terrain.frag has it (Rendering Features > Ground Under Grass):
    // a little near, fully far; ground painted with nothing keeps its own colour.
    vec4 lw = sum > 0.0 ? w / max(w.x + w.y + w.z + w.w, 1e-4) : vec4(0.0);
    vec4 gg = u_LayerGrass[0] * lw.x + u_LayerGrass[1] * lw.y + u_LayerGrass[2] * lw.z + u_LayerGrass[3] * lw.w;
    if (gg.a > 0.001)
        albedo = mix(albedo, gg.rgb / gg.a, gg.a * mix(0.6, 1.0, smoothstep(8.0, 50.0, distance(P, u_CameraPos))));

    vec3 L = normalize(u_SunDir);
    float ndl = max(dot(N, L), 0.0);
    float shadow = ndl > 0.0 ? SunShadowTapAt(P, distance(P, u_CameraPos)) : 0.0;
    vec3 sun = u_SunIlluminance * FZE_SunThroughAir(FZE_AtmosphereFromUniforms(), P, L);
    vec3 sky = u_HasIBL == 1 ? texture(u_IrradianceMap, N).rgb * u_IBLScale * u_SkyLightIntensity : vec3(0.0);
    vec3 color = albedo * (sun * ndl * shadow / 3.14159265 + sky);

    // The lamps, the plain way: how much reaches this pixel and how square it lands. No
    // highlight, no shadow. A day with every lamp off pays one comparison for this.
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
        color += albedo * lamps / 3.14159265;
    }

    color = FZE_ApplyFog(color,
                         FZE_FogRadiance(pow(max(u_FogColor, 0.0), vec3(2.2)), P - u_CameraPos),
                         FZE_FogDepth(u_CameraPos, P));
    color = FZE_ApplyAerial(color, gl_FragCoord.xy / max(u_ScreenSize, vec2(1.0)), length(P - u_CameraPos));
    FragColor = vec4(color, 1.0);
}
