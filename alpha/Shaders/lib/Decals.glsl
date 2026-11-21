#ifndef FZE_DECALS_GLSL
#define FZE_DECALS_GLSL
// ---------------------------------------------------------------
//  Fiona Zi Engine — decals, applied to a surface before it is lit
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// ⚠️ BEFORE LIGHTING, NOT ON TOP OF IT. A bullet hole changes what the wall
// IS here - its colour, its normal, its roughness - and then the wall is lit,
// shadowed and rained on as one surface. A mark drawn over the finished pixel
// is lit by nothing and glows in the dark.
//
// Each decal is a box; a point inside it is projected along the box's z (the
// surface normal it was fired against) onto the atlas layer. Faces turned away
// from that axis take none of it (the inside of a doorframe beside a hole),
// and it thins towards the box's front and back so it never cuts a hard line
// across a corner.
//
// Needs lib/Lights.glsl first (the cluster grid and FZE_ClusterIndex).
// Renderer/Decals.cpp sets the counts; the bindings below are fixed in the
// shader so a program nobody bound still keeps its samplers off unit 0.
// ⚠️ STORAGE BINDINGS 7-9: this GPU has sixteen (0-15) and 15-18 did not
// compile. 7-9 are the rain's and the cluster pass's at other times; every lit
// program's set-up binds them again (Decals::Bind).

struct FZEDecal {
    vec4 Row0, Row1, Row2;     // world -> the box's own -0.5..0.5
    vec4 Params;               // layer, opacity, normal strength, -
    vec4 Tint;
    vec4 Lo, Hi;
};
layout(std430, binding = 7) readonly buffer FZEDecalBuffer        { FZEDecal fzeDecals[]; };
layout(std430, binding = 8) readonly buffer FZEDecalClusterBuffer { uvec2 fzeDecalClusters[]; };
layout(std430, binding = 9) readonly buffer FZEDecalItemBuffer    { uint fzeDecalItems[]; };
layout(binding = 28) uniform sampler2DArray u_DecalColor;    // sRGB colour, coverage
layout(binding = 29) uniform sampler2DArray u_DecalNormal;   // normal xy, roughness, metalness
uniform int   u_DecalCount;
uniform int   u_DecalBypass;     // few: every pixel walks them all
uniform int   u_NoDecals;        // this draw takes none (characters)
uniform float u_DecalTexels;

void FZE_DecalOne(uint i, vec3 P, vec3 Ng, float footprint,
                  inout vec3 albedo, inout vec3 N, inout float rough, inout float metal) {
    FZEDecal d = fzeDecals[i];
    vec4 P4 = vec4(P, 1.0);
    vec3 q = vec3(dot(d.Row0, P4), dot(d.Row1, P4), dot(d.Row2, P4));
    vec3 aq = abs(q);
    if (aq.x > 0.5 || aq.y > 0.5 || aq.z > 0.5) return;
    vec3 axis = normalize(d.Row2.xyz);
    float a = d.Params.y * smoothstep(0.15, 0.45, dot(Ng, axis)) * (1.0 - smoothstep(0.3, 0.5, aq.z));
    if (a <= 0.0) return;
    // ⚠️ AN EXPLICIT LEVEL OF DETAIL: this runs in a loop whose length differs
    // between neighbouring pixels, where the hardware's own derivatives are
    // undefined. The footprint was measured outside the loop.
    float lod = log2(max(footprint * length(d.Row0.xyz) * u_DecalTexels, 1e-6));
    vec3 uvw = vec3(q.xy + 0.5, d.Params.x);
    vec4 c = textureLod(u_DecalColor, uvw, lod);
    a *= c.a;
    if (a <= 0.002) return;
    vec4 m = textureLod(u_DecalNormal, uvw, lod);
    albedo = mix(albedo, pow(c.rgb, vec3(2.2)) * d.Tint.rgb, a);
    rough  = mix(rough, clamp(m.b, 0.04, 1.0), a);
    metal  = mix(metal, m.a, a);
    // The mark's own normal, in its frame laid across this surface.
    vec2 t = (m.xy * 2.0 - 1.0) * d.Params.z;
    vec3 T = d.Row0.xyz - Ng * dot(Ng, d.Row0.xyz);
    vec3 B = d.Row1.xyz - Ng * dot(Ng, d.Row1.xyz);
    T = T * inversesqrt(max(dot(T, T), 1e-12));
    B = B * inversesqrt(max(dot(B, B), 1e-12));
    vec3 nd = normalize(T * t.x + B * t.y + Ng * sqrt(max(1.0 - dot(t, t), 0.0)));
    N = normalize(mix(N, nd, a));
}

// Every decal that reaches this pixel, oldest first.
void FZE_ApplyDecals(vec3 P, vec3 Ng, vec2 fragCoord,
                     inout vec3 albedo, inout vec3 N, inout float rough, inout float metal) {
    // Simple Surfaces take no marks: their program does not contain them.
#ifndef FZE_NO_DECALS
    if (u_DecalCount <= 0 || u_NoDecals == 1) return;
    float footprint = max(length(dFdx(P)), length(dFdy(P)));
    if (u_DecalBypass == 1) {
        for (int i = 0; i < u_DecalCount; ++i)
            FZE_DecalOne(uint(i), P, Ng, footprint, albedo, N, rough, metal);
    } else {
        uvec2 cl = fzeDecalClusters[FZE_ClusterIndex(fragCoord, P)];
        for (uint k = 0u; k < cl.y; ++k)
            FZE_DecalOne(fzeDecalItems[cl.x + k], P, Ng, footprint, albedo, N, rough, metal);
    }
#endif
}

#endif
