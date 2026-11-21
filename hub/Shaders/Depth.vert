#version 460 core

layout(location = 0) in vec3 a_Position;
layout(location = 2) in vec2 a_TexCoord;

uniform mat4 u_LightSpace;
uniform mat4 u_Model;
// For DepthCutout.frag: where on its picture this point is.
uniform vec2 u_UVScale;
uniform vec2 u_UVOffset;
out vec2 v_UV;

// ---- instancing -------------------------------------------------------------
//
// ⚠️ LOCATIONS 3..6 ARE ONE mat4, and they are the same four locations the
// foliage renderer has always used - Mesh::DrawInstanced sets them up with a
// divisor of 1. Sharing the convention means a mesh needs one instance buffer,
// not one per shader that might draw it.
//
// u_Instanced selects the source. A disabled vertex attribute reads back a
// constant, so the attribute is not merely unused on a non-instanced draw, it is
// meaningless - the branch is what keeps it from being read at all.
layout(location = 3) in mat4 a_InstanceModel;
uniform int u_Instanced;

mat4 FZE_Model() { return (u_Instanced != 0) ? a_InstanceModel : u_Model; }


// ⚠️ THIS MUST AGREE WITH Lit.vert TO THE LAST BIT.
//
// This shader now writes the depth that the lit pass TESTS AGAINST rather than
// only feeding shadow maps, so a surface has to land on exactly the same depth in
// both programs. It used to read
//
//     gl_Position = u_LightSpace * FZE_Model() * vec4(a_Position, 1.0);
//
// which GLSL groups as (u_LightSpace * u_Model) * p — a matrix product, then one
// transform. Lit.vert does u_ViewProjection * (FZE_Model() * p) — two transforms.
// Those are the same in algebra and NOT the same in floating point, and the
// difference lands in the last bits of z. With the lit pass testing GL_LEQUAL
// that is a hole in the surface wherever the prepass rounded the other way.
//
// `invariant` is the other half: without it the compiler is free to optimise the
// same expression differently in two programs, which reintroduces exactly the
// mismatch this ordering was written to remove.
invariant gl_Position;

#include "lib/Retro.glsl"

void main()
{
    vec4 world = FZE_Model() * vec4(a_Position, 1.0);
    gl_Position = FZE_RetroSnap(u_LightSpace * world);
    v_UV = a_TexCoord * u_UVScale + u_UVOffset;
}
