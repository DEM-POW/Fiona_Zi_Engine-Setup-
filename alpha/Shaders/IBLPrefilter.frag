#version 460 core

// Specular IBL prefilter: for a given roughness (one mip level), GGX importance-
// sample the captured sky around the reflection direction (assuming V = R = N).

in vec2 v_UV;
out vec4 FragColor;

uniform vec3  u_FaceFwd, u_FaceRight, u_FaceUp;
uniform float u_Roughness;

// ⚠️ THE SKY CAPTURED ONCE (IBLCapture.frag), NOT EVALUATED PER SAMPLE. And
// read with FILTERED importance sampling (Krivanek & Colbert, GPU Gems 3 ch.
// 20; what Unreal's and Filament's prefilters do): each sample reads the mip
// whose texel is the size of the lobe it stands for, so 32 samples give the
// smooth answer 128 point samples were noisily approaching - at the cost of
// texture reads instead of atmosphere evaluations.
uniform samplerCube u_SkyCube;
uniform float u_SkyCubeSize;    // texels on a face of its mip 0
uniform float u_SkyCubeMaxLod;

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

float D_GGX(float NdotH, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

void main() {
    vec2 c = v_UV * 2.0 - 1.0;
    vec3 N = normalize(u_FaceFwd + c.x * u_FaceRight + c.y * u_FaceUp);
    vec3 R = N, V = N;

    // A mirror reflects the sky itself.
    if (u_Roughness <= 0.0) {
        FragColor = vec4(textureLod(u_SkyCube, N, 0.0).rgb, 1.0);
        return;
    }

    const uint SAMPLES = 32u;
    float saTexel = 4.0 * PI / (6.0 * u_SkyCubeSize * u_SkyCubeSize);
    vec3 color = vec3(0.0);
    float weight = 0.0;
    for (uint i = 0u; i < SAMPLES; ++i) {
        vec2 Xi = Hammersley(i, SAMPLES);
        vec3 H = ImportanceSampleGGX(Xi, N, u_Roughness);
        vec3 L = normalize(2.0 * dot(V, H) * H - V);
        float NdotL = max(dot(N, L), 0.0);
        if (NdotL > 0.0) {
            // V = N, so N.H = V.H and the pdf of L is D / 4.
            float NdotH = max(dot(N, H), 0.0);
            float pdf = D_GGX(NdotH, u_Roughness) * 0.25;
            float saSample = 1.0 / (float(SAMPLES) * pdf + 1e-4);
            float lod = clamp(0.5 * log2(saSample / saTexel) + 1.0, 0.0, u_SkyCubeMaxLod);
            color += textureLod(u_SkyCube, L, lod).rgb * NdotL;
            weight += NdotL;
        }
    }
    FragColor = vec4(color / max(weight, 0.001), 1.0);
}
