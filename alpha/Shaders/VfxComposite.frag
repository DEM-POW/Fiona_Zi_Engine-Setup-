#version 460 core
// ============================================================================
//  HALF-SIZE SMOKE BACK ONTO THE FULL PICTURE (Effects/Vfx/VfxRenderer)
//
//  ⚠️ THICK SMOKE COSTS ITS AREA, AND AREA IS WHAT A WEAK GPU LACKS. Sixteen
//  smoke columns were 6.8 ms of this laptop's GPU at full size; a quarter of
//  the pixels is a quarter of that. Engines draw it the same way at their low
//  settings (Unreal's separate translucency at reduced resolution).
//
//  The blurring a plain upscale gives is fine for smoke; the halo it gives
//  round anything in front is not. So each full-size pixel looks at the four
//  half-size texels around it: where their depths agree with its own it takes
//  the smooth bilinear blend, and where they do not (an edge) it takes the one
//  whose depth is nearest its own - "nearest-depth upsampling".
// ============================================================================

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Color;       // half size, premultiplied
uniform sampler2D u_HalfDepth;   // half size, the depth it was drawn against
uniform sampler2D u_FullDepth;   // full size
uniform vec2 u_Proj;             // the projection's [2][2] and [3][2]: depth back to metres

float Metres(float d) { return u_Proj.y / ((d * 2.0 - 1.0) + u_Proj.x); }

void main()
{
    vec2 halfSize = vec2(textureSize(u_Color, 0));
    vec2 p = v_UV * halfSize - 0.5;
    ivec2 i0 = ivec2(floor(p));
    vec2 f = p - vec2(i0);
    ivec2 top = ivec2(halfSize) - 1;
    ivec2 t[4] = ivec2[4](clamp(i0, ivec2(0), top), clamp(i0 + ivec2(1, 0), ivec2(0), top),
                          clamp(i0 + ivec2(0, 1), ivec2(0), top), clamp(i0 + ivec2(1, 1), ivec2(0), top));
    float here = Metres(texture(u_FullDepth, v_UV).r);
    float worst = 0.0, best = 1e9;
    int pick = 0;
    for (int k = 0; k < 4; ++k) {
        float diff = abs(Metres(texelFetch(u_HalfDepth, t[k], 0).r) - here);
        worst = max(worst, diff);
        if (diff < best) { best = diff; pick = k; }
    }
    vec4 c;
    if (worst < here * 0.06 + 0.05) {
        c = mix(mix(texelFetch(u_Color, t[0], 0), texelFetch(u_Color, t[1], 0), f.x),
                mix(texelFetch(u_Color, t[2], 0), texelFetch(u_Color, t[3], 0), f.x), f.y);
    } else {
        c = texelFetch(u_Color, t[pick], 0);
    }
    if (c.a <= 0.0005 && dot(c.rgb, c.rgb) <= 1e-8) discard;
    FragColor = c;
}
