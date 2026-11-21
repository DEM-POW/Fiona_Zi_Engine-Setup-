#version 460 core

// =============================================================================
//  WATER - rebuilt from nothing (2026-09-23).
//
//  One surface, lit the way every other surface in the engine is lit, and
//  made of water:
//
//    * UNDER it, the scene as it already stands in the frame, seen through the
//      water: bent by the surface, and dimmed per channel by Beer-Lambert over
//      the metres the view crosses - red first, so a shallow edge shows its
//      bed and deep water turns blue-green. What the water scatters back (its
//      body colour, lit by sky and sun) fills in what was absorbed.
//
//    * ON it, what it reflects: the sky from the pre-filtered IBL map, and
//      whatever is on screen along the reflected ray, found by marching the
//      depth buffer. ⚠️ NOT THE SCENE RENDERED A SECOND TIME. That is what the
//      old water did, every frame, and it was 112 ms of a 150 ms frame.
//
//    * the sun's highlight, GGX with the surface's roughness, from the same
//      sun the lit pass uses (through the same air).
//
//  Fresnel decides the mix: at a glance the surface is a mirror, looking down
//  you see into it. Linear HDR out, like the lit pass; the composite exposes it.
// =============================================================================

in vec3 v_WorldPos;
in vec2 v_Flow;            // m/s: a river's course (see Water.vert)
out vec4 FragColor;

#include "lib/Material.glsl"
#include "lib/Fog.glsl"
#include "lib/AerialPerspective.glsl"
#include "lib/SkySample.glsl"
#include "lib/AtmosphereUniforms.glsl"
#include "lib/Shadows.glsl"
#include "lib/Ripples.glsl"

uniform vec3  u_CameraPos;
uniform vec2  u_ScreenSize;
uniform mat4  u_ViewProjection;
uniform mat4  u_InvViewProj;
uniform float u_Time;
uniform float u_Level;
uniform vec4  u_WaveDirK[4];     // the same waves as Water.vert
uniform float u_WaveAmp[4];

uniform vec3  u_Absorption;      // per metre, per channel
uniform vec3  u_Scatter;         // ScatterColor * ScatterStrength
uniform float u_Roughness;
uniform float u_Ripples;
uniform vec4  u_WeatherNow;   // x: rain mm/h falling here now (Renderer/WeatherSurface) - the rings it strikes
uniform vec2  u_Current;         // the body's own current, m/s, world XZ
uniform float u_Foam;
uniform float u_BreakDepth;      // metres: shallower than this, the waves break (WaterWaves::BreakingDepth)
uniform float u_Caustics;

uniform vec3  u_SunDir;          // TOWARDS the sun
uniform vec3  u_SunIlluminance;  // the sun, before the air (lux x pre-exposure)
uniform float u_SkyReflection;
uniform float u_SkyLightIntensity;
uniform float u_IBLScale;          // the ambient maps are baked per unit of sky (IBL::RadianceScale)

uniform sampler2D   u_SceneColor;    // the frame so far, copied before the water
uniform sampler2D   u_SceneDepth;
uniform int         u_HasIBL;
uniform samplerCube u_IrradianceMap;
uniform samplerCube u_PrefilterMap;
uniform int         u_PrefilterMips;

vec3 WorldFromDepth(vec2 uv, float d) {
    vec4 h = u_InvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return h.xyz / h.w;
}

// ---- the fine ripples: gradient noise, two octaves drifting apart ------------
//
// ⚠️ WITH ITS DERIVATIVE, NOT BY DIFFERENCES. What the surface needs from the
// ripples is their SLOPE; taking it by central differences cost four noise
// evaluations per octave, eight per pixel, and the water pass measured 6.1 ms
// on a 7 m pond. The derivative of gradient noise is closed-form (the quintic
// fade and the four gradients are already in hand), so each octave is one call.
// ⚠️ NO sin() IN THE HASH. The usual fract(sin(x) * 43758) asks a GPU for the
// sine of numbers in the millions once the lattice is a few kilometres out -
// and an open sea is drawn out to 4 km - where the sine has no digits left to
// be random with and each vendor's range reduction answers differently. This
// one (Hoskins' hash22) is multiplies and fract(), the same everywhere.
// (Measured: no faster here, 44.6 ms either way. It is for the far sea.)
vec2 Hash2(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}
// Returns the noise's gradient (d/dx, d/dy) - the value itself is not needed.
vec2 NoiseGrad(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    vec2 ga = Hash2(i), gb = Hash2(i + vec2(1, 0)), gc = Hash2(i + vec2(0, 1)), gd = Hash2(i + vec2(1, 1));
    float va = dot(ga, f), vb = dot(gb, f - vec2(1, 0)), vc = dot(gc, f - vec2(0, 1)), vd = dot(gd, f - vec2(1, 1));
    return ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va);
}
vec2 RippleSlope(vec2 p) {
    return NoiseGrad(p * 2.7 + u_Time * vec2(0.55, 0.20)) * (0.020 * 2.7)
         + NoiseGrad(p * 6.9 - u_Time * vec2(0.30, 0.47)) * (0.007 * 6.9);
}

// The noise's value, for the foam and the caustics.
float Noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(dot(Hash2(i), f),                   dot(Hash2(i + vec2(1, 0)), f - vec2(1, 0)), u.x),
               mix(dot(Hash2(i + vec2(0, 1)), f - vec2(0, 1)), dot(Hash2(i + vec2(1, 1)), f - vec2(1, 1)), u.x), u.y);
}

// ---- flowing water ------------------------------------------------------------
//
// ⚠️ A PATTERN CARRIED BY A CURRENT HAS TO BE RESET, OR IT STRETCHES. Moving the
// ripples by flow * time works for a uniform current and smears everywhere the
// flow bends (a river's every meander). Two copies are carried half a cycle
// apart and each is faded out as it grows old and started again - the flow-map
// technique every engine's river uses - so no copy is ever carried far enough
// to tear.
const float kFlowCycle = 2.0;    // seconds a copy is carried before it restarts
vec2 FlowedRippleSlope(vec2 p, vec2 flow) {
    if (dot(flow, flow) < 1e-6) return RippleSlope(p);
    float t0 = fract(u_Time / kFlowCycle), t1 = fract(u_Time / kFlowCycle + 0.5);
    float w0 = 1.0 - abs(2.0 * t0 - 1.0);            // 0 at a restart, 1 half way
    vec2 a = RippleSlope(p - flow * (t0 * kFlowCycle));
    vec2 b = RippleSlope(p - flow * (t1 * kFlowCycle) + vec2(0.37, 0.61));
    return mix(b, a, w0);
}

// ---- reflections of what is on screen ----------------------------------------
//
// March the reflected ray, projecting each step onto the screen and comparing
// it with the depth there; the first step that passes behind a surface (by less
// than a thickness) is refined by bisection. Steps grow geometrically: fine near
// the water, where a miss would show, coarse far away, where it would not -
// sixteen of them, growing by 1.6, reach 0.15 m to 170 m.
vec3 TraceScreen(vec3 P, vec3 R, out float conf) {
    conf = 0.0;
    float t = 0.15, prev = 0.0;
    for (int i = 0; i < 16; ++i) {
        vec3 Q = P + R * t;
        vec4 c = u_ViewProjection * vec4(Q, 1.0);
        if (c.w <= 1e-4) break;
        vec2 q = c.xy / c.w * 0.5 + 0.5;
        if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) break;
        float sd = texture(u_SceneDepth, q).r;
        if (sd < 1.0) {
            vec3 S = WorldFromDepth(q, sd);
            float rayD = length(Q - u_CameraPos), sceneD = length(S - u_CameraPos);
            if (rayD > sceneD && rayD - sceneD < max(0.25, t * 0.25)) {
                float lo = prev, hi = t;
                for (int k = 0; k < 3; ++k) {
                    float m = 0.5 * (lo + hi);
                    vec3 M = P + R * m;
                    vec4 mc = u_ViewProjection * vec4(M, 1.0);
                    vec2 mq = mc.xy / mc.w * 0.5 + 0.5;
                    vec3 MS = WorldFromDepth(mq, texture(u_SceneDepth, mq).r);
                    if (length(M - u_CameraPos) > length(MS - u_CameraPos)) hi = m; else lo = m;
                    q = mq;
                }
                // Fade toward the screen edge, where the ray leaves what is known,
                // and with the march: a late hit is a guess.
                vec2 edge = smoothstep(vec2(0.0), vec2(0.08), q) * (1.0 - smoothstep(vec2(0.92), vec2(1.0), q));
                conf = edge.x * edge.y * (1.0 - float(i) / 16.0);
                return texture(u_SceneColor, q).rgb;
            }
        }
        prev = t;
        t *= 1.6;
    }
    return vec3(0.0);
}

void main() {
    vec3 P = v_WorldPos;
    vec3 toCam = u_CameraPos - P;
    float dist = length(toCam);
    vec3 V = toCam / max(dist, 1e-4);
    bool below = u_CameraPos.y < u_Level;     // under the surface, looking up at it
    vec2 uv = gl_FragCoord.xy / u_ScreenSize;

    // ---- the surface's normal: the waves exactly, the ripples on top ----
    vec2 slope = vec2(0.0);
    for (int i = 0; i < 4; ++i) {
        float phase = u_WaveDirK[i].z * dot(u_WaveDirK[i].xy, P.xz) - u_WaveDirK[i].w * u_Time;
        slope += u_WaveDirK[i].xy * (u_WaveAmp[i] * u_WaveDirK[i].z * cos(phase));
    }
    // Ripples a pixel cannot resolve are sparkle, not detail: faded with distance.
    float rippleFade = 1.0 - smoothstep(25.0, 90.0, dist);
    vec2 flow = v_Flow + u_Current;
    // Moving water is rougher: a current breaks the surface up.
    float flowRipples = 1.0 + 0.6 * clamp(length(flow), 0.0, 2.0);
    slope += FlowedRippleSlope(P.xz, flow) * (u_Ripples * flowRipples * rippleFade);
    // Rain on the water: the same rings a puddle gets (lib/Ripples.glsl), but
    // carried off by the current - a ring lands and then drifts downstream.
    // Past thirty metres a 2 cm ring is under a pixel and only flickers.
    if (u_WeatherNow.x > 0.0) {
        float near = 1.0 - smoothstep(12.0, 30.0, dist);
        slope += FZE_RainRingSlope(P.xz - flow * u_Time, u_Time, u_WeatherNow.x) * near;
    }
    vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
    if (below) N = -N;
    float NoV = max(dot(N, V), 1e-4);

    // ---- the light arriving at the surface ----
    vec3 sunL = normalize(u_SunDir);
    // ⚠️ THROUGH THE SAME SHADOW MAP AS EVERYTHING ELSE. Without it the sun
    // glinted off the water right inside a pier's shadow. The flat normal, not
    // the wavy one, for the bias: the map knows nothing of ripples.
    float sunSeen = DirectionalShadow(P, vec3(0.0, 1.0, 0.0), sunL) * CloudShadow(P, sunL);
    vec3 sunHere = u_SunIlluminance * FZE_SunThroughAir(FZE_AtmosphereFromUniforms(), P, sunL) * sunSeen;
    // ⚠️ NO BAKE, NO SKY LIGHT - NOT A PAINTED ONE. The fallback here was a
    // fixed blue in display units; in physical units that is 20,000 cd/m^2 at
    // night, and a reflection probe captured over this pond at 22:00 recorded
    // a floor brighter than noon.
    vec3 skyIrr = (u_HasIBL == 1 ? texture(u_IrradianceMap, vec3(0.0, 1.0, 0.0)).rgb * u_IBLScale : vec3(0.0))
                * u_SkyLightIntensity;
    // As radiance off a white card lying on the water: what the water column is lit by.
    vec3 lightIn = skyIrr + sunHere * max(sunL.y, 0.0) / FZE_PI;
    vec3 body = u_Scatter * lightIn;

    // ---- under the surface: the scene, through the water ----
    float dStraight = texture(u_SceneDepth, uv).r;
    vec3 bedStraight = dStraight >= 1.0 ? P - V * 1000.0 : WorldFromDepth(uv, dStraight);
    float through = length(bedStraight - P);
    // Bent by the surface, as much as there is water to bend through - none at
    // the shore line, where the bed meets the surface.
    vec2 ruv = clamp(uv + N.xz * 0.05 * clamp(through, 0.0, 1.0), vec2(0.001), vec2(0.999));
    float dBent = texture(u_SceneDepth, ruv).r;
    vec3 bed = dBent >= 1.0 ? P - V * 1000.0 : WorldFromDepth(ruv, dBent);
    // ⚠️ A BENT SAMPLE THAT LANDS ON SOMETHING IN FRONT OF THE WATER - a post, a
    // leg, a boat - would pull it INTO the water. Those take the straight one.
    if (length(bed - u_CameraPos) < dist) { ruv = uv; bed = bedStraight; }
    vec3 behind = texture(u_SceneColor, ruv).rgb;
    // How deep the water is HERE, straight down to whatever is under it - what
    // the shore, the foam and the caustics all ask. A pixel with nothing under
    // it (the sky, through a gap) is deep water.
    float depth = dStraight >= 1.0 ? 1000.0 : max(P.y - bedStraight.y, 0.0);

    // ---- caustics: sunlight focused by the waves onto the bed ----
    //
    // Two drifting octaves of noise folded into bright lines, laid on the bed
    // where it is: strongest just under the surface, gone at the water line
    // (nothing to focus through) and fading with depth as the light is absorbed
    // on the way down and back up.
    if (!below && u_Caustics > 0.0 && depth < 30.0 && sunL.y > 0.0) {
        vec2 q = bed.xz * 1.6 - flow * u_Time * 0.8;
        float c1 = 1.0 - abs(Noise(q + u_Time * vec2(0.20, 0.13)) * 2.0);
        float c2 = 1.0 - abs(Noise(q * 1.7 - u_Time * vec2(0.11, 0.17)) * 2.0);
        float lines = pow(c1 * c2, 6.0) * 4.0 * u_Caustics * smoothstep(0.02, 0.25, depth) * sunL.y;
        // Sunlight focused onto the BED, so it is the bed's own view of the sun
        // that decides: none in the shade under the pier.
        float bedSun = DirectionalShadow(bed, vec3(0.0, 1.0, 0.0), sunL) * CloudShadow(bed, sunL);
        vec3 reach = exp(-u_Absorption * depth * 2.0);           // down and back up
        behind *= 1.0 + lines * reach * bedSun;
    }

    // From below, the camera is already in the water; the post process owns
    // that murk, and above the surface there is only air.
    float path = below ? 0.0 : length(bed - P);
    vec3 T = exp(-u_Absorption * path);
    vec3 refracted = behind * T + body * (1.0 - T);

    // ---- on the surface: what it reflects ----
    float rough = clamp(u_Roughness, 0.02, 1.0);
    float F;
    vec3 reflected;
    if (!below) {
        F = F_Schlick1(0.02, 1.0, NoV);          // water's F0 is 2%
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);                           // a wave cannot show the sea its own floor
        float lod = rough * float(max(u_PrefilterMips - 1, 1));
        vec3 sky = (u_HasIBL == 1 ? textureLod(u_PrefilterMap, R, lod).rgb * u_IBLScale : vec3(0.0))
                 * u_SkyReflection;
        reflected = sky;
        // Only where the reflection shows: looking straight down, F is 2% and a
        // march would buy nothing.
        if (F > 0.04) {
            float conf;
            vec3 onScreen = TraceScreen(P, R, conf);
            reflected = mix(sky, onScreen, conf);
        }
    } else {
        // From inside: beyond the critical angle (48.6 degrees for water) the
        // surface is a mirror, and what it mirrors is the water.
        float sinT = 1.333 * sqrt(max(1.0 - NoV * NoV, 0.0));
        F = sinT >= 1.0 ? 1.0 : F_Schlick1(0.02, 1.0, sqrt(1.0 - sinT * sinT));
        reflected = body;
    }

    // ---- the sun's highlight ----
    vec3 spec = vec3(0.0);
    if (!below) {
        vec3 H = normalize(V + sunL);
        float NoL = max(dot(N, sunL), 0.0);
        float NoH = max(dot(N, H), 0.0);
        float LoH = max(dot(sunL, H), 0.0);
        float a = max(rough * rough, 0.002);
        spec = sunHere * (D_GGX(a, NoH) * V_SmithGGXCorrelated(a, NoV, NoL)
                          * F_Schlick1(0.02, 1.0, LoH) * NoL);
    }

    vec3 color = mix(refracted, reflected, F) + spec;

    // ---- foam: white water where the waves break ----
    //
    // In water shallower than u_BreakDepth the waves are breaking (see
    // WaterWaves::BreakingDepth). Broken, not a band: a noise pattern
    // thresholded harder the deeper the water, so it thins into streaks and
    // patches away from the shore, carried
    // by the current. Lit like any white matte thing (albedo 0.85) by the same
    // sky and sun as the water.
    if (!below && u_Foam > 0.0 && depth < u_BreakDepth * 1.5) {
        vec2 fq = P.xz * 3.0 - flow * u_Time;
        float n = Noise(fq + u_Time * 0.15) * 0.6 + Noise(fq * 2.3 - u_Time * 0.2) * 0.4 + 0.5;
        float shallow = 1.0 - clamp(depth / u_BreakDepth, 0.0, 1.0);
        float foam = smoothstep(1.0 - shallow, 1.0 - shallow + 0.25, n) * u_Foam;
        color = mix(color, 0.85 * lightIn, clamp(foam, 0.0, 1.0));
    }

    // ---- the water line: the surface thins to nothing where it meets a shore ----
    //
    // Without this the surface ends in a hard edge along every bank - a line the
    // eye reads as a flat sheet laid over the ground. Over the last few
    // centimetres of depth it hands over to what is under it.
    if (!below) color = mix(behind, color, smoothstep(0.0, 0.06, depth));

    // The air between here and the eye, as for every other surface.
    color = FZE_ApplyFog(color, FZE_FogRadiance(pow(max(u_FogColor, 0.0), vec3(2.2)), P - u_CameraPos),
                         FZE_FogDepth(u_CameraPos, P));
    color = FZE_ApplyAerial(color, uv, dist);
    FragColor = vec4(color, 1.0);
}
