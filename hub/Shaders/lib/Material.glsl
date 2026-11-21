// ---------------------------------------------------------------
//  Fiona Zi Engine — the material model
//  Copyright (c) 2026 Nabras. All rights reserved.
//
//  Derived from Google Filament (Apache License 2.0):
//  https://github.com/google/filament — shaders/src/surface_brdf.fs,
//  surface_shading_model_standard.fs, surface_shading_lit.fs.
//  See THIRD-PARTY-NOTICES.txt.
// ---------------------------------------------------------------
//
// ONE PLACE WHERE THIS ENGINE DECIDES WHAT A SURFACE LOOKS LIKE.
//
// ⚠️ It was three. Lit.frag, Terrain.frag and IBLBRDF.frag each carried their own
// copy of DistributionGGX + GeometrySmith, which meant the ground could be lit by
// different physics from the thing standing on it and nobody would file it as a bug —
// only as "the terrain looks a bit off". A material model that cannot be changed in
// one edit is a material model that drifts.
//
// ⚠️ AND WHAT WAS IN THOSE COPIES WAS THE TUTORIAL VERSION. Every line below replaces
// something measurably less correct:
//
//   V_SmithGGXCorrelated   was  k = (roughness+1)^2 / 8, the UE4 approximation of a
//                          term that has an exact form. Height-correlated Smith is
//                          the real visibility function (Heitz 2014) and folds in the
//                          4·NoV·NoL denominator, so the divide-by-zero guard the old
//                          code needed disappears with it.
//
//   Fd_Burley              was  albedo/PI — flat Lambert, which does not know the
//                          surface is rough. Real rough dielectrics brighten at
//                          grazing angles; Lambert paints them flat and grey.
//
//   f0 from reflectance    was  a hardcoded 0.04 for every dielectric. Water, skin,
//                          glass and gemstone are not all 4% reflective, and there
//                          was no way to say so.
//
//   energyCompensation     was  ABSENT, and this is the one people SEE. A
//                          single-scattering GGX loses the light that bounces more
//                          than once between microfacets, and the loss grows with
//                          roughness — up to ~40% on a rough metal. That is why a
//                          brushed-metal sphere renders dark and lifeless while the
//                          reference image glows.
// ---------------------------------------------------------------

#ifndef FZE_MATERIAL_GLSL
#define FZE_MATERIAL_GLSL

const float FZE_PI = 3.14159265359;
const float FZE_MIN_ROUGHNESS = 0.045;   // below this, highlights alias into fireflies

//------------------------------------------------------------------------------
// Specular D — the normal distribution
//------------------------------------------------------------------------------
float D_GGX(float roughness, float NoH) {
    // Filament's formulation, kept because it is written to survive medium float:
    // the naive (NoH*NoH*(a2-1)+1) squares a number near 1 and loses its precision
    // exactly where a highlight is sharpest.
    float a = NoH * roughness;
    float k = roughness / (1.0 - NoH * NoH + a * a);
    float d = k * k * (1.0 / FZE_PI);
    return min(d, 65504.0);
}

//------------------------------------------------------------------------------
// Specular V — visibility (geometry, already divided by 4·NoV·NoL)
//------------------------------------------------------------------------------
// ⚠️ The COAT gets its own visibility, and a cheaper one on purpose. Kelemen
// 2001: a clear coat is a thin smooth dielectric film, so the full height-correlated
// Smith term is precision spent on a surface that has almost no microfacet shadowing
// to describe. Filament uses this here for the same reason.
float V_Kelemen(float LoH) {
    return 0.25 / max(LoH * LoH, 1e-5);
}

float V_SmithGGXCorrelated(float roughness, float NoV, float NoL) {
    // Heitz 2014, "Understanding the Masking-Shadowing Function in Microfacet-Based
    // BRDFs". Height-correlated: masking and shadowing are not independent, and
    // treating them as if they were is what the old k-approximation did.
    float a2 = roughness * roughness;
    float lambdaV = NoL * sqrt((NoV - a2 * NoV) * NoV + a2);
    float lambdaL = NoV * sqrt((NoL - a2 * NoL) * NoL + a2);
    return 0.5 / max(lambdaV + lambdaL, 1e-5);
}

//------------------------------------------------------------------------------
// Specular F — Fresnel
//------------------------------------------------------------------------------
vec3 F_Schlick(const vec3 f0, float f90, float VoH) {
    return f0 + (f90 - f0) * pow(1.0 - VoH, 5.0);
}
float F_Schlick1(float f0, float f90, float VoH) {
    return f0 + (f90 - f0) * pow(1.0 - VoH, 5.0);
}

//------------------------------------------------------------------------------
// Diffuse
//------------------------------------------------------------------------------
float Fd_Lambert() { return 1.0 / FZE_PI; }

float Fd_Burley(float roughness, float NoV, float NoL, float LoH) {
    // Burley 2012, "Physically-Based Shading at Disney".
    float f90 = 0.5 + 2.0 * roughness * LoH * LoH;
    float lightScatter = F_Schlick1(1.0, f90, NoL);
    float viewScatter  = F_Schlick1(1.0, f90, NoV);
    return lightScatter * viewScatter * (1.0 / FZE_PI);
}

//------------------------------------------------------------------------------
// Anisotropic specular — brushed metal, hair, vinyl, satin
//------------------------------------------------------------------------------
// ⚠️ ROUGHNESS IS ONE NUMBER, AND SOME SURFACES NEED TWO.
//
// A brushed pan, a hairbrush and a record are all rough ALONG one direction and
// smooth ACROSS it. A single roughness cannot say that, so every one of them
// rendered as an ordinary round highlight — which is exactly the look that says
// "computer graphics" about a metal object, and no amount of texture fixes it,
// because the wrongness is in the SHAPE of the highlight, not its colour.
//
// Two roughnesses: along the tangent and across it. Everything else is the same
// microfacet model.
float D_GGX_Anisotropic(float at, float ab, float ToH, float BoH, float NoH) {
    // Burley 2012. Deliberately computed wide: at*ab is roughness^4 and the dot
    // below is roughness^8, which does not survive medium precision.
    float a2 = at * ab;
    vec3  d  = vec3(ab * ToH, at * BoH, a2 * NoH);
    float d2 = dot(d, d);
    float b2 = a2 / max(d2, 1e-12);
    return a2 * b2 * b2 * (1.0 / FZE_PI);
}

float V_SmithGGXCorrelated_Anisotropic(float at, float ab, float ToV, float BoV,
                                       float ToL, float BoL, float NoV, float NoL) {
    // Heitz 2014, the anisotropic form of the same height-correlated visibility.
    float lambdaV = NoL * length(vec3(at * ToV, ab * BoV, NoV));
    float lambdaL = NoV * length(vec3(at * ToL, ab * BoL, NoL));
    return 0.5 / max(lambdaV + lambdaL, 1e-5);
}

// ⚠️ THE TANGENT FRAME, FROM DERIVATIVES — NO VERTEX CHANGE.
//
// This engine's vertex has position, normal and UV, and no tangent. Adding one
// would touch the importer, the mesh, every vertex layout and every shader, for a
// direction that can be recovered where it is used: Lit.frag already reconstructs
// exactly this frame for normal mapping (PerturbNormal). Same trick, one owner.
//
// UV-aligned on purpose: the brush direction an artist paints into a texture is the
// direction they expect the highlight to stretch along.
void FZE_TangentFrame(vec3 N, vec3 worldPos, vec2 uv, out vec3 T, out vec3 B) {
    vec3 dp1 = dFdx(worldPos), dp2 = dFdy(worldPos);
    vec2 du1 = dFdx(uv),       du2 = dFdy(uv);

    vec3 dp2perp = cross(dp2, N);
    vec3 dp1perp = cross(N, dp1);
    T = dp2perp * du1.x + dp1perp * du2.x;
    B = dp2perp * du1.y + dp1perp * du2.y;

    // A flat-shaded face or a mesh with no UVs gives a degenerate frame. Fall back to
    // any stable basis rather than producing NaNs that survive into the highlight.
    float len2 = max(dot(T, T), dot(B, B));
    if (len2 < 1e-12) {
        vec3 up = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        T = normalize(cross(up, N));
        B = cross(N, T);
        return;
    }
    float invmax = inversesqrt(len2);
    T *= invmax;
    B *= invmax;
}

//------------------------------------------------------------------------------
// A surface, resolved once per pixel
//------------------------------------------------------------------------------
struct FZESurface {
    vec3  diffuseColor;
    vec3  f0;
    float f90;
    float roughness;          // PERCEPTUAL roughness squared — what the BRDF wants
    float perceptualRoughness;
    vec3  energyCompensation;

    // ⚠️ A SECOND, SMOOTH LAYER ON TOP - which is what WET actually is.
    //
    // Rain does not make a surface "shinier". It puts a thin film of water over it,
    // and that film is its own dielectric layer with its own smoothness, sitting above
    // a rock that is still exactly as rough as it was. Faking it by lowering the
    // roughness of the rock says something different and looks it: the stone itself
    // turns to plastic instead of the water lying on it.
    //
    // Same model for a puddle, a varnished floor, a car panel and wet leaves - which
    // is the argument for it being in the shared file rather than in the rain code.
    float clearCoat;              // 0 = none, 1 = a full film
    float clearCoatRoughness;     // the FILM's roughness, not the surface's

    // ⚠️ LIGHT THAT WENT THROUGH THE SURFACE AND CAME OUT THIS SIDE.
    //
    // A leaf with the sun behind it GLOWS. Every purely reflective model says the
    // opposite: dot(N, L) is negative, so the leaf is black - a flat silhouette
    // exactly where nature puts the brightest thing in the frame. No amount of
    // ambient fixes it, because ambient is not directional and the effect is entirely
    // about where the light is.
    //
    // Thickness is how much light does NOT get through: 0 is tissue paper, 1 is a
    // tree trunk with no translucency at all.
    float subsurface;             // 0 = opaque, 1 = fully translucent
    float thickness;
    float subsurfacePower;        // tightness of the forward-scatter lobe
    vec3  subsurfaceColor;

    // Anisotropy: -1 stretches the highlight ACROSS the tangent, +1 ALONG it,
    // 0 is the ordinary round lobe and costs nothing extra.
    float anisotropy;
    vec3  anisotropicT;
    vec3  anisotropicB;

    // How the light becomes colour - Renderer/Material.h ShadingModel, and
    // FZE_ShadeLight below: 0 Standard (everything above), 1 Toon, 2 Stylized,
    // 3 Unlit. The rest are Toon's and Stylized's; Standard reads none of them.
    int   model;
    float toonBands;
    float toonSoftness;
    vec3  shadeTint;          // LINEAR: the colour of the shaded side, over the base colour
    float toonSpecSize;
    vec3  toonSpecColor;
    vec3  toonBase;
    float rim;
    float wrap;
};

// ⚠️ reflectance is AUTHORED IN THE 0..1 RANGE ARTISTS USE, not as an F0 colour.
// Filament's mapping: 0.5 is the 4% everybody hardcodes, 0.35 is water, 1.0 is the
// top of the common dielectric range (~16%). Metals ignore it entirely — their f0 IS
// their base colour, which is what makes copper copper-coloured in its highlight.
FZESurface FZE_Surface(vec3 baseColor, float metallic, float perceptualRoughness,
                       float reflectance) {
    FZESurface s;
    s.diffuseColor = baseColor * (1.0 - metallic);
    s.f0 = mix(vec3(0.16 * reflectance * reflectance), baseColor, metallic);

    // f90 = 1 for anything reflective enough to matter; for very low reflectance the
    // grazing response must fall off too, or a nearly non-reflective surface still
    // flashes white at the silhouette.
    s.f90 = clamp(dot(s.f0, vec3(50.0 * 0.33)), 0.0, 1.0);

    s.perceptualRoughness = clamp(perceptualRoughness, FZE_MIN_ROUGHNESS, 1.0);
    s.roughness = s.perceptualRoughness * s.perceptualRoughness;
    s.energyCompensation = vec3(1.0);   // filled by FZE_EnergyCompensation
    s.clearCoat = 0.0;
    s.clearCoatRoughness = 0.0;
    s.subsurface = 0.0;
    s.thickness = 0.5;
    s.subsurfacePower = 12.0;
    s.subsurfaceColor = vec3(1.0);
    s.anisotropy = 0.0;
    s.anisotropicT = vec3(1.0, 0.0, 0.0);
    s.anisotropicB = vec3(0.0, 0.0, 1.0);
    s.model = 0;
    s.toonBands = 1.0;
    s.toonSoftness = 0.04;
    s.shadeTint = vec3(1.0);
    s.toonSpecSize = 0.0;
    s.toonSpecColor = vec3(1.0);
    s.toonBase = baseColor;
    s.rim = 0.0;
    s.wrap = 0.5;
    return s;
}

// Put a film on top. `roughness` is the FILM's - a fresh puddle is near-mirror, a
// weathered varnish is not, and neither says anything about the surface underneath.
void FZE_SetClearCoat(inout FZESurface s, float strength, float perceptualRoughness) {
    s.clearCoat = clamp(strength, 0.0, 1.0);
    float pr = clamp(perceptualRoughness, FZE_MIN_ROUGHNESS, 1.0);
    s.clearCoatRoughness = pr * pr;

    // ⚠️ THE LAYER UNDERNEATH IS AT LEAST AS ROUGH AS THE FILM ON IT.
    //
    // Light is diffused passing through the coat, so the base layer's highlight cannot
    // be sharper than the coat's. Filament's own comment calls this a hack and it is -
    // the honest solve is a refracted lobe - but leaving it out is worse than the hack:
    // a sharp film over an unchanged matte base reads as a decal stuck on the surface
    // rather than a wet surface.
    //
    // Copied deliberately, hack and all, rather than invented. A shortcut that ships in
    // a renderer this widely used has been looked at by more eyes than mine.
    float base = max(s.perceptualRoughness, pr);
    s.perceptualRoughness = mix(s.perceptualRoughness, base, s.clearCoat);
    s.roughness = s.perceptualRoughness * s.perceptualRoughness;
}

// ⚠️ THE MULTI-SCATTER TERM, AND IT COSTS NOTHING NEW.
//
// `dfg` is the split-sum BRDF lookup this engine ALREADY builds for image-based
// lighting (IBLBRDF.frag → u_BRDFLUT). Its .y is the fraction of energy a
// single-scattering GGX keeps; the reciprocal is what it lost, and adding that back
// is the whole correction. So the thing that makes rough metal look like metal was
// one texture read away the entire time — the table was already on the GPU.
// ⚠️ AND IT IS CLAMPED, BECAUSE AN UNBOUND TABLE IS A WHITE SCREEN.
//
// Measured the moment this shipped: the material preview does not bind the BRDF LUT,
// so the lookup returned ~0, 1/dfg.y went to 10000, and a rough copper sphere
// rendered as a solid white disc. The material model was correct; a reciprocal with
// no floor was not.
//
// dfg.y is an energy fraction in (0,1], so the honest correction never exceeds about
// 4x even for a perfect mirror-conductor at maximum roughness. Past that the input is
// wrong, and a wrong input must produce a slightly wrong image - never a screen with
// no picture on it, which is indistinguishable from a crash.
void FZE_EnergyCompensation(inout FZESurface s, vec2 dfg) {
    // ⚠️ THE ENERGY IS dfg.x + dfg.y, NOT dfg.y.
    //
    // Filament reads a single channel here because its DFG table is parameterised its
    // own way. This engine's u_BRDFLUT is the classic split-sum (scale, bias) pair,
    // reconstructed as f0*scale + bias - so the energy a perfect reflector keeps is
    // the SUM, and only the sum.
    //
    // Copying the formula without checking what the table meant produced a rough
    // copper sphere as a solid white disc: the bias channel alone is near zero at high
    // roughness, so the reciprocal exploded. The maths was Filament's and correct; the
    // input was this engine's and different. A borrowed equation carries its
    // definitions with it, and they do not survive the trip on their own.
    float Ess = clamp(dfg.x + dfg.y, 0.25, 1.0);
    s.energyCompensation = 1.0 + s.f0 * (1.0 / Ess - 1.0);
}

//------------------------------------------------------------------------------
// Occlusion
//------------------------------------------------------------------------------
// ⚠️ REFLECTIONS DO NOT SEE THE SAME OCCLUSION THE DIFFUSE DOES.
//
// The classic bug is applying AO to diffuse and leaving reflections at full strength.
// This engine does not have it - it multiplies BOTH by the same `occ` - and that is
// the opposite error, not the absence of one:
//
//   diffuse gathers the WHOLE hemisphere, so a crevice occludes almost all of it.
//   a polished surface gathers ONE direction, and a narrow opening in front of it
//   barely occludes anything at all.
//
// Darkening a mirror by the diffuse occlusion turns every polished surface inside
// geometry into a dull grey patch - the wet floor under an arch, the car panel beside
// a wall - and it cannot be tuned away, because the AO is right and the surface it is
// being applied to is not.
//
// Lagarde and de Rousiers 2014, "Moving Frostbite to PBR": roughness-aware, so a
// mirror keeps its reflection and a rough surface is occluded nearly as much as the
// diffuse. It converges to the old behaviour at roughness 1, which is why nothing
// that already looked right changes.
// Light does not stop after one bounce inside a crevice, and single-scatter AO
// pretends it does. A white corner and a black corner get the same occlusion from
// the geometry, but the white one is measurably brighter in it, because the light
// that lands there bounces again off walls that return 90% of it. That is why AO
// on pale plaster always looks like dirt somebody airbrushed in.
//
// ⚠️ THIS TAKES THE ALBEDO, WHICH IS THE WHOLE POINT. The occlusion pass cannot
// apply it - it has depth and nothing else, and no idea what colour the surface
// it is darkening happens to be. It has to happen here, per surface, which is
// also why AO strength has always needed a different value per material and now
// does not.
//
// Jimenez et al. 2016, the same paper as the occlusion itself.
vec3 FZE_MultiBounceAO(float visibility, vec3 albedo) {
    vec3 a =  2.0404 * albedo - 0.3324;
    vec3 b = -4.7951 * albedo + 0.6417;
    vec3 c =  2.7552 * albedo + 0.6903;
    return clamp(max(vec3(visibility),
                     ((visibility * a + b) * visibility + c) * visibility),
                 0.0, 1.0);
}

float FZE_SpecularAO(float NoV, float visibility, float roughness) {
    return clamp(pow(NoV + visibility, exp2(-16.0 * roughness - 1.0)) - 1.0 + visibility,
                 0.0, 1.0);
}

// Make a surface translucent. `color` is what the light looks like AFTER passing
// through - a leaf turns sunlight yellow-green, skin turns it red - and it is not the
// surface's own colour, which is what it looks like in reflection.
void FZE_SetSubsurface(inout FZESurface s, float amount, float thickness,
                       vec3 color, float power) {
    s.subsurface = clamp(amount, 0.0, 1.0);
    s.thickness = clamp(thickness, 0.0, 1.0);
    s.subsurfaceColor = color;
    s.subsurfacePower = max(power, 1.0);
}

// `rotation` turns the frame about the normal, in turns (0..1), so a brushed pattern
// can run diagonally without the artist re-authoring the UVs.
void FZE_SetAnisotropy(inout FZESurface s, float amount, vec3 T, vec3 B, float rotation) {
    s.anisotropy = clamp(amount, -1.0, 1.0);
    if (abs(rotation) > 1e-4) {
        float a = rotation * 6.28318530718;
        float c = cos(a), sn = sin(a);
        vec3 t2 =  T * c + B * sn;
        vec3 b2 = -T * sn + B * c;
        T = t2; B = b2;
    }
    s.anisotropicT = T;
    s.anisotropicB = B;
}

//------------------------------------------------------------------------------
// The reflection vector for an anisotropic surface
//------------------------------------------------------------------------------
// ⚠️ ANISOTROPY WITHOUT THIS IS HALF A FEATURE, AND THE MISSING HALF IS THE VISIBLE ONE.
//
// The direct-light lobe was already stretched (D_GGX_Anisotropic), but the environment
// was still sampled down a perfect mirror, `reflect(-V, N)`. On brushed metal indoors
// that is most of what you see: the sun gives one long streak and the room gives a
// round highlight, on the same surface, at the same time. Nothing in the material is
// wrong, so nobody can tune it out.
//
// Filament's construction: build the normal of the plane containing the view and the
// anisotropy direction, then lean the shading normal toward it. The lean is scaled by
// roughness because a mirror has no lobe to stretch — a polished anisotropic surface
// really does reflect like a mirror, and bending it there would invent a smear.
vec3 FZE_AnisotropicReflection(const FZESurface s, vec3 N, vec3 V) {
    if (abs(s.anisotropy) < 0.001) return reflect(-V, N);
    vec3 dir  = s.anisotropy >= 0.0 ? s.anisotropicB : s.anisotropicT;
    vec3 tang = cross(dir, V);
    vec3 aniN = cross(tang, dir);
    float bend = abs(s.anisotropy) * clamp(5.0 * s.perceptualRoughness, 0.0, 1.0);
    return reflect(-V, normalize(mix(N, aniN, bend)));
}

//------------------------------------------------------------------------------
// One light
//------------------------------------------------------------------------------
// Returns the surface's response to `radiance` arriving from L. NoL is applied here
// because every caller wants it and half of them used to forget.
vec3 FZE_Shade(FZESurface s, vec3 N, vec3 V, vec3 L, vec3 radiance) {
    vec3 h = normalize(V + L);

    float NoV = max(dot(N, V), 1e-4);
    float NoL = clamp(dot(N, L), 0.0, 1.0);
    float NoH = clamp(dot(N, h), 0.0, 1.0);
    float LoH = clamp(dot(L, h), 0.0, 1.0);

    float D, Vis;
    if (abs(s.anisotropy) > 1e-3) {
        // ⚠️ TWO ROUGHNESSES, NOT ONE SCALED. at and ab are the roughness along
        // and across the brush; the floor stops the sharper of the two collapsing to a
        // point, which is a firefly rather than a highlight.
        float at = max(s.roughness * (1.0 + s.anisotropy), FZE_MIN_ROUGHNESS);
        float ab = max(s.roughness * (1.0 - s.anisotropy), FZE_MIN_ROUGHNESS);

        vec3 T = s.anisotropicT, B = s.anisotropicB;
        D   = D_GGX_Anisotropic(at, ab, dot(T, h), dot(B, h), NoH);
        Vis = V_SmithGGXCorrelated_Anisotropic(at, ab, dot(T, V), dot(B, V),
                                               dot(T, L), dot(B, L), NoV, NoL);
    } else {
        D   = D_GGX(s.roughness, NoH);
        Vis = V_SmithGGXCorrelated(s.roughness, NoV, NoL);
    }
    vec3  F = F_Schlick(s.f0, s.f90, LoH);

    vec3 Fr = (D * Vis) * F * s.energyCompensation;
    vec3 Fd = s.diffuseColor * Fd_Burley(s.roughness, NoV, NoL, LoH);

    // ⚠️ THE COAT TAKES ITS SHARE BEFORE ANYTHING REACHES THE SURFACE.
    //
    // Its Fresnel is fixed at 4% (water and varnish are both about IOR 1.5), and
    // whatever it reflects never reaches the layer below - so the base is attenuated
    // by exactly what the coat took. Without that the surface reflects MORE light than
    // arrives at it, and a wet rock ends up brighter than a dry one lit by the same
    // sun. That is the whole reason this is a layer and not a second highlight added
    // on top.
    if (s.clearCoat > 0.0) {
        float Dc  = D_GGX(s.clearCoatRoughness, NoH);
        float Vc  = V_Kelemen(LoH);
        float Fc  = F_Schlick1(0.04, 1.0, LoH) * s.clearCoat;
        Fr = Fr * (1.0 - Fc) + vec3(Dc * Vc * Fc);
        Fd *= (1.0 - Fc);
    }

    // ⚠️ NO kD = (1 - F). The old code multiplied diffuse by (1-F) to "conserve
    // energy", which double-counts: diffuseColor is already baseColor*(1-metallic),
    // and the Fresnel-weighted split is what the specular term's own F is doing.

    // ⚠️ TRANSMITTED LIGHT IS NOT MULTIPLIED BY NoL.
    //
    // That is the whole point: NoL is how much of the light hits THIS face, and the
    // light being modelled here hit the OTHER one. Folding NoL in would switch the
    // effect off exactly where it exists - at the silhouette of a backlit leaf.
    //
    // Filament's terms: a forward-scatter lobe about the light's own direction (the
    // bright rim when you look towards the sun through a leaf) mixed with a broad
    // back-scatter that survives at any angle, both scaled by how thin the surface is.
    if (s.subsurface > 0.0) {
        float scatterVoH = clamp(dot(V, -L), 0.0, 1.0);
        float forward = exp2(scatterVoH * s.subsurfacePower - s.subsurfacePower);
        float back = clamp(NoL * s.thickness + (1.0 - s.thickness), 0.0, 1.0) * 0.5;
        float through = mix(back, 1.0, forward) * (1.0 - s.thickness);
        vec3  trans = s.subsurfaceColor * (through * Fd_Lambert()) * s.subsurface;
        return trans * radiance + (Fd + Fr) * radiance * NoL;
    }

    return (Fd + Fr) * radiance * NoL;
}

// =============================================================================
//  THE OTHER WAYS TO TURN LIGHT INTO COLOUR (Renderer/Material.h ShadingModel)
//
//  ⚠️ STANDARD IS NOT THE ONLY RIGHT ANSWER. A physically based surface is what a
//  photograph shows; an anime frame, a cartoon and a painted game are drawn by
//  other rules on purpose - the light in flat bands, the shaded side a COLOUR
//  rather than darkness, a highlight with an edge. Those rules live here, beside
//  the standard model, and take the same light: the sun in lux, the lamps in
//  candela, the same shadows. A toon character stands in the same scene, under
//  the same sun, as a photographic rock.
//
//  `visibility` is the shadow (the sun's cascades and clouds, a lamp's map):
//  Standard multiplies the light by it; these fold it into the band, so a cast
//  shadow is the same shade colour as the side turned away - which is what makes
//  cel shading read as drawn rather than as lit.
// =============================================================================

// The shading model and its settings, on a surface built by FZE_Surface.
// shadeTint is LINEAR. baseColor is the base colour before metallic split it.
void FZE_SetShading(inout FZESurface s, int model, float bands, float softness, vec3 shadeTint,
                    float specSize, float rim, float wrap, vec3 baseColor, float metallic) {
    s.model = model;
    s.toonBands = clamp(bands, 1.0, 4.0);
    s.toonSoftness = clamp(softness, 0.0, 0.5);
    s.shadeTint = max(shadeTint, vec3(0.0));
    s.toonSpecSize = clamp(specSize, 0.0, 1.0);
    // White on paint and skin, the metal's own colour on metal.
    s.toonSpecColor = mix(vec3(0.7), baseColor, metallic);
    // ⚠️ A TOON METAL STILL HAS A COLOUR. The standard split leaves a metal no
    // diffuse at all - its colour is in its reflections - and a flat-shaded
    // style has no reflections worth the name, so a gold ring would draw black.
    s.toonBase = baseColor * mix(1.0, 0.6, metallic);
    s.rim = max(rim, 0.0);
    s.wrap = clamp(wrap, 0.0, 1.0);
}

void FZE_CopyShading(inout FZESurface d, FZESurface s) {
    d.model = s.model; d.toonBands = s.toonBands; d.toonSoftness = s.toonSoftness;
    d.shadeTint = s.shadeTint; d.toonSpecSize = s.toonSpecSize; d.toonSpecColor = s.toonSpecColor;
    d.toonBase = s.toonBase; d.rim = s.rim; d.wrap = s.wrap;
}

// The light in bands: x is cos(N, L). One band is two tones (lit and shaded,
// the edge at the terminator); more bands step down from the light. softness
// is the width of each edge as a fraction of a band.
float FZE_ToonBand(float x, float bands, float softness) {
    float q = clamp(x, -1.0, 1.0) * bands + 0.5;
    float e = smoothstep(0.5 - softness - 1e-4, 0.5 + softness + 1e-4, fract(q));
    return clamp((floor(q) + e) / bands, 0.0, 1.0);
}

// The bright edge towards the light - a drawn outline of light, not a Fresnel.
float FZE_Rim(FZESurface s, float NoV, float NoL, float edge) {
    if (s.rim <= 0.0) return 0.0;
    return s.rim * smoothstep(0.58 - edge, 0.62 + edge, 1.0 - NoV) * smoothstep(-0.1, 0.35, NoL);
}

vec3 FZE_ShadeToon(FZESurface s, vec3 N, vec3 V, vec3 L, vec3 radiance, float visibility) {
    float NoL = dot(N, L);
    float w = s.toonSoftness;
    // The shadow's edge as hard as the bands' - a soft-filtered cascade under a
    // razor terminator reads as a smudge.
    float vis = smoothstep(0.5 - w - 1e-3, 0.5 + w + 1e-3, visibility);
    float lit = FZE_ToonBand(NoL, s.toonBands, w) * vis;
    // ⚠️ NOT TIMES NoL. A flat-shaded surface is as bright across its whole lit
    // side; the bands are the only gradient there is.
    vec3 c = s.toonBase * mix(s.shadeTint, vec3(1.0), lit);
    if (s.toonSpecSize > 0.0) {
        float NoH = clamp(dot(N, normalize(V + L)), 0.0, 1.0);
        float cut = cos(radians(mix(2.0, 24.0, s.toonSpecSize)));
        float e = (1.0 - cut) * (0.15 + w);
        c += s.toonSpecColor * smoothstep(cut - e, cut + e, NoH) * lit;
    }
    c += (s.toonBase + vec3(0.25)) * FZE_Rim(s, clamp(dot(N, V), 0.0, 1.0), NoL, w) * vis;
    return c * radiance * (1.0 / FZE_PI);
}

vec3 FZE_ShadeStylized(FZESurface s, vec3 N, vec3 V, vec3 L, vec3 radiance, float visibility) {
    float NoL = dot(N, L);
    // Light that reaches past the terminator, and a soft S into the shade -
    // the form reads as painted rather than lit by a point.
    float wr = clamp((NoL + s.wrap) / (1.0 + s.wrap), 0.0, 1.0);
    float lit = wr * wr * (3.0 - 2.0 * wr) * visibility;
    vec3 c = s.diffuseColor * mix(s.shadeTint, vec3(1.0), lit) * (1.0 / FZE_PI);
    // The highlight is the standard one: stylized is a softer read of the same
    // material, not a different one.
    vec3 h = normalize(V + L);
    float NoV = max(dot(N, V), 1e-4);
    float cl = clamp(NoL, 0.0, 1.0);
    vec3 Fr = D_GGX(s.roughness, clamp(dot(N, h), 0.0, 1.0)) * V_SmithGGXCorrelated(s.roughness, NoV, cl)
                  * F_Schlick(s.f0, s.f90, clamp(dot(L, h), 0.0, 1.0)) * s.energyCompensation;
    c += Fr * cl * visibility;
    c += (s.diffuseColor + vec3(0.15)) * FZE_Rim(s, clamp(NoV, 0.0, 1.0), NoL, 0.12) * visibility * (1.0 / FZE_PI);
    return c * radiance;
}

// One light on one surface, by its shading model.
vec3 FZE_ShadeLight(FZESurface s, vec3 N, vec3 V, vec3 L, vec3 radiance, float visibility) {
    if (s.model == 1) return FZE_ShadeToon(s, N, V, L, radiance, visibility);
    if (s.model == 2) return FZE_ShadeStylized(s, N, V, L, radiance, visibility);
    return FZE_Shade(s, N, V, L, radiance) * visibility;
}

#endif
