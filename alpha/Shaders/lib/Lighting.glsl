// ---------------------------------------------------------------
//  Fiona Zi Engine — the scene's lights
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// HOW A SURFACE IS LIT, ONCE.
//
// ⚠️ THIS WAS THE BOTTOM HALF OF Lit.frag, AND THE GROUND HAD ITS OWN COPY. The
// old Terrain.frag carried a second sun, a second set of lamps and a second sky,
// and they had drifted: the ground skipped the spot shadows, the point-light
// cubes and the bounce light that lit everything standing on it. A surface
// shader now says what the surface is and calls FZE_LightSurface; the renderer
// sets these uniforms for any program that includes this file (UploadLitUniforms,
// BindDirectionalShadows and the lit pass's own bindings).
#include "Material.glsl"
#include "AtmosphereUniforms.glsl"
#include "SkySample.glsl"
#include "Shadows.glsl"
#include "Lights.glsl"
#include "Octahedral.glsl"

// ---- The surface target (Renderer::SetSurfaceTarget) ----
// ⚠️ A FORWARD RENDERER THROWS AWAY WHAT A REFLECTION NEEDS. By the time the
// post pass runs, the roughness was a uniform of a draw long finished and the
// normal map was never anywhere but here. So the main view's lit pass writes
// them to a second target, Unity HDRP's forward way: the octahedral normal,
// the roughness the mirror lobe has, and a: 0 nothing lit here, 0.5 a lit
// surface the screen's reflection skips, 1 one it traces. Ignored
// (no buffer at location 1) in every other pass that draws with this file.
layout(location = 1) out vec4 o_SurfaceInfo;

// ---- The screen's reflections, traced last frame (PostProcessor, SSR.frag) ----
// rgb what each pixel's mirror direction found on screen, a how sure; looked up
// where THIS point was in that frame. The reflection hierarchy every engine
// uses - screen first, then the probe or the sky for what the screen does not
// hold - happens below, so a glossy floor in a room reflects the room's walls
// instead of a sky its roof hides.
uniform sampler2D u_SSRHistory;
uniform int   u_HasSSRHistory;
uniform mat4  u_SSRPrevViewProj;
uniform float u_SSRExposure;      // this frame's pre-exposure over the one it was traced at

// The roughness past which the screen's mirror image is not used: what is
// traced is ONE ray, and a rough surface's reflection is the average of a
// cone - blurred by the filter up to here, the sky's prefiltered answer after.
float FZE_SSRFade(float perceptualRoughness) {
    return 1.0 - smoothstep(0.3, 0.55, perceptualRoughness);
}
vec4 FZE_ScreenReflection(vec3 P) {
    if (u_HasSSRHistory != 1) return vec4(0.0);
    vec4 clip = u_SSRPrevViewProj * vec4(P, 1.0);
    if (clip.w <= 0.0) return vec4(0.0);
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
    vec4 r = texture(u_SSRHistory, uv);
    return vec4(r.rgb * u_SSRExposure, clamp(r.a, 0.0, 1.0));
}


// ⚠️ EVERY LIGHT HERE IS IN PHYSICAL UNITS TIMES THE CAMERA'S PRE-EXPOSURE
// (Renderer/Exposure.h): the sun in lux, a lamp in candela, a flash in lux.
// Nothing in this file scales a light by a number of its own.
uniform vec3 u_SunDir;          // TOWARDS the sun
uniform vec3 u_SunIlluminance;  // above the air; FZE_SunThroughAir takes out what the air takes
// A lightning flash (Weather/Lightning): the illuminance it puts on the ground
// now - zero between flashes - and the direction towards it.
uniform vec3 u_FlashLight;
uniform vec3 u_FlashDir;

uniform float u_SkyReflection;
// The look's scene shading (Renderer/Look.h): 0 leaves every surface its own;
// 1 Toon, 2 Stylized for every surface whose material says Standard.
uniform int  u_SceneShading;
uniform vec4 u_SceneToon;    // bands, softness, specular size, rim
uniform vec4 u_SceneShade;   // rgb the shade tint (linear), a the wrap
// FZE_LITDEBUG=n (Renderer): one term of the sum alone - 1 the direct light
// (sun, lamps, flash), 2 the sky's diffuse, 3 the reflections (sky or probe),
// 4 the bounce light, 5 the emission, 6 (Lit only) the roughness the light
// sees, after the normal-map and geometry spread, 7 the screen's reflection
// as this point reads it (rgb times how sure). 0 is the whole picture.
uniform int u_LitDebug;

// The lamps: one storage buffer, listed per cluster of the view - see
// lib/Lights.glsl. What follows here is only their shadow maps, which still
// live in fixed slots.
// Point-light shadow cubes (a couple of casters).
// ---- bounce light -----------------------------------------------------------
// ⚠️ THE BOUNCE ARRIVES AS A PICTURE NOW, NOT AS A VOLUME TO MARCH. Tracing six
// cones through the voxel volume here cost 4.75 ms of a 21.54 ms frame - more
// than the sun shadows, the lamp shadows, the occlusion, the clouds and the
// bloom put together - to answer a question whose answer changes over metres.
// Bounce.frag gathers it at the same reduced size the occlusion uses and this
// reads one texel. Same sampler unit: the volume is no longer bound here.
uniform sampler2D u_BounceMap;
uniform int   u_HasGI;

// ---- How much of the sky this point sees (Renderer/SkyVisibility.h) ----
// A grid of probes round the camera, each the sky's visibility as spherical
// harmonics (L1): x the average, yzw the direction (y, z, x). Unreal's
// distance-field AO and Unity's probe-volume sky occlusion answer the same
// question; without it the sky lit a room's corners as brightly as a field.
uniform sampler3D u_SkyVis;
uniform int   u_SkyVisEnabled;
uniform vec3  u_SkyVisMin;        // world, metres
uniform vec3  u_SkyVisSize;
uniform vec3  u_SkyVisProbe;      // the spacing of the probes
uniform float u_SkyVisStrength;   // 0 = the open sky everywhere

// The four numbers at a surface: read half a probe off it along its normal (a
// probe on the wall's own line is half inside it), faded out over the last
// two probes before the grid's edge, where nothing is known.
//
// ⚠️ EIGHT PROBES BY HAND, NOT ONE FILTERED READ. A wall is thinner than the
// probes are apart, so the eight round a point beside it include probes on
// the wall's OTHER side - and a filtered read mixed the street's open sky into
// the room's dark corner (20% of the sky in a closed corner, measured in
// FZESkyVisibilityTest). Unity's Adaptive Probe Volumes weight each probe
// instead: one inside a solid (its L0 stored negative by the dilation) or
// behind the surface counts for almost nothing, and the rest are renormalised.
// Almost, not nothing - with no good probe near, a filled one still answers.
vec4 FZE_SkyVisSH(vec3 P, vec3 N, out float weight) {
    weight = 0.0;
    if (u_SkyVisEnabled != 1) return vec4(3.5449, 0.0, 0.0, 0.0);
    vec3 probe = u_SkyVisProbe;
    vec3 dimF = u_SkyVisSize / max(probe, vec3(1e-3));
    vec3 uvw = (P + N * (0.5 * probe.x) - u_SkyVisMin) / u_SkyVisSize;
    vec3 edge = min(uvw, 1.0 - uvw) * dimF;
    weight = clamp(min(edge.x, min(edge.y, edge.z)) * 0.5, 0.0, 1.0) * u_SkyVisStrength;
    if (weight <= 0.0) return vec4(3.5449, 0.0, 0.0, 0.0);

    vec3 g = uvw * dimF - 0.5;
    vec3 f = fract(g);
    ivec3 i0 = ivec3(floor(g));
    ivec3 hi = ivec3(dimF + 0.5) - 1;
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    for (int k = 0; k < 8; ++k) {
        ivec3 o = ivec3(k & 1, (k >> 1) & 1, k >> 2);
        ivec3 cell = clamp(i0 + o, ivec3(0), hi);
        vec4 v = texelFetch(u_SkyVis, cell, 0);
        vec3 t = mix(1.0 - f, f, vec3(o));
        float w = t.x * t.y * t.z;
        if (v.x < 0.0) { v.x = -v.x - 0.001; w *= 0.02; }          // inside a solid
        vec3 at = u_SkyVisMin + (vec3(cell) + 0.5) * probe;
        if (dot(at - P, N) < -0.1 * probe.x) w *= 0.02;             // behind the surface
        sum += v * w;
        wsum += w;
    }
    return sum / max(wsum, 1e-8);
}
// The sky's light on a surface facing N, as a fraction of the open sky's: the
// visibility convolved with the cosine (irradiance), 1 under an open sky.
float FZE_SkyVisDiffuse(vec4 sh, vec3 N) {
    return clamp(0.282095 * sh.x + 0.325735 * (sh.y * N.y + sh.z * N.z + sh.w * N.x), 0.0, 1.0);
}
// The sky's visibility toward one direction (a reflection), 1 when it is open.
float FZE_SkyVisToward(vec4 sh, vec3 D) {
    return clamp(0.282095 * sh.x + 0.488603 * (sh.y * D.y + sh.z * D.z + sh.w * D.x), 0.0, 1.0);
}

// The lamps' shadows are one atlas now - see FZE_LampShadow in lib/Lights.glsl.


// Screen-space ambient occlusion (computed in a prepass, sampled by screen UV).
uniform sampler2D u_SSAOMap;
uniform int   u_HasSSAO;
uniform vec2  u_ScreenSize;

// Image-based lighting (split-sum) baked from the procedural sky.
uniform samplerCube u_IrradianceMap;
uniform samplerCube u_PrefilterMap;

// ---- reflection probe (0 = none, fall back to the sky) ----
uniform int         u_HasProbe;
uniform samplerCube u_ProbeMap;
uniform int         u_ProbeMips;
uniform vec3        u_ProbeBoxMin, u_ProbeBoxMax, u_ProbeCapturePos;
uniform float       u_ProbeIntensity;

// ⚠️ BOX PROJECTION: WHY A CUBEMAP ALONE IS NOT ENOUGH INDOORS.
//
// Sampling a cubemap by direction treats it as infinitely far away. That is true
// for the sky and false for a room: the wall two metres from a polished floor is
// reflected as though it were on the horizon, so the reflection does not line up
// with the wall and SLIDES as the camera moves — the giveaway that a reflection
// is fake.
//
// The fix is to intersect the reflection ray with the probe's box, then look up
// the direction from the CAPTURE POINT to that intersection. The reflection then
// lands where the wall actually is.
vec3 ProbeDirection(vec3 worldPos, vec3 R) {
    // Slab test. The 1/R division is deliberate rather than guarded: a component
    // of exactly zero gives an infinity that max/min handle correctly, and
    // branching per axis costs more than the infinity does.
    vec3 invR = 1.0 / R;
    vec3 t1 = (u_ProbeBoxMax - worldPos) * invR;
    vec3 t2 = (u_ProbeBoxMin - worldPos) * invR;
    vec3 tmax = max(t1, t2);
    float dist = min(min(tmax.x, tmax.y), tmax.z);
    vec3 hit = worldPos + R * dist;
    return hit - u_ProbeCapturePos;
}
uniform sampler2D   u_BRDFLUT;
uniform int   u_HasIBL;
uniform int   u_PrefilterMips;
uniform float u_SkyLightIntensity;   // raw scalar for scaling IBL diffuse
uniform float u_IBLScale;            // the maps are baked per unit of sky: what one unit is worth now

// ⚠️ THE BRDF USED TO LIVE HERE, AND IN TWO OTHER FILES.
//
// DistributionGGX / GeometrySmith / FresnelSchlick were copied into Lit.frag,
// Terrain.frag and IBLBRDF.frag. Three copies of the physics means the ground can be
// lit differently from the thing standing on it, and nobody reports that as a bug -
// only as "the terrain looks a bit off". They now share lib/Material.glsl.
//
// FresnelSchlickRoughness stays: it is the IBL-only approximation, and the direct
// lighting path no longer uses a roughness-faded Fresnel at all.
vec3 FresnelSchlickRoughness(float cosTheta, vec3 F0, float roughness) {
    return F0 + (max(vec3(1.0 - roughness), F0) - F0)
              * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}


// =============================================================================
//  EVERY LIGHT IN THE SCENE, ON ONE SURFACE.
//
//  The sun through its cascades and the clouds, the lamps through their own
//  shadow maps, the sky and the reflection probe, and the bounce light. The
//  caller decides what the surface IS (its FZESurface, its occlusion) and this
//  decides how it is lit - so a mesh and the ground it stands on are lit by the
//  same code, not by two copies that drift. Linear HDR, before fog and air.
//
//  screenTerms: R the screen-space ambient occlusion, G the contact shadow.
//  sunOcclusion: anything else that blocks the sun here and only the caller
//  can know (Lit's parallax self-shadow); 1 for nothing.
// =============================================================================
// ⚠️ A CALLER THAT HAS ALREADY LOOKED UP THE SUN'S SHADOW HANDS IT OVER. The
// cascade lookup with its filtering is the dearest thing in this function on
// this GPU, and foliage needs the same value for the light through a leaf -
// looking it up twice made a meadow's lit pass cost half as much again.
// Negative: look it up here, as every other caller does.
float g_FZESunShadow = -1.0;

vec3 FZE_LightSurface(FZESurface surf, vec3 P, vec3 N, vec3 V,
                      vec3 albedo, float metallic, float reflectance, float ao,
                      vec2 screenTerms, float sunOcclusion, vec3 emissive) {
    // Nothing here reflects until shown otherwise (a = 0).
    o_SurfaceInfo = vec4(0.0, 0.0, 1.0, 0.0);
    // Unlit: its colour, and the light it gives off. Nothing reaches it.
    if (surf.model == 3) return albedo + emissive;
    // ⚠️ THE SCENE'S LOOK, FOR WHATEVER DID NOT CHOOSE ITS OWN. A whole game
    // turns cel-shaded with one setting - the ground, the grass and every
    // imported model with it - while a material that names a model keeps it.
    if (surf.model == 0 && u_SceneShading != 0)
        FZE_SetShading(surf, u_SceneShading, u_SceneToon.x, u_SceneToon.y, u_SceneShade.rgb,
                       u_SceneToon.z, u_SceneToon.w, u_SceneShade.a, albedo, metallic);

    vec3 F0 = surf.f0;
    float roughness = surf.perceptualRoughness;   // the coat widened it; keep IBL in step

    // ⚠️ THE MULTI-SCATTER CORRECTION, COMPUTED BEFORE ANY LIGHT IS ADDED.
    //
    // A single-scattering GGX drops the light that bounces more than once between
    // microfacets, and the loss grows with roughness - measured in FZEMaterialModelTest:
    // at roughness 1.0 the old model kept 0.361 of the energy that arrived. Sixty-four
    // per cent of the light on a rough metal was being thrown away, which is exactly
    // why brushed metal rendered grey and dead.
    //
    // The table it needs is the split-sum BRDF LUT this engine ALREADY builds for
    // image-based lighting. So the fix costs one texture read, and it was one texture
    // read away for as long as the LUT has existed.
    // u_HasIBL is the engine's own gate: the LUT is bound only when it is 1, so this
    // never reads an unbound sampler.
    // ⚠️ READ ONCE, USED TWICE: the split sum below asks the table at the same
    // (N.V, roughness) - neither changes in between - and read it a second time.
    // One texture read a pixel less, the same numbers (docs/BENCHMARKS.md, Phase 3).
    vec2 dfg0 = vec2(0.0);
    if (u_HasIBL == 1) {
        dfg0 = texture(u_BRDFLUT, vec2(max(dot(N, V), 0.0), roughness)).rg;
        FZE_EnergyCompensation(surf, dfg0);
    }


    // ---- Sun (with shadows) ----
    vec3 L = normalize(u_SunDir);
    // FZE_EXP_*: measuring switches, set only by FZE_SHADERDEFINES for one run
    // (docs/BENCHMARKS.md): each compiles one part out, so its cost can be read.
#if defined(FZE_EXP_NO_SUNSHADOW)
    float shadow = 1.0;
#elif defined(FZE_SUN_SHADOW_GIVEN)
    // The shader set g_FZESunShadow before calling (Foliage.frag): no second copy of
    // DirectionalShadow compiled in for a branch that never runs.
    float shadow = g_FZESunShadow;
#else
    float shadow = g_FZESunShadow >= 0.0 ? g_FZESunShadow : DirectionalShadow(P, N, L);
#endif
    // ⚠️ THE CONTACT TERM MULTIPLIES THE SUN'S SHADOW AND NOTHING ELSE. It is a
    // statement about one light being blocked over a short distance, not about
    // how open the sky is - applying it to the ambient as well would darken the
    // inside of every shadow twice and is how contact shadows get their
    // reputation for looking like grime.
#ifndef FZE_EXP_NO_CONTACT
    shadow *= screenTerms.g;
#endif
#ifndef FZE_EXP_NO_CLOUDSHADOW
    shadow *= CloudShadow(P, L);   // passing clouds
#endif
    // What only the caller knows blocks the sun: Lit's parallax relief shading
    // itself (pebbles shading the dirt behind them). 1 when nothing does.
    shadow *= sunOcclusion;
    // The sun, as it arrives here rather than as it left.
#ifdef FZE_EXP_NO_SUNAIR
    vec3 sunHere = u_SunIlluminance;
#else
    vec3 sunHere = u_SunIlluminance * FZE_SunThroughAir(FZE_AtmosphereFromUniforms(), P, L);
#endif
    vec3 Lo = FZE_ShadeLight(surf, N, V, L, sunHere, shadow);

    // ---- The lamps: every directional light, then this pixel's cluster ----
    //
    // ⚠️ THE CLUSTER, NOT THE OBJECT, DECIDES WHICH LAMPS ARE ASKED. The object
    // mask this replaced was one bitmask per MESH: a long floor under a street
    // of lamps took every lamp that touched any part of it, at every pixel.
    // A cluster is a sliver of the view a few metres across, so a pixel is
    // asked about the lamps that can actually reach where it is.
    uint cl = FZE_ClusterIndex(gl_FragCoord.xy, P);
    uvec2 range = fzeClusters[cl];
    int total = u_ClusterBypass == 1 ? u_LightCount : u_DirectionalCount + int(range.y);
#ifdef FZE_EXP_NO_LAMPS
    total = 0;
#endif
    for (int k = 0; k < total; ++k) {
        int i = (k < u_DirectionalCount || u_ClusterBypass == 1)
              ? k : int(fzeClusterItems[range.x + uint(k - u_DirectionalCount)]);
        vec3 Lp;
        float dist;
        // ⚠️ LEAVE THE CONE BEFORE PAYING FOR ANYTHING INSIDE IT. Outside the
        // range or the outer angle FZE_LightAt is exactly zero, and the shadow
        // lookup and the BRDF below are skipped - most pixels a spot's range
        // reaches are outside its cone.
        float atten = FZE_LightAt(i, P, Lp, dist);
        if (atten <= 0.0) continue;
        FZELight lt = fzeLights[i];
        int type = int(lt.Intensity.w + 0.5);
        // Spot or point, one atlas, one rule. A toon surface keeps its shade
        // colour inside a lamp's shadow, so only the standard model may skip it.
        float vis = FZE_LampShadow(i, P, N, true);
        if (vis <= 0.0 && surf.model == 0) continue;

        // Spherical area light (Karis representative-point approximation): a
        // physical bulb has a RADIUS, so its highlight widens with distance
        // instead of staying a laser-point sparkle on every surface.
        float lr = roughness;
        if (type != 2 && lt.Params.y > 0.0)
            lr = clamp(roughness + lt.Params.y / (2.0 * max(dist, 0.05)), roughness, 1.0);
        // A lamp may carry its own roughness (the bulb's size widens its
        // highlight), so the surface is rebuilt for that light only - still one
        // function, not a second BRDF with its own opinions.
        FZESurface ps = FZE_Surface(albedo, metallic, lr, reflectance);
        ps.energyCompensation = surf.energyCompensation;
        FZE_CopyShading(ps, surf);
        Lo += FZE_ShadeLight(ps, N, V, Lp, lt.Intensity.rgb * atten, vis);
    }

    // ---- A lightning flash ----
    // From the channel, straight - and from the cloud base it lights, a wash
    // from overhead: a flash is seen as much by the sky going white as by the
    // bolt. Kilometres away and above, it reaches in where the sky does, so
    // it is occluded like the sky's light below, not by a shadow map.
    vec3 flash = vec3(0.0);
    if (u_FlashLight.g > 0.0) {
        flash = FZE_Shade(surf, N, V, normalize(u_FlashDir), u_FlashLight)
              + albedo * (1.0 - metallic) * u_FlashLight * (0.5 + 0.5 * N.y) * (0.3 / 3.14159265);
    }

    // ---- Indirect lighting (ambient diffuse + environment specular) ----
    vec3 ambient, envSpec;
    float NdotV = max(dot(N, V), 0.0);
    // The base layer's split-sum weight - what its reflection is multiplied
    // by - kept for the screen's reflection, which replaces the sky's below.
    vec3 specDFG = vec3(0.0);
    // The film on top (rain, varnish, car paint): its Fresnel and reflection.
    float coatF = 0.0, coatPR = 1.0;
    vec3 coatSpec = vec3(0.0);
#ifdef FZE_EXP_NO_IBL
    if (false) {
#else
    if (u_HasIBL == 1) {
#endif
        // Split-sum image-based lighting from the sky-baked cubemaps.
        vec3 F = FresnelSchlickRoughness(NdotV, F0, roughness);
        vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);
        // ⚠️ A DRAWN SURFACE IS NOT SHADED BY THE SKY'S GRADIENT. Toon and
        // Stylized read the sky's light from a normal bent towards the zenith,
        // so the shaded side is one flat colour (toon) or nearly (stylized)
        // rather than a photographic falloff.
        vec3 Na = surf.model == 1 ? normalize(N + vec3(0.0, 1.6, 0.0))
                : surf.model == 2 ? normalize(N + vec3(0.0, 0.6, 0.0)) : N;
        vec3 irradiance = texture(u_IrradianceMap, Na).rgb * u_IBLScale;
        ambient = kD * irradiance * albedo * u_SkyLightIntensity;

        // Anisotropic surfaces bend the reflection toward the brush direction; an
        // isotropic one gets exactly reflect(-V, N), as before.
        vec3 R = FZE_AnisotropicReflection(surf, N, V);
        vec3 prefiltered;
        if (u_HasProbe == 1) {
            float plod = roughness * float(max(u_ProbeMips - 1, 1));
            prefiltered = textureLod(u_ProbeMap, ProbeDirection(P, R), plod).rgb
                        * u_ProbeIntensity;
        } else {
            float lod = roughness * float(max(u_PrefilterMips - 1, 1));
            prefiltered = textureLod(u_PrefilterMap, R, lod).rgb * u_IBLScale;
        }
#ifdef FZE_EXP_OLD_LUT   // the second read again, to measure what it cost
        vec2 brdf = texture(u_BRDFLUT, vec2(NdotV, roughness)).rg;
#else
        vec2 brdf = dfg0;   // = texture(u_BRDFLUT, vec2(NdotV, roughness)).rg, read above
#endif
        specDFG = (F * brdf.x + brdf.y) * surf.energyCompensation;
        // Paint does not mirror the sky; a toon metal still shines.
        if (surf.model == 1) specDFG *= mix(0.3, 1.0, metallic);
        envSpec = prefiltered * specDFG * u_SkyReflection;

        // ⚠️ THE FILM REFLECTS TOO - AND IT DID NOT. The clear coat lit the
        // sun's highlight (FZE_ShadeLight) and nothing else, so rain on a road
        // and a puddle under the open sky showed no sky in them at all: the
        // reflection came from the rough stone underneath. Filament's
        // evaluateClearCoatIBL: the film's own mirror at its own roughness,
        // and everything beneath it seen through what the film lets pass.
        if (surf.clearCoat > 0.0) {
            coatPR = sqrt(max(surf.clearCoatRoughness, 0.0));
            coatF = F_Schlick1(0.04, 1.0, NdotV) * surf.clearCoat;
            vec3 Rc = reflect(-V, N);
            vec3 coatPref = u_HasProbe == 1
                ? textureLod(u_ProbeMap, ProbeDirection(P, Rc), coatPR * float(max(u_ProbeMips - 1, 1))).rgb * u_ProbeIntensity
                : textureLod(u_PrefilterMap, Rc, coatPR * float(max(u_PrefilterMips - 1, 1))).rgb * u_IBLScale;
            ambient *= 1.0 - coatF;
            envSpec *= 1.0 - coatF;
            specDFG *= 1.0 - coatF;
            coatSpec = coatPref * coatF * u_SkyReflection;
        }
    } else {
        // ⚠️ NO SKY LIGHT MEANS NO SKY LIGHT. There used to be a painted
        // hemisphere here - an ambient colour, a ground colour and two sky
        // colours, none of them the sky on screen - for passes that forgot to
        // bind the bake. A pass that does not bind it now shows up dark, which
        // is a bug somebody can see, instead of lit by a sky that is not there.
        ambient = vec3(0.0);
        envSpec = vec3(0.0);
    }

    // Ambient occlusion (material AO map * screen-space AO) darkens indirect
    // (ambient + environment) light only — never direct lighting.
    // R is the ambient occlusion, G is the contact shadow - see ContactShadow.frag.
    float ssao = screenTerms.r;
    float occ = ao * ssao;
    // The diffuse ambient is occluded with the bounce inside the crevice put
    // back; the reflection is not, because a mirror shows what is there, not a
    // diffuse average of it.
    ambient *= FZE_MultiBounceAO(occ, albedo);
    // ⚠️ The reflection gets its OWN occlusion, from the same measurement.
    // Same number for a fully rough surface, and progressively less as it polishes.
    envSpec *= FZE_SpecularAO(NdotV, occ, roughness);
    coatSpec *= FZE_SpecularAO(NdotV, occ, coatPR);

    // ⚠️ AND THE SKY ONLY LIGHTS WHAT CAN SEE IT (Renderer/SkyVisibility.h). The
    // diffuse sky by the visibility round the normal; the sky's reflection by
    // the visibility toward the reflection - a polished floor under a roof
    // reflects the ceiling's shade, not the blue overhead - widening to the
    // diffuse answer as the surface roughens. A local reflection probe already
    // holds what the room looks like, so it is left as it is.
#ifndef FZE_EXP_NO_SKYVIS
    {
        float skyW;
        vec4 skySH = FZE_SkyVisSH(P, N, skyW);
        if (skyW > 0.0) {
            float visD = FZE_SkyVisDiffuse(skySH, N);
            ambient *= mix(1.0, visD, skyW);
            if (u_HasProbe != 1) {
                vec3 Rv = reflect(-V, N);
                float toward = FZE_SkyVisToward(skySH, Rv);
                envSpec  *= mix(1.0, mix(toward, visD, roughness), skyW);
                coatSpec *= mix(1.0, mix(toward, visD, coatPR), skyW);
            }
        }
    }
#endif

    // ⚠️ THE SCREEN FIRST, THE SKY FOR WHAT IT DOES NOT HOLD - the reflection
    // hierarchy of Unreal's and Unity's reflection environment. Where last
    // frame's trace found a surface along this point's mirror direction, that
    // is what the reflection IS: the probe or the sky only fills the rest. Each
    // lobe takes it by its own roughness, so a wet film over rough stone
    // mirrors the street while the stone under it stays matt.
#ifndef FZE_EXP_NO_SSR
    {
        vec4 ssr = FZE_ScreenReflection(P);
        if (ssr.a > 0.0) {
            float aBase = ssr.a * FZE_SSRFade(roughness);
            envSpec = mix(envSpec, ssr.rgb * specDFG * FZE_SpecularAO(NdotV, occ, roughness), aBase);
            if (coatF > 0.0) {
                float aCoat = ssr.a * FZE_SSRFade(coatPR);
                coatSpec = mix(coatSpec, ssr.rgb * coatF * FZE_SpecularAO(NdotV, occ, coatPR), aCoat);
            }
        }
    }
#endif
    envSpec += coatSpec;

    // What the reflection pass needs of this surface: the normal, and the
    // smoothest lobe that will take the screen's reflection - a puddle's film,
    // not the mud under it. Toon paint and anything rough enough that the sky
    // alone serves are marked 0.5: a surface (a hit can be checked against its
    // normal) that the trace skips.
    {
        float ssrRough = roughness;
        if (coatF > 0.0 && surf.clearCoat > 0.2) ssrRough = min(ssrRough, coatPR);
        bool reflects = u_HasIBL == 1 && surf.model != 1 && FZE_SSRFade(ssrRough) > 0.0;
        o_SurfaceInfo = vec4(FZE_OctEncode(N), ssrRough, reflects ? 1.0 : 0.5);
    }

    // ⚠️ BOUNCE LIGHT IS OCCLUDED LIKE THE AMBIENT, AND MULTIPLIED BY THE
    // SURFACE'S OWN COLOUR. The volume holds light LEAVING other surfaces, so
    // what arrives here still has to be coloured by what it lands on - a red
    // wall beside a white one tints the white one, which is the whole reason
    // bounce light looks like anything.
    vec3 bounce = (u_HasGI == 1
                 ? texture(u_BounceMap, gl_FragCoord.xy / u_ScreenSize).rgb
                 : vec3(0.0)) * albedo * occ;

    if (u_LitDebug == 1) return Lo + flash * occ;
    if (u_LitDebug == 2) return ambient;
    if (u_LitDebug == 3) return envSpec;
    if (u_LitDebug == 4) return bounce;
    if (u_LitDebug == 5) return emissive;
    if (u_LitDebug == 7) { vec4 sr = FZE_ScreenReflection(P); return vec3(sr.rgb * sr.a); }
    return ambient + envSpec + Lo + emissive + bounce + flash * occ;
}
