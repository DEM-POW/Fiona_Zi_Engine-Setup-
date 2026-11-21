#version 460 core

// One axis of the voxelisation. See VoxelInject.frag for why there are three.

layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Normal;
layout(location = 2) in vec2 a_UV;

uniform mat4 u_Model;
uniform mat4 u_AxisViewProj;

out vec3 v_WorldPos;
out vec3 v_Normal;

void main() {
    vec4 wp = u_Model * vec4(a_Position, 1.0);
    v_WorldPos = wp.xyz;
    v_Normal   = normalize(mat3(u_Model) * a_Normal);
    gl_Position = u_AxisViewProj * wp;
}
