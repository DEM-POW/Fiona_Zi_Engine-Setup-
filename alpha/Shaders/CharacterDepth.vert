#version 460 core
// ---------------------------------------------------------------
//  Fiona Zi Engine - a character's depth (Animation 2.0)
// ---------------------------------------------------------------
// The same skinning as Character.vert (lib/Skinning.glsl), for the prepass,
// the AO's depth and the sun's cascades. With Depth.frag, or DepthCutout.frag
// for hair and lashes cut out of their picture.

layout(location = 0) in vec3  a_Position;
layout(location = 1) in vec3  a_Normal;
layout(location = 2) in vec2  a_TexCoord;
layout(location = 3) in ivec4 a_Joints;
layout(location = 4) in vec4  a_Weights;

uniform mat4 u_LightSpace;
uniform mat4 u_Model;
uniform vec2 u_UVScale;
uniform vec2 u_UVOffset;
out vec2 v_UV;

#include "lib/Skinning.glsl"

invariant gl_Position;

void main()
{
    vec3 p, n;
    FZE_Skin(a_Position, a_Normal, a_Joints, a_Weights, p, n);
    gl_Position = u_LightSpace * (u_Model * vec4(p, 1.0));
    v_UV = a_TexCoord * u_UVScale + u_UVOffset;
}
