#version 460 core
// ---------------------------------------------------------------
//  Fiona Zi Engine - a bone or a joint in the Character Preview
// ---------------------------------------------------------------
// Drawn after the scene, over it (the editor's skeleton view): one octahedron
// per bone, one small sphere per joint.

layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Normal;

uniform mat4 u_ViewProjection;
uniform mat4 u_Model;

out vec3 v_Normal;
out vec3 v_WorldPos;

void main()
{
    vec4 world = u_Model * vec4(a_Position, 1.0);
    v_WorldPos = world.xyz;
    v_Normal = normalize(transpose(inverse(mat3(u_Model))) * a_Normal);
    gl_Position = u_ViewProjection * world;
}
