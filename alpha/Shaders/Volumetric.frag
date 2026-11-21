#version 460 core

// ============================================================================
//  LIGHT YOU CAN SEE IN THE AIR
//
//  Everything else in this renderer answers "how much light reaches this
//  SURFACE". This pass answers the other question: how much light reaches the
//  eye from the air BETWEEN the eye and that surface. It is the visible cone
//  under a lamp, the shaft through a hole in a cave roof, the halo around a
//  street light in mist - the two reference images Nabras sent are both mostly
//  this effect, and the engine had none of it.
//
//  ⚠️ THE MEDIUM IS THE FOG THAT ALREADY EXISTS. There is no second density
//  here. A beam is light bouncing off SOMETHING, so in perfectly clear air
//  there is nothing to see and this pass is skipped entirely by the caller.
//  Adding a "volumetric density" beside the fog density would be two controls
//  for one physical fact, and they would disagree the first time anyone touched
//  either - the engine has been bitten by exactly that twice (the cloud/weather
//  split, the sun's dead Environment fields).
//
//  ⚠️ AND THE MARCH IS DITHERED, NOT SMOOTH. Twenty-four steps across fifty
//  metres puts a sample every two metres, and a shadow edge crossing that grid
//  produces banded slices - the classic "venetian blind" volumetric. Offsetting
//  each pixel's start by a per-pixel fraction of a step turns those bands into
//  fine noise, which the blur afterwards resolves into the smooth gradient the
//  bands were pretending to be. It is the same trade as any dither: trading a
//  structured error nobody can unsee for an unstructured one nobody notices.
// ============================================================================

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Depth;          // the scene's depth buffer
uniform mat4  u_InvViewProj;
uniform vec3  u_CameraPos;
uniform float u_Time;

// The medium, from the scene's fog.
uniform vec3  u_FogColor;
uniform float u_FogDensity;         // extinction per metre at the base height
uniform float u_FogHeightFalloff;   // metres for 1/e; 0 = a uniform slab
uniform float u_FogBaseHeight;

// The sun.
uniform vec3  u_SunDir;             // TOWARDS the sun
uniform vec3  u_SunColor;           // already multiplied by intensity
uniform float u_SunVolumetric;      // 0 = the sun contributes no shafts

// Local lights - THE SAME BUFFER THE LIT PASS READS (lib/Lights.glsl), so
// there is one description of a light in this renderer and not three.
#include "lib/Lights.glsl"

// The lamps' shadows: one atlas, FZE_LampShadow (lib/Lights.glsl).

// The sun's cascades.
// ⚠️ u_ShadowMap, NOT u_ShadowMaps. BindDirectionalShadows sets that name, and a
// sampler nobody binds reads texture unit 0 - which in this pass is the DEPTH
// buffer. Sampling a depth texture through a shadow sampler returned zero for
// every point in the air, so every sample came back fully shadowed and the whole
// buffer was black. The pass ran, the maths was right, and one letter meant it
// could never produce anything.
#include "lib/Shadows.glsl"

uniform int   u_Steps;              // how many samples along the ray
uniform float u_MaxDistance;        // stop marching here (metres)
uniform float u_Scattering;         // Henyey-Greenstein g, forward bias

// ---------------------------------------------------------------------------

// Interleaved gradient noise: one multiply-add and a fract, and its pattern is
// finer and less structured than a Bayer matrix at the same cost.
float IGN(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// Henyey-Greenstein. g = 0 scatters evenly, g -> 1 throws light forward, which
// is why a beam is brightest when you look almost into it.
float Phase(float cosT, float g) {
    float g2 = g * g;
    float d = 1.0 + g2 - 2.0 * g * cosT;
    return (1.0 - g2) / (4.0 * 3.14159265 * max(pow(d, 1.5), 1e-4));
}

// Density of the medium at a height, matching lib/Fog.glsl's model so the beams
// live in the same air the surfaces are fogged by.
float Density(vec3 p) {
    if (u_FogHeightFalloff <= 0.0) return u_FogDensity;
    return u_FogDensity * exp(-max(p.y - u_FogBaseHeight, 0.0) / u_FogHeightFalloff);
}

float SunShadowAt(vec3 P) {
    // ⚠️ ONE TAP, NOT A FILTER. This is asked 24 times per pixel; the softness of a
    // shaft's edge comes from the march's own dither and the blur after it.
    return SunShadowTap(P);
}


void main() {
    // The ray for this pixel, from the camera through the far plane.
    vec4 farH = u_InvViewProj * vec4(v_UV * 2.0 - 1.0, 1.0, 1.0);
    vec3 farP = farH.xyz / farH.w;
    vec3 dir  = normalize(farP - u_CameraPos);

    // How far to march: to the surface behind this pixel, or the cap.
    //
    // ⚠️ THE SURFACE IS UNPROJECTED, NOT LINEARISED. Turning a depth value back
    // into metres needs the near and far planes, which means a second copy of
    // numbers the projection matrix already holds - and the day a camera changes
    // its near plane the beams would quietly be measured against the old one.
    // Running the depth through the SAME inverse view-projection the ray came
    // from gives the world point directly, and the distance is then just a
    // length. Nothing to keep in step.
    float depth = texture(u_Depth, v_UV).r;
    float travel = u_MaxDistance;
    if (depth < 1.0) {
        vec4 hitH = u_InvViewProj * vec4(v_UV * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        travel = min(u_MaxDistance, length(hitH.xyz / hitH.w - u_CameraPos));
    }
    if (travel <= 0.01 || u_FogDensity <= 0.0) { FragColor = vec4(0.0); return; }

    float steps = float(max(u_Steps, 1));
    float dt = travel / steps;

    // The dither: a per-pixel fraction of one step, so no two neighbouring
    // pixels sample the same planes.
    float jitter = IGN(gl_FragCoord.xy + fract(u_Time) * 64.0);

    vec3 inscatter = vec3(0.0);
    float transmittance = 1.0;

    for (int i = 0; i < u_Steps; ++i) {
        float t = (float(i) + jitter) * dt;
        vec3 P = u_CameraPos + dir * t;

        float dens = Density(P);
        if (dens <= 0.0) continue;
        float sigma = dens * dt;

        vec3 lit = vec3(0.0);

        // ---- the sun ----
        if (u_SunVolumetric > 0.0) {
            float sh = SunShadowAt(P);
            if (sh > 0.0) {
                float ph = Phase(dot(dir, u_SunDir), u_Scattering);
                lit += u_SunColor * (sh * ph * u_SunVolumetric);
            }
        }

        // ---- local lights ----
        for (int k = 0; k < u_LightCount; ++k) {
            float vol = fzeLights[k].Extra.y;
            if (vol <= 0.0) continue;
            vec3 toL; float dist; float cosT;
            float atten = FZE_LightAt(k, P, toL, dist);
            if (atten <= 0.0) continue;

            // ⚠️ THE SHADOW IS WHAT MAKES A BEAM A BEAM. Without it a lamp fills
            // its whole sphere with an even glow and a spot lights the air behind
            // the wall it is pointed at. The shape of a shaft IS the shape of the
            // hole the light came through.
            // No surface here: the offset is taken towards the light, which is
            // all a bias in the air has to do (keep a point just outside a wall
            // from reading as inside it). One tap - the march's dither and the
            // blur after it are the filter.
            atten *= FZE_LampShadow(k, P, toL, false);
            if (atten <= 0.0) continue;

            cosT = dot(dir, toL);
            lit += fzeLights[k].Intensity.rgb * (atten * Phase(cosT, u_Scattering) * vol);
        }

        // Beer-Lambert along the way: light gathered far off is dimmed by the
        // air in front of it, and the whole integral stops mattering once the
        // medium has closed up.
        inscatter += lit * u_FogColor * sigma * transmittance;
        transmittance *= exp(-sigma);
        if (transmittance < 0.01) break;
    }

    FragColor = vec4(max(inscatter, 0.0), 1.0);
}
