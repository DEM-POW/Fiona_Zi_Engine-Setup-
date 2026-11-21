#version 460 core
// =============================================================================
//  A TREE PHOTOGRAPHED FOR ITS PICTURES (lib/TreePicture.glsl).
//
//  The model's own vertices, in units of its height from its root as the plant
//  draws have them, seen by an orthographic camera from picture u_PicFrame's
//  direction, its crown's sphere filling the picture.
// =============================================================================
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Normal;
layout(location = 2) in vec2 a_TexCoord;

#include "lib/TreePicture.glsl"

uniform vec3  u_ModelPivot;
uniform float u_ModelInvHeight;
uniform vec3  u_PicCenter;        // the crown's centre, in units of the height
uniform float u_PicRadius;
uniform vec2  u_PicFrame;         // which picture, 0..N-1 on both axes
uniform float u_PicGrid;          // N

out vec3  v_Normal;
out vec3  v_Pos;                  // in units of the height: for the normal map's frame
out vec2  v_UV;
out float v_Height01;
out float v_Depth;                // -1..1: how far in front of the centre, towards the camera
flat out vec3 v_D;

void main() {
    vec3 D = FZE_PicGridToDir(u_PicFrame / (u_PicGrid - 1.0));
    vec3 T, B;
    FZE_PicBasis(D, T, B);
    vec3 m = (a_Position - u_ModelPivot) * u_ModelInvHeight;
    vec3 q = m - u_PicCenter;
    float dep = dot(q, D) / u_PicRadius;
    // 0..1 for the depth: inside the clip range whichever depth convention is set.
    gl_Position = vec4(dot(q, T) / u_PicRadius, dot(q, B) / u_PicRadius, 0.5 - 0.5 * dep, 1.0);
    v_Normal = a_Normal;
    v_Pos = m;
    v_UV = a_TexCoord;
    v_Height01 = clamp(m.y, 0.0, 1.0);
    v_Depth = dep;
    v_D = D;
}
