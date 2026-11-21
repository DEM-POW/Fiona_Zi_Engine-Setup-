#version 460 core
// =============================================================================
//  A PLANT'S DEPTH: where its picture has no leaf, it has no surface.
//
//  ⚠️ THE ALPHA GROWS WITH THE MIP LEVEL. Averaging a blade's alpha with the
//  empty texels round it thins it at every mip, so past a few metres a cut-out
//  plant eats itself away to nothing. Scaling the alpha back up with the level
//  (Golus, "Anti-aliased Alpha Test", 2017) keeps its coverage the same at every
//  distance. This is the ONLY place the shape is cut: the lit pass draws with
//  the depth test EQUAL against what this wrote.
//
//  The prepass, the sun's cascades and the sky's view all go through here, so
//  a cut-out leaf casts a leaf-shaped shadow and hides only what a leaf hides.
// =============================================================================
in vec2 v_UV;
flat in float v_Fade;
in vec4 v_PicUV01;
in vec2 v_PicUV2;
flat in vec4 v_PicW;
flat in vec4 v_PicF01;
flat in vec2 v_PicF2;

uniform sampler2D u_AlbedoMap;
uniform int   u_HasAlbedo;
uniform float u_AlphaCutoff;
uniform int   u_Exp;              // FZE_FOLIAGEEXP, for measuring: 2 no mip-alpha scaling
uniform int   u_Impostor;         // a far tree as its pictures: the albedo map is their atlas
uniform float u_PicGrid;

#include "lib/TreePicture.glsl"

void main() {
    if (v_Fade != 0.0 && FZE_PicFadeCut(v_Fade, gl_FragCoord.xy)) discard;
    if (u_Impostor == 1) {
        float n = u_PicGrid;
        float inset = 0.5 * n / float(textureSize(u_AlbedoMap, 0).x);
        float a = v_PicW.x * FZE_PicTexel(u_AlbedoMap, v_PicF01.xy, v_PicUV01.xy, n, inset).a * FZE_PicInside(v_PicUV01.xy)
                + v_PicW.y * FZE_PicTexel(u_AlbedoMap, v_PicF01.zw, v_PicUV01.zw, n, inset).a * FZE_PicInside(v_PicUV01.zw)
                + v_PicW.z * FZE_PicTexel(u_AlbedoMap, v_PicF2, v_PicUV2, n, inset).a * FZE_PicInside(v_PicUV2);
        a *= 1.0 + max(textureQueryLod(u_AlbedoMap, (v_PicF01.xy + v_PicUV01.xy) / n).x, 0.0) * 0.25;
        // ⚠️ 0.3, NOT 0.5: THE PICTURE'S ALPHA IS COVERAGE NOW. The pictures are drawn at twice
        // their size and averaged (FoliageRenderer, kBakeSS), so a texel a needle half covers is
        // 0.5, not 1 or 0. Cut at 0.5 a tree as pictures covered 21% fewer pixels than the same
        // tree as leaves; at 0.3, within 2% (DREVAR's plaza, 2026-11-13). The change between the
        // two is then a change of detail, not of how full the tree is.
        if (a < 0.3) discard;
        return;
    }
    if (u_AlphaCutoff <= 0.0 || u_HasAlbedo == 0) return;
    float a = texture(u_AlbedoMap, v_UV).a;
    if ((u_Exp & 2) == 0) a *= 1.0 + max(textureQueryLod(u_AlbedoMap, v_UV).x, 0.0) * 0.25;
    if (a < u_AlphaCutoff) discard;
}
