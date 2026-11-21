#version 460 core

// A mesh's own triangles, drawn as their edges over it (Modeling Mode's
// wireframe, View > Show > Mesh Edges). The mesh's vertex buffer is read as it
// is: only the position.

layout(location = 0) in vec3 a_Position;

uniform mat4 u_Model;
uniform mat4 u_ViewProjection;
uniform vec3 u_Eye;
// Every point is moved this fraction of its distance toward the eye, so an edge
// wins against the face it lies on at any distance (a constant depth offset
// would be centimetres near the camera and metres far from it).
uniform float u_Pull;

out float v_Distance;

void main()
{
    vec3 world = vec3(u_Model * vec4(a_Position, 1.0));
    v_Distance = length(world - u_Eye);
    world = u_Eye + (world - u_Eye) * (1.0 - u_Pull);
    gl_Position = u_ViewProjection * vec4(world, 1.0);
}
