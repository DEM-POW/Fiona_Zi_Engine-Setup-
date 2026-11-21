#version 460 core
// ---------------------------------------------------------------
//  Fiona Zi Engine - a character, lit (Animation 2.0)
// ---------------------------------------------------------------
// The skinned body through the shared lit fragment shader (Lit.frag), drawn by
// Anim/CharacterRenderer as a self-drawn surface - so a character is in the
// prepass, the sun's cascades and the AO like every other surface.

layout(location = 0) in vec3  a_Position;
layout(location = 1) in vec3  a_Normal;
layout(location = 2) in vec2  a_TexCoord;
layout(location = 3) in ivec4 a_Joints;
layout(location = 4) in vec4  a_Weights;

uniform mat4 u_ViewProjection;
uniform mat4 u_Model;

#include "lib/Skinning.glsl"
#include "lib/Retro.glsl"
noperspective out vec2 v_AffineUV;
noperspective out vec3 v_AffinePos;

out vec3 v_WorldPos;
out vec3 v_Normal;
out vec2 v_TexCoord;
out vec3 v_GridPos;       // Lit.frag's prototype grid: a skinned mesh never shows it
out vec3 v_GridNormal;

// Lit.frag reads the surface numbers from the vertex stage (see Skinned.vert).
uniform vec3  u_BaseColor;
uniform float u_Metallic;
uniform float u_Roughness;
uniform float u_Reflectance;
flat out vec4 v_MatColorMetal;
flat out vec4 v_MatRoughRefl;

// The prepass writes this body's depth; the lit pass tests LEQUAL against it.
invariant gl_Position;

#ifdef FZE_WEIGHTS
// The Skin Weight Editor's view: how much u_WeightJoint moves this vertex, as
// the colours every rigging tool uses - blue nothing, green half, red all.
// A vertex whose weights do not add up to one is magenta: it is wrong.
uniform int u_WeightJoint;
out vec3 v_Tint;
vec3 Heat(float w)
{
    const vec3 c[5] = vec3[5](vec3(0.03, 0.06, 0.42), vec3(0.00, 0.52, 0.92), vec3(0.12, 0.82, 0.22),
                              vec3(1.00, 0.86, 0.06), vec3(1.00, 0.14, 0.06));
    float x = clamp(w, 0.0, 1.0) * 4.0;
    int i = min(int(x), 3);
    return mix(c[i], c[i + 1], x - float(i));
}
#endif

void main()
{
    vec3 p, n;
    FZE_Skin(a_Position, a_Normal, a_Joints, a_Weights, p, n);
    vec4 world = u_Model * vec4(p, 1.0);
    v_WorldPos = world.xyz;
    v_GridPos = a_Position;
    v_GridNormal = vec3(0.0, 1.0, 0.0);
    v_Normal   = normalize(transpose(inverse(mat3(u_Model))) * n);
    v_TexCoord = a_TexCoord;
    v_AffineUV = a_TexCoord;
    v_AffinePos = world.xyz;
    v_MatColorMetal = vec4(u_BaseColor, u_Metallic);
    v_MatRoughRefl  = vec4(u_Roughness, u_Reflectance, 0.0, 0.0);
#ifdef FZE_WEIGHTS
    float w = 0.0, total = 0.0;
    for (int k = 0; k < 4; ++k) {
        if (a_Weights[k] > 0.0) total += a_Weights[k];
        if (a_Joints[k] == u_WeightJoint) w += a_Weights[k];
    }
    v_Tint = abs(total - 1.0) > 0.002 ? vec3(1.0, 0.0, 1.0) : Heat(w);
#endif
    gl_Position = u_ViewProjection * world;
}
