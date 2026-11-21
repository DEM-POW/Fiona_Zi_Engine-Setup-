#version 460 core

// Split-sum BRDF integration LUT (environment-independent, baked once).
// x axis = NdotV, y axis = roughness. Output RG = scale/bias for F0.

in vec2 v_UV;
out vec2 FragColor;

// ⚠️ THE LUT MUST BE BAKED WITH THE SAME VISIBILITY THE SHADING USES.
//
// This file carried its OWN Smith term - the k = alpha^2/2 approximation - while
// Lit/Terrain/Foliage shade with V_SmithGGXCorrelated out of lib/Material.glsl. The
// split-sum approximation reconstructs the BRDF it was integrated from, so baking one
// and shading with another means the environment response is not the response the
// direct lights give. Two lobes on one surface, and no artist can tune it out because
// nothing in the material is wrong.
//
// It was the third and last private copy of this maths in the engine.
#include "lib/Material.glsl"

const float PI = 3.14159265359;   // used by the Hammersley/GGX sampling below


float RadicalInverse_VdC(uint bits) {
    bits = (bits << 16u) | (bits >> 16u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
    bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    return float(bits) * 2.3283064365386963e-10;
}
vec2 Hammersley(uint i, uint n) { return vec2(float(i) / float(n), RadicalInverse_VdC(i)); }

vec3 ImportanceSampleGGX(vec2 Xi, vec3 N, float roughness) {
    float a = roughness * roughness;
    float phi = 2.0 * PI * Xi.x;
    float cosT = sqrt((1.0 - Xi.y) / (1.0 + (a * a - 1.0) * Xi.y));
    float sinT = sqrt(1.0 - cosT * cosT);
    vec3 H = vec3(cos(phi) * sinT, sin(phi) * sinT, cosT);
    vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    vec3 tangent = normalize(cross(up, N));
    vec3 bitangent = cross(N, tangent);
    return normalize(tangent * H.x + bitangent * H.y + N * H.z);
}


void main() {
    float NdotV = max(v_UV.x, 0.001);
    float roughness = v_UV.y;
    vec3 V = vec3(sqrt(1.0 - NdotV * NdotV), 0.0, NdotV);
    vec3 N = vec3(0.0, 0.0, 1.0);

    float A = 0.0, B = 0.0;
    const uint SAMPLES = 512u;
    for (uint i = 0u; i < SAMPLES; ++i) {
        vec2 Xi = Hammersley(i, SAMPLES);
        vec3 H = ImportanceSampleGGX(Xi, N, roughness);
        vec3 L = normalize(2.0 * dot(V, H) * H - V);
        float NdotL = max(L.z, 0.0);
        float NdotH = max(H.z, 0.0);
        float VdotH = max(dot(V, H), 0.0);
        if (NdotL > 0.0) {
            // DERIVED, not copied. GGX importance sampling of H gives
            // pdf(L) = D * NoH / (4 * VoH), so the Monte Carlo weight of
            // f_r * NoL is 4 * V * NoL * VoH / NoH. (The old form, G * VoH /
            // (NoV * NoH), is the same expression written with G instead of the
            // visibility V = G / (4 NoL NoV) - identical algebra, different term.)
            float Vis = V_SmithGGXCorrelated(roughness, NdotV, NdotL);
            float w   = 4.0 * Vis * NdotL * VdotH / max(NdotH, 1e-5);
            float Fc  = pow(1.0 - VdotH, 5.0);
            A += (1.0 - Fc) * w;
            B += Fc * w;
        }
    }
    FragColor = vec2(A, B) / float(SAMPLES);
}
