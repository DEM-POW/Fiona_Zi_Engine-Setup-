// ---------------------------------------------------------------
//  Fiona Zi Engine — the weather field, on the GPU
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//  ⚠️ LINE FOR LINE AGAINST Engine/Weather/WeatherField.cpp. The GPU bakes the
//  map the clouds are marched through from this; the CPU answers "is it
//  raining here" from that. Change one and change the other: FZECloudsTest
//  checks the quantile table below against the engine's, and FZE_WEATHERDIAG
//  compares the baked map with the CPU's answer at run time.
// ---------------------------------------------------------------
#ifndef FZE_WEATHERFIELD_GLSL
#define FZE_WEATHERFIELD_GLSL

uint FZE_WHash(uint x) {
    x ^= x >> 16u; x *= 0x7feb352du;
    x ^= x >> 15u; x *= 0x846ca68bu;
    x ^= x >> 16u;
    return x;
}

float FZE_WGrad(uint h, float x, float y, float z) {
    uint k = h & 15u;
    float u = k < 8u ? x : y;
    float v = k < 4u ? y : ((k == 12u || k == 14u) ? x : z);
    return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? v : -v);
}

uint FZE_WCorner(int x, int y, int z, uint seed) {
    return FZE_WHash(uint(x) ^ FZE_WHash(uint(y) ^ FZE_WHash(uint(z) ^ seed)));
}

float FZE_WPerlin3(vec3 p, uint seed) {
    vec3 fl = floor(p);
    int ix = int(fl.x), iy = int(fl.y), iz = int(fl.z);
    vec3 f = p - fl;
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = FZE_WGrad(FZE_WCorner(ix,     iy,     iz,     seed), f.x,       f.y,       f.z);
    float n100 = FZE_WGrad(FZE_WCorner(ix + 1, iy,     iz,     seed), f.x - 1.0, f.y,       f.z);
    float n010 = FZE_WGrad(FZE_WCorner(ix,     iy + 1, iz,     seed), f.x,       f.y - 1.0, f.z);
    float n110 = FZE_WGrad(FZE_WCorner(ix + 1, iy + 1, iz,     seed), f.x - 1.0, f.y - 1.0, f.z);
    float n001 = FZE_WGrad(FZE_WCorner(ix,     iy,     iz + 1, seed), f.x,       f.y,       f.z - 1.0);
    float n101 = FZE_WGrad(FZE_WCorner(ix + 1, iy,     iz + 1, seed), f.x - 1.0, f.y,       f.z - 1.0);
    float n011 = FZE_WGrad(FZE_WCorner(ix,     iy + 1, iz + 1, seed), f.x,       f.y - 1.0, f.z - 1.0);
    float n111 = FZE_WGrad(FZE_WCorner(ix + 1, iy + 1, iz + 1, seed), f.x - 1.0, f.y - 1.0, f.z - 1.0);
    float x00 = mix(n000, n100, u.x), x10 = mix(n010, n110, u.x);
    float x01 = mix(n001, n101, u.x), x11 = mix(n011, n111, u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

// Convective cells that swell, peak and dissolve on their own clocks, each
// cycle a new cloud - see WeatherField::Cells.
float FZE_WCells(vec2 p, float cycles, uint seed) {
    vec2 fl = floor(p);
    int ix = int(fl.x), iy = int(fl.y);
    vec2 f = p - fl;
    float best = 0.0;
    for (int oy = -1; oy <= 1; ++oy)
        for (int ox = -1; ox <= 1; ++ox) {
            uint h0 = FZE_WHash(uint(ix + ox) ^ FZE_WHash(uint(iy + oy) ^ seed));
            float tc = cycles + float(h0 & 0xffffu) / 65535.0;
            float n  = floor(tc);
            uint h = FZE_WHash(h0 ^ uint(int(n)));
            vec2 j = vec2(float(h & 0xffffu), float((h >> 16u) & 0xffffu)) / 65535.0;
            float life = 0.5 - 0.5 * cos((tc - n) * 6.2831853);
            vec2 pt = vec2(float(ox), float(oy)) + 0.15 + 0.7 * j;
            float d = length(f - pt);
            float r = 0.35 + 0.35 * life;
            best = max(best, life * (1.0 - smoothstep(0.0, r, d)));
        }
    return best;
}

const float FZE_W_AIRMASS_SCALE = 22000.0;
const float FZE_W_AIRMASS_LIFE  = 5400.0;
const float FZE_W_SHAPE_SCALE   = 4200.0;
const float FZE_W_SHAPE_LIFE    = 1500.0;
const float FZE_W_CELL_SPACING  = 2400.0;
const float FZE_W_CELL_LIFE     = 1200.0;

// params: x cover, y kind, z size, w time (seconds of weather)
float FZE_WRawField(vec4 params, vec2 drift, vec2 xz, float cumulus, out float air, out float cells) {
    float s = max(params.z, 0.05);
    vec2 q = xz - drift;
    air = FZE_WPerlin3(vec3(q / (FZE_W_AIRMASS_SCALE * s), params.w / FZE_W_AIRMASS_LIFE), 11u);
    vec3 sp = vec3(q / (FZE_W_SHAPE_SCALE * s), params.w / FZE_W_SHAPE_LIFE);
    float shape = 0.5 + 0.5 * (0.60 * FZE_WPerlin3(sp, 1u)
                             + 0.28 * FZE_WPerlin3(sp * 2.03 + vec3(17.1, 3.7, 5.3), 2u)
                             + 0.12 * FZE_WPerlin3(sp * 4.07 + vec3(-7.9, 11.3, 2.1), 3u));
    cells = FZE_WCells(q / (FZE_W_CELL_SPACING * s), params.w / FZE_W_CELL_LIFE, 7u);
    return mix(shape, 0.55 * cells + 0.45 * shape, cumulus) + 0.12 * air;
}

// The raw field's measured distribution: WeatherFieldQuantiles.inl, copied.
const float FZE_W_QUANTILES[85] = float[85](
    0.13048f, 0.35260f, 0.38838f, 0.41329f, 0.43349f, 0.45121f, 0.46752f, 0.48300f, 0.49818f, 0.51342f, 0.52878f, 0.54527f, 0.56292f, 0.58315f, 0.60742f, 0.64246f, 0.88317f,
    0.10948f, 0.31723f, 0.35014f, 0.37292f, 0.39163f, 0.40820f, 0.42331f, 0.43803f, 0.45213f, 0.46648f, 0.48111f, 0.49635f, 0.51329f, 0.53257f, 0.55651f, 0.59097f, 0.84908f,
    0.08373f, 0.27067f, 0.30106f, 0.32273f, 0.34057f, 0.35643f, 0.37156f, 0.38621f, 0.40054f, 0.41528f, 0.43078f, 0.44773f, 0.46696f, 0.49027f, 0.52102f, 0.56779f, 0.86450f,
    0.05798f, 0.21907f, 0.24649f, 0.26625f, 0.28276f, 0.29804f, 0.31274f, 0.32714f, 0.34189f, 0.35777f, 0.37533f, 0.39589f, 0.42178f, 0.45580f, 0.50347f, 0.57269f, 0.89834f,
    0.03222f, 0.16427f, 0.18848f, 0.20624f, 0.22134f, 0.23569f, 0.24941f, 0.26373f, 0.27868f, 0.29581f, 0.31680f, 0.34428f, 0.38139f, 0.43075f, 0.49554f, 0.58779f, 0.93217f);

float FZE_WEqualise(float raw, float cumulus) {
    float fc = clamp(cumulus, 0.0, 1.0) * 4.0;
    int   r0 = min(int(fc), 3);
    float wr = fc - float(r0);
    float q0 = mix(FZE_W_QUANTILES[r0 * 17], FZE_W_QUANTILES[(r0 + 1) * 17], wr);
    if (raw <= q0) return 0.0;
    for (int k = 0; k < 16; ++k) {
        float q1 = mix(FZE_W_QUANTILES[r0 * 17 + k + 1], FZE_W_QUANTILES[(r0 + 1) * 17 + k + 1], wr);
        if (raw <= q1) return (float(k) + clamp((raw - q0) / max(q1 - q0, 1e-6), 0.0, 1.0)) / 16.0;
        q0 = q1;
    }
    return 1.0;
}

// The raw value a given rank sits at - WeatherField::Quantile.
float FZE_WQuantile(float rank, float cumulus) {
    float fc = clamp(cumulus, 0.0, 1.0) * 4.0;
    int   r0 = min(int(fc), 3);
    float wr = fc - float(r0);
    float x  = clamp(rank, 0.0, 1.0) * 16.0;
    int   k  = min(int(x), 15);
    float q0 = mix(FZE_W_QUANTILES[r0 * 17 + k],     FZE_W_QUANTILES[(r0 + 1) * 17 + k],     wr);
    float q1 = mix(FZE_W_QUANTILES[r0 * 17 + k + 1], FZE_W_QUANTILES[(r0 + 1) * 17 + k + 1], wr);
    return mix(q0, q1, x - float(k));
}

// How wide a cloud's edge is in the map, in RAW units - WeatherField::kPresenceEdge.
const float FZE_W_PRESENCE_EDGE = 0.1;

// x presence, y kind, z rain, w rank - see WeatherField.h.
vec4 FZE_WeatherField(vec4 params, vec2 drift, vec2 xz) {
    float air, cells;
    float cu   = smoothstep(0.25, 0.6, params.y);
    float raw  = FZE_WRawField(params, drift, xz, cu, air, cells);
    float rank = FZE_WEqualise(raw, cu);
    float c    = clamp(params.x, 0.0, 1.0);
    float edge = FZE_WQuantile(1.0 - c, cu);
    float presence = smoothstep(edge - FZE_W_PRESENCE_EDGE, edge + FZE_W_PRESENCE_EDGE, raw);
    float kind = clamp(params.y + 0.22 * air, 0.0, 1.0);     // the air mass, not the cell: see WeatherField.cpp
    // The densest 30% of the cloud rains - WeatherField::kRainShare, see WeatherField.cpp.
    float coreEdge = FZE_WQuantile(1.0 - 0.3 * c, cu);
    float rain = smoothstep(coreEdge - 0.04, coreEdge + 0.16, raw) * smoothstep(0.3, 0.75, kind);
    return vec4(presence, kind, rain, rank);
}

// How deep a column of this kind is, metres - CloudLayer::Depth.
float FZE_CloudDepth(float kind) {
    float k = clamp(kind, 0.0, 1.0);
    float heaped = smoothstep(0.0, 0.5, k);
    float tower  = smoothstep(0.6, 1.0, k);
    return mix(300.0, 1600.0, heaped) + 6400.0 * tower * tower;
}

#endif  // FZE_WEATHERFIELD_GLSL
