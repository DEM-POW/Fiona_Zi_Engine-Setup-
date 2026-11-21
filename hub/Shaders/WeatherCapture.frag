#version 460 core
// ============================================================================
//  THE WORLD FROM ABOVE, FOR THE WEATHER: depth, and what each surface is
//
//  Drawn with Depth.vert into the weather capture (Renderer, WeatherSurface).
//  The depth is the top surface's height; this writes its SurfaceType, so a
//  drop that lands knows whether it struck sheet metal or a lawn and the
//  ground's water knows how fast that surface drinks. A material cut out of
//  its picture (leaves, a fence) is cut here as in every depth pass: a canopy
//  shelters where its leaves are, not as a solid card.
// ============================================================================

in vec2 v_UV;
uniform float     u_SurfaceType;   // SurfaceType as a number
uniform int       u_Cutout;
uniform sampler2D u_AlbedoMap;
uniform float     u_AlphaCutoff;
layout(location = 0) out vec4 o_Surface;

void main() {
    if (u_Cutout != 0) {
        float a = texture(u_AlbedoMap, v_UV).a;
        a *= 1.0 + max(textureQueryLod(u_AlbedoMap, v_UV).x, 0.0) * 0.25;
        if (a < u_AlphaCutoff) discard;
    }
    o_Surface = vec4(u_SurfaceType / 255.0, 0.0, 0.0, 1.0);
}
