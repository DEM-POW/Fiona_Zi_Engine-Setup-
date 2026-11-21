#version 460 core
// ============================================================================
//  THE SCENE'S DEPTH AT HALF SIZE, FOR SMOKE DRAWN AT HALF SIZE
//  (Effects/Vfx/VfxRenderer, the low-resolution pass)
//
//  The NEAREST of each 2x2: smoke behind a thin edge is hidden in the texel
//  the edge touches, and the composite (VfxComposite.frag) gives the pixels on
//  the far side of the edge a neighbour that does have it. The farthest would
//  let smoke leak over the front of every silhouette instead.
//
//  Written twice: as the depth the half-size pass tests against, and as a
//  colour the soft fade and the composite can read.
// ============================================================================

in vec2 v_UV;
out float FragDepthCopy;

uniform sampler2D u_Depth;       // the full-size copy

void main()
{
    ivec2 full = textureSize(u_Depth, 0);
    ivec2 base = ivec2(gl_FragCoord.xy) * 2;
    float d = 1.0;
    for (int y = 0; y < 2; ++y)
        for (int x = 0; x < 2; ++x)
            d = min(d, texelFetch(u_Depth, clamp(base + ivec2(x, y), ivec2(0), full - 1), 0).r);
    FragDepthCopy = d;
    gl_FragDepth = d;
}
