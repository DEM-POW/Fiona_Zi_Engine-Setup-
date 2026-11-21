#version 460 core
#include "lib/Finite.glsl"     // one bad pixel never spreads (R0)
// ============================================================================
//  THE REFLECTION, HELD FROM FRAME TO FRAME
//
//  SSR.frag (mode 1) traces one mirror ray per pixel, its march offset moved
//  every frame, and left the averaging to the temporal AA. On a mirror that is
//  not enough: a ray that slips past a wall's edge in one frame and lands on it
//  in the next is a dot of sky in a dark puddle - a different dot in every
//  frame, which the AA's clip keeps instead of averaging. That was the sparkle
//  in the Animation Lab's puddle (947 pixels switching on and off over 40
//  frames; 7 with the reflections off). Two steps, as Unity HDRP and Unreal
//  take for their screen-space reflections:
//
//  1. A DOT IS NOT A REFLECTION. A pixel brighter than all eight round it is
//     brought down to the brightest of them (a lone dark one up to the
//     darkest): a reflection has neighbours, a ray that slipped does not.
//  2. HELD. Last frame's answer, read where this point was (the surface's own
//     point, through last frame's camera), kept inside what this frame's
//     neighbourhood allows, and moved a sixth of the way toward this frame -
//     the march's moving offset averages away instead of being redrawn.
// ============================================================================

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Current;    // this frame's filtered reflection: rgb what the mirror saw, a how sure
uniform sampler2D u_History;    // last frame's answer, the same size
uniform sampler2D u_Depth;      // full size
uniform mat4  u_InvViewProj;    // the surface target's camera, this frame
uniform mat4  u_PrevViewProj;   // and last frame's
uniform vec2  u_TexelSize;      // of this target
uniform int   u_HasHistory;     // 0: the first frame, a resize, reflections just turned on
uniform float u_NewFrame;       // how much of this frame (Core/RenderFeatures.h)

void main() {
    vec4 c = FZE_Finite(texture(u_Current, v_UV));
    vec4 lo = vec4(1e9), hi = vec4(-1e9);
    for (int y = -1; y <= 1; ++y)
        for (int x = -1; x <= 1; ++x) {
            if (x == 0 && y == 0) continue;
            vec4 s = FZE_Finite(texture(u_Current, v_UV + vec2(x, y) * u_TexelSize));
            lo = min(lo, s);
            hi = max(hi, s);
        }
    c = clamp(c, lo, hi);
    lo = min(lo, c);
    hi = max(hi, c);

    float d = texture(u_Depth, v_UV).r;
    if (u_HasHistory == 0 || d >= 1.0) { FragColor = c; return; }
    vec4 p = u_InvViewProj * vec4(v_UV * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 pc = u_PrevViewProj * vec4(p.xyz / p.w, 1.0);
    if (pc.w <= 1e-6) { FragColor = c; return; }
    vec2 prevUV = pc.xy / pc.w * 0.5 + 0.5;
    if (any(lessThan(prevUV, vec2(0.0))) || any(greaterThan(prevUV, vec2(1.0)))) { FragColor = c; return; }
    vec4 h = clamp(FZE_Finite(texture(u_History, prevUV)), lo, hi);
    FragColor = mix(h, c, u_NewFrame);
}
