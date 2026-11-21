#version 460 core
// ============================================================================
//  THE SCREEN'S REFLECTION, WIDENED BY HOW ROUGH THE SURFACE IS
//
//  SSR.frag (mode 1) traced ONE mirror ray per pixel. A polished floor shows
//  that image sharp; a satin one shows it smeared, wider the rougher it is -
//  the reflection lobe is a cone, and a cone sees a blur of what the ray saw.
//  One direction of a separable blur, its radius from the surface's own
//  roughness (the surface target, lib/Lighting.glsl), so a mirror stays a
//  mirror next to a satin panel that does not.
//
//  ⚠️ IT DOES NOT CROSS EDGES. A neighbour on another surface - further away,
//  or facing elsewhere - holds that surface's reflection, and blurring it in
//  is the glowing fringe round every object in a cheap SSR. Depth and normal
//  decide who may mix; the confidence (alpha) travels with the colour, so a
//  miss next to a hit fades the hit instead of darkening it.
// ============================================================================
#include "lib/Octahedral.glsl"

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Src;       // rgb what the mirror saw, a how sure (this target's size)
uniform sampler2D u_Surface;   // full size: normal, roughness, a 1 = traced
uniform sampler2D u_Depth;     // full size
uniform vec2  u_Dir;           // one texel of u_Src along this pass's axis
uniform float u_MaxRadius;     // texels, at the roughest surface that still reflects

void main() {
    vec4 si = texture(u_Surface, v_UV);
    vec4 c = texture(u_Src, v_UV);
    if (si.a < 0.75) { FragColor = vec4(0.0); return; }

    // Radius from roughness: nothing for a mirror (the trace's own noise is
    // the temporal AA's), the widest at the fade's end.
    float r = clamp((si.z - 0.05) / 0.5, 0.0, 1.0);
    float radius = r * r * u_MaxRadius;
    if (radius < 0.5) { FragColor = c; return; }

    float d0 = texture(u_Depth, v_UV).r;
    vec3 n0 = FZE_OctDecode(si.xy);
    float span = max(1.0 - d0, 1e-6);   // (1 - depth) ~ near/z: a ratio is a relative distance

    vec4 sum = vec4(c.rgb * c.a, c.a);
    float wsum = 1.0;
    const int TAPS = 4;
    for (int i = -TAPS; i <= TAPS; ++i) {
        if (i == 0) continue;
        float o = float(i) / float(TAPS) * radius;
        vec2 uv = v_UV + u_Dir * o;
        vec4 s = texture(u_Src, uv);
        vec4 ss = texture(u_Surface, uv);
        if (ss.a < 0.75) continue;
        float d = texture(u_Depth, uv).r;
        float wd = exp(-abs(d - d0) / span * 20.0);
        float wn = pow(max(dot(FZE_OctDecode(ss.xy), n0), 0.0), 8.0);
        float wg = exp(-2.0 * (o / radius) * (o / radius));
        float w = wd * wn * wg;
        sum += vec4(s.rgb * s.a, s.a) * w;
        wsum += w;
    }
    float a = sum.a / wsum;
    FragColor = vec4(sum.a > 1e-5 ? sum.rgb / sum.a : vec3(0.0), a);
}
