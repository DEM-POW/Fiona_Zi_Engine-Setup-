// The geometry of a 1990s console (Rendering Features > Retro Console Look).
//
// A PlayStation kept its vertices in whole pixels, so a shape shivers as it moves;
// and it drew textures across a triangle with no regard for depth, so they bend.
// Both are one line each here, and both are nothing at all while u_Retro is zero.

uniform vec4 u_Retro;   // xy: the picture in pixels; z: vertex snap; w: texture swim

vec4 FZE_RetroSnap(vec4 clip) {
    if (u_Retro.z <= 0.0 || clip.w <= 0.0) return clip;
    vec2 grid = u_Retro.xy * 0.5;
    vec2 ndc = clip.xy / clip.w;
    clip.xy = mix(ndc, floor(ndc * grid + 0.5) / grid, u_Retro.z) * clip.w;
    return clip;
}
