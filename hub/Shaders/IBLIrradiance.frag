#version 460 core

// Diffuse IBL: convolve the sky over the hemisphere around each cubemap
// texel's direction. Rendered once per cube face.

in vec2 v_UV;
out vec4 FragColor;

uniform vec3 u_FaceFwd, u_FaceRight, u_FaceUp;   // face basis (c in [-1,1] -> dir)
uniform vec3 u_SunDir;      // towards the sun (the daylight readout)

#include "lib/IBLSky.glsl"

// The sky captured into a cube (IBLCapture.frag), with its mips. ⚠️ READ AT A
// MIP WHOSE TEXEL IS ONE SAMPLE'S SHARE OF THE HEMISPHERE: 128 samples of
// 2 pi / 128 sr each are one texel of a 6-7 px level (lod 4.3 of 128), so
// the sum is the integral of the whole dome and not 128 pinpricks of it. The
// thousand analytic evaluations this replaced were most of a 163 ms bake.
uniform samplerCube u_SkyCube;
uniform float u_SkyLod;

// 0: a cube face. 1: the sky's irradiance on a horizontal surface, and 2: the
// sun's transmittance down to the ground - the two halves of what "white" is in
// daylight, read back by IBL.cpp for the camera's white balance. Computed here
// so there is one sky model, not a second one on the CPU. (⚠️ 1 READS THE CUBE
// TOO: it is one pixel, and one GPU thread evaluating the atmosphere a thousand
// times in a row was most of what was left of the bake - 8 ms.)
uniform int u_Daylight;

void main() {
    if (u_Daylight == 2) {
        FragColor = vec4(FZE_SunThroughAir(FZE_AtmosphereFromUniforms(), vec3(0.0),
                                           normalize(u_SunDir)), 1.0);
        return;
    }
    vec2 c = v_UV * 2.0 - 1.0;
    vec3 N = u_Daylight == 1 ? vec3(0.0, 1.0, 0.0)
                             : normalize(u_FaceFwd + c.x * u_FaceRight + c.y * u_FaceUp);

    vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 right = normalize(cross(up, N));
    up = normalize(cross(N, right));

    vec3 irradiance = vec3(0.0);
    float samples = 0.0;
    {
        // A midpoint grid, 16 around by 8 up: the same estimator (pi / N times
        // the sum of L cos sin), so the map keeps its units.
        const int kPhi = 16, kTheta = 8;
        for (int i = 0; i < kPhi; ++i) {
            float phi = (float(i) + 0.5) * (2.0 * PI / float(kPhi));
            for (int j = 0; j < kTheta; ++j) {
                float theta = (float(j) + 0.5) * (0.5 * PI / float(kTheta));
                vec3 t = vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));
                vec3 dir = t.x * right + t.y * up + t.z * N;
                irradiance += textureLod(u_SkyCube, dir, u_SkyLod).rgb * cos(theta) * sin(theta);
                samples += 1.0;
            }
        }
    }
    irradiance = PI * irradiance / samples;
    FragColor = vec4(irradiance, 1.0);
}
