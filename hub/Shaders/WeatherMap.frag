#version 460 core
// ============================================================================
//  THE WEATHER MAP: the weather field, baked for the square of sky around the
//  camera. The march reads this instead of evaluating the field at every step;
//  the CPU evaluates the same field (WeatherField::Sample) when it needs one
//  point. It is rebaked only when the weather has moved on by a second or the
//  camera has walked out of the middle of it - the wind's drift since the bake
//  is an offset the samplers apply, not a reason to bake again.
// ============================================================================
#include "lib/WeatherField.glsl"

out vec4 FragColor;

uniform vec4 u_Params;     // cover, kind, size, time (seconds of weather)
uniform vec2 u_Drift;      // metres the wind had carried the field at the bake
uniform vec4 u_Rect;       // xy world corner, zw metres per texel
uniform int  u_Size;
// The living weather (WeatherSim, docs/SKY-PLAN.md phase 3): its cloud and kind here take the place of
// the one cover and kind, and only where it rains does the cloud's core rain.
uniform int       u_SimOn;
uniform sampler2D u_Sim;       // (cloud, kind, rain, moisture) over 64 km
uniform vec4      u_SimRect;   // xy world corner, zw 1 / span

void main() {
    vec2 xz = u_Rect.xy + gl_FragCoord.xy * u_Rect.zw;
    vec4 params = u_Params;
    float raining = 1.0;
    if (u_SimOn == 1) {
        vec4 sim = texture(u_Sim, (xz - u_SimRect.xy) * u_SimRect.zw);
        params.x = sim.x;
        params.y = sim.y;
        raining = smoothstep(0.05, 0.4, sim.z);
    }
    vec4 w = FZE_WeatherField(params, u_Drift, xz);
    w.z *= raining;
    FragColor = w;
}
