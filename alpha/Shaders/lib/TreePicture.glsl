#ifndef FZE_TREE_PICTURE_GLSL
#define FZE_TREE_PICTURE_GLSL
// =============================================================================
//  TREE PICTURES: a far tree drawn as pictures of itself (Engine/Foliage,
//  docs/LAB.md "Far trees").
//
//  A tree kind is photographed once, from N x N directions over the upper half
//  of the sky round it: a hemi-octahedral grid, so the views from above that a
//  hill or a roof gives are there too. Each picture has the colour and its
//  cut-out shape (one atlas), and the normal, the depth in front of the crown's
//  centre and the height up the tree (the other). Far away a tree is one square
//  facing the camera that shows the three pictures taken nearest to where the
//  camera is, blended by how near each one is, so it never jumps from one
//  picture to the next as the camera goes round it.
//
//  Directions are in the tree's own axes (before its yaw), y up, pointing from
//  the crown's centre towards the camera.
// =============================================================================

// A direction above the horizon to its place on the grid, 0..1 on both axes.
vec2 FZE_PicDirToGrid(vec3 d) {
    d.y = max(d.y, 0.0);
    d /= abs(d.x) + d.y + abs(d.z) + 1e-6;
    return vec2(d.x + d.z, d.x - d.z) * 0.5 + 0.5;
}

vec3 FZE_PicGridToDir(vec2 g) {
    vec2 p = g * 2.0 - 1.0;
    vec2 xz = vec2(p.x + p.y, p.x - p.y) * 0.5;
    return normalize(vec3(xz.x, max(1.0 - abs(xz.x) - abs(xz.y), 0.0), xz.y));
}

// A picture's own axes: right and up across it, as the camera that took it saw them.
void FZE_PicBasis(vec3 D, out vec3 T, out vec3 B) {
    T = abs(D.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), D));
    B = cross(D, T);
}

// Where the ray from the eye through a point of the square meets picture F's own
// plane, in that picture's 0..1 coordinates. eyeL is the eye and rayL the ray, in the
// tree's axes from the crown's centre; R the crown's radius.
vec2 FZE_PicUV(vec2 F, float n1, vec3 eyeL, vec3 rayL, float R) {
    vec3 D = FZE_PicGridToDir(F / n1);
    vec3 T, B;
    FZE_PicBasis(D, T, B);
    float den = dot(rayL, D);
    float t = -dot(eyeL, D) / (abs(den) > 1e-6 ? den : -1e-6);
    vec3 hit = eyeL + rayL * t;
    return vec2(dot(hit, T), dot(hit, B)) / R * 0.5 + 0.5;
}

// A normal in two 0..1 numbers (octahedral, y up), and back.
vec2 FZE_PicPackNormal(vec3 n) {
    n /= abs(n.x) + abs(n.y) + abs(n.z);
    vec2 p = n.y >= 0.0 ? n.xz : (1.0 - abs(n.zx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.z >= 0.0 ? 1.0 : -1.0);
    return p * 0.5 + 0.5;
}

vec3 FZE_PicUnpackNormal(vec2 e) {
    vec2 p = e * 2.0 - 1.0;
    vec3 n = vec3(p.x, 1.0 - abs(p.x) - abs(p.y), p.y);
    float t = max(-n.y, 0.0);
    n.x += n.x >= 0.0 ? -t : t;
    n.z += n.z >= 0.0 ? -t : t;
    return normalize(n);
}

// One picture's texel: F the picture on the grid, uv in it, n the grid's size.
// Kept half a texel inside its own picture, so the filter never reads the next one.
vec4 FZE_PicTexel(sampler2D atlas, vec2 F, vec2 uv, float n, float inset) {
    return texture(atlas, (F + clamp(uv, vec2(inset), vec2(1.0 - inset))) / n);
}

// 1 where uv is inside its picture, 0 outside it (the square is larger than any one view).
float FZE_PicInside(vec2 uv) {
    return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
}

// ⚠️ THE SAME PIXELS IN EVERY PASS. A tree changing level is drawn twice for a few
// metres, each version on the pixels the other leaves (Trees Change Detail Softly): fade
// > 0 is the version going, kept where the noise is at least `fade`; fade < 0 the one
// coming, kept where it is under -fade. Interleaved gradient noise (Jimenez 2014) of the
// pixel alone, so the prepass, the ambient occlusion's depth and the lit pass agree.
bool FZE_PicFadeCut(float fade, vec2 pixel) {
    float n = fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
    return fade > 0.0 ? n < fade : n >= -fade;
}
#endif
