// ---------------------------------------------------------------
//  Fiona Zi Engine — the scene's lamps, as the GPU sees them
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// ONE DESCRIPTION OF A LIGHT, READ BY EVERY SHADER THAT LIGHTS ANYTHING.
//
// ⚠️ THE LIGHTS USED TO BE 32 ARRAYS OF UNIFORMS, COPIED THREE TIMES. The lit
// pass, the volumetric march and the bounce-light injection each declared
// u_PointPos[32], u_PointColor[32] ... fourteen arrays, and each had its own
// copy of the falloff and the cone - and the renderer re-sent all fourteen,
// by name, for every light, every time any of those shaders was bound. It
// also meant a hard ceiling of 32 lights in a scene and a per-OBJECT bitmask
// the CPU rebuilt every frame to say which of them could reach each mesh.
//
// Now the lights are one storage buffer (Renderer::LightingFrame, uploaded
// once a frame) and the question "which lights can reach this pixel" is
// answered on the GPU, per CLUSTER: the view is cut into 16 x 9 screen tiles
// by 24 slices of depth (exponential, so the slices near the camera are thin
// where detail is), a compute pass (LightCluster.comp) lists the lamps whose
// reach touches each one, and a pixel walks only its own cluster's list. A
// street of two hundred lamps costs a pixel the three or four around it.
//
// The first u_DirectionalCount lights are directional (no position, in every
// cluster); the rest are points and spots.

#ifndef FZE_LIGHTS_GLSL
#define FZE_LIGHTS_GLSL

struct FZELight {
    vec4 PosRange;     // xyz world position, w range (metres)
    vec4 Intensity;    // rgb candela (lux, directional) x colour x pre-exposure; w type 0 point 1 spot 2 dir
    vec4 DirCos;       // xyz the way the light travels, w cos(outer angle)
    vec4 Params;       // x cos(inner angle), y source radius, z first shadow view (-1 none), w view count
    vec4 Extra;        // x shadow bias scale, y volumetric strength
};

layout(std430, binding = 4) readonly buffer FZELightBuffer   { FZELight fzeLights[]; };
layout(std430, binding = 5) readonly buffer FZEClusterBuffer { uvec2 fzeClusters[]; };     // offset, count
layout(std430, binding = 6) readonly buffer FZEItemBuffer    { uint fzeClusterItems[]; };

uniform int   u_LightCount;         // every light in the buffer
uniform int   u_DirectionalCount;   // the first N of them
uniform vec3  u_ClusterGrid;        // tiles x, tiles y, depth slices
uniform vec2  u_ClusterDepth;       // near, 1 / log(far / near)
uniform vec2  u_ClusterScreen;      // the target the clusters were built for, pixels
uniform vec3  u_ClusterEye;         // the camera the clusters were built from
uniform vec3  u_ClusterForward;     // and the way it looks
// FZE_NOCLUSTERS=1: every pixel walks every light. The control for the
// clustering: it must change no pixel, only the cost.
uniform int   u_ClusterBypass;

// ---- every lamp's shadow: one atlas (Renderer/ShadowAtlas.h) ----
//
// A view is one square tile: a spot has one, a point light six (+X -X +Y -Y
// +Z -Z, each a 90-degree frustum a few texels wider so a filter at the seam
// stays in its own tile).
struct FZEShadowView {
    mat4 ViewProj;
    vec4 Rect;         // xy the tile's corner in atlas uv, zw its size
    vec4 Params;       // x world size of one texel per metre of distance
};
layout(std430, binding = 3) readonly buffer FZEShadowViewBuffer { FZEShadowView fzeShadowViews[]; };
uniform sampler2DShadow u_LampShadowAtlas;
uniform float u_LampShadowTexel;    // 1 / the atlas's size

// ⚠️ ONE RULE FOR EVERY LAMP, AND IT IS WORKED OUT FROM THE MAP, NOT TYPED IN.
//
// What a bias has to cover is the depth a surface changes across ONE texel,
// and a texel of a perspective map covers (2 tan(fov/2) / resolution) metres
// per metre of distance - so the sample is moved off the surface along its
// normal by that much, widened where the light grazes it. The maps record
// BACK faces, so the lit surface is never the stored surface and this offset
// only has to cover the filter's reach: contact shadows stay touching their
// casters. biasScale is the light's own multiplier (1 = this rule).
//
// ⚠️ AND THE SOFTNESS IS THE BULB'S SIZE. The kernel is the bulb's radius at
// the receiver, measured in texels of this tile, from one texel (the map's
// own limit) to four. A bare bulb has a hard edge, a shade a soft one - the
// Source Radius is the only control, for every lamp alike.
float FZE_LampShadow(int i, vec3 P, vec3 N, bool filtered) {
    FZELight lt = fzeLights[i];
    int v = int(lt.Params.z);
    if (v < 0) return 1.0;
    vec3 fromL = P - lt.PosRange.xyz;
    if (int(lt.Params.w) == 6) {
        // The face whose frustum holds this point: the major axis.
        vec3 a = abs(fromL);
        if (a.x >= a.y && a.x >= a.z) v += fromL.x > 0.0 ? 0 : 1;
        else if (a.y >= a.z)          v += fromL.y > 0.0 ? 2 : 3;
        else                          v += fromL.z > 0.0 ? 4 : 5;
    }
    FZEShadowView sv = fzeShadowViews[v];
    float dist = max(length(fromL), 0.05);
    vec3 L = -fromL / dist;
    float texelWorld = sv.Params.x * dist;
    float ndl = clamp(dot(N, L), 0.0, 1.0);
    float slope = clamp(1.0 / max(ndl, 0.25), 1.0, 3.0);
    vec3 Pb = P + N * (texelWorld * 0.75 * slope * lt.Extra.x);

    vec4 clip = sv.ViewProj * vec4(Pb, 1.0);
    vec3 proj = clip.xyz / clip.w * 0.5 + 0.5;
    if (clip.w <= 0.0 || proj.z >= 1.0) return 1.0;
    vec2 lo = sv.Rect.xy + vec2(0.5 * u_LampShadowTexel);
    vec2 hi = sv.Rect.xy + sv.Rect.zw - vec2(0.5 * u_LampShadowTexel);
    vec2 uv = sv.Rect.xy + clamp(proj.xy, 0.0, 1.0) * sv.Rect.zw;
    if (!filtered) return texture(u_LampShadowAtlas, vec3(clamp(uv, lo, hi), proj.z));

    // The kernel in atlas uv: the bulb's radius in texels of this tile.
    float tileTexels = sv.Rect.z / u_LampShadowTexel;
    float radius = clamp(lt.Params.y / max(texelWorld, 1e-5), 1.0, 4.0);
    float stepUV = min(radius / 1.5, 1.6) * u_LampShadowTexel;
    // Four corners first: fully lit or fully shadowed is the common case, and
    // the hardware comparison gives exactly 0 or 1 there (see the sun's filter
    // in lib/Shadows.glsl, which this mirrors).
    float first = 0.0;
    for (int k = 0; k < 4; ++k) {
        vec2 g = vec2(float(k & 1) * 3.0 - 1.5, float(k >> 1) * 3.0 - 1.5);
        first += texture(u_LampShadowAtlas, vec3(clamp(uv + g * stepUV, lo, hi), proj.z));
    }
    if (first >= 3.999) return 1.0;
    if (first <= 0.001) return 0.0;
    float s = 0.0;
    for (int y = 0; y < 4; ++y)
        for (int x = 0; x < 4; ++x) {
            vec2 g = vec2(float(x) - 1.5, float(y) - 1.5);
            s += texture(u_LampShadowAtlas, vec3(clamp(uv + g * stepUV, lo, hi), proj.z));
        }
    return s / 16.0;
}

// ⚠️ INVERSE SQUARE, BECAUSE THAT IS WHAT LIGHT DOES. A lamp of I candela
// puts I / d^2 lux on a surface facing it, floored at the bulb's own radius
// (touching a bulb is bright, not infinite), and the range window lets it
// stop at a finite distance without a visible edge - see LightUnits.h, which
// this matches and which FZELightingTest checks.
float FZE_LightFalloff(float dist, float range, float sourceRadius) {
    float d2 = max(dist * dist, max(sourceRadius * sourceRadius, 1e-4));
    float r = dist / max(range, 0.001);
    float w = clamp(1.0 - r * r * r * r, 0.0, 1.0);
    return w * w / d2;
}

// How much of light i reaches P, unshadowed, and from which way (L points
// TOWARDS the light). Zero when it cannot reach - outside its range or its
// cone - which a caller should treat as "skip everything else".
float FZE_LightAt(int i, vec3 P, out vec3 L, out float dist) {
    // ⚠️ WHETHER IT REACHES, BEFORE THE REST OF IT IS READ. A lamp is five vec4s, and
    // read as one structure all eighty bytes came in for every lamp a cluster lists. A far
    // cluster from above lists many of a city's lamps and almost none reaches a given
    // pixel: its type and its place and range (twenty bytes) say so, and only a lamp that
    // reaches has the rest read. The same answers, exactly.
    int type = int(fzeLights[i].Intensity.w + 0.5);
    if (type == 2) {
        L = -normalize(fzeLights[i].DirCos.xyz);
        dist = 1e9;
        return 1.0;
    }
    vec4 pr = fzeLights[i].PosRange;
    vec3 toL = pr.xyz - P;
    dist = length(toL);
    if (dist > pr.w) { L = vec3(0.0, 1.0, 0.0); return 0.0; }
    L = toL / max(dist, 1e-4);
    vec4 params = fzeLights[i].Params;
    float a = FZE_LightFalloff(dist, pr.w, params.y);
    if (type == 1) {
        // ⚠️ A SPOT IS A MASKED BULB. Full inside the inner angle, nothing
        // outside the outer; the square gives the soft shoulder a lens makes.
        vec4 dc = fzeLights[i].DirCos;
        float cd = dot(normalize(dc.xyz), -L);
        if (cd <= dc.w) return 0.0;
        float s = clamp((cd - dc.w) / max(params.x - dc.w, 1e-3), 0.0, 1.0);
        a *= s * s;
    }
    return a;
}

// The cluster a point on screen belongs to.
uint FZE_ClusterIndex(vec2 fragCoord, vec3 P) {
    vec2 uv = clamp(fragCoord / max(u_ClusterScreen, vec2(1.0)), vec2(0.0), vec2(0.99999));
    uint tx = uint(uv.x * u_ClusterGrid.x);
    uint ty = uint(uv.y * u_ClusterGrid.y);
    float d = max(dot(P - u_ClusterEye, u_ClusterForward), u_ClusterDepth.x);
    uint tz = uint(clamp(log(d / u_ClusterDepth.x) * u_ClusterDepth.y * u_ClusterGrid.z,
                         0.0, u_ClusterGrid.z - 1.0));
    return (tz * uint(u_ClusterGrid.y) + ty) * uint(u_ClusterGrid.x) + tx;
}

#endif
