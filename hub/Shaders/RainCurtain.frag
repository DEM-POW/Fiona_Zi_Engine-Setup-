#version 460 core
// ============================================================================
//  A SHEET OF FAR RAIN
//
//  Columns a couple of pixels wide round the cylinder, each with streaks the
//  length one shutter's fall makes, falling at the type's speed and leaning
//  with the wind across the sheet. Hidden where the weather map has a roof
//  over the point (a curtain does not fall inside a building the camera is
//  looking into). Lit by the sky and the directional lights - the sun among
//  them - through the same forward lobe the near drops have.
// ============================================================================

in vec3  v_World;
in vec3  v_Light;
flat in float v_Radius;
flat in int v_Layer;
out vec4 FragColor;

#include "lib/Wind.glsl"
#include "lib/WeatherMap.glsl"

uniform vec3  u_CameraPos;
uniform float u_Time;
uniform float u_PixelAngle;
uniform float u_Fall;           // m/s
uniform float u_Shutter;
uniform float u_Alpha;          // 0..1 how dense, from the intensity
uniform int   u_Form;           // 0 streak / 2 pellet, 1 flake
uniform vec3  u_Color;
uniform vec2  u_Span;

uint Hash(uint x) {
    x ^= x >> 16u; x *= 0x7feb352du;
    x ^= x >> 15u; x *= 0x846ca68bu;
    x ^= x >> 16u;
    return x;
}
float H01(uint x) { return float(Hash(x) & 0xffffffu) / 16777216.0; }

float Sheet(vec2 uv, float colW, float len, float gap, uint salt) {
    float c = floor(uv.x / colW);
    uint cid = uint(int(c) + 100000) * 747796405u + salt;
    float off = H01(cid) * 37.0;
    float speed = mix(0.85, 1.15, H01(cid ^ 0x51ed27u));
    float y = (uv.y + u_Time * u_Fall * speed + off) / (len + gap);
    float k = fract(y);
    float inStreak = 1.0 - smoothstep(len / (len + gap) * 0.7, len / (len + gap), k);
    inStreak *= smoothstep(0.0, 0.08, k);
    float x = fract(uv.x / colW) * 2.0 - 1.0;
    float across = 1.0 - smoothstep(0.2, 1.0, abs(x));
    float lit = mix(0.4, 1.0, H01(cid + uint(floor(y)) * 31u));
    return inStreak * across * lit * step(0.35, H01(cid * 3u + uint(floor(y))));
}

void main() {
    vec3 P = v_World;
    if (u_HasWeatherMap == 1) {
        vec2 uv = FZE_WeatherUV(P.xz);
        if (FZE_WeatherInside(uv) && FZE_WeatherTop(uv) > P.y) discard;
    }
    vec3 d = P - u_CameraPos;
    float ang = atan(d.z, d.x);
    vec2 tangent = vec2(-sin(ang), cos(ang));
    // Across the sheet in metres along its arc; the wind leans the streaks.
    float across = ang * v_Radius;
    float lean = dot(u_WindMean.xz, tangent) / max(u_Fall, 0.5);
    vec2 uv = vec2(across + P.y * lean, P.y);
    float pix = v_Radius * u_PixelAngle;
    float a;
    if (u_Form == 1) {
        // Snow far off: specks drifting down.
        float colW = max(pix * 3.0, 0.04);
        a = Sheet(uv, colW, colW, colW * 6.0, 0x2c9277b5u + uint(v_Layer)) * 0.8;
    } else {
        float colW = max(pix * 2.0, 0.01);
        float len = max(u_Fall * u_Shutter, pix * 3.0);
        a = 1.4 * Sheet(uv, colW, len, len * 3.0, 0x9e3779b9u + uint(v_Layer));
    }
    // Faded at the top and bottom of the cylinder, and straight overhead.
    float h = (P.y - u_CameraPos.y + u_Span.x) / (u_Span.x + u_Span.y);
    a *= smoothstep(0.0, 0.15, h) * (1.0 - smoothstep(0.7, 1.0, h));
    vec3 V = normalize(d);
    a *= 1.0 - smoothstep(0.75, 0.95, abs(V.y));
    a *= u_Alpha;
    if (a <= 0.0005) discard;

    a = min(a, 0.6);
    FragColor = vec4(v_Light * u_Color * a, a);
}
