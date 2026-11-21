#version 460 core
// =============================================================================
//  DEPTH FOR A SOLID SURFACE BETWEEN TWO LEVELS OF DETAIL (lib/LodFade.glsl).
//
//  Its own program, used only for those few draws: a discard here would cost
//  every solid surface its early depth test if Depth.frag carried it.
// =============================================================================
#include "lib/LodFade.glsl"

uniform float u_LodFade;

void main() {
    if (FZE_LodFadeCut(u_LodFade, gl_FragCoord.xy)) discard;
}
