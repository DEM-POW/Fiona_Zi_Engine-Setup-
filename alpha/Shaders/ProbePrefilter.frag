#version 460 core

// =============================================================================
//  REFLECTION PROBE PREFILTER.
//
//  Identical to IBLPrefilter except for one line: the radiance comes from a
//  CAPTURED cubemap rather than the analytic sky. That is the whole difference
//  between "this metal reflects the sky" and "this metal reflects the room it is
//  standing in".
//
//  ⚠️ SAMPLED AT MIP 0 OF THE SOURCE, DELIBERATELY. Letting the hardware pick a
//  mip inside an importance-sampled loop makes the result depend on screen-space
//  derivatives that do not exist here — every texel would blur by a different,
//  meaningless amount.
// =============================================================================

in vec2 v_UV;
out vec4 FragColor;

uniform vec3  u_FaceFwd, u_FaceRight, u_FaceUp;
uniform float u_Roughness;
uniform samplerCube u_Source;

const float PI = 3.14159265359;

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
    vec2 c = v_UV * 2.0 - 1.0;
    vec3 N = normalize(u_FaceFwd + c.x * u_FaceRight + c.y * u_FaceUp);
    vec3 R = N, V = N;

    const uint SAMPLES = 128u;
    vec3 color = vec3(0.0);
    float weight = 0.0;
    for (uint i = 0u; i < SAMPLES; ++i) {
        vec2 Xi = Hammersley(i, SAMPLES);
        vec3 H = ImportanceSampleGGX(Xi, N, u_Roughness);
        vec3 L = normalize(2.0 * dot(V, H) * H - V);
        float NdotL = max(dot(N, L), 0.0);
        if (NdotL > 0.0) {
            color += textureLod(u_Source, L, 0.0).rgb * NdotL;
            weight += NdotL;
        }
    }
    FragColor = vec4(color / max(weight, 0.001), 1.0);
}
