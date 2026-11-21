#version 460 core
// ---------------------------------------------------------------
//  Fiona Zi Engine - the game UI (Gui/Renderer)
// ---------------------------------------------------------------
// Target pixels in, clip space out through u_Proj - an orthographic flip for
// the game's screen, the editor camera times the canvas's plane for the scene
// view. Masks are clipped per pixel (a_Clip, target pixels), never by a
// scissor, so they hold in either projection. Every
// shape is drawn in its own pixel space (a_Local, from its centre, before the
// node's rotation and scale), so a distance field's edge stays one pixel wide
// whatever the transform.

layout(location = 0) in vec2 a_Pos;
layout(location = 1) in vec2 a_UV;
layout(location = 2) in vec2 a_Local;
layout(location = 3) in vec4 a_Color;
layout(location = 4) in vec4 a_Color2;
layout(location = 5) in vec4 a_Border;
layout(location = 6) in vec4 a_P0;     // half size x/y, mode, border width
layout(location = 7) in vec4 a_P1;     // corner radii tl tr br bl  | text: outline, softness, weight, -
layout(location = 8) in vec4 a_P2;     // gradient, blur, fill amount, fill start
layout(location = 9) in vec4 a_Clip;   // min x, min y, max x, max y (target pixels)

uniform mat4 u_Proj;

out vec2 v_UV;
out vec2 v_Local;
out vec4 v_Color;
out vec4 v_Color2;
out vec4 v_Border;
flat out vec4 v_P0;
flat out vec4 v_P1;
flat out vec4 v_P2;
out vec2 v_Pos;
flat out vec4 v_Clip;

void main()
{
    v_UV = a_UV;
    v_Local = a_Local;
    v_Color = a_Color;
    v_Color2 = a_Color2;
    v_Border = a_Border;
    v_P0 = a_P0;
    v_P1 = a_P1;
    v_P2 = a_P2;
    v_Pos = a_Pos;
    v_Clip = a_Clip;
    gl_Position = u_Proj * vec4(a_Pos, 0.0, 1.0);
}
