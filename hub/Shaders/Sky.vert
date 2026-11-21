#version 460 core

// Fullscreen triangle generated from gl_VertexID (no vertex buffer needed).
out vec2 v_NDC;

void main()
{
    vec2 verts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    v_NDC = verts[gl_VertexID];
    gl_Position = vec4(verts[gl_VertexID], 1.0, 1.0);   // z = 1 (far plane)
}
