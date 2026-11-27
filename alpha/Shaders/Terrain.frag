#version 460 core

// =============================================================================
//  THE GROUND - rebuilt from nothing (2026-09-23).
//
//  This file decides what the ground IS at a pixel - which painted layers,
//  their colour, bumps, roughness and occlusion - and nothing else. How it is
//  lit is lib/Lighting.glsl, the one function every mesh is lit by; how rain
//  lies on it is lib/Weather.glsl, the one the kerb beside it uses. The old
//  terrain carried a copy of both and they had drifted apart from the meshes.
// =============================================================================

in vec3 v_WorldPos;
in vec2 v_Cell;
layout(location = 0) out vec4 FragColor;

uniform vec3  u_CameraPos;
uniform float u_CellSize;
uniform float u_Resolution;

uniform sampler2D      u_Height;        // metres (TerrainComponent::Heights)
uniform sampler2D      u_Splat;         // layer weights, painted
uniform sampler2DArray u_LayerAlbedo;   // rgb colour as authored (sRGB), a height
uniform sampler2DArray u_LayerDetail;   // rg tangent normal, b roughness, a occlusion
uniform int   u_LayerCount;
uniform int   u_MaterialView;   // the editor's buffer views, as Lit.frag (Renderer::SetMaterialView)
uniform int   u_LightingOnly;   // the editor's Lighting Only view
uniform vec4  u_LayerScale;             // repeats per metre, per layer
uniform vec4  u_LayerGrass[4];          // Ground Under Grass: per layer, the grass's colour (linear) and cover

uniform vec4  u_Brush;                  // editor: world x, z, radius; w = 1 shown
uniform vec3  u_BrushColor;

#include "lib/Material.glsl"
#include "lib/Fog.glsl"
#include "lib/AerialPerspective.glsl"
#include "lib/SkySample.glsl"
#include "lib/AtmosphereUniforms.glsl"
#include "lib/Weather.glsl"
#include "lib/Lighting.glsl"
#include "lib/SimpleLight.glsl"
#include "lib/Decals.glsl"

// ---- one layer, projected the way the ground faces -----------------------------
//
// ⚠️ TRIPLANAR, BUT ONLY WHERE IT IS NEEDED. Projected straight down, a texture
// on a cliff is smeared into vertical streaks, because a metre of rock face
// covers a centimetre of the map. So each pixel takes its layers from the
// planes its normal faces - and the two side planes are only sampled where the
// ground is steep enough to show them, so flat ground pays for one projection,
// not three.
struct Layer { vec3 albedo; float height; vec3 n; float rough; float ao; };

// Axis-aligned frames, chosen so T x B = N and no face is seen mirrored.
void Project(int layer, vec3 P, vec3 Ng, float scale, vec3 T, vec3 B, vec3 A,
             float w, inout Layer acc) {
    vec2 uv = vec2(dot(P, T), dot(P, B)) * scale;
    vec4 a = texture(u_LayerAlbedo, vec3(uv, float(layer)));
    vec4 d = texture(u_LayerDetail, vec3(uv, float(layer)));
    vec2 t = d.xy * 2.0 - 1.0;
    float tz = sqrt(max(1.0 - dot(t, t), 0.0));
    // Whiteout blend: the map's slope added to the surface's own, in the
    // projection's frame, then back to the world.
    vec3 n = vec3(t + vec2(dot(Ng, T), dot(Ng, B)), tz * dot(Ng, A));
    acc.albedo += a.rgb * w;
    acc.height += a.a * w;
    acc.n      += (T * n.x + B * n.y + A * n.z) * w;
    acc.rough  += d.b * w;
    acc.ao     += d.a * w;
}

Layer SampleLayer(int i, vec3 P, vec3 Ng, vec3 bw) {
    Layer acc = Layer(vec3(0.0), 0.0, vec3(0.0), 0.0, 0.0);
    float scale = u_LayerScale[i];
    vec3 s = sign(Ng + 1e-6);
    if (bw.y > 0.0) Project(i, P, Ng, scale, vec3(1, 0, 0), vec3(0, 0, -s.y), vec3(0, s.y, 0), bw.y, acc);
    if (bw.x > 0.0) Project(i, P, Ng, scale, vec3(0, 0, -s.x), vec3(0, 1, 0), vec3(s.x, 0, 0), bw.x, acc);
    if (bw.z > 0.0) Project(i, P, Ng, scale, vec3(s.z, 0, 0), vec3(0, 1, 0), vec3(0, 0, s.z), bw.z, acc);
    return acc;
}

// Tone over tens of metres, so a field of one texture is not one flat colour
// repeated to the horizon.
float Hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float ValueNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(Hash(i), Hash(i + vec2(1, 0)), u.x),
               mix(Hash(i + vec2(0, 1)), Hash(i + vec2(1, 1)), u.x), u.y);
}

void main() {
    o_SurfaceInfo = vec4(0.0, 0.0, 1.0, 0.0);   // the surface target (lib/Lighting.glsl): nothing, until lit
    vec3 P = v_WorldPos;
    vec3 V = normalize(u_CameraPos - P);
    vec2 texel = 1.0 / vec2(u_Resolution);
    vec2 uv = (v_Cell + 0.5) * texel;

    // ---- the ground's own normal, from every sample ------------------------
    // ⚠️ FROM THE HEIGHTS, NOT FROM THE TRIANGLES. A distant piece is drawn
    // with a grid eight samples apart, and lit by its triangles it would go
    // faceted and flat; lit from the heights it keeps every ridge it has.
    float hl = texture(u_Height, uv - vec2(texel.x, 0.0)).r;
    float hr = texture(u_Height, uv + vec2(texel.x, 0.0)).r;
    float hd = texture(u_Height, uv - vec2(0.0, texel.y)).r;
    float hu = texture(u_Height, uv + vec2(0.0, texel.y)).r;
    vec3 Ng = normalize(vec3(hl - hr, 2.0 * u_CellSize, hd - hu));

    // Which planes to project from: sharpened, and a plane under 3% dropped.
    vec3 bw = pow(abs(Ng), vec3(6.0));
    bw /= dot(bw, vec3(1.0));
    bw = max(bw - 0.03, 0.0);
    bw /= dot(bw, vec3(1.0));

    // ---- the painted layers, blended by their own heights --------------------
    //
    // ⚠️ A WEIGHT ALONE MAKES A SMEAR. Painted 50/50, grass and rock would
    // cross-fade into a green-grey film. Real ground does not blend: the rock
    // shows through where it stands proud and the grass fills the hollows
    // between. Each layer's height (its displacement map) is added to its
    // weight, and only what is near the top of that sum survives.
    //
    // ⚠️ FOUR NAMED LAYERS, NOT AN ARRAY OF THEM. An array of structures written and read through
    // a loop's index goes out to scratch memory on an integrated GPU, at every pixel.
    vec4 w = texture(u_Splat, uv);
    // FZE_EXP_*: measuring switches, set only by FZE_SHADERDEFINES for one run (docs/BENCHMARKS.md).
#ifdef FZE_EXP_ONE_LAYER
    w = vec4(1.0, 0.0, 0.0, 0.0);   // the first layer alone, from one projection
    bw = vec3(0.0, 1.0, 0.0);
#endif
    const Layer none = Layer(vec3(0.0), 0.0, vec3(0.0), 0.0, 0.0);
    Layer L0 = none, L1 = none, L2 = none, L3 = none;
    float k0 = -1.0, k1 = -1.0, k2 = -1.0, k3 = -1.0;
    if (u_LayerCount > 0 && w.x >= 0.004) { L0 = SampleLayer(0, P, Ng, bw); k0 = w.x + L0.height * 0.6; }
    if (u_LayerCount > 1 && w.y >= 0.004) { L1 = SampleLayer(1, P, Ng, bw); k1 = w.y + L1.height * 0.6; }
    if (u_LayerCount > 2 && w.z >= 0.004) { L2 = SampleLayer(2, P, Ng, bw); k2 = w.z + L2.height * 0.6; }
    if (u_LayerCount > 3 && w.w >= 0.004) { L3 = SampleLayer(3, P, Ng, bw); k3 = w.w + L3.height * 0.6; }
    float top = max(max(k0, k1), max(k2, k3));
    const float kBlend = 0.15;   // how much of that sum is a transition
    vec4 b = max(vec4(k0, k1, k2, k3) - (top - kBlend), 0.0) * step(0.0, vec4(k0, k1, k2, k3));
    vec3 albedoS = L0.albedo * b.x + L1.albedo * b.y + L2.albedo * b.z + L3.albedo * b.w;
    vec3 n = L0.n * b.x + L1.n * b.y + L2.n * b.z + L3.n * b.w;
    float rough = dot(vec4(L0.rough, L1.rough, L2.rough, L3.rough), b);
    float ao = dot(vec4(L0.ao, L1.ao, L2.ao, L3.ao), b);
    float total = b.x + b.y + b.z + b.w;
    if (total <= 0.0) {                 // nothing painted: the first layer
        L0 = SampleLayer(0, P, Ng, bw);
        albedoS = L0.albedo; n = L0.n; rough = L0.rough; ao = L0.ao; total = 1.0;
    }
    albedoS /= total; rough /= total; ao /= total;
    vec3 N = normalize(n);

    // Colours are stored as authored; decoded here exactly as Lit.frag does.
    vec3 albedo = pow(max(albedoS, 0.0), vec3(2.2));

    // ---- the ground under grass (Rendering Features > Ground Under Grass) ----
    // The grass growing on this ground's layers, its colour and how much it covers: a little
    // near (the soil between the blades is the meadow's thatch) and fully far (the field).
    float lsum = b.x + b.y + b.z + b.w;
    // Ground painted with nothing (a path) has no grass on it either: no colour of one.
    vec4 lw = lsum > 0.0 ? b / lsum : vec4(0.0);
    vec4 gg = u_LayerGrass[0] * lw.x + u_LayerGrass[1] * lw.y + u_LayerGrass[2] * lw.z + u_LayerGrass[3] * lw.w;
    if (gg.a > 0.001) {
        float k = gg.a * mix(0.6, 1.0, smoothstep(8.0, 50.0, length(u_CameraPos - P)));
        albedo = mix(albedo, gg.rgb / gg.a, k);   // premultiplied: the cover-weighted colour
        rough = mix(rough, 0.9, k);
    }
    albedo *= mix(0.86, 1.14, ValueNoise(P.xz / 23.0)) * mix(0.93, 1.07, ValueNoise(P.xz / 5.3 + 17.0));
    float roughness = clamp(rough, 0.04, 1.0);
    if (dot(N, V) < 0.0) N = normalize(N - V * dot(N, V) * 1.01);   // never face away from the eye

    // ---- marks on it: craters, scorches, blood (lib/Decals.glsl) ------------------
    float metallic = 0.0;
#ifndef FZE_EXP_NO_DECALS
    FZE_ApplyDecals(P, Ng, gl_FragCoord.xy, albedo, N, roughness, metallic);
#endif

    // ---- rain on it, as on everything else ---------------------------------------
    float coatStrength = 0.0, coatRoughness = 1.0;
#ifndef FZE_EXP_NO_WEATHER
    FZE_ApplyWeather(P, Ng, metallic, -1.0, albedo, roughness, N, coatStrength, coatRoughness);
#endif

    // The editor's view modes, the same answers Lit.frag gives, so the ground
    // does not stay lit while everything on it shows its base colour.
    if (u_MaterialView != 0) {
        vec3 o = u_MaterialView == 1 ? pow(max(albedo, vec3(0.0)), vec3(1.0 / 2.2))
               : u_MaterialView == 2 ? N * 0.5 + 0.5
               : u_MaterialView == 3 ? vec3(roughness)
               : u_MaterialView == 4 ? vec3(metallic)
               : u_MaterialView == 5 ? vec3(0.5)
               :                       vec3(ao);
        FragColor = vec4(o, 1.0);
        return;
    }
    if (u_LightingOnly == 1) { albedo = vec3(0.5); metallic = 0.0; }
#ifdef FZE_SIMPLE_LIT
    vec3 color = FZE_SimpleLight(P, N, V, length(u_CameraPos - P), albedo, metallic, roughness, ao);
#else
    FZESurface surf = FZE_Surface(albedo, metallic, roughness, 0.5);
    if (coatStrength > 0.001) FZE_SetClearCoat(surf, coatStrength, coatRoughness);

    vec2 screenTerms = vec2(1.0);
    if (u_HasSSAO == 1) screenTerms = texture(u_SSAOMap, gl_FragCoord.xy / u_ScreenSize).rg;
#ifdef FZE_EXP_FLAT
    vec3 color = albedo;   // no lighting at all: what is left is the ground's own cost
#else
    vec3 color = FZE_LightSurface(surf, P, N, V, albedo, metallic, 0.5, ao, screenTerms, 1.0, vec3(0.0));
#endif
#endif

#ifndef FZE_EXP_NO_FOG
    color = FZE_ApplyFog(color,
                         FZE_FogRadiance(pow(max(u_FogColor, 0.0), vec3(2.2)), P - u_CameraPos),
                         FZE_FogDepth(u_CameraPos, P));
    color = FZE_ApplyAerial(color, gl_FragCoord.xy / max(u_ScreenSize, vec2(1.0)), length(P - u_CameraPos));
#endif

    // ---- the editor's brush, drawn on the ground itself --------------------------
    if (u_Brush.w > 0.0) {
        float d = length(P.xz - u_Brush.xy);
        float px = max(fwidth(d), 1e-4);
        float ring = 1.0 - smoothstep(0.0, 1.5 * px, abs(d - u_Brush.z));
        float inside = d < u_Brush.z ? 0.12 : 0.0;
        float centre = 1.0 - smoothstep(0.0, 1.5 * px, abs(d - u_Brush.z * 0.04));
        color = mix(color, u_BrushColor, clamp(max(ring, centre) * 0.9 + inside, 0.0, 1.0));
    }
    FragColor = vec4(color, 1.0);
}
