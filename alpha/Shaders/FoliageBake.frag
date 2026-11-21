#version 460 core
// =============================================================================
//  ONE PICTURE OF A TREE: its colour and shape, and its normal, depth and height
//  (lib/TreePicture.glsl). The colour is the material's factor times its map, as
//  stored (sRGB): the lit pass decodes it as it decodes the leaves' own map.
// =============================================================================
#include "lib/TreePicture.glsl"

in vec3  v_Normal;
in vec3  v_Pos;
in vec2  v_UV;
in float v_Height01;
in float v_Depth;
flat in vec3 v_D;

layout(location = 0) out vec4 o_Albedo;
layout(location = 1) out vec4 o_Normal;

uniform sampler2D u_AlbedoMap;
uniform int   u_HasAlbedo;
uniform vec3  u_BaseColor;
uniform float u_AlphaCutoff;
uniform sampler2D u_NormalMap;
uniform int   u_HasNormal;

// The leaf's normal map in the frame its UVs make on the card (as Foliage.frag does it).
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
    vec4 tex = u_HasAlbedo == 1 ? texture(u_AlbedoMap, v_UV) : vec4(1.0);
    // The leaves keep their coverage at the small size a picture takes them at (FoliageDepth.frag).
    if (u_HasAlbedo == 1) tex.a *= 1.0 + max(textureQueryLod(u_AlbedoMap, v_UV).x, 0.0) * 0.25;
    if (u_AlphaCutoff > 0.0 && tex.a < u_AlphaCutoff) discard;
    vec3 n = normalize(v_Normal);
    if (dot(n, v_D) < 0.0) n = -n;      // a leaf card shows its face to whoever looks
    if (u_HasNormal == 1) {
        vec3 t = texture(u_NormalMap, v_UV).xyz * 2.0 - 1.0;
        n = normalize(Cotangent(n, v_Pos, v_UV) * t);
    }
    o_Albedo = vec4(clamp(u_BaseColor, 0.0, 1.0) * tex.rgb, 1.0);
    o_Normal = vec4(FZE_PicPackNormal(n), v_Depth * 0.5 + 0.5, v_Height01);
}
