#version 460 core

// The water surface: a flat grid lifted by the wave sum.
//
// ⚠️ THE SAME FOUR WAVES AS WaveSurfaceOffset (Renderer/WaterComponent.h). The
// uniforms are built from that function's tables, so the drawn surface, the
// physics' buoyancy and the rain's rings all agree on where the water is.
// Height from WORLD position, so the grid can slide with the camera (open
// water) without the waves sliding with it.

layout(location = 0) in vec3 a_Position;
// ⚠️ ON A WATER MESH THE NORMAL'S XZ IS THE FLOW, m/s. A water surface has no
// use for a stored normal - the fragment shader builds it from the waves - and
// a river needs a velocity at every vertex along its course. The flat grids
// carry (0, 1, 0): still water, moved only by the body's own u_Current.
layout(location = 1) in vec3 a_Normal;

uniform mat4  u_ViewProjection;
uniform mat4  u_Model;          // square: centre + Size; sea: under the camera; river/pond: identity
// World height of the rest surface. A river or pond is built in the world with
// each vertex already at its own level (a river falls along its course), and
// passes 0; the flat grids are at y = 0 and pass their level.
uniform float u_Level;
uniform float u_Time;
uniform vec4  u_WaveDirK[4];    // xy direction of travel, z wavenumber k, w angular frequency
uniform float u_WaveAmp[4];

out vec3 v_WorldPos;
out vec2 v_Flow;

void main() {
    vec3 p = (u_Model * vec4(a_Position, 1.0)).xyz;
    float h = 0.0;
    for (int i = 0; i < 4; ++i) {
        float phase = u_WaveDirK[i].z * dot(u_WaveDirK[i].xy, p.xz) - u_WaveDirK[i].w * u_Time;
        h += u_WaveAmp[i] * sin(phase);
    }
    p.y += u_Level + h;
    v_WorldPos = p;
    v_Flow = a_Normal.xz;      // a river mesh is built in world space, so its flow already is
    gl_Position = u_ViewProjection * vec4(p, 1.0);
}
