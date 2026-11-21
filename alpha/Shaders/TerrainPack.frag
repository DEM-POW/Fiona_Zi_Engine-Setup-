#version 460 core

// =============================================================================
//  ONE TERRAIN LAYER'S MATERIAL, PACKED INTO TWO ARRAY SLICES.
//
//  A material from the library can bring six maps. Four layers of six would be
//  twenty-four samplers on top of the sixteen the lit pass already binds, on a
//  GPU that has thirty-two. So each layer is baked once - when it is assigned,
//  not per frame - into one slice of two texture arrays, and the ground reads
//  every layer through two samplers:
//
//    albedo slice: rgb the colour as authored (texture x base colour, still
//                  sRGB-encoded, decoded by the terrain exactly as Lit.frag
//                  decodes a mesh's), a the height map (0.5 without one)
//    detail slice: rg the tangent-space normal (strength and DirectX flip
//                  already applied), b roughness, a ambient occlusion
// =============================================================================

in vec2 v_UV;
layout(location = 0) out vec4 o_Albedo;
layout(location = 1) out vec4 o_Detail;

uniform sampler2D u_AlbedoMap;     uniform int u_HasAlbedo;
uniform sampler2D u_NormalMap;     uniform int u_HasNormal;
uniform sampler2D u_RoughnessMap;  uniform int u_HasRoughness;
uniform sampler2D u_MetalRoughMap; uniform int u_HasMetalRough;
uniform sampler2D u_AOMap;         uniform int u_HasAO;
uniform sampler2D u_HeightMap;     uniform int u_HasHeight;

uniform vec3  u_BaseColor;         // as picked (sRGB)
uniform float u_Roughness;
uniform float u_AOStrength;
uniform float u_NormalStrength;
uniform int   u_NormalFlipY;

void main() {
    vec3 colour = u_BaseColor;
    if (u_HasAlbedo == 1) colour *= texture(u_AlbedoMap, v_UV).rgb;
    float height = u_HasHeight == 1 ? texture(u_HeightMap, v_UV).r : 0.5;

    vec2 n = vec2(0.0);
    if (u_HasNormal == 1) {
        vec3 tn = texture(u_NormalMap, v_UV).rgb;
        if (u_NormalFlipY == 1) tn.g = 1.0 - tn.g;
        n = (tn.xy * 2.0 - 1.0) * u_NormalStrength;
        float l = length(n);
        if (l > 0.98) n *= 0.98 / l;           // stays a unit normal's slope
    }

    // The same rules as Lit.frag: a standalone roughness map wins over the
    // packed glTF one, and both multiply the slider.
    float rough = u_Roughness;
    if (u_HasMetalRough == 1) rough = u_Roughness * texture(u_MetalRoughMap, v_UV).g;
    if (u_HasRoughness == 1)  rough = u_Roughness * texture(u_RoughnessMap, v_UV).r;
    float ao = u_HasAO == 1 ? mix(1.0, texture(u_AOMap, v_UV).r, clamp(u_AOStrength, 0.0, 1.0)) : 1.0;

    o_Albedo = vec4(clamp(colour, 0.0, 1.0), height);
    o_Detail = vec4(n * 0.5 + 0.5, clamp(rough, 0.04, 1.0), ao);
}
