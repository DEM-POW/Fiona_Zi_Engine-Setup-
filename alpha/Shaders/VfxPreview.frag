#version 460 core
// ---------------------------------------------------------------
//  Fiona Zi Engine - the VFX Editor's preview, made a picture
// ---------------------------------------------------------------
// The preview is drawn in light (linear HDR, pre-exposed, like the scene).
// The scene is given its exposure, tone curve and gamma at the end of
// Composite.frag; this is the same three steps for the editor's own small
// target, so a flame core rolls off the way it does in the level instead of
// clipping to a flat white disc.

#include "lib/Tonemap.glsl"

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Source;
uniform float u_Exposure;
uniform int   u_TonemapMode;   // Environment::TonemapMode

void main() {
    vec3 c = max(texelFetch(u_Source, ivec2(gl_FragCoord.xy), 0).rgb, vec3(0.0)) * u_Exposure;
    c = FZE_Tonemap(c, u_TonemapMode);
    if (!FZE_TonemapEncodes(u_TonemapMode))
        c = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
    FragColor = vec4(c, 1.0);
}
