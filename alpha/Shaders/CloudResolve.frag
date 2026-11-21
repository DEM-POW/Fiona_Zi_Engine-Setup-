#version 460 core
#include "lib/Finite.glsl"     // one bad pixel never spreads (R0)
// ============================================================================
//  THE CLOUDS, ACCUMULATED OVER FRAMES.
//
//  Each frame's march starts every ray at a different fraction of a step (the
//  jitter walks the golden ratio), so any one frame is noisy and eight of them
//  average to a clean one. This pass finds where each pixel's cloud was on
//  screen last frame - its distance, carried back through the wind's drift and
//  last frame's camera - and blends into what was there.
//
//  ⚠️ THE HISTORY IS CLAMPED TO WHAT THIS FRAME'S NEIGHBOURHOOD CAN BE. A
//  reprojection is only ever approximately right (a cloud has no single
//  depth), and where it is wrong an unclamped history drags a ghost of the
//  old sky across the new one. Held inside the range of the 3x3 around the
//  pixel it can only smooth noise, never invent structure.
// ============================================================================

in vec2 v_NDC;
out vec4 FragColor;

uniform sampler2D u_Current;       // this frame's march: one corner of every block
uniform sampler2D u_CurrentDepth;
uniform sampler2D u_History;       // last frame's resolved clouds, full cloud size
uniform int   u_HasHistory;
uniform vec2  u_Offset;            // the corner marched this frame (0..u_Block-1 each)
uniform float u_Block;             // 2 or 4 (Rendering Features > Clouds Marched 1 in 16)
uniform vec2  u_MarchSize;         // the part of u_Current this frame wrote: a sparse frame uses a corner of it
uniform mat4  u_InvViewProj;
uniform mat4  u_PrevViewProj;
uniform vec3  u_CameraPos;
uniform vec2  u_DriftDelta;        // metres the cloud moved since last frame

void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    int block = int(u_Block + 0.5);
    ivec2 q = px / block;
    ivec2 msize = ivec2(u_MarchSize + 0.5);
    ivec2 qc = clamp(q, ivec2(0), msize - 1);
    bool fresh = (px - q * block) == ivec2(u_Offset + 0.5);

    // What this frame knows near here: the marched corners of the 3x3 blocks
    // around this one. Their range is what the history is held inside.
    vec4 lo = vec4(1e9), hi = vec4(-1e9);
    for (int y = -1; y <= 1; ++y)
        for (int x = -1; x <= 1; ++x) {
            vec4 s = FZE_Finite(texelFetch(u_Current, clamp(qc + ivec2(x, y), ivec2(0), msize - 1), 0));
            lo = min(lo, s); hi = max(hi, s);
        }
    vec2 uv = (vec2(px) + 0.5) / vec2(textureSize(u_History, 0));
    // Between the marched corners, the march filtered. A sparse frame wrote only a corner of the
    // texture, so it is read in the march's own texels and kept inside what was written.
    vec2 mts = vec2(textureSize(u_Current, 0));
    vec2 muv = block == 2 ? uv
             : clamp((vec2(px) - u_Offset) / u_Block + 0.5, vec2(0.5), vec2(msize) - 0.5) / mts;
    vec4 cur = FZE_Finite(fresh ? texelFetch(u_Current, qc, 0) : texture(u_Current, muv));
    if (u_HasHistory == 0) { FragColor = cur; return; }

    float d = texelFetch(u_CurrentDepth, qc, 0).r;
    if (d <= 0.0) d = 20000.0;                     // empty sky: far enough to not parallax
    vec2 ndc = uv * 2.0 - 1.0;
    vec4 world = u_InvViewProj * vec4(ndc, 1.0, 1.0);
    vec3 dir = normalize(world.xyz / world.w - u_CameraPos);
    vec3 p = u_CameraPos + dir * d;
    p.xz -= u_DriftDelta;                          // where this cloud was a frame ago
    vec4 prev = u_PrevViewProj * vec4(p, 1.0);
    if (prev.w <= 0.0) { FragColor = cur; return; }
    vec2 puv = prev.xy / prev.w * 0.5 + 0.5;
    if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) { FragColor = cur; return; }

    vec4 hist = FZE_Finite(texture(u_History, puv));
    vec4 pad = (hi - lo) * 0.25 + 0.002;
    hist = clamp(hist, lo - pad, hi + pad);
    // A pixel marched this frame blends in its new sample (the march's own
    // jitter is what the history averages away); the other three carry the
    // history forward.
    FragColor = fresh ? mix(hist, cur, 0.35) : hist;
}
