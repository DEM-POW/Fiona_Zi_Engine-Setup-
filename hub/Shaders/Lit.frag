#version 460 core

in vec3 v_WorldPos;
in vec3 v_Normal;
in vec2 v_TexCoord;
// The same two, not corrected for depth (lib/Retro.glsl: the retro look's bend).
noperspective in vec2 v_AffineUV;
noperspective in vec3 v_AffinePos;
uniform vec4 u_Retro;
in vec3 v_GridPos;      // object space, metres (Lit.vert)
in vec3 v_GridNormal;

// Ben Golus's "pristine grid": lines sized from the pixel's footprint, so a line
// is never thinner than a pixel (no crawling at grazing angles) and, past the
// distance where it would be, fades to the AVERAGE coverage it would have had
// instead of a moire - a distant wall goes evenly tinted, not to noise.
// `lineWidth`: the line's share of a cell (0.02 = 2 cm in a 1 m cell).
float FZE_PristineGrid(vec2 uv, vec2 lineWidth) {
    vec4 uvDDXY = vec4(dFdx(uv), dFdy(uv));
    vec2 uvDeriv = vec2(length(uvDDXY.xz), length(uvDDXY.yw));
    bvec2 invertLine = greaterThan(lineWidth, vec2(0.5));
    vec2 targetWidth = mix(lineWidth, 1.0 - lineWidth, vec2(invertLine));
    vec2 drawWidth = clamp(targetWidth, uvDeriv, vec2(0.5));
    vec2 lineAA = uvDeriv * 1.5;
    vec2 gridUV = abs(fract(uv) * 2.0 - 1.0);
    gridUV = mix(1.0 - gridUV, gridUV, vec2(invertLine));
    vec2 grid2 = smoothstep(drawWidth + lineAA, drawWidth - lineAA, gridUV);
    grid2 *= clamp(targetWidth / drawWidth, 0.0, 1.0);
    grid2 = mix(grid2, targetWidth, clamp(uvDeriv * 2.0 - 1.0, 0.0, 1.0));
    grid2 = mix(grid2, 1.0 - grid2, vec2(invertLine));
    return mix(grid2.x, 1.0, grid2.y);
}

layout(location = 0) out vec4 FragColor;

uniform vec3 u_CameraPos;
uniform int   u_TonemapMode;   // 0 ACES, 1 Reinhard, 2 None


// Material (metallic-roughness PBR)
// ⚠️ THESE FOUR COME FROM THE VERTEX STAGE NOW, NOT FROM A UNIFORM.
//
// They are still uniforms - Lit.vert declares them and BindMaterial still sets
// them - but the vertex shader chooses between the uniform and the instance
// attribute and passes the winner along flat. That leaves exactly one path
// here: a draw of a hundred differently coloured crates and a draw of one
// crate reach this line the same way.
flat in vec4 v_MatColorMetal;   // rgb = base colour, a = metallic
flat in vec4 v_MatRoughRefl;    // x = roughness, y = reflectance
#define u_BaseColor   (v_MatColorMetal.rgb)
#define u_Metallic    (v_MatColorMetal.a)
#define u_Roughness   (v_MatRoughRefl.x)
#define u_Reflectance (v_MatRoughRefl.y)
#ifdef FZE_VERTEX_TINT
// An editor view that colours each vertex with information (the Skin Weight
// Editor: how much one joint moves it). It replaces the albedo; the light
// stays, so the shape still reads.
in vec3 v_Tint;
#endif
// ⚠️ HOW REFLECTIVE A NON-METAL IS, authored in the 0..1 range artists use
// rather than as an F0 colour. 0.5 is the 4% every engine hardcodes, 0.35 is water,
// 1.0 is the top of the common dielectric range (~16%). Metals ignore it - their F0
// IS their base colour, which is what makes a copper highlight copper-coloured.
uniform float u_Opacity;      // 1 = opaque; below that the draw is blended
uniform float u_AlphaCutoff;  // > 0: cut out where the colour map's alpha is under it (glTF MASK)
uniform int   u_AlphaBlend;   // 1: the colour map's alpha is how opaque each texel is (glTF BLEND)
// A smooth film over the surface: car paint, varnish, wet. 0 = none.
uniform float u_ClearCoat;
uniform float u_ClearCoatRough;
// The smoothest the material's kind of surface is while dry (SurfaceType):
// a floor under the roughness map, 0 for metal, glass, water and Default.
uniform float u_DryRoughness;
// -1 stretches the highlight across the brush, +1 along it, 0 = round (free).
uniform float u_Anisotropy;
uniform float u_AnisoRotation;   // turns, 0..1
uniform vec3  u_Emissive;
uniform float u_EmissiveStrength;   // nits
// How the light becomes colour (Renderer/Material.h ShadingModel): 0 Standard,
// 1 Toon, 2 Stylized, 3 Unlit - and Toon's and Stylized's own settings.
uniform int   u_ShadingModel;
uniform int   u_LightingOnly;   // the editor's Lighting Only view (Renderer::SetLightingOnly)
uniform int   u_ToonBands;
uniform float u_ToonSoftness;
uniform vec3  u_ShadowTint;         // sRGB, like every picked colour
uniform float u_SpecularSize;
uniform float u_RimLight;
uniform float u_Wrap;
uniform float u_PreExposure;        // the camera (Renderer/Exposure.h)

// Albedo (base-color) texture
uniform vec2      u_UVScale;    // texture repeats across the mesh UV range
uniform vec2      u_UVOffset;
uniform sampler2D u_AlbedoMap;
uniform int       u_HasAlbedo;
uniform int       u_Checker;        // engine-default UV checker (untextured primitives)
uniform int       u_WorldUV;        // maps projected from world position along the dominant axis
uniform float     u_CheckerScale;

// Additional PBR maps (sampled only when the matching flag is 1).
uniform sampler2D u_NormalMap;      // tangent-space normals
uniform int       u_HasNormal;
uniform float     u_NormalStrength;
uniform sampler2D u_MetalRoughMap;  // glTF packing: G = roughness, B = metallic
uniform int       u_HasMetalRough;
uniform sampler2D u_RoughnessMap;   // standalone grayscale roughness (R)
uniform int       u_HasRoughness;
uniform sampler2D u_MetallicMap;    // standalone grayscale metallic (R)
uniform int       u_HasMetallic;
uniform sampler2D u_AOMap;          // ambient occlusion in R
uniform int       u_HasAO;

uniform sampler2D u_HeightMap;      // displacement, white = high (unit 16)
uniform int       u_HasHeight;
uniform float     u_HeightScale;    // world-ish depth of the relief
uniform int       u_NormalFlipY;    // 1 = DirectX-convention normal map (G inverted)
uniform float     u_AOStrength;
// The material preview's views (Renderer::SetMaterialView): 0 the lit surface;
// 1 base colour, 2 normal, 3 roughness, 4 metallic, 5 height, 6 occlusion - each
// as the surface really has it after mapping, relief and detail, not the file.
uniform int       u_MaterialView;
uniform sampler2D u_EmissiveMap;    // emissive color
uniform int       u_HasEmissiveMap;

// Reconstruct a tangent-space -> world normal without a tangent vertex
// attribute, using screen-space derivatives of world position and UV
// (Christian Schuler, "Followup: Normal Mapping Without Precomputed Tangents").
vec3 PerturbNormal(vec3 N, vec2 uv, vec3 tangentNormal) {
    vec3 dp1 = dFdx(v_WorldPos);
    vec3 dp2 = dFdy(v_WorldPos);
    vec2 duv1 = dFdx(uv);
    vec2 duv2 = dFdy(uv);
    vec3 dp2perp = cross(dp2, N);
    vec3 dp1perp = cross(N, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float invmax = inversesqrt(max(dot(T, T), dot(B, B)));
    mat3 TBN = mat3(T * invmax, B * invmax, N);
    return normalize(TBN * tangentNormal);
}

// ============================================================================
// Parallax Occlusion Mapping — what makes a height-mapped surface read as real
// relief instead of a flat photo. The view ray is marched through the height
// field in tangent space; each pixel shows the texel the ray actually HITS, so
// pebbles occlude the dirt behind them and the surface parallaxes as the
// camera moves.
//
// Reuses the same derivative-based tangent frame as PerturbNormal, so it works
// on any mesh with UVs — no precomputed tangents needed.
// ============================================================================
mat3 CotangentFrame(vec3 N, vec2 uv) {
    vec3 dp1 = dFdx(v_WorldPos);
    vec3 dp2 = dFdy(v_WorldPos);
    vec2 duv1 = dFdx(uv);
    vec2 duv2 = dFdy(uv);
    vec3 dp2perp = cross(dp2, N);
    vec3 dp1perp = cross(N, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float invmax = inversesqrt(max(dot(T, T), dot(B, B)));
    return mat3(T * invmax, B * invmax, N);
}

const float PI = 3.14159265359;

#include "lib/Material.glsl"
#include "lib/Fog.glsl"
#include "lib/AerialPerspective.glsl"
#include "lib/SkySample.glsl"
#include "lib/AtmosphereUniforms.glsl"
#include "lib/Tonemap.glsl"
#include "lib/Weather.glsl"
#include "lib/SpecularAA.glsl"

#include "lib/Lighting.glsl"
#include "lib/SimpleLight.glsl"
#include "lib/Decals.glsl"
#include "lib/SurfaceDetail.glsl"

// ⚠️ A NODE MATERIAL'S CODE GOES HERE. Built with FZE_GRAPH defined, the marker
// line below is replaced by the function its graph compiled to (Materials/MaterialGraph.cpp:
// FZE_Graph, its helpers and its u_Graph* uniforms). Without it, the marker is a
// comment and the program is the standard surface. Keep it after the includes:
// the generated code may read u_CameraPos and u_ScreenSize.
// @FZE_GRAPH_FUNCTION

#include "lib/LodFade.glsl"
uniform float u_LodFade;          // between two levels of detail (Renderer: ResolveLODs)

// ⚠️ THE DEPTH TEST BEFORE THE SHADER, NOT AFTER IT (R1, docs/RENDER-PLAN.md). The prepass has
// written every surface's depth and this pass only tests it (LEQUAL, no writes), so a hidden
// fragment should never be lit. But this shader can `discard` (a leaf's cut, a level-of-detail
// fade), and a GPU that sees a discard tests depth AFTER the shader: every wall behind a wall
// was lit in full and thrown away. Measured on DREVAR at 75%: the lit pass 24.1 -> 17.0 ms with
// full materials, 9.5 -> 8.2 with Simple Surfaces; the picture is the same, because nothing in
// this pass writes depth. Only the two programs the renderer draws that way get it (FZE_EARLY_Z):
// a material graph that cuts holes writes its own depth and keeps the late test.
#if defined(FZE_EARLY_Z) && !defined(FZE_EXP_LATE_Z)   // FZE_EXP_LATE_Z: the old way, to compare
layout(early_fragment_tests) in;
#endif
// FZE_EXP_*: measuring switches, set only by FZE_SHADERDEFINES (docs/RENDER-PLAN.md R1).
#ifdef FZE_SIMPLE_LIT
// =============================================================================
//  THE SIMPLE SURFACE (Rendering Features > Simple Surfaces).
//
//  ⚠️ WHAT MADE A FRAME FALL NEXT TO A BUILDING. Measured on a UHD 620 at 360
//  lines: the Lit pass took 6.9 ms in the open and 22 ms in front of a house,
//  because the wall fills the screen and every one of its pixels runs everything
//  below this block: maps, decals, wetness, two reflection paths and the full
//  BRDF. This is what TerrainSimple.frag did for the ground, with the same sum,
//  so a wall and the ground it stands on are lit alike.
// =============================================================================
uniform int u_SimpleMarks;         // Rendering Features > Marks on Simple Surfaces
void main() {
    if (FZE_LodFadeCut(u_LodFade, gl_FragCoord.xy)) discard;
    o_SurfaceInfo = vec4(0.0, 0.0, 1.0, 0.0);
    vec3 P = v_WorldPos;
    vec3 N = normalize(v_Normal);
    vec3 toEye = u_CameraPos - P;
    float eyeDist = length(toEye);
    vec3 V = toEye / max(eyeDist, 1e-4);
    if (dot(N, V) < 0.0) N = -N;
    const vec3 Nface = N;

    FZEMapCoords mc = FZE_MapCoords(mix(v_TexCoord, v_AffineUV, u_Retro.w), mix(P, v_AffinePos, u_Retro.w), N);
    vec3 albedo = pow(max(u_BaseColor, 0.0), vec3(2.2));
    float texAlpha = 1.0;
    if (u_HasAlbedo == 1) {
        vec4 tex = FZE_Sample(u_AlbedoMap, mc);
        texAlpha = tex.a;
        albedo *= pow(tex.rgb, vec3(2.2));
    }
    if (u_AlphaCutoff > 0.0 && texAlpha < u_AlphaCutoff) discard;
#ifdef FZE_VERTEX_TINT
    albedo = pow(max(v_Tint, 0.0), vec3(2.2));
#endif
    // Relief, while it is near enough to be seen: past this it is under a pixel.
    if (u_HasNormal == 1 && eyeDist < 45.0) {
        vec3 tn = FZE_SampleNormalTS(u_NormalMap, mc, u_NormalFlipY);
        tn.xy *= u_NormalStrength * (1.0 - smoothstep(25.0, 45.0, eyeDist));
        N = PerturbNormal(N, mc.uv, normalize(tn));
    }

    vec3 emissive = pow(max(u_Emissive, 0.0), vec3(2.2)) * u_EmissiveStrength * u_PreExposure;
    if (u_HasEmissiveMap == 1) emissive *= FZE_Sample(u_EmissiveMap, mc).rgb;

    // The marks on it (lib/Decals.glsl) - bullet holes, scorches, blood - before it is lit,
    // as the full surface takes them, when the game wants them here too.
    float sRough = u_Roughness, sMetal = u_Metallic;
    if (u_SimpleMarks == 1) FZE_ApplyDecals(P, Nface, gl_FragCoord.xy, albedo, N, sRough, sMetal);

    vec3 color;
    if (u_ShadingModel == 3) {
        color = albedo + emissive;
    } else {
        float mapAO = u_HasAO == 1 ? mix(1.0, FZE_Sample(u_AOMap, mc).r, clamp(u_AOStrength, 0.0, 1.0)) : 1.0;
        color = FZE_SimpleLight(P, N, V, eyeDist, albedo, sMetal, sRough, mapAO) + emissive;
    }

#ifndef FZE_EXP_NO_FOG
    color = FZE_ApplyFog(color, FZE_FogRadiance(pow(max(u_FogColor, 0.0), vec3(2.2)), P - u_CameraPos),
                         FZE_FogDepth(u_CameraPos, P));
    color = FZE_ApplyAerial(color, gl_FragCoord.xy / max(u_ScreenSize, vec2(1.0)), length(P - u_CameraPos));
#endif
#ifdef FZE_EXP_FLAT
    color = albedo;
#endif
    FragColor = vec4(color, u_Opacity * (u_AlphaBlend == 1 ? texAlpha : 1.0));
}
#else
void main() {
    if (FZE_LodFadeCut(u_LodFade, gl_FragCoord.xy)) discard;
    o_SurfaceInfo = vec4(0.0, 0.0, 1.0, 0.0);   // the surface target (lib/Lighting.glsl): nothing, until lit
    // ⚠️ SAMPLED ONCE, AT THE TOP, BECAUSE TWO DIFFERENT PARTS OF THIS SHADER
    // NEED IT. R is ambient occlusion and G is the contact shadow: the first is
    // wanted three hundred lines below with the ambient light, the second is
    // wanted immediately, with the sun's shadow. Declared where it was first
    // needed it was used before it existed - GLSL says nothing useful about
    // that on this driver, the program simply does not do what it says.
    vec2 screenTerms = vec2(1.0);
    if (u_HasSSAO == 1)
        screenTerms = texture(u_SSAOMap, gl_FragCoord.xy / u_ScreenSize).rg;

    vec3 N = normalize(v_Normal);
    vec3 V = normalize(u_CameraPos - v_WorldPos);
    if (dot(N, V) < 0.0) N = -N;          // two-sided
    vec3 Ngeom = N;                       // the face itself, before any map bends it

    // ============================================================
    //  TILING, APPLIED ONCE AND BEFORE EVERYTHING ELSE.
    //
    //  ⚠️ UVs COME OUT OF THE MESH AS 0..1 ACROSS A WHOLE FACE, WHATEVER ITS
    //  SIZE. A 40 m ground and a 1 m crate therefore both get exactly one copy
    //  of their texture — the ground stretched over forty metres, which is why a
    //  1K material on it resolves to about 26 pixels per metre and reads as mush.
    //  Tiling is the only thing that decouples texel density from object size.
    //
    //  ⚠️ AND IT MUST BE APPLIED BEFORE PARALLAX, NOT AFTER. Parallax marches
    //  through the height map in UV space; scaling its result instead of its
    //  input would step at one rate and sample at another, and the relief would
    //  slide across the surface as the camera moves.
    // ============================================================
    vec2  baseUV = mix(v_TexCoord, v_AffineUV, u_Retro.w) * u_UVScale + u_UVOffset;
    if (u_WorldUV == 1) {
        // The face's dominant axis picks the plane; the other two world axes are
        // the texture axes, in metres times u_UVScale. Flat-shaded boxes have one
        // axis per face, so this is a clean projection, not a triplanar blend.
        vec3 an = abs(normalize(v_Normal));
        vec2 wuv = (an.y >= an.x && an.y >= an.z) ? v_WorldPos.xz
                 : (an.x >= an.z)                  ? v_WorldPos.zy
                 :                                   v_WorldPos.xy;
        baseUV = wuv * u_UVScale + u_UVOffset;
    }

    vec2  uv = baseUV;
    float pomDepth = 0.0;
    // Where the standard surface reads its maps, and its relief - declared out
    // here because the self-shadow below the #endif reads them too.
    FZEMapCoords mc;
    mat3  reliefTBN = mat3(1.0);
    float reliefUV = 0.0;
    float camDist = length(u_CameraPos - v_WorldPos);
    float reflectance = u_Reflectance;
#ifdef FZE_GRAPH
    // ============================================================
    //  A NODE MATERIAL: ITS GRAPH IS THE SURFACE.
    //
    //  Everything the standard path reads from maps and sliders below - colour,
    //  metal, roughness, normal, occlusion, emission, opacity - comes from the
    //  graph instead (Materials/MaterialGraph.h). Everything after the surface is
    //  shared: wetness, the shading model, every light, fog, the air. A graph is
    //  a material, not a separate renderer.
    // ============================================================
    FZEGraphOut graphOut = FZE_Graph(baseUV, v_WorldPos, N, V);
    float normalVariance = 0.0;
    if (graphOut.HasNormal) N = PerturbNormal(N, baseUV, normalize(graphOut.Normal + vec3(0.0, 0.0, 1e-5)));
    vec3  albedo    = max(graphOut.BaseColor, vec3(0.0));
    float texAlpha  = 1.0;
    float metallic  = clamp(graphOut.Metallic, 0.0, 1.0);
    float roughness = clamp(graphOut.Roughness, 0.04, 1.0);
    reflectance     = clamp(graphOut.Reflectance, 0.0, 1.0);
#else
    // ============================================================
    //  THE MAPS, PLACED IN METRES (lib/SurfaceDetail.glsl): the mesh's UVs,
    //  a world projection, or three blended - and the relief's depth is a
    //  depth, not a fraction of whatever the UVs happen to span.
    // ============================================================
    mc = FZE_MapCoords(mix(v_TexCoord, v_AffineUV, u_Retro.w), mix(v_WorldPos, v_AffinePos, u_Retro.w), Ngeom);
    uv = mc.uv;
    if (u_HasHeight == 1 && u_Parallax == 1 && mc.mode == 0) {
        reliefUV = FZE_ReliefUV(mc);
        if (reliefUV > 1e-5) {
            reliefTBN = CotangentFrame(N, mc.uv);
            uv = FZE_ParallaxUV(mc, reliefTBN, V, reliefUV, camDist, pomDepth);
            mc.uv = uv;          // every map below reads where the relief put it
        }
    }

    // Tangent-space normal map perturbs the geometric normal per-pixel.
    //
    // ⚠️ A FILTERED NORMAL IS SHORTER THAN ONE, AND THE SHORTFALL IS ROUGHNESS.
    // Past a few metres a texel of the map covers many bumps - needles, grains of
    // concrete - and the mip averages their normals into one that points nearly
    // straight up. Normalised, that is a FLAT surface, and a flat surface at the
    // material's roughness took a low sun as a sheet of glare across the whole
    // field: the Outpost's forest floor (roughness 0.60 in its map) lit like a
    // wet road. The bumps did not go away, they got smaller than a pixel; their
    // spread is still there to scatter the light, and the averaged normal's
    // length says how much (Toksvig): variance = (1 - |n|) / |n|.
    float normalVariance = 0.0;
    if (u_HasNormal == 1 && mc.mode == 2) {
        // Three projections, blended in world space (no tangent frame to share).
        float len;
        N = FZE_TriplanarNormal(u_NormalMap, mc, N, u_NormalFlipY, u_NormalStrength, len);
        len = clamp(len / 0.97, 1e-3, 1.0);
        normalVariance = (1.0 - len) / len * u_NormalStrength * u_NormalStrength;
    } else if (u_HasNormal == 1) {
        // DirectX-convention maps store green inverted; without the flip
        // (FZE_UnpackNormal) every bump lights as a dent.
        vec3 tn = FZE_SampleNormalTS(u_NormalMap, mc, u_NormalFlipY);
        // The map is block-compressed (BC1), whose 5-6-5 endpoints put up to
        // ~3% into a texel's length at full resolution - noise, not bumps -
        // so lengths from 0.97 up count as one and a polished part stays so.
        float len = clamp(length(tn) / 0.97, 1e-3, 1.0);
        normalVariance = (1.0 - len) / len * u_NormalStrength * u_NormalStrength;
        tn.xy *= u_NormalStrength;
        N = PerturbNormal(N, uv, normalize(tn));
    }

    // Base colour comes from a COLOUR PICKER, which works in sRGB — the same space
    // an albedo texture is authored in. It was being fed to the lighting as if it
    // were already linear, which is why untextured surfaces read as washed-out
    // white plastic: 0.8 "grey" is a LINEAR albedo of 0.8, and almost nothing in
    // the real world reflects that much (fresh snow is about 0.9). Decoding it the
    // same way the texture is decoded makes the picked colour the colour you get,
    // and puts every material back in a physically sane range.
    vec3 albedo = pow(max(u_BaseColor, 0.0), vec3(2.2));          // sRGB -> linear
    float texAlpha = 1.0;
    float alphaLod = 0.0;
    if (u_HasAlbedo == 1) {
        vec4 tex = FZE_Sample(u_AlbedoMap, mc);
        texAlpha = tex.a;
        alphaLod = textureQueryLod(u_AlbedoMap, uv).x;
        albedo *= pow(tex.rgb, vec3(2.2));                        // sRGB -> linear
    }
    // A separate opacity map, when the material has one, says how opaque
    // instead of the colour map's alpha.
    if (u_HasOpacityMap == 1) {
        texAlpha = FZE_Sample(u_OpacityMap, mc).r;
        alphaLod = textureQueryLod(u_OpacityMap, uv).x;
    }
    // A leaf cut out of its picture (the depth passes cut the same shape,
    // DepthCutout.frag). The lit pass writes no depth, so this costs the
    // solid surfaces nothing.
    if (u_AlphaCutoff > 0.0 && texAlpha * (1.0 + max(alphaLod, 0.0) * 0.25) < u_AlphaCutoff) discard;
    // Finer texture up close, and broad patches far off (lib/SurfaceDetail.glsl).
    FZE_ApplyDetail(albedo, N, mc, camDist);
    FZE_ApplyVariation(albedo, mc);
#ifdef FZE_VERTEX_TINT
    albedo = pow(max(v_Tint, 0.0), vec3(2.2));
#endif

    // THE PROTOTYPE GRID - Unreal's level-design look, on the object's own space.
    //
    // ⚠️ IN THE OBJECT'S SPACE, NOT THE WORLD'S. Projected from world position
    // (Unreal's WorldGridMaterial does that) the squares stay where the world is
    // while the object moves through them: drag a cube and its grid swims across
    // it, turn it and the lines change direction on its faces. Here the grid is
    // measured on the object - its position times its scale - so it travels and
    // turns with the object, and a cube stretched to 8 x 0.2 x 3 still shows
    // squares of the same metres (the scale is in the coordinates, not in the
    // squares): what a level designer counts to read a size stays true.
    //
    // Major lines every u_CheckerScale metres, faint minor ones every quarter,
    // each tile a shade apart from its neighbour - thin rules on a light surface,
    // so the form and the shadows read first.
    if (u_Checker == 1) {
        vec3 an = abs(normalize(v_GridNormal));
        an = pow(an, vec3(8.0));                       // sharpen toward one axis
        an /= max(an.x + an.y + an.z, 1e-6);
        vec3 gp = v_GridPos / max(u_CheckerScale, 1e-3);
        float major = 0.0, minor = 0.0, tone = 0.0;
        for (int axis = 0; axis < 3; ++axis) {
            if (an[axis] < 1e-3) continue;
            vec2 c = axis == 0 ? gp.zy : (axis == 1 ? gp.xz : gp.xy);
            major += FZE_PristineGrid(c, vec2(0.022)) * an[axis];
            minor += FZE_PristineGrid(c * 4.0, vec2(0.05)) * an[axis];
            vec2 cell = floor(c);
            tone += mod(cell.x + cell.y, 2.0) * an[axis];
        }
        albedo *= 1.0 - 0.035 * tone;                  // a tile a shade apart from its neighbour
        albedo *= 1.0 - 0.12 * clamp(minor, 0.0, 1.0);
        albedo *= 1.0 - 0.42 * clamp(major, 0.0, 1.0);
    }
    float metallic = clamp(u_Metallic, 0.0, 1.0);
    float roughness = clamp(u_Roughness, 0.04, 1.0);
    if (u_HasMetalRough == 1) {
        vec3 mr = FZE_Sample(u_MetalRoughMap, mc).rgb;   // glTF: G rough, B metal
        roughness = clamp(u_Roughness * mr.g, 0.04, 1.0);
        metallic  = clamp(u_Metallic  * mr.b, 0.0, 1.0);
    }
    // Standalone grayscale maps override the packed channel (texture-set libraries).
    if (u_HasRoughness == 1)
        roughness = clamp(u_Roughness * FZE_Sample(u_RoughnessMap, mc).r, 0.04, 1.0);
    if (u_HasMetallic == 1)
        metallic  = clamp(u_Metallic  * FZE_Sample(u_MetallicMap, mc).r, 0.0, 1.0);
    // A cover layer - snow, dust, moss - over all of the above, where the
    // slope, the noise and the relief let it lie.
    if (u_Cover == 1) {
        float h01 = u_HasHeight == 1 ? FZE_Sample(u_HeightMap, mc).r : 0.5;
        FZE_ApplyCover(albedo, roughness, metallic, N, mc, Ngeom, h01);
    }
#endif
    // ---- Marks on it (lib/Decals.glsl): bullet holes, scorches, blood - part
    // of the surface from here on, so the rain wets them and the light below
    // lights them as it lights the wall. -------------------------------------
    FZE_ApplyDecals(v_WorldPos, Ngeom, gl_FragCoord.xy, albedo, N, roughness, metallic);
    roughness = max(roughness, u_DryRoughness);
    // The spread of normals a pixel covers widens the lobe (Tokuyoshi &
    // Kaplanyan: alpha^2 + 2 sigma^2): the map's own, from above, and the
    // geometry's - how fast the shading normal turns across the pixel - capped
    // so a hard edge does not turn to chalk.
    {
        vec3 dNx = dFdx(N), dNy = dFdy(N);
        float geomVariance = min(0.25 * (dot(dNx, dNx) + dot(dNy, dNy)), 0.18);
        float a = roughness * roughness;
        float a2 = clamp(a * a + 2.0 * (normalVariance + geomVariance), 0.0, 1.0);
        roughness = clamp(sqrt(sqrt(a2)), 0.04, 1.0);
    }
    if (u_LitDebug == 6) { FragColor = vec4(vec3(roughness), 1.0); return; }
    // The screen-space terms this point reads: 8 the ambient occlusion, 9 the
    // contact shadow (grey, 1 = nothing in the way).
    if (u_LitDebug == 8) { FragColor = vec4(vec3(screenTerms.r), 1.0); return; }
    if (u_LitDebug == 9) { FragColor = vec4(vec3(screenTerms.g), 1.0); return; }
    float ao = 1.0;
#ifdef FZE_GRAPH
    ao = clamp(graphOut.AO, 0.0, 1.0);
#else
    if (u_HasAO == 1)
        ao = mix(1.0, FZE_Sample(u_AOMap, mc).r, clamp(u_AOStrength, 0.0, 1.0));
#endif
    if (u_MaterialView != 0) {
        float h = 0.5;
#ifndef FZE_GRAPH
        if (u_HasHeight == 1) h = FZE_Sample(u_HeightMap, mc).r;
#endif
        vec3 o = u_MaterialView == 1 ? pow(max(albedo, vec3(0.0)), vec3(1.0 / 2.2))
               : u_MaterialView == 2 ? N * 0.5 + 0.5
               : u_MaterialView == 3 ? vec3(roughness)
               : u_MaterialView == 4 ? vec3(metallic)
               : u_MaterialView == 5 ? vec3(h)
               :                       vec3(ao);
        FragColor = vec4(o, 1.0);
        return;
    }
    // ---- The weather on it (lib/Weather.glsl): water in the pores, a film,
    // standing water in the hollows of the ground - the material's own height
    // map where it has one - and snow. The material may author a coat; rain
    // adds one on top of whatever it says. ------------------------------------
    float coatStrength = u_ClearCoat, coatRoughness = u_ClearCoatRough;
    {
        float hW = -1.0;
#ifndef FZE_GRAPH
        if (u_HasHeight == 1) hW = FZE_Sample(u_HeightMap, mc).r;
#endif
        FZE_ApplyWeather(v_WorldPos, Ngeom, metallic, hW, albedo, roughness, N, coatStrength, coatRoughness);
    }

    // ⚠️ ONE SURFACE, BUILT ONCE. Every light below shades THIS, so the sun
    // and a lamp cannot disagree about what the material is. Reflectance replaces the
    // hardcoded 0.04: water is not as reflective as glass and there was no way to say
    // so. 0.5 reproduces the old 4% exactly, which is why nothing changes until
    // somebody moves the slider.
    // ⚠️ BUILT AFTER WETNESS, NOT BEFORE. When this sat above the block it
    // read albedo/roughness/N as they were BEFORE the rain touched them, so every wet
    // surface in the engine silently went back to being dry. The surface has to be the
    // last thing decided, because everything above is still deciding what it is.
    // The editor's Lighting Only view: every surface the same neutral grey and
    // nothing metal, so what is left on screen is the light alone.
    if (u_LightingOnly == 1) { albedo = vec3(0.5); metallic = 0.0; }
    FZESurface surf = FZE_Surface(albedo, metallic, roughness, reflectance);
    if (u_ShadingModel != 0)
        FZE_SetShading(surf, u_ShadingModel, float(u_ToonBands), u_ToonSoftness,
                       pow(max(u_ShadowTint, 0.0), vec3(2.2)), u_SpecularSize, u_RimLight, u_Wrap,
                       albedo, metallic);
    if (coatStrength > 0.001) FZE_SetClearCoat(surf, coatStrength, coatRoughness);
    if (abs(u_Anisotropy) > 0.001) {
        // The frame is rebuilt from derivatives here rather than carried on the
        // vertex - see FZE_TangentFrame. Same reconstruction PerturbNormal uses.
        vec3 T, B;
        FZE_TangentFrame(N, v_WorldPos, uv, T, B);
        FZE_SetAnisotropy(surf, u_Anisotropy, T, B, u_AnisoRotation);
    }
    // Same story as the base colour: the emissive tint is a picked sRGB colour.
    // In nits, times the camera - see Material::EmissiveStrength.
#ifdef FZE_GRAPH
    // The graph's emission is a linear colour; its brightness in nits is the
    // Output node's (Material::EmissiveStrength), times the camera, as below.
    vec3 emissive = graphOut.Emissive * u_EmissiveStrength * u_PreExposure;
#else
    vec3 emissive = pow(max(u_Emissive, 0.0), vec3(2.2)) * u_EmissiveStrength * u_PreExposure;
    if (u_HasEmissiveMap == 1)
        emissive *= texture(u_EmissiveMap, uv).rgb;
#endif

    // Every light, through the one lighting function the ground uses too.
    float sunOcclusion = 1.0;
#ifndef FZE_EXP_NO_POMSHADOW   // FZE_EXP_*: measuring switches (docs/BENCHMARKS.md)
    if (u_HasHeight == 1 && pomDepth > 0.001)
        sunOcclusion = FZE_ParallaxShadow(mc, reliefTBN, pomDepth, normalize(u_SunDir), reliefUV);
#endif
    // ⚠️ THE HOLLOWS OF A SURFACE ARE IN THEIR OWN SHADOW WHEN THE SUN IS LOW.
    // The occlusion map says how much of the sky a point in a crevice sees; a
    // sun lower than the crevice's walls is part of the sky it does not see.
    // Micro-shadowing (Naughty Dog, 2016): the cone that ambient occlusion
    // implies, against the sun's height above the surface. Open ground (ao 1)
    // is untouched at any height; the gaps between the needles go dark once the
    // sun drops below their rims instead of shining like the tops.
#ifdef FZE_GRAPH
    if (ao < 0.999) {
#else
    if (u_HasAO == 1) {
#endif
        float NdotLg = abs(dot(normalize(v_Normal), normalize(u_SunDir)));
#ifndef FZE_EXP_NO_MICROSHADOW
        sunOcclusion *= clamp(NdotLg + 2.0 * ao * ao - 1.0, 0.0, 1.0);
#endif
    }
    vec3 color = FZE_LightSurface(surf, v_WorldPos, N, V, albedo, metallic, reflectance, ao,
                                  screenTerms, sunOcclusion, emissive);

    // Atmospheric fog — height-integrated, shared with the terrain, the foliage
    // and the sky (lib/Fog.glsl).
    //
    // ⚠️ THE FOG COLOUR IS A DISPLAY COLOUR, SO LINEARISE IT LIKE EVERY OTHER
    // ONE. It comes from the sky gradient, and Sky.frag writes its colours
    // straight out with no tonemap and no gamma - they are what you SEE. Mixed
    // in here it is radiance instead, next to a ground whose albedo is
    // carefully pow(2.2)'d two hundred lines up. 0.80 as radiance is 0.61, so
    // the fog was about a third too bright and it flattened the distance:
    // measured, the pixel variation of the ground below the horizon dropped
    // from 10.72 to 5.60 when fog was switched on - half the shape in the land
    // was being erased by haze that was too strong to begin with.
    color = FZE_ApplyFog(color,
                         FZE_FogRadiance(pow(max(u_FogColor, 0.0), vec3(2.2)),
                                         v_WorldPos - u_CameraPos),
                         FZE_FogDepth(u_CameraPos, v_WorldPos));

    // /!\ THE AIR, BEFORE THE TONEMAP AND AFTER EVERYTHING ELSE. Aerial
    // perspective is light: it has to be added while the frame is still linear
    // HDR, or a distant hillside gets its haze applied to an already-compressed
    // colour and the far field goes flat instead of blue. It also has to come
    // after the local fog, which is a different thing - weather near the ground
    // rather than the whole air column - and the two compose rather than
    // replace each other.
    color = FZE_ApplyAerial(color, gl_FragCoord.xy / max(u_ScreenSize, vec2(1.0)),
                            length(v_WorldPos - u_CameraPos));

    // ⚠️ LINEAR HDR OUT. Exposure, tone mapping and gamma used to happen right
    // here, which made the scene buffer a display image and everything after it
    // - bloom, reflections, volumetrics, the grade - work on numbers that were
    // no longer light. They happen once now, at the end of Composite.frag.
    // ⚠️ GLASS GETS BRIGHTER AT A GLANCE, NOT MORE SOLID. A flat alpha makes a
    // pane look like tinted plastic from every angle. Real glass is nearly
    // invisible face-on and nearly a mirror at a grazing one, because the Fresnel
    // reflection rises towards the edges - so the alpha has to rise with it, or
    // the reflection is drawn on something you can see straight through.
#ifdef FZE_GRAPH
    float a = clamp(graphOut.Opacity, 0.0, 1.0);
#else
    float a = u_Opacity * (u_AlphaBlend == 1 ? texAlpha : 1.0);
#endif
    if (a < 0.999) {
        float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
        a = clamp(a + (1.0 - a) * f * 0.85, 0.0, 1.0);
    }
    FragColor = vec4(color, a);
}
#endif  // FZE_SIMPLE_LIT