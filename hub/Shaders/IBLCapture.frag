#version 460 core

// ============================================================================
//  THE SKY, CAPTURED ONCE INTO A SMALL CUBE (Renderer/IBL)
//
//  ⚠️ THE FILTERS USED TO EVALUATE THE ATMOSPHERE FOR EVERY SAMPLE THEY TOOK.
//  128 GGX samples a texel for the reflections, a thousand for the ambient:
//  about 23 million evaluations of the sky per bake, 163 ms of an integrated
//  GPU - and the bake runs again whenever the clouds thicken by 2% or the sun
//  moves a degree, so a weather change was a run of hitches. Unreal's
//  sky light and Filament's cmgen do it the other way round, and so does this
//  now: the sky is evaluated ONCE per texel of a 128 px cube, its mips are
//  built, and both filters read that (Krivanek & Colbert, GPU Gems 3 ch. 20).
// ============================================================================

in vec2 v_UV;
out vec4 FragColor;

uniform vec3 u_FaceFwd, u_FaceRight, u_FaceUp;   // face basis (c in [-1,1] -> dir)

#include "lib/IBLSky.glsl"

void main() {
    vec2 c = v_UV * 2.0 - 1.0;
    vec3 d = normalize(u_FaceFwd + c.x * u_FaceRight + c.y * u_FaceUp);
    FragColor = vec4(max(Sky(d), vec3(0.0)), 1.0);
}
