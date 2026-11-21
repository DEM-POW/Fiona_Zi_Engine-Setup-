#version 460 core
// ============================================================================
//  THE CLOUDS' SHADOW, BAKED ONCE A FRAME.
//
//  For each texel of a square of ground around the camera, the sun's ray is
//  followed up through the cloud layer and the optical depth added up from
//  the SAME density the sky is drawn with - so a shadow on the ground belongs
//  to a cloud overhead and moves with it. Stored as the fraction of direct
//  sun that gets through; the lit shaders read it along their own sun ray
//  (lib/Shadows.glsl, CloudShadow).
//
//  The rim's erosion is left out: a shadow is cast from a kilometre up, and
//  the sun's half-degree disc blurs anything finer than about ten metres.
// ============================================================================
#include "lib/CloudVolume.glsl"

out vec4 FragColor;

uniform vec4 u_Rect;         // xy world corner, zw metres per texel
uniform vec3 u_SunDir;       // towards the sun
uniform vec3 u_CameraPos;

void main() {
    if (u_SunDir.y < 0.03) { FragColor = vec4(1.0); return; }
    vec2 g = u_Rect.xy + gl_FragCoord.xy * u_Rect.zw;        // a point on the ground, y = 0
    // Along the sun's ray from the ground through the layer.
    float tIn  = u_CloudBase / u_SunDir.y;
    float tOut = u_CloudTop  / u_SunDir.y;
    const int N = 20;
    float dt = (tOut - tIn) / float(N);
    float tau = 0.0;
    for (int i = 0; i < N; ++i) {
        vec3 p = vec3(g.x, 0.0, g.y) + u_SunDir * (tIn + (float(i) + 0.5) * dt);
        float alt = FZE_CloudAltitude(p, u_CameraPos);
        tau += FZE_CloudDensity(p, alt, FZE_CloudWeather(p), false) * dt;
    }
    FragColor = vec4(exp(-tau * u_CloudSigma), 0.0, 0.0, 1.0);
}
