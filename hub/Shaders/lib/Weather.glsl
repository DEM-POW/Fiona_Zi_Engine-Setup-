// ---------------------------------------------------------------
//  Fiona Zi Engine — the weather on surfaces: wet, flooded, snowed on
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//  ONE MODEL FOR EVERY SURFACE SHADER (Lit.frag for meshes, Terrain.frag for
//  the ground, Foliage.frag for the grass), so a kerb and the road beside it
//  cannot disagree about whether it has rained. Lagarde's "Water drop" 2-3
//  (2012-13) is the model:
//
//    * WATER IN THE PORES darkens a porous surface - the light that would
//      have come back out is trapped by total internal reflection in the
//      water filling them (Lekner & Dorf 1988) - and smooths it a little.
//      How porous is the material's (SurfaceType): a soaked brick goes dark,
//      a wet pane of glass barely changes colour.
//    * A FILM on top is a clear coat of water, smoother than what is under it.
//    * STANDING WATER floods the hollows of up-facing ground: the flood level
//      rises through the ground's height - the material's own height map
//      where it has one, a field of broad hollows always - so puddles appear
//      first in the deepest places and spread and merge as the water rises.
//      A puddle is level, dark, a mirror, and struck by rain rings.
//    * SNOW lies on what faces up, deepest in the hollows, broken at its edge.
//
//  WHERE AND HOW MUCH comes from Renderer/WeatherSurface's map: the water on
//  each texel of the ground seen from above. A point that IS the top surface
//  there reads its own texel; one that is not (a wall, a floor under a roof)
//  asks whether the falling weather reaches it - a ray up the fall through
//  the map's heights - and takes the open ground's wetness by how squarely
//  the rain strikes it. Beyond the map: the open ground's (the far field).
// ---------------------------------------------------------------
#ifndef FZE_WEATHER_GLSL
#define FZE_WEATHER_GLSL

#include "Ripples.glsl"
#include "SpecularAA.glsl"
#include "WeatherField.glsl"
#include "WeatherMap.glsl"

uniform vec4  u_WeatherFar;      // the open ground: soak 0..1, film 0..1, standing mm, snow mm
uniform vec3  u_WeatherFall;     // the way the weather falls (unit)
uniform vec4  u_WeatherNow;      // rain mm/h, snow mm/h, temperature C, dew 0..1
uniform float u_Porosity;        // the material's (SurfaceType); 0.35 is neutral
uniform float u_Time;
uniform int   u_WetDebug;        // FZE_WETDEBUG: 1 soak/film/standing, 2 exposure/top/snow

const float FZE_NEUTRAL_POROSITY = 0.35;   // SurfaceType's kNeutralPorosity

struct FZEWeather {
    float soak;       // 0..1 water in the pores
    float film;       // 0..1 the film on top
    float depth;      // mm of standing water
    float snow;       // mm of water lying as snow
    float exposed;    // 0..1 how much of what is falling reaches this point now
    float top;        // 1 when the point is the top surface the map holds
};

bool FZE_WeatherAnything() {
    return u_HasWeatherMap == 1 || dot(u_WeatherFar, vec4(1.0)) > 1e-4
        || u_WeatherNow.x > 0.0 || u_WeatherNow.y > 0.0 || u_WeatherNow.w > 0.001;
}

// How much of what is falling reaches P: a ray from just off the surface up
// the fall, through the map's heights. Leaving the map is open sky.
float FZE_WeatherExposure(vec3 P, vec3 N) {
    return FZE_WeatherOpen(P + N * 0.12 + vec3(0.0, 0.03, 0.0), -u_WeatherFall);
}

FZEWeather FZE_WeatherAt(vec3 P, vec3 Ng) {
    FZEWeather w;
    w.exposed = 1.0;
    w.top = 1.0;
    vec4 W = u_WeatherFar;
    // A wall takes the open ground's wetness by how squarely the rain strikes
    // it (and the water running down from above it); a ceiling none of it.
    float facing = clamp(dot(Ng, -u_WeatherFall), 0.0, 1.0);
    float up = Ng.y;
    float side = up > 0.6 ? 1.0 : clamp(0.3 + 1.4 * facing, 0.0, 1.0) * smoothstep(-0.6, -0.1, up);
    vec4 notTop = vec4(W.r * mix(0.6, 1.0, side) * step(-0.6, up), W.g * side, 0.0, W.a * smoothstep(0.5, 0.8, up));
    if (u_HasWeatherMap == 1) {
        vec2 uv = FZE_WeatherUV(P.xz);
        if (FZE_WeatherInside(uv)) {
            vec4 st = FZE_WeatherStatic(uv);
            if (st.a > 0.5) {
                float topY = st.r + u_WeatherRect.w;
                // The texel's own height holds anywhere on its face; a slope
                // rises across a texel by its width times the slope.
                float texel = 1.0 / (u_WeatherRect.z * u_WeatherRes);
                float ny = max(abs(up), 0.2);
                float tol = 0.08 + texel * sqrt(max(1.0 - ny * ny, 0.0)) / ny;
                float isTop = up > 0.25 ? smoothstep(topY - tol - 0.06, topY - tol + 0.02, P.y) : 0.0;
                vec4 mine = textureLod(u_WeatherMap, vec3(uv, u_WeatherLayers.x), 0.0);
                // ⚠️ THE TOP SURFACE ASKS NO RAY. Its texel's water already knows
                // whether the rain reached it (the step traced that); only a wall,
                // an overhang's underside or a floor under a roof traces one here.
                // Most of an outdoor view is top surface: tracing every pixel cost
                // a tenth of the lit pass on an integrated GPU.
                float ex = isTop > 0.999 ? 1.0 : FZE_WeatherExposure(P, Ng);
                w.exposed = ex;
                // Not the top surface: what the open ground has, if the weather reaches here.
                vec4 other = notTop * ex;
                W = mix(other, mine, isTop);
                w.top = isTop;
            } else {
                float ex = FZE_WeatherExposure(P, Ng);
                w.exposed = ex;
                W = notTop * ex;
                w.top = 0.0;
            }
        } else {
            W = up > 0.6 ? W : notTop;
        }
    } else {
        W = up > 0.6 ? W : notTop;
    }
    w.soak = clamp(W.r, 0.0, 1.0);
    w.film = clamp(W.g, 0.0, 1.0);
    w.depth = max(W.b, 0.0);
    w.snow = max(W.a, 0.0);
    return w;
}

// Raindrops striking a wet film: a dimple where each lands, gone in a third
// of a second. Cells of 12 cm, one strike each per period; a strike is two
// centimetres across at most and sits inside its cell, so only the cell the
// point is in can hold one that reaches it.
vec2 FZE_FilmDropSlope(vec2 p, float time, float rate) {
    if (rate <= 0.05) return vec2(0.0);
    float period = clamp(1.6 / sqrt(rate), 0.12, 2.5);
    const float cell = 0.12;
    vec2 c = floor(p / cell);
    vec2 h = FZE_RingHash2(c + 3.7);
    float tc = time / period + h.x * 5.13;
    float age = fract(tc) * period;
    vec2 jitter = FZE_RingHash2(c + floor(tc) * 2.31);
    vec2 d = p - (c + 0.2 + jitter * 0.6) * cell;
    float r = length(d);
    float rad = 0.004 + 0.012 * min(age / 0.08, 1.0);
    float x = r / rad;
    if (x > 1.0) return vec2(0.0);
    return d / max(r, 1e-4) * (-sin(x * 3.14159) * 0.25 * exp(-age * 9.0));
}

// Water running down a wall in the rain: streaks that move down it.
float FZE_RunoffStreaks(vec3 P, vec3 N, float time) {
    vec2 along = normalize(vec2(-N.z, N.x) + vec2(1e-4, 0.0));
    float u = dot(P.xz, along);
    float s = 0.5 + 0.5 * FZE_WPerlin3(vec3(u * 9.0, (P.y + time * 0.9) * 1.3, 0.21), 93u);
    return smoothstep(0.55, 0.85, s);
}

// Darkens, polishes, floods and snows over the surface in place. The coat is
// the water's: the caller's own clear coat stays if it is stronger.
// height01: the material's height map at this point (1 its top), or < 0 if it has none.
void FZE_ApplyWeather(vec3 P, vec3 Ng, float metallic, float height01, inout vec3 albedo,
                      inout float roughness, inout vec3 N, inout float coatStrength, inout float coatRoughness) {
    if (!FZE_WeatherAnything() && u_WetDebug == 0) return;
    FZEWeather w = FZE_WeatherAt(P, Ng);
    float por = clamp(u_Porosity, 0.0, 1.0);
    float dew = u_WeatherNow.w;
    float soak = max(w.soak, dew);
    float film = max(w.film, dew * 0.6);
    float up = clamp(Ng.y, 0.0, 1.0);
    float rain = u_WeatherNow.x * w.exposed;

    if (u_WetDebug == 1) { albedo = vec3(soak, film, clamp(w.depth / 15.0, 0.0, 1.0)); return; }
    if (u_WetDebug == 2) { albedo = vec3(w.exposed, w.top, clamp(w.snow / 4.0, 0.0, 1.0)); return; }

    // ---- the pores: darker, and a little smoother (Lagarde 2b) ----
    float factor = mix(1.0, 0.2, por);
    float wetNonMetal = soak * (1.0 - metallic);
    albedo *= mix(1.0, factor, wetNonMetal);
    roughness *= mix(1.0, factor, 0.5 * wetNonMetal);

    // ---- the film: a clear coat of water ----
    if (rain > 0.0 && up < 0.35) {
        // A wall in the rain is not evenly wet: the water runs down it in streaks.
        float st = FZE_RunoffStreaks(P, Ng, u_Time);
        film = clamp(film * (0.55 + 0.6 * st), 0.0, 1.0);
    }
    coatStrength  = max(coatStrength, film * 0.9);
    coatRoughness = min(coatRoughness, mix(0.3, 0.04, film));

    // ---- standing water: the flood level through the hollows (Lagarde 3b) ----
    float puddle = 0.0;
    if (w.depth > 0.05 && up > 0.75) {
        float flood = clamp(w.depth / 15.0, 0.0, 1.0);  // 15 mm floods flat ground
        // The broad hollows, and the small ones near enough to tell apart.
        float camD = length(P - u_CameraPos);
        float fine = camD < 40.0 ? FZE_WPerlin3(vec3(P.xz / 0.9, 0.61), 92u) * (1.0 - smoothstep(25.0, 40.0, camD)) : 0.0;
        float field = 0.5 + 0.5 * (0.65 * FZE_WPerlin3(vec3(P.xz / 2.6, 0.37), 91u) + 0.35 * fine);
        float hollow = height01 >= 0.0 ? mix(field, height01, 0.4) : field;
        // How high the water stands: the deepest few percent first, most of
        // flat ground when it is flooded - the rest is the high ground that drains.
        float level = mix(0.16, 0.6, sqrt(flood));
        puddle = (1.0 - smoothstep(level - 0.035, level + 0.035, hollow)) * smoothstep(0.82, 0.97, up);
        // Porous ground drinks its puddles' edges; glass and metal hold them.
        puddle *= 1.0 - por * 0.35;
    }
    if (puddle > 0.001) {
        albedo *= mix(1.0, 0.62, puddle);              // looked at through water
        roughness = mix(roughness, 0.05, puddle);
        coatStrength = max(coatStrength, puddle);
        coatRoughness = mix(coatRoughness, 0.012, puddle);
        // A puddle is level whatever the ground under it does.
        N = normalize(mix(N, vec3(0.0, 1.0, 0.0), puddle * 0.95));
        // Rings two centimetres across are sparkle past twenty-five metres, and
        // each costs nine cells a layer: only near.
        float nearR = 1.0 - smoothstep(12.0, 25.0, length(P - u_CameraPos));
        if (nearR > 0.0) {
            vec2 s = FZE_RainRingSlope(P.xz, u_Time, rain) * puddle * nearR;
            N = normalize(N + vec3(-s.x, 0.0, -s.y));
        }
    } else if (rain > 0.0 && film > 0.4 && up > 0.5 && length(P - u_CameraPos) < 20.0) {
        vec2 s = FZE_FilmDropSlope(P.xz, u_Time, rain) * film;
        N = normalize(N + vec3(-s.x, 0.0, -s.y) * 0.6);
    }

    // ---- snow: on what faces up, thickest in the hollows, ragged at its edge ----
    if (w.snow > 0.02) {
        float lie = smoothstep(0.35, 0.8, up);
        float n = 0.5 + 0.5 * FZE_WPerlin3(vec3(P.xz * 1.9, 0.83), 94u);
        float h = height01 >= 0.0 ? height01 : 0.5;
        float cover = clamp(w.snow / 4.0 * 1.25 - h * 0.25 + (n - 0.5) * 0.45, 0.0, 1.0) * lie;
        cover = smoothstep(0.15, 0.65, cover);
        if (cover > 0.001) {
            vec3 sn = vec3(FZE_WPerlin3(vec3(P.xz * 7.0, 0.1), 95u), 4.0, FZE_WPerlin3(vec3(P.xz * 7.0, 0.7), 96u));
            albedo = mix(albedo, vec3(0.80, 0.83, 0.88), cover);
            roughness = mix(roughness, 0.62, cover);
            coatStrength *= 1.0 - cover;
            N = normalize(mix(N, normalize(sn), cover * 0.85));
        }
    }
    coatRoughness = FZE_SpecularAA(coatRoughness, N);
}

#endif  // FZE_WEATHER_GLSL
