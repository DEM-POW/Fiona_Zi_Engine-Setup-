// ---------------------------------------------------------------
//  Fiona Zi Engine — the cloud volume
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//  ONE DENSITY FUNCTION FOR EVERY QUESTION ASKED OF A CLOUD: the march that
//  draws it, the march that finds how much sun reaches inside it, and the
//  bake that puts its shadow on the ground. Three copies of "what is a cloud"
//  is how a shadow ends up under empty sky.
//
//  A cloud here is:
//    * WHERE the weather map says there is cloud (presence, kind, rain) -
//      baked from lib/WeatherField.glsl, the same function the CPU asks;
//    * as DEEP as its kind - a sheet, a heap or a tower (FZE_CloudDepth);
//    * SHAPED by a Perlin-Worley volume: soft billows with cellular edges,
//      the look of cumulus, remapped by the coverage so a thin edge of the
//      map only keeps the densest billows (Schneider, "The Real-time
//      Volumetric Cloudscapes of Horizon Zero Dawn", 2015);
//    * ERODED at its rim by a finer Worley volume - wispy at the base, where
//      the air is turbulent, and billowing at the top.
// ---------------------------------------------------------------
#ifndef FZE_CLOUDVOLUME_GLSL
#define FZE_CLOUDVOLUME_GLSL

#include "WeatherField.glsl"

uniform sampler2D u_WeatherMap;     // x presence, y kind, z rain, w rank
uniform vec4      u_WeatherRect;    // xy world x/z of the map's corner, zw 1 / size (metres)
uniform sampler3D u_NoiseBase;      // r Perlin-Worley, gba Worley at 2/4/8 per tile
uniform sampler3D u_NoiseDetail;    // rgb Worley at 2/4/8 per tile
uniform vec3      u_NoiseOffset;    // metres: the wind's drift, and the rise of the tops
uniform float     u_BaseTile;       // metres one base tile covers
uniform float     u_DetailTile;     // metres one detail tile covers
uniform float     u_CloudBase;      // metres above the ground
uniform float     u_CloudTop;       // the deepest column anywhere, metres
uniform float     u_CloudSigma;     // extinction per metre at density 1
uniform float     u_PlanetRadius;   // metres
uniform vec2      u_WindShear;      // metres sideways per metre up: the tops lean downwind (phase 4)

// ⚠️ THE TOPS LEAN WITH THE WIND (docs/SKY-PLAN.md, phase 4). The wind is stronger higher up, so a
// tall cloud's top is carried downwind of its base: a tower leans and its anvil streams ahead. Every
// lookup of the field and the noise goes through this, so the march, the sun's march and the shadow
// on the ground all see the same leaning cloud.
vec3 FZE_CloudSheared(vec3 p) {
    return p - vec3(u_WindShear.x, 0.0, u_WindShear.y) * max(p.y - u_CloudBase, 0.0);
}

const float FZE_CLOUD_RAIN_THICKENING = 1.5;   // CloudLayer::kRainThickening

float FZE_Remap(float v, float a, float b, float c, float d) {
    return c + (v - a) / max(b - a, 1e-5) * (d - c);
}

// Altitude above the curved ground, for a point in world space. The planet's
// centre is under the camera: the scene is flat, the sky over it is not, and
// the curvature is what bends a cloud deck down into the horizon instead of
// stretching it into a flat ceiling that never meets the ground.
//
// sqrt((R+y)^2 + d^2) - R, rearranged so no two planet-sized numbers are ever
// subtracted: (2Ry + y^2 + d^2) / (sqrt(...) + R).
float FZE_CloudAltitude(vec3 p, vec3 camera) {
    vec2 d = p.xz - camera.xz;
    float R = u_PlanetRadius;
    float n = 2.0 * R * p.y + p.y * p.y + dot(d, d);
    return n / (sqrt((R + p.y) * (R + p.y) + dot(d, d)) + R);
}

// ⚠️ THE MAP ENDS, AND ITS EDGE MUST NOT BE SEEN. It is a square 64 km across
// round the camera, and a ray low over the horizon runs past it; cut off
// there, the clouds stood on the horizon as straight vertical walls along the
// square's edge. Past three quarters of the way out the cloud thins to nothing
// by distance from the middle - a circle - so the sky just ends, the way it
// does behind the haze at forty kilometres anyway.
vec4 FZE_CloudWeather(vec3 p) {
    vec2 uv = (FZE_CloudSheared(p).xz - u_WeatherRect.xy) * u_WeatherRect.zw;
    float r = length(uv - 0.5) * 2.0;
    if (r >= 0.97) return vec4(0.0);
    vec4 w = textureLod(u_WeatherMap, uv, 0.0);
    float fade = 1.0 - smoothstep(0.72, 0.97, r);
    w.x *= fade;
    w.z *= fade;
    return w;
}

// Density 0..~2 (more where it rains). `detail` erodes the rim; the light
// march and the shadow bake leave it off - they see a cloud from inside or
// from a kilometre away, where the rim's fine structure averages out.
float FZE_CloudDensity(vec3 p, float altitude, vec4 w, bool detail) {
    if (w.x < 0.01) return 0.0;
    float depth = FZE_CloudDepth(w.y);
    float h = (altitude - u_CloudBase) / depth;
    if (h <= 0.0 || h >= 1.0) return 0.0;

    // ⚠️ THREE FAMILIES, EACH ITS OWN SHAPE (docs/SKY-PLAN.md, phase 4; his pictures: a stratus deck,
    // fair-weather cumulus, a cumulonimbus anvil). By kind:
    //  - a SHEET (stratus, the overcast): soft above and below, the noise only lumping it a little;
    //  - a HEAP (cumulus): a flat base and a top that rounds into a dome - each cell narrows upward;
    //  - a TOWER (cumulonimbus): straight sides to near the top, where it spreads into an ANVIL.
    float sheet = 1.0 - smoothstep(0.2, 0.4, w.y);
    float tower = smoothstep(0.72, 0.9, w.y);
    float heap  = max(1.0 - sheet - tower, 0.0);
    float profile = sheet * smoothstep(0.0, 0.15, h) * (1.0 - smoothstep(0.5, 1.0, h))
                  + heap  * smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(0.65, 1.0, h))
                  + tower * smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.92, 1.0, h));

    vec3 np = (FZE_CloudSheared(p) + u_NoiseOffset) / u_BaseTile;
    vec4 n = textureLod(u_NoiseBase, np, 0.0);
    float wfbm  = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
    float shape = FZE_Remap(n.r, wfbm - 1.0, 1.0, 0.0, 1.0) * profile;
    // A deck is smooth: most of its shape is the profile, the noise only lumps it.
    shape = mix(shape, profile * (0.7 + 0.3 * n.r), sheet * 0.75);

    // Coverage decides how much of the shape survives: a thin edge keeps only
    // its densest billows, a solid core most of it.
    //
    // ⚠️ NEVER ALL OF IT. The first threshold was 1 - coverage, which is zero
    // in a solid core: everything passed, the height profile only dimmed the
    // top instead of narrowing it, and every cloud was a column with flat
    // vertical sides. At 0.35 the columns became domes - but the shape sits
    // mostly between 0.5 and 1, so a full column still passed nearly all of
    // it and a storm drew as a stack of flat discs. At 0.55 a solid core
    // keeps its middle and the noise carves its top and sides into billows.
    float cov = w.x;
    // A heap narrows toward its top (the dome); a tower spreads into its anvil.
    cov *= 1.0 - 0.55 * heap * smoothstep(0.3, 1.0, h);
    cov = mix(cov, min(cov * 2.2 + 0.15, 1.0), tower * smoothstep(0.7, 0.85, h));
    float d = clamp(FZE_Remap(shape, mix(0.9, 0.55, cov), 1.0, 0.0, 1.0), 0.0, 1.0) * cov;

    if (detail && d > 0.0) {
        vec3 dn = textureLod(u_NoiseDetail, (FZE_CloudSheared(p) + u_NoiseOffset) / u_DetailTile, 0.0).rgb;
        float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
        // Wisps below, billows above; a deck's edges are worn less.
        float erode = mix(1.0 - dfbm, dfbm, clamp(h * 6.0, 0.0, 1.0));
        d = clamp(FZE_Remap(d, erode * mix(0.45, 0.25, sheet), 1.0, 0.0, 1.0), 0.0, 1.0);
    }
    return d * (1.0 + FZE_CLOUD_RAIN_THICKENING * w.z);
}

#endif  // FZE_CLOUDVOLUME_GLSL
