#version 460 core

layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Normal;
layout(location = 2) in vec2 a_TexCoord;

uniform mat4 u_ViewProjection;
uniform mat4 u_Model;

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

// ---- per-instance surface ---------------------------------------------------
//
// ⚠️ FOUR NUMBERS THAT USED TO FORCE A SEPARATE DRAW CALL. Base colour,
// metallic, roughness and reflectance are what content varies from one prop to
// the next; carrying them per instance is what lets a hundred differently
// tinted crates be one call instead of a hundred.
//
// They leave here as FLAT varyings and the fragment shader reads only those, so
// there is one code path in the fragment shader rather than two: on a
// non-instanced draw this fills them from the same uniforms it always used.
layout(location = 7) in vec4 a_InstColorMetal;   // rgb = base colour, a = metallic
layout(location = 8) in vec4 a_InstRoughRefl;    // x = roughness, y = reflectance

uniform vec3  u_BaseColor;
uniform float u_Metallic;
uniform float u_Roughness;
uniform float u_Reflectance;

flat out vec4 v_MatColorMetal;
flat out vec4 v_MatRoughRefl;


out vec3 v_WorldPos;
out vec3 v_Normal;
out vec2 v_TexCoord;
// The object's OWN space with its scale applied - metres measured on the object:
// the prototype grid travels with it (moved, turned) and stays square when it is
// stretched (Lit.frag, u_Checker).
out vec3 v_GridPos;
out vec3 v_GridNormal;
// The mesh's own lowest corner: the grid starts at the object's edges, so a box
// 1 m tall has its lines on its top and bottom, not one through its middle.
uniform vec3 u_GridOrigin;

// Must match Depth.vert exactly — the depth prepass writes the value this pass
// tests against. See the long note there.
invariant gl_Position;

#include "lib/Retro.glsl"
noperspective out vec2 v_AffineUV;
noperspective out vec3 v_AffinePos;

void main()
{
    vec4 world = FZE_Model() * vec4(a_Position, 1.0);
    v_WorldPos = world.xyz;
    // The NORMAL matrix, not the model matrix. A normal is not a direction you
    // can push through the model matrix: under NON-uniform scale (a box stretched
    // tall, a torus flattened) the plain mat3(u_Model) shears every normal off the
    // surface, and the lighting slides across the model as if it were greased —
    // the "distortion when I scale it" the artist sees. The inverse-transpose is
    // the one transform that keeps a normal perpendicular to its surface through
    // any scale or shear.
    mat3 normalMatrix = transpose(inverse(mat3(FZE_Model())));
    v_Normal = normalize(normalMatrix * a_Normal);
    {
        mat4 M = FZE_Model();
        vec3 scale = vec3(length(M[0].xyz), length(M[1].xyz), length(M[2].xyz));
        v_GridPos = (a_Position - u_GridOrigin) * scale;
        v_GridNormal = a_Normal / max(scale, vec3(1e-6));   // the inverse-transpose of a scale
    }
    v_TexCoord = a_TexCoord;
    v_AffineUV = a_TexCoord;
    v_AffinePos = world.xyz;
    v_MatColorMetal = (u_Instanced != 0) ? a_InstColorMetal
                                         : vec4(u_BaseColor, u_Metallic);
    v_MatRoughRefl  = (u_Instanced != 0) ? a_InstRoughRefl
                                         : vec4(u_Roughness, u_Reflectance, 0.0, 0.0);
    gl_Position = FZE_RetroSnap(u_ViewProjection * world);
}
