#version 460 core
// =============================================================================
//  DEPTH FOR A SURFACE CUT OUT OF ITS PICTURE (Material::AlphaCutoff, glTF MASK).
//
//  Where the colour map's alpha is under the cutoff there is no surface: no
//  depth, no shadow. The alpha is scaled up with the mip level (Golus, "Anti-
//  aliased Alpha Test", 2017) exactly as Lit.frag does it, so a far leaf keeps
//  its shape and both passes cut the same one. Only cut-out materials come
//  here (Renderer's DrawDepthSet); Depth.frag stays empty so every solid
//  surface keeps the early depth test.
// =============================================================================
in vec2 v_UV;

uniform sampler2D u_AlbedoMap;
uniform float u_AlphaCutoff;
uniform float u_LodFade;          // between two levels of detail (lib/LodFade.glsl)

#include "lib/LodFade.glsl"

void main() {
    if (FZE_LodFadeCut(u_LodFade, gl_FragCoord.xy)) discard;
    float a = texture(u_AlbedoMap, v_UV).a;
    a *= 1.0 + max(textureQueryLod(u_AlbedoMap, v_UV).x, 0.0) * 0.25;
    if (a < u_AlphaCutoff) discard;
}
