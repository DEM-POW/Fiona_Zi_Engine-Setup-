#ifndef FZE_LOD_FADE_GLSL
#define FZE_LOD_FADE_GLSL
// =============================================================================
//  A MESH BETWEEN TWO LEVELS OF DETAIL (Rendering Features > LOD Changes Softly).
//
//  For a stretch of distance before a mesh changes to its next, lighter level,
//  both levels are drawn, each on the pixels the other leaves: fade > 0 is the
//  level going, kept where the noise is at least `fade`; fade < 0 the level
//  coming, kept where the noise is under -fade; 0 draws the whole surface. The
//  noise is the pixel's alone (interleaved gradient noise, Jimenez 2014), so the
//  depth prepass and the lit pass keep exactly the same pixels, and the change
//  is a dissolve over metres instead of a switch in one frame.
// =============================================================================
bool FZE_LodFadeCut(float fade, vec2 pixel) {
    if (fade == 0.0) return false;
    float n = fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
    return fade > 0.0 ? n < fade : n >= -fade;
}
#endif
