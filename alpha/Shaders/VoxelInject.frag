#version 460 core

// ============================================================================
//  WRITING THE LIT SCENE INTO A BOX OF VOXELS
//
//  This is the first half of voxel cone tracing: before anything can ask "what
//  light is bouncing towards me from over there", the scene has to be recorded
//  somewhere that can be asked cheaply from any point, in any direction. A 3D
//  texture is that somewhere, and what goes into each cell is the light LEAVING
//  the surface in that cell - albedo times the direct light on it.
//
//  ⚠️ THREE PASSES ALONG THREE AXES, NOT A GEOMETRY SHADER. The standard trick
//  is one pass with a geometry shader that picks each triangle's dominant axis,
//  because rasterising a wall from the side gives it almost no pixels and it
//  drops out of the volume. This engine's Shader class has no geometry stage,
//  and adding one to voxelise would be a new stage in the pipeline for one pass.
//  Rendering three times along X, Y and Z costs three times almost nothing -
//  the viewport is 64x64 and there is no depth test, no blending and no output
//  attachment - and every surface is well covered by at least one of them.
//
//  ⚠️ AND IT DOES NOT RUN EVERY FRAME. Voxelising is the expensive half; the
//  scenes this engine builds are mostly static, so the volume is rebuilt on a
//  timer and when the scene changes. A GI that costs nothing on a still frame is
//  the difference between shippable and a demo.
// ============================================================================

in vec3 v_WorldPos;
in vec3 v_Normal;

layout(rgba16f, binding = 0) uniform writeonly image3D u_Voxels;   // pre-exposed radiance, not a colour in 0..1

uniform vec3  u_VolumeMin;      // world box the volume covers
uniform vec3  u_VolumeSize;
uniform int   u_Dim;            // cells per side

uniform vec3  u_Albedo;
uniform vec3  u_Emissive;
uniform float u_EmissiveStrength;   // nits
uniform float u_PreExposure;

// The sun, and its shadow, so a voxel in shade is dark - which is what makes a
// bounce come FROM the lit side of a room and not from everywhere at once.
uniform vec3  u_SunDir;         // towards the sun
uniform vec3  u_SunColor;       // already multiplied by intensity
uniform vec3  u_Ambient;

// The lamps: THE SAME BUFFER THE LIT PASS READS (lib/Lights.glsl), bound by
// Renderer::BindLightArray. Every one of them, not a cluster's: the volume is
// the world, not the view, and a lamp behind the camera still lights a wall.
#include "lib/Lights.glsl"

// The lamps' shadows: one atlas, FZE_LampShadow (lib/Lights.glsl).

#include "lib/Shadows.glsl"

float SunShadow(vec3 P) { return SunShadowTap(P); }


// Everything the lamps put on this surface. Diffuse only: what a cone trace
// gathers is the light leaving a surface in every direction, and a specular
// highlight leaves in one - putting it in the volume would smear a mirror
// reflection over the whole room.
vec3 LampLight(vec3 P, vec3 N) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < u_LightCount; ++i) {
        vec3 L; float dist;
        float atten = FZE_LightAt(i, P, L, dist);
        float ndl = max(dot(N, L), 0.0);
        if (ndl <= 0.0 || atten <= 0.0) continue;
        atten *= FZE_LampShadow(i, P, N, false);
        sum += fzeLights[i].Intensity.rgb * (ndl * atten);
    }
    return sum;
}

void main() {
    vec3 t = (v_WorldPos - u_VolumeMin) / max(u_VolumeSize, vec3(1e-4));
    if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) return;

    ivec3 cell = ivec3(t * float(u_Dim));
    cell = clamp(cell, ivec3(0), ivec3(u_Dim - 1));

    vec3 N = normalize(v_Normal);
    float ndl = max(dot(N, normalize(u_SunDir)), 0.0);
    vec3 direct = u_SunColor * (ndl * SunShadow(v_WorldPos));

    // ⚠️ WHAT IS STORED IS WHAT LEAVES THE SURFACE, not what arrives at it. A
    // cone trace samples this volume and adds the result as incoming light, so a
    // cell holding irradiance would count the albedo twice - once here and once
    // where the cone's result is multiplied by the receiver's own colour.
    // ⚠️ LINEARISED, LIKE THE LIT PASS. u_Albedo is a picked sRGB colour and
    // Lit.frag raises it to 2.2 before using it; injecting the raw value made
    // every bounce lighter and less saturated than the surface it came from,
    // which is the difference between a red wall tinting a room and a pink one
    // washing it.
    vec3 albedo = pow(max(u_Albedo, 0.0), vec3(2.2));
    vec3 lamps = LampLight(v_WorldPos, N);
    vec3 outgoing = albedo * (direct + lamps + u_Ambient)
                  + pow(max(u_Emissive, 0.0), vec3(2.2)) * u_EmissiveStrength * u_PreExposure;

    imageStore(u_Voxels, cell, vec4(outgoing, 1.0));
}
