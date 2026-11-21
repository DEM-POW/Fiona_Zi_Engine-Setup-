#version 460 core
// =============================================================================
//  A PLANT, LIT LIKE EVERYTHING ELSE - AND LIT THROUGH.
//
//  The model's own material: its colour map (cut out where its alpha is under
//  the cutoff), its normal map, its roughness. On top, what is particular to a
//  field of plants:
//
//    * variation: a slow noise shifts each plant's green and turns some patches
//      to straw (the scatter pass decided which) - a field is never one colour;
//    * the normal leans towards the sky: a clump is a hundred blades facing
//      every way, and lit by its own blade normals it glitters like a cheap
//      carpet; lit mostly by the ground's, it shades like the meadow it is;
//    * occlusion at the root: the inside of a clump is dark;
//    * the light that comes THROUGH a blade (a leaf is thin and passes most of
//      the red-green it does not reflect) - so grass with the sun behind it
//      glows instead of going black;
//    * rain: the water film darkens it and gives it a sheen; no puddles stand
//      on a blade.
//
//  Then lib/Lighting.glsl, the one lighting every surface gets, fog and the
//  air - the same as the ground it grows out of.
// =============================================================================
// ⚠️ THE PREPASS CUT THE SHAPE; THIS PASS ONLY LIGHTS WHAT IS IN FRONT.
// With a `discard` here the GPU cannot test depth before running the shader,
// so every blade behind the front one was lit in full and then thrown away:
// 40.8 ms of a 96 ms frame on a meadow. The depth prepass already wrote the
// cut-out shape (FoliageDepth.frag, the same invariant vertex shader), so this
// pass draws with the depth test EQUAL, tested before the shader runs, and a
// fragment outside the leaf never reaches it.
layout(early_fragment_tests) in;

in vec3  v_WorldPos;
in vec3  v_Normal;
in vec2  v_UV;
in float v_Height01;
in vec2  v_Variation;
in vec4  v_PicUV01;
in vec2  v_PicUV2;
flat in vec4 v_PicW;
flat in vec4 v_PicF01;
flat in vec2 v_PicF2;
flat in vec2 v_PicYaw;
flat in vec4 v_Crown;
flat in float v_Soft;
layout(location = 0) out vec4 FragColor;

uniform vec3  u_CameraPos;
uniform sampler2D u_AlbedoMap;
uniform int   u_HasAlbedo;
uniform sampler2D u_NormalMap;
uniform int   u_HasNormal;
uniform vec3  u_BaseColor;        // sRGB, the material's factor
uniform float u_AlphaCutoff;
uniform float u_Roughness;
uniform float u_Reflectance;     // Material::Reflectance: 0.5 is 4%, 0 reflects nothing
uniform vec3  u_Tint;             // the type's, multiplies the colour
uniform vec3  u_DryTint;
uniform float u_Translucency;
uniform float u_UpNormal;         // how far the normal leans to the sky (grass ~0.6, trees ~0.2)
uniform float u_RootOcclusion;    // how dark the root is (grass ~0.6, trees ~0.3)
// FZE_FOLIAGEDEBUG: 1 albedo, 2 sun N.L (unshadowed), 3 sun shadow x clouds x contact,
// 4 screen-space AO, 5 the lit colour without the light through the blade,
// 6 the sun's shadow map alone, 7 the clouds' shadow alone, 8 the contact shadow alone.
uniform int   u_Debug;
uniform int   u_Exp;              // FZE_FOLIAGEEXP, measuring: 4 sun diffuse only, 8 no normal map / no light through,
                                  // 128 cut-out parts flat red and solid parts flat blue (count a crown's coverage)
                                  // 256 a NaN on a sparse grid of leaf pixels (tests lib/Finite.glsl)
// A far tree as its pictures: the albedo map is the colour atlas, the normal map the other one.
uniform int   u_Impostor;
uniform float u_PicGrid;

#include "lib/Material.glsl"
#include "lib/Fog.glsl"
#include "lib/AerialPerspective.glsl"
#include "lib/SkySample.glsl"
#include "lib/AtmosphereUniforms.glsl"
#include "lib/Weather.glsl"
#include "lib/Lighting.glsl"
#include "lib/SimpleLight.glsl"
#include "lib/TreePicture.glsl"

mat3 Cotangent(vec3 N, vec3 p, vec2 uv) {
    vec3 dp1 = dFdx(p), dp2 = dFdy(p);
    vec2 du1 = dFdx(uv), du2 = dFdy(uv);
    vec3 dp2p = cross(dp2, N), dp1p = cross(N, dp1);
    vec3 T = dp2p * du1.x + dp1p * du2.x;
    vec3 B = dp2p * du1.y + dp1p * du2.y;
    float inv = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
    return mat3(T * inv, B * inv, N);
}

void main() {
    o_SurfaceInfo = vec4(0.0, 0.0, 1.0, 0.0);   // the surface target (lib/Lighting.glsl): nothing, until lit
    vec4 tex = u_HasAlbedo == 1 ? texture(u_AlbedoMap, v_UV) : vec4(1.0);

    vec3 P = v_WorldPos;
    vec3 base = u_BaseColor;
    float h01 = v_Height01;
    vec3 picN = vec3(0.0, 1.0, 0.0);
    // ---- a far tree: its three pictures, by their weights and their coverage here ----
    if (u_Impostor == 1) {
        float n = u_PicGrid;
        float inset = 0.5 * n / float(textureSize(u_AlbedoMap, 0).x);
        vec4 a0 = FZE_PicTexel(u_AlbedoMap, v_PicF01.xy, v_PicUV01.xy, n, inset);
        vec4 a1 = FZE_PicTexel(u_AlbedoMap, v_PicF01.zw, v_PicUV01.zw, n, inset);
        vec4 a2 = FZE_PicTexel(u_AlbedoMap, v_PicF2, v_PicUV2, n, inset);
        vec3 wa = v_PicW.xyz * vec3(a0.a * FZE_PicInside(v_PicUV01.xy), a1.a * FZE_PicInside(v_PicUV01.zw),
                                    a2.a * FZE_PicInside(v_PicUV2));
        float sum = max(wa.x + wa.y + wa.z, 1e-4);
        tex = vec4((a0.rgb * wa.x + a1.rgb * wa.y + a2.rgb * wa.z) / sum, 1.0);
        base = vec3(1.0);                       // the pictures hold the factor already
        // The depth and the height: the three views blended, as the colour is.
        vec4 n0 = FZE_PicTexel(u_NormalMap, v_PicF01.xy, v_PicUV01.xy, n, inset);
        vec4 n1 = FZE_PicTexel(u_NormalMap, v_PicF01.zw, v_PicUV01.zw, n, inset);
        vec4 n2 = FZE_PicTexel(u_NormalMap, v_PicF2, v_PicUV2, n, inset);
        // ⚠️ THE NORMAL IS ONE LEAF'S, NOT THE MEAN OF SEVERAL. A real tree far off shows one leaf
        // card in a pixel, each turned its own way, so its pixels go from lit to dark. The mean
        // of a few texels' normals is one smooth normal every pixel lights alike: the pictures
        // came out pale, the lit colour 94 against the tree's 81 from above. Lit by one texel of
        // one view they measured 81.4. So each pixel takes one unfiltered texel, of a view picked
        // by a fixed noise against the three weights: over the pixels each view counts by its
        // weight, as in the colour, and the pick shifts a pixel at a time as the camera moves.
        float pick = fract(52.9829189 * fract(dot(gl_FragCoord.xy + vec2(17.0, 31.0), vec2(0.06711056, 0.00583715))));
        int k = pick * sum < wa.x ? 0 : (pick * sum < wa.x + wa.y ? 1 : 2);
        vec2 Fk = k == 0 ? v_PicF01.xy : (k == 1 ? v_PicF01.zw : v_PicF2);
        vec2 uk = k == 0 ? v_PicUV01.xy : (k == 1 ? v_PicUV01.zw : v_PicUV2);
        vec2 ts = vec2(textureSize(u_NormalMap, 0));
        vec3 Nl = FZE_PicUnpackNormal(texelFetch(u_NormalMap, ivec2((Fk + clamp(uk, vec2(0.0), vec2(0.9999))) / n * ts), 0).xy);
        picN = normalize(vec3(v_PicYaw.x * Nl.x - v_PicYaw.y * Nl.z, Nl.y, v_PicYaw.y * Nl.x + v_PicYaw.x * Nl.z));
        float depth = (n0.z * wa.x + n1.z * wa.y + n2.z * wa.z) / sum;
        h01 = (n0.w * wa.x + n1.w * wa.y + n2.w * wa.z) / sum;
        // Lit, shadowed and fogged where the leaf is, not where the square is.
        P = v_WorldPos + normalize(u_CameraPos - v_WorldPos) * ((depth * 2.0 - 1.0) * v_PicW.w);
    }
    vec3 V = normalize(u_CameraPos - P);

    vec3 albedo = pow(max(base, 0.0), vec3(2.2)) * pow(max(tex.rgb, 0.0), vec3(2.2));
    albedo *= u_Tint;
    // Colour variation: a little brighter and yellower here, deeper there.
    albedo *= mix(vec3(0.82, 0.88, 0.80), vec3(1.10, 1.06, 0.88), v_Variation.x);
    // Dry patches: the plant's own lightness, in straw.
    // ⚠️ STRAW IS NOT WHITE. Scaled by 2.2 the dry grass came out at an albedo
    // of 0.74 - brighter than fresh snow's shadow side - and a backlit dry
    // patch burned to white. Dry grass reflects about a third of the light
    // (albedo ~0.3-0.4): the lightness is kept and only its hue is changed.
    float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 straw = pow(max(u_DryTint, 0.0), vec3(2.2));
    straw /= max(dot(straw, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
    albedo = mix(albedo, lum * straw * 1.1, v_Variation.y);

    // ---- the normal: its own, two-sided, leaning to the sky ----
    vec3 Nm = normalize(v_Normal);
    if (!gl_FrontFacing) Nm = -Nm;
    if (u_Impostor == 1) Nm = picN;
    else if (u_HasNormal == 1 && (u_Exp & 8) == 0) {
        vec3 t = texture(u_NormalMap, v_UV).xyz * 2.0 - 1.0;
        Nm = normalize(Cotangent(Nm, P, v_UV) * t);
    }
    // ---- Soft Foliage Far Away ----
    // ⚠️ FROM FAR, A CROWN IS ONE LEAFY VOLUME. Each leaf card faces its own way, so a pixel of a
    // far tree is a sunlit leaf or a dark gap beside it, and without a temporal filter the crown
    // reads as grain. Turned towards the crown's own round shape, it is lit on the sun's side,
    // dark on the far one, and darker inside where the leaves cover each other. Grass far off
    // lies in the field's light: its blades turn up. Near, every leaf keeps its own.
    float upBend = u_UpNormal, crownAO = 1.0;
    if (v_Soft > 0.0) {
        if (v_Crown.w > 0.0) {
            vec3 toP = P - v_Crown.xyz;
            float r = length(toP) / v_Crown.w;
            Nm = normalize(mix(Nm, toP / max(length(toP), 1e-4), 0.8 * v_Soft));
            crownAO = mix(1.0, mix(0.55, 1.0, smoothstep(0.25, 0.95, r)), v_Soft);
        } else {
            upBend = mix(u_UpNormal, 0.92, v_Soft);
        }
    }
    vec3 N = normalize(mix(Nm, vec3(0.0, 1.0, 0.0), upBend));
    if (dot(N, V) < 0.0) N = normalize(N - V * dot(N, V) * 1.01);

    float ao = mix(1.0 - u_RootOcclusion, 1.0, smoothstep(0.0, 0.65, h01)) * crownAO;
    // What the softened normal no longer varies is roughness now: a far crown with smooth
    // normals and its leaves' gloss caught the sky at its edges and went milky.
    float leafRough = mix(clamp(u_Roughness, 0.3, 1.0), 0.95, v_Soft * (v_Crown.w > 0.0 ? 0.85 : 0.5));

    // ---- the weather: a film on the blades, no puddles; snow over them ----
    float coat = 0.0, coatRough = 1.0;
    if (FZE_WeatherAnything()) {
        // The blade takes the weather of the ground it grows from.
        FZEWeather wet = FZE_WeatherAt(P, vec3(0.0, 1.0, 0.0));
        float soak = max(wet.soak, u_WeatherNow.w), film = max(wet.film, u_WeatherNow.w * 0.6);
        albedo *= mix(1.0, 0.72, clamp(soak + film * 0.5, 0.0, 1.0));
        coat = film * 0.75;
        coatRough = mix(0.35, 0.12, film);
        // Snow buries the blades from the root up.
        float buried = clamp(wet.snow / 4.0, 0.0, 1.0);
        float snowOn = smoothstep(0.0, 0.35, buried * 1.2 - h01 * 0.6);
        albedo = mix(albedo, vec3(0.80, 0.83, 0.88), snowOn);
        coat *= 1.0 - snowOn;
    }

    FZESurface surf = FZE_Surface(albedo, 0.0, leafRough, clamp(u_Reflectance, 0.0, 1.0));
    if (coat > 0.001) FZE_SetClearCoat(surf, coat, coatRough);

    vec2 screenTerms = vec2(1.0);
    if (u_HasSSAO == 1) screenTerms = texture(u_SSAOMap, gl_FragCoord.xy / u_ScreenSize).rg;
    // The sun's shadow once, for the lighting and for the light through the blade.
    vec3 Lsun = normalize(u_SunDir);
#ifdef FZE_SIMPLE_LIT
    // Rendering Features > Simple Surfaces: grass stands on the ground, under the same light.
    float eyeDist = length(u_CameraPos - P);
    float sunShadow = SunShadowTapAt(P, eyeDist);
    vec3 color = FZE_SimpleLight(P, N, V, eyeDist, albedo, 0.0, leafRough, ao);
#else
    float sunShadow = DirectionalShadow(P, Nm, Lsun);
    g_FZESunShadow = sunShadow;
    vec3 color = (u_Exp & 4) != 0 ? albedo * u_SunIlluminance * max(dot(N, Lsun), 0.0) * sunShadow
               : FZE_LightSurface(surf, P, N, V, albedo, 0.0, 0.5, ao, screenTerms, 1.0, vec3(0.0));
#endif
    if ((u_Debug > 0 && u_Debug < 5) || u_Debug >= 6) {
        vec3 Ld = normalize(u_SunDir);
        float v = u_Debug == 2 ? max(dot(N, Ld), 0.0)
                : u_Debug == 3 ? DirectionalShadow(P, Nm, Ld) * CloudShadow(P, Ld) * screenTerms.g
                : u_Debug == 6 ? DirectionalShadow(P, Nm, Ld)
                : u_Debug == 7 ? CloudShadow(P, Ld)
                : u_Debug == 8 ? screenTerms.g
                : screenTerms.r;
        FragColor = vec4(u_Debug == 1 ? albedo : vec3(v), 1.0);
        return;
    }
    if (u_Debug == 5) { FragColor = vec4(color, 1.0); return; }

    // ---- the light through the blade ----
    // Sun arriving on the far side of the face the eye sees, passed on
    // diffusely, and more of it straight towards the eye (forward scattering:
    // the glow of a backlit field). Coloured by the leaf twice - in and out.
    if (u_Translucency > 0.0 && (u_Exp & 8) == 0) {
        vec3 L = Lsun;
        float sh = sunShadow * CloudShadow(P, L) * screenTerms.g;
        if (sh > 0.001) {
            vec3 sun = u_SunIlluminance * FZE_SunThroughAir(FZE_AtmosphereFromUniforms(), P, L);
            float through = max(-dot(Nm, L), 0.0) * 0.6 + pow(max(dot(-V, L), 0.0), 5.0) * 1.2;
            vec3 leaf = albedo * sqrt(max(albedo, 1e-4)) * 1.6;
            // A dead blade is dry fibre and air, and lets much less through.
            float living = 1.0 - 0.7 * v_Variation.y;
            color += leaf * sun * (sh * through * u_Translucency * living * ao / 3.14159265);
        }
    }

    color = FZE_ApplyFog(color,
                         FZE_FogRadiance(pow(max(u_FogColor, 0.0), vec3(2.2)), P - u_CameraPos),
                         FZE_FogDepth(u_CameraPos, P));
    color = FZE_ApplyAerial(color, gl_FragCoord.xy / max(u_ScreenSize, vec2(1.0)), length(P - u_CameraPos));
    FragColor = vec4(color, 1.0);
    if ((u_Exp & 128) != 0) FragColor = vec4(u_AlphaCutoff > 0.0 ? vec3(3.0, 0.0, 0.0) : vec3(0.0, 0.0, 3.0), 1.0);
    // 256: a real NaN on every 32nd leaf pixel each way - the bad-pixel guard's test (lib/Finite.glsl).
    if ((u_Exp & 256) != 0 && all(equal(ivec2(gl_FragCoord.xy) % 32, ivec2(0)))) FragColor = vec4(uintBitsToFloat(0x7fc00000u));
}
