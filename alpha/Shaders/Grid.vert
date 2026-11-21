#version 460 core

// Infinite editor grid — the ground plane is reconstructed PER PIXEL, not built
// from line geometry.
//
// The old grid was a fixed cage of DebugRenderer lines (20 x 20 cells): it ran
// out a few metres from the origin, and because a line is rasterised at a fixed
// width in screen space it broke into dashes and crawled with moire the moment
// you looked along the plane. Ray-marching the plane in the fragment shader fixes
// both: the grid has no extent to run out of, and the line width is derived from
// the pixel footprint (fwidth), so a line is exactly one pixel wide at ANY angle.
//
// This stage only fires a full-screen triangle and hands the fragment shader the
// two ends of that pixel's view ray, in world space.

uniform mat4 u_InvViewProj;

out vec3 v_NearPoint;
out vec3 v_FarPoint;

vec3 Unproject(vec2 ndc, float z)
{
    vec4 p = u_InvViewProj * vec4(ndc, z, 1.0);
    return p.xyz / p.w;
}

void main()
{
    // Full-screen TRIANGLE (3 verts, no buffer): ndc (-1,-1), (3,-1), (-1,3).
    vec2 p   = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vec2 ndc = p * 2.0 - 1.0;

    v_NearPoint = Unproject(ndc, -1.0);
    v_FarPoint  = Unproject(ndc,  1.0);

    gl_Position = vec4(ndc, 0.0, 1.0);
}
