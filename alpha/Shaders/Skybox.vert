#version 460 core

// HDRI skybox on a real UV sphere, the way most engines do it.
//
// Why a mesh and not per-pixel equirect math: atan(z,x) jumps at +/-180deg, so
// its screen-space derivative explodes along one column of pixels and the
// sampler drops to the smallest mip there — a visible vertical seam. A sphere's
// UVs are interpolated per-vertex (with the seam column duplicated), so there is
// no discontinuity for the derivative to trip on.

layout (location = 0) in vec3 a_Pos;   // unit sphere
layout (location = 1) in vec2 a_UV;    // equirect mapping, v=0 at the zenith

uniform mat4 u_ViewProj;
uniform vec3 u_CameraPos;

out vec2 v_UV;

void main()
{
    v_UV = a_UV;
    // The sphere rides on the camera so it never gets closer or farther, and
    // .xyww forces depth to the far plane so every real object draws in front.
    vec4 pos = u_ViewProj * vec4(a_Pos * 10.0 + u_CameraPos, 1.0);
    gl_Position = pos.xyww;
}
