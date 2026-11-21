#version 460 core
// ============================================================================
//  FAR RAIN: CYLINDERS OF STREAKS BEYOND THE PARTICLE BOXES
//
//  The particles fill the forty metres round the camera; beyond them a
//  downpour is still visible as streaks, and drawing it with particles would
//  take a hundred thousand of them. Tatarchuk's ToyShop rain (2006) and every
//  game since draw it as layers: here three cylinders round the camera, at
//  22, 40 and 70 m, each a procedural sheet of falling streaks
//  (RainCurtain.frag), depth-tested against the scene so a building in front
//  hides the rain behind it. One instance a cylinder; the strip is made from
//  the vertex index.
// ============================================================================

#include "lib/Lights.glsl"

uniform mat4  u_ViewProj;
uniform vec3  u_CameraPos;
uniform vec3  u_Radii;          // metres
uniform vec2  u_Span;           // below, above the camera
uniform samplerCube u_Irradiance;
uniform int   u_HasIBL;
uniform float u_SkyScale;

out vec3  v_World;
out vec3  v_Light;
flat out float v_Radius;
flat out int v_Layer;

const int kSegments = 96;

void main() {
    int i = gl_VertexID >> 1;
    bool topV = (gl_VertexID & 1) == 1;
    float a = float(i) / float(kSegments) * 6.2831853;
    float r = gl_InstanceID == 0 ? u_Radii.x : (gl_InstanceID == 1 ? u_Radii.y : u_Radii.z);
    vec3 p = u_CameraPos + vec3(cos(a) * r, topV ? u_Span.y : -u_Span.x, sin(a) * r);
    v_World = p;
    v_Radius = r;
    v_Layer = gl_InstanceID;
    gl_Position = u_ViewProj * vec4(p, 1.0);
    // ⚠️ LIT HERE, NOT PER PIXEL. A sheet of far rain covers the screen; its
    // light changes over metres, not pixels - per pixel it cost more than
    // every near drop together.
    vec3 V = normalize(p - u_CameraPos);
    vec3 L = u_HasIBL == 1 ? texture(u_Irradiance, vec3(0.0, 1.0, 0.0)).rgb * u_SkyScale * 1.4 : vec3(0.0);
    for (int i = 0; i < min(u_DirectionalCount, 4); ++i) {
        FZELight li = fzeLights[i];
        float c = dot(li.DirCos.xyz, -V);
        float g = 0.7, g2 = g * g;
        float hg = (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
        L += li.Intensity.rgb * (0.03 + 1.5 * hg);
    }
    v_Light = L;
}
