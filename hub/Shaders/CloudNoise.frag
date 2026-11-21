#version 460 core
// ============================================================================
//  THE CLOUD NOISE VOLUMES, ONE SLICE PER DRAW.
//
//  Two tiling 3D textures, made once at start-up on the GPU (a few
//  milliseconds; the CPU took most of a second for a smaller pair):
//
//    base   r  Perlin-Worley: Perlin fBm lifted by an inverted Worley, so the
//              soft Perlin billows gain cellular, cauliflower edges
//           gba Worley fBm at 2 / 4 / 8 cells per tile - the shape's lumps
//    detail rgb Worley fBm at 2 / 4 / 8 - the fine erosion of a rim
//
//  Every lattice wraps at the tile, so the volume repeats without a seam.
// ============================================================================

out vec4 FragColor;

uniform int   u_Mode;       // 0 base, 1 detail
uniform int   u_Size;       // texels per side
uniform float u_Slice;      // which slice, 0..u_Size-1

uint NHash(uint x) {
    x ^= x >> 16u; x *= 0x7feb352du;
    x ^= x >> 15u; x *= 0x846ca68bu;
    x ^= x >> 16u;
    return x;
}
uint NHash3(ivec3 c, uint seed) {
    return NHash(uint(c.x) ^ NHash(uint(c.y) ^ NHash(uint(c.z) ^ seed)));
}
vec3 NRand3(ivec3 c, uint seed) {
    uint h = NHash3(c, seed);
    uint h2 = NHash(h);
    return vec3(float(h & 0xffffu), float(h >> 16u), float(h2 & 0xffffu)) / 65535.0;
}

// Distance to the nearest feature point, one per cell, cells wrapping at `period`.
// Inverted so a cell centre is 1: that is the billow.
float WorleyTile(vec3 p, int period, uint seed) {
    vec3 q = p * float(period);
    ivec3 i = ivec3(floor(q));
    vec3 f = q - vec3(i);
    float best = 1e9;
    for (int z = -1; z <= 1; ++z)
        for (int y = -1; y <= 1; ++y)
            for (int x = -1; x <= 1; ++x) {
                ivec3 o = ivec3(x, y, z);
                ivec3 c = (i + o + period) % period;
                vec3 d = vec3(o) + NRand3(c, seed) - f;
                best = min(best, dot(d, d));
            }
    return 1.0 - clamp(sqrt(best), 0.0, 1.0);
}

float Grad(uint h, vec3 f) {
    uint k = h & 15u;
    float u = k < 8u ? f.x : f.y;
    float v = k < 4u ? f.y : ((k == 12u || k == 14u) ? f.x : f.z);
    return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? v : -v);
}

float PerlinTile(vec3 p, int period, uint seed) {
    vec3 q = p * float(period);
    ivec3 i = ivec3(floor(q));
    vec3 f = q - vec3(i);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float r[8];
    for (int k = 0; k < 8; ++k) {
        ivec3 o = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
        ivec3 c = (i + o) % period;
        r[k] = Grad(NHash3(c, seed), f - vec3(o));
    }
    float x00 = mix(r[0], r[1], u.x), x10 = mix(r[2], r[3], u.x);
    float x01 = mix(r[4], r[5], u.x), x11 = mix(r[6], r[7], u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

float WorleyFbm(vec3 p, int period, uint seed) {
    return WorleyTile(p, period, seed) * 0.625
         + WorleyTile(p, period * 2, seed + 101u) * 0.25
         + WorleyTile(p, period * 4, seed + 202u) * 0.125;
}

float Remap(float v, float a, float b, float c, float d) {
    return c + (v - a) / max(b - a, 1e-5) * (d - c);
}

void main() {
    vec3 p = vec3(gl_FragCoord.xy, u_Slice + 0.5) / float(u_Size);
    if (u_Mode == 0) {
        float perlin = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 4; ++o) {
            perlin += PerlinTile(p, 4 << o, 11u + uint(o)) * amp;
            norm += amp;
            amp *= 0.5;
        }
        perlin = clamp(perlin / norm * 0.5 + 0.5, 0.0, 1.0);
        float worley4 = WorleyFbm(p, 4, 17u);
        float pw = clamp(Remap(perlin, 0.0, 1.0, worley4, 1.0), 0.0, 1.0);
        FragColor = vec4(pw,
                         WorleyFbm(p, 4, 31u),
                         WorleyFbm(p, 8, 47u),
                         WorleyFbm(p, 16, 59u));
    } else {
        FragColor = vec4(WorleyFbm(p, 2, 71u),
                         WorleyFbm(p, 4, 83u),
                         WorleyFbm(p, 8, 97u),
                         1.0);
    }
}
