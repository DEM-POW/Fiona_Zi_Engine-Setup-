// ---------------------------------------------------------------
//  Fiona Zi Engine — sun shadows
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// WHETHER THE SUN REACHES A POINT: the sun's shadow clipmap, and the clouds.
// One copy for every shader under the sun (lit surfaces, characters, water,
// foliage, the fog's beams, the bounce-light volume) - Renderer::
// BindDirectionalShadows sets these for any shader that includes this file.
//
// THE CLIPMAP (Renderer/Shadows/SunClipmap.h): squares around the camera, each
// twice the last - Unreal 5's directional clipmap, at a size GL runs well. A
// point reads the finest level it is well inside; near a level's edge the next
// one is blended in, so no seam crosses the ground; past the last it fades out.
//
// THE FILTER: a tent, Unity's - its texels weighed by the area of a 45-degree
// tent over each, read as bilinear comparisons placed between texel pairs so
// sixteen fetches make a smooth 8x8 kernel. No randomness anywhere: the edge
// is the same every frame, so it cannot crawl or speckle.
//
// CONTACT HARDENING: how far a point is below what shadows it decides how wide
// its penumbra is (the sun is a disc, not a point) - sharp where a foot meets
// the ground, soft at the end of a tower's shadow. A wide penumbra is read from
// a COARSER level, where the same tent covers more ground: the softness is the
// level's, not more samples', and it costs nothing more.

#define MAX_SUN_LEVELS 8
uniform sampler2DArrayShadow u_ShadowMap;          // compared (LEqual)
uniform sampler2DArray       u_ShadowDepth;        // the same array, raw depth (blocker search)
uniform mat4  u_SunLevelVP[MAX_SUN_LEVELS];
uniform vec4  u_SunLevelInfo[MAX_SUN_LEVELS];      // x metres per texel, y metres per unit of depth, z radius, w 1 = drawn
uniform int   u_SunLevels;
uniform int   u_ShadowsEnabled;
uniform int   u_SimpleShadowSoft;                   // Simple Surfaces > Shadow Softness: 0 one tap, 1 4-tap tent, 2 16-tap tent
uniform int   u_ShadowFilter;                       // 0 sharp (2x2 tent), 1 soft (8x8 tent), 2 soft + contact hardening
uniform float u_SunPenumbra;                        // penumbra metres per metre below the blocker (the sun's angle)
// The moving bodies' layer of the same array (Renderer: SelfDrawnSurface::Actor): characters,
// drawn every frame round themselves, so the cached levels never redraw for them.
uniform int   u_ActorLayer1;                        // its layer + 1; 0 = none this frame
uniform mat4  u_ActorVP;
uniform vec4  u_ActorInfo;                          // x metres per texel, y metres per unit of depth, z its corner's share of the layer

// ---- the tent ----
// The share of a tent of half-width R (in texels) that lies left of x, four at once.
vec4 FZE_TentCdf4(vec4 x, float R) {
    vec4 a = x + R, b = R - x;
    float k = 1.0 / (2.0 * R * R);
    vec4 v = mix(1.0 - b * b * k, a * a * k, step(x, vec4(0.0)));   // left half rises, right half levels off
    v = mix(v, vec4(0.0), step(x, vec4(-R)));                       // before the tent: nothing
    return mix(v, vec4(1.0), step(vec4(R), x));                     // past it: all
}
vec2 FZE_TentCdf2(vec2 x, float R) {
    vec2 a = x + R, b = R - x;
    float k = 1.0 / (2.0 * R * R);
    vec2 v = mix(1.0 - b * b * k, a * a * k, step(x, vec2(0.0)));
    v = mix(v, vec2(0.0), step(x, vec2(-R)));
    return mix(v, vec2(1.0), step(vec2(R), x));
}

// One axis of the tent as four bilinear fetches over eight texels: each fetch's
// weight (its two texels' together) and where it sits between them so the
// hardware's blend gives each texel its own share.
void FZE_TentAxis4(float c, float R, out vec4 w, out vec4 pos) {
    vec4 i0 = floor(c) + vec4(-3.0, -1.0, 1.0, 3.0);
    vec4 a = FZE_TentCdf4(i0 + 0.5 - c, R) - FZE_TentCdf4(i0 - 0.5 - c, R);
    vec4 b = FZE_TentCdf4(i0 + 1.5 - c, R) - FZE_TentCdf4(i0 + 0.5 - c, R);
    w = a + b;
    pos = i0 + b / max(w, vec4(1e-6));
}
void FZE_TentAxis2(float c, float R, out vec2 w, out vec2 pos) {
    vec2 i0 = floor(c) + vec2(-1.0, 1.0);
    vec2 a = FZE_TentCdf2(i0 + 0.5 - c, R) - FZE_TentCdf2(i0 - 0.5 - c, R);
    vec2 b = FZE_TentCdf2(i0 + 1.5 - c, R) - FZE_TentCdf2(i0 + 0.5 - c, R);
    w = a + b;
    pos = i0 + b / max(w, vec2(1e-6));
}

// A tent of half-width R texels centred on `uv`: 16 comparisons (`pairs` 4, R up
// to 3.5) or 4 (`pairs` 2, R up to 1.5). Written with plain vectors and fixed
// loops - a version with local arrays and early exits came out black on this
// machine's driver.
float FZE_TentShadow(vec2 uv, float layer, float ref, float R, int pairs) {
    vec2 res = vec2(textureSize(u_ShadowMap, 0).xy);
    vec2 c = uv * res - 0.5;                           // texel centres at whole numbers
    float sum = 0.0;
    if (pairs <= 2) {
        vec2 wx, px, wy, py;
        FZE_TentAxis2(c.x, R, wx, px);
        FZE_TentAxis2(c.y, R, wy, py);
        for (int y = 0; y < 2; ++y)
            for (int x = 0; x < 2; ++x)
                sum += wx[x] * wy[y] * texture(u_ShadowMap, vec4((vec2(px[x], py[y]) + 0.5) / res, layer, ref));
        return sum;
    }
    vec4 wx, px, wy, py;
    FZE_TentAxis4(c.x, R, wx, px);
    FZE_TentAxis4(c.y, R, wy, py);
    for (int y = 0; y < 4; ++y)
        for (int x = 0; x < 4; ++x)
            sum += wx[x] * wy[y] * texture(u_ShadowMap, vec4((vec2(px[x], py[y]) + 0.5) / res, layer, ref));
    return sum;
}

// ---- the levels ----
// A point in level `l`: its uv and depth, and how far it is inside (1 well inside, 0 at the edge).
vec3 FZE_SunProject(int l, vec3 P) {
    vec4 q = u_SunLevelVP[l] * vec4(P, 1.0);
    return q.xyz * 0.5 + 0.5;
}
float FZE_SunInside(vec3 p) {
    vec2 e = min(p.xy, 1.0 - p.xy);
    return (p.z >= 0.0 && p.z <= 1.0) ? clamp(min(e.x, e.y) / 0.12, 0.0, 1.0) : 0.0;
}

// ⚠️ A LEVEL IS FETCHED BY A CONSTANT INDEX, NEVER BY ONE CHOSEN PER PIXEL. An array read through a
// computed index goes to memory, element by element, and a level is a whole matrix. On a UHD 620
// that was most of what the sun's shadow cost. The branches here read the same numbers from
// registers. See SunShadowTapAt for the measurement.
void FZE_SunLevelAt(int l, out mat4 vp, out vec4 info) {
    if (l <= 0)      { vp = u_SunLevelVP[0]; info = u_SunLevelInfo[0]; }
    else if (l == 1) { vp = u_SunLevelVP[1]; info = u_SunLevelInfo[1]; }
    else if (l == 2) { vp = u_SunLevelVP[2]; info = u_SunLevelInfo[2]; }
    else if (l == 3) { vp = u_SunLevelVP[3]; info = u_SunLevelInfo[3]; }
    else if (l == 4) { vp = u_SunLevelVP[4]; info = u_SunLevelInfo[4]; }
    else if (l == 5) { vp = u_SunLevelVP[5]; info = u_SunLevelInfo[5]; }
    else if (l == 6) { vp = u_SunLevelVP[6]; info = u_SunLevelInfo[6]; }
    else             { vp = u_SunLevelVP[7]; info = u_SunLevelInfo[7]; }
}

// Which level a point falls in: level 0's own projection says how many of its radii away the
// point is, and each level is twice as wide as the last.
int FZE_SunLevelOf(vec3 P) {
    vec4 q = u_SunLevelVP[0] * vec4(P, 1.0);
    float k = max(abs(q.x), abs(q.y));
    return k < 0.72 ? 0 : k < 1.44 ? 1 : k < 2.88 ? 2 : k < 5.76 ? 3 : k < 11.5 ? 4 : k < 23.0 ? 5 : k < 46.0 ? 6 : 7;
}

// The shadow at P from a level, biased for that level's texels.
float FZE_SunLevelShadow(int l, mat4 vp, vec4 info, vec3 P, vec3 N, vec3 L, float ndl, bool hardening) {
    float mPerTexel = info.x, mPerDepth = max(info.y, 1e-4);
    float slope = sqrt(max(1.0 - ndl * ndl, 0.0)) / max(ndl, 0.15);
    // ⚠️ MOST OF THE BIAS IS SPENT SIDEWAYS: the sample walks out of its own texel
    // along the normal (no gap opens under the caster - no "peter-panning"); the
    // depth term left covers the map's own steps, and the raster already pushed
    // the casters back by their slope (polygon offset).
    vec3 Pb = P + N * (mPerTexel * (0.75 + slope * 0.75));
    vec3 p = (vp * vec4(Pb, 1.0)).xyz * 0.5 + 0.5;
    float ref = p.z - (mPerTexel * slope * 0.35 + mPerTexel * 0.25) / mPerDepth;

    // ⚠️ ONE TENT, CALLED ONCE, AT THE END. Each branch below used to return its own
    // FZE_TentShadow - five inlined copies of a sixteen-fetch filter in this function,
    // and this function is inlined twice per DirectionalShadow. The driver translates
    // all of them at a program's first draw whichever one runs: on a UHD 620 the sun's
    // shadow was most of what every lit program cost to finish (2026-11-27,
    // FZE_DRAWCOST). The branches now only choose the tent's arguments; the same
    // tent with the same arguments is taken as before.
    vec2  tuv = p.xy;
    float tlayer = float(l), tref = ref, tR = 2.5;   // the plain filter (u_ShadowFilter 1, or no hardening)
    int   tpairs = 4;
    if (u_ShadowFilter == 0) {
        tR = 1.0;
        tpairs = 2;
    } else if (hardening && u_ShadowFilter >= 2) {
        // Contact hardening: the blockers' depth, then a penumbra as wide as the sun
        // makes it at that distance.
        vec2 texel = 1.0 / vec2(textureSize(u_ShadowDepth, 0).xy);
        float blockers = 0.0, found = 0.0;
        const float kSearch = 5.0;                                   // texels
        for (int i = 0; i < 12; ++i) {
            // A fixed Vogel spiral: the same twelve everywhere (no noise).
            float r = sqrt((float(i) + 0.5) / 12.0) * kSearch;
            float a = float(i) * 2.39996323;
            float d = texture(u_ShadowDepth, vec3(p.xy + vec2(cos(a), sin(a)) * r * texel, float(l))).r;
            if (d < ref) { blockers += d; found += 1.0; }
        }
        if (found < 0.5) return 1.0;                                  // nothing above it nearby: lit
        float gap = (ref - blockers / found) * mPerDepth;            // metres below the blockers
        float penTexels = max(gap * u_SunPenumbra / mPerTexel, 1.0);
        if (penTexels <= 3.5) {
            tR = max(penTexels, 1.0);
        } else {
            // Wider than this level's tent: a coarser level, where it fits.
            int up = min(int(ceil(log2(penTexels / 3.5))), u_SunLevels - 1 - l);
            int lc = l + up;
            mat4 vc;
            vec4 ic;
            FZE_SunLevelAt(lc, vc, ic);
            if (ic.w < 0.5) {
                tR = 3.5;
            } else {
                vec3 Pc = P + N * (ic.x * (0.75 + slope * 0.75));
                vec3 pc = (vc * vec4(Pc, 1.0)).xyz * 0.5 + 0.5;
                tuv = pc.xy;
                tlayer = float(lc);
                tref = pc.z - (ic.x * slope * 0.35 + ic.x * 0.25) / max(ic.y, 1e-4);
                tR = clamp(penTexels / exp2(float(up)), 1.0, 3.5);
            }
        }
    }
    return FZE_TentShadow(tuv, tlayer, tref, tR, tpairs);
}

// The moving bodies' shadow at P (1 none). Its softness is the sun's: the penumbra a metre
// below the body, in this layer's texels.
float FZE_ActorShadow(vec3 P, vec3 N, float ndl) {
    if (u_ActorLayer1 <= 0) return 1.0;
    float mpt = max(u_ActorInfo.x, 1e-5);
    vec3 p = (u_ActorVP * vec4(P + N * (mpt * 1.5), 1.0)).xyz * 0.5 + 0.5;
    if (p.x <= 0.0 || p.y <= 0.0 || p.x >= 1.0 || p.y >= 1.0 || p.z >= 1.0) return 1.0;
    float slope = clamp(sqrt(max(1.0 - ndl * ndl, 0.0)) / max(ndl, 0.05), 0.0, 4.0);
    float ref = p.z - mpt * (slope * 0.35 + 0.5) / max(u_ActorInfo.y, 1e-4);
    return FZE_TentShadow(p.xy * u_ActorInfo.z, float(u_ActorLayer1 - 1), ref, clamp(u_SunPenumbra / mpt, 1.0, 3.5), 4);
}

// Whether the sun reaches P (0 shadow ... 1 lit): the cached levels, and the moving bodies.
float FZE_SunLevelsShadow(vec3 worldPos, vec3 N, vec3 L);
float DirectionalShadow(vec3 worldPos, vec3 N, vec3 L) {
    if (u_ShadowsEnabled == 0) return 1.0;
    return min(FZE_SunLevelsShadow(worldPos, N, L), FZE_ActorShadow(worldPos, N, clamp(dot(N, L), 0.0, 1.0)));
}

float FZE_SunLevelsShadow(vec3 worldPos, vec3 N, vec3 L) {
    if (u_ShadowsEnabled == 0 || u_SunLevels <= 0) return 1.0;
    float ndl = clamp(dot(N, L), 0.0, 1.0);
    int l = FZE_SunLevelOf(worldPos);
    // Its level's edge can fall short of the estimate while the level waits to re-centre: one
    // step out is always enough.
    mat4 vp;
    vec4 info;
    FZE_SunLevelAt(l, vp, info);
    vec3 p = (vp * vec4(worldPos, 1.0)).xyz * 0.5 + 0.5;
    float inside = info.w < 0.5 ? 0.0 : FZE_SunInside(p);
    if (inside <= 0.0) {
        ++l;
        if (l >= u_SunLevels) return 1.0;
        FZE_SunLevelAt(l, vp, info);
        if (info.w < 0.5) return 1.0;
        p = (vp * vec4(worldPos, 1.0)).xyz * 0.5 + 0.5;
        inside = FZE_SunInside(p);
        if (inside <= 0.0) return 1.0;
    }
    // ⚠️ TWO CALLS, ON PURPOSE. Folding these two into a loop whose length is known only per
    // pixel kept one copy in the program and saved 0.4 s at its first draw - and cost 13 ms
    // a frame on a UHD 620 (GPU Lit 27 -> 40 ms on B1 and B2, 2026-11-27): a loop of texture
    // reads under per-pixel control is far slower here than two straight copies.
    float s = FZE_SunLevelShadow(l, vp, info, worldPos, N, L, ndl, true);
    if (inside >= 1.0) return s;
    // Near the edge: the next level's answer blended in, so no seam crosses the ground.
    if (l + 1 < u_SunLevels) {
        FZE_SunLevelAt(l + 1, vp, info);
        if (info.w > 0.5) return mix(FZE_SunLevelShadow(l + 1, vp, info, worldPos, N, L, ndl, true), s, inside);
    }
    return mix(1.0, s, inside);                         // past the last level: the shadow fades out
}

// One comparison, no filter: for what asks many times a pixel (the fog's beams,
// the bounce-light volume), where the softness comes from elsewhere.
float SunShadowTap(vec3 P) {
    if (u_ShadowsEnabled == 0 || u_SunLevels <= 0) return 1.0;
    for (int l = 0; l < MAX_SUN_LEVELS; ++l) {
        if (l >= u_SunLevels) break;
        if (u_SunLevelInfo[l].w < 0.5) continue;
        vec3 p = FZE_SunProject(l, P);
        if (FZE_SunInside(p) <= 0.0) continue;
        return texture(u_ShadowMap, vec4(p.xy, float(l), p.z - 2.0 * u_SunLevelInfo[l].x / max(u_SunLevelInfo[l].y, 1e-4)));
    }
    return 1.0;
}

// The same, for what fills the screen and is `dist` metres from the camera.
//
// ⚠️ THE LEVEL IS A FIXED NUMBER AT EACH STEP, AND THAT IS THE WHOLE POINT. An array read with
// an index chosen per pixel goes to memory for each element, and a level is a whole matrix. On
// a UHD 620 at 360 lines that search was 4 to 5 ms of a ground that cost 13: with the level
// written as a constant the same shadow costs almost nothing over no shadow at all (8.9 ms
// against 8.5). Each level is twice as wide as the last and they are all round the camera, so
// the distance says where to start, and a point outside its level falls through to the next.
// ⚠️ ONE SAMPLE DRAWS THE EDGE IN SQUARES. A single hardware-compared tap is a 2x2 bilinear
// step: the edge of a shadow on Simple Surfaces showed every texel of the map as a square
// (Nabras's close look at a pine's shadow on the grass, 2026-11-14). Shadow Softness reads a
// tent instead - the full surfaces' filter (FZE_TentShadow), 4 or 16 bilinear compares - and
// biases a little further for the wider footprint.
#define FZE_SUN_TAP(L) { \
    vec3 p = FZE_SunProject(L, P); \
    if (u_SunLevelInfo[L].w > 0.5 && FZE_SunInside(p) > 0.0) { \
        float texel = u_SunLevelInfo[L].x / max(u_SunLevelInfo[L].y, 1e-4); \
        if (u_SimpleShadowSoft <= 0) return texture(u_ShadowMap, vec4(p.xy, float(L), p.z - 2.0 * texel)); \
        if (u_SimpleShadowSoft == 1) return FZE_TentShadow(p.xy, float(L), p.z - 2.5 * texel, 1.5, 2); \
        return FZE_TentShadow(p.xy, float(L), p.z - 3.0 * texel, 2.5, 4); \
    } \
}
float FZE_SunLevelsTapAt(vec3 P, float dist) {
    if (u_ShadowsEnabled == 0 || u_SunLevels <= 0) return 1.0;
    float k = dist / u_SunLevelInfo[0].z;       // in radii of the first level
    if (k < 0.7) FZE_SUN_TAP(0)
    if (k < 1.4) FZE_SUN_TAP(1)
    if (k < 2.8) FZE_SUN_TAP(2)
    if (k < 5.6) FZE_SUN_TAP(3)
    if (k < 11.2) FZE_SUN_TAP(4)
    if (k < 22.4) FZE_SUN_TAP(5)
    FZE_SUN_TAP(6)
    return 1.0;
}
// ...and the moving bodies' layer (Simple Surfaces read the sun through here): one matrix a
// pixel, and the filter only inside the bodies' small square.
float SunShadowTapAt(vec3 P, float dist) {
    if (u_ShadowsEnabled == 0) return 1.0;
    float s = FZE_SunLevelsTapAt(P, dist);
    if (u_ActorLayer1 <= 0) return s;
    float mpt = max(u_ActorInfo.x, 1e-5);
    vec3 p = (u_ActorVP * vec4(P, 1.0)).xyz * 0.5 + 0.5;
    if (p.x <= 0.0 || p.y <= 0.0 || p.x >= 1.0 || p.y >= 1.0 || p.z >= 1.0) return s;
    float ref = p.z - 2.0 * mpt / max(u_ActorInfo.y, 1e-4);
    return min(s, FZE_TentShadow(p.xy * u_ActorInfo.z, float(u_ActorLayer1 - 1), ref, clamp(u_SunPenumbra / mpt, 1.0, 3.5), 4));
}

// The level P is read from (-1: none) - the debug view's colours.
int SunShadowLevelAt(vec3 P) {
    for (int l = 0; l < MAX_SUN_LEVELS; ++l) {
        if (l >= u_SunLevels) break;
        if (u_SunLevelInfo[l].w < 0.5) continue;
        if (FZE_SunInside(FZE_SunProject(l, P)) > 0.0) return l;
    }
    return -1;
}

// ============================================================================
// Cloud shadows - the fraction of direct sun the clouds overhead let through.
//
// Baked once a frame by the cloud layer (Shaders/CloudShadow.frag) from the
// SAME density the sky is drawn with: for each point of a square of ground
// around the camera, the optical depth along the sun's ray through the cloud.
// A surface at height y finds its texel by sliding back down its own sun ray
// to the ground - one multiply-add, the per-pixel part of a projection whose
// hard part was done once for the frame.
// ============================================================================
uniform int       u_CloudsOn;
uniform vec2      u_CloudRay;          // sunDir.xz / sunDir.y
uniform vec4      u_CloudShadowRect;   // xy world corner, zw 1 / size
uniform sampler2D u_CloudShadowMap;

float CloudShadow(vec3 P, vec3 sunDir) {
    if (u_CloudsOn == 0) return 1.0;
    vec2 g = P.xz - u_CloudRay * P.y;
    vec2 uv = (g - u_CloudShadowRect.xy) * u_CloudShadowRect.zw;
    // Past the baked square the clouds are kilometres away and their shadow
    // is a smear of a few pixels: the sun as it is.
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
    return texture(u_CloudShadowMap, uv).r;
}

