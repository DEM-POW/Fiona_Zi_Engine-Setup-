// ---------------------------------------------------------------
//  Fiona Zi Engine — the wind, as one field everything reads
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//  ⚠️ THE SAME ARITHMETIC AS Engine/Weather/Wind.cpp - the same hash, noise
//  and constants - so what the CPU says the air is doing, the drops do.
//  Change one, change both.
// ---------------------------------------------------------------
#ifndef FZE_WIND_GLSL
#define FZE_WIND_GLSL

uniform vec3 u_WindMean;     // m/s, the mean wind
uniform vec4 u_WindParams;   // x gust 0..1, y turbulence 0..1, z speed m/s, w the wind's clock (s)

uint FZE_WindHash3(ivec3 c) {
    uint h = uint(c.x) * 0x8da6b343u ^ uint(c.y) * 0xd8163841u ^ uint(c.z) * 0xcb1ab31fu;
    h ^= h >> 16u; h *= 0x7feb352du;
    h ^= h >> 15u; h *= 0x846ca68bu;
    h ^= h >> 16u;
    return h;
}
float FZE_WindH01(ivec3 c) { return float(FZE_WindHash3(c) & 0xffffffu) / 16777216.0; }

float FZE_WindNoise3(vec3 p) {
    vec3 f = floor(p);
    ivec3 i = ivec3(f);
    vec3 t = p - f;
    vec3 s = t * t * (3.0 - 2.0 * t);
    float a = FZE_WindH01(i),                 b = FZE_WindH01(i + ivec3(1, 0, 0));
    float c = FZE_WindH01(i + ivec3(0, 1, 0)), d = FZE_WindH01(i + ivec3(1, 1, 0));
    float e = FZE_WindH01(i + ivec3(0, 0, 1)), g = FZE_WindH01(i + ivec3(1, 0, 1));
    float h = FZE_WindH01(i + ivec3(0, 1, 1)), k = FZE_WindH01(i + ivec3(1, 1, 1));
    float ab = a + (b - a) * s.x, cd = c + (d - c) * s.x;
    float eg = e + (g - e) * s.x, hk = h + (k - h) * s.x;
    float lo = ab + (cd - ab) * s.y, hi = eg + (hk - eg) * s.y;
    return lo + (hi - lo) * s.z;
}

float FZE_WindGust(vec3 pos, float t) {
    vec3 q = (pos - u_WindMean * t) * (1.0 / 35.0);
    float g = 0.7 * FZE_WindNoise3(vec3(q.x, q.z, t * 0.08))
            + 0.3 * FZE_WindNoise3(vec3(q.x * 2.3 + 5.1, q.z * 2.3, t * 0.17));
    float x = clamp((g - 0.35) / 0.5, 0.0, 1.0);
    return x * x * (3.0 - 2.0 * x);
}

vec3 FZE_WindAt(vec3 pos, float t) {
    float strength = 1.0 + u_WindParams.x * (FZE_WindGust(pos, t) * 1.6 - 0.3);
    vec3 r = (pos - u_WindMean * (t * 0.8)) * (1.0 / 7.0);
    vec3 eddy = vec3(
        FZE_WindNoise3(r + vec3(11.0, t * 0.6, 0.0)) - 0.5,
        (FZE_WindNoise3(r + vec3(23.0, 0.0, t * 0.5)) - 0.5) * 0.4,
        FZE_WindNoise3(r + vec3(37.0, t * 0.55, 5.0)) - 0.5);
    float turb = u_WindParams.y * (0.4 * u_WindParams.z + 0.3);
    return u_WindMean * strength + eddy * (2.0 * turb);
}

vec3 FZE_WindAt(vec3 pos) { return FZE_WindAt(pos, u_WindParams.w); }

#endif // FZE_WIND_GLSL
