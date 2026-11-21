#version 460 core

// ============================================================================
//  AERIAL PERSPECTIVE — the air between you and everything else.
//
//  ⚠️ THIS IS THE HALF OF AN ATMOSPHERE THAT IS NOT THE SKY, AND IT IS THE HALF
//  THAT MAKES A LANDSCAPE READ AS BIG. A physically correct sky over a valley
//  whose far wall is as saturated and as contrasty as the near one still looks
//  like a diorama, because the eye judges distance almost entirely from how much
//  air it is looking through. Twelve kilometres of air is not a grey veil: it
//  scatters its own blue INTO the view and takes the object's own colour OUT of
//  it, in different amounts per wavelength, which is why distant mountains go
//  blue rather than merely pale.
//
//  ⚠️ AND IT IS A VOLUME, NOT A DISTANCE FADE. A fog function of distance cannot
//  know that the air between you and the mountain is lit by a sun that is low
//  and red, or that the shadow of a nearer ridge is falling across it. This
//  marches the same scattering integral the sky uses, from the camera out to
//  each of sixteen depths, and stores what it finds - so the haze is lit by the
//  same sun as everything else and turns gold at the same moment the sky does.
//
//  32 x 32 x 16 froxels: coarse on purpose. Aerial perspective has no detail in
//  it - it is the smoothest thing in the frame - so the entire volume is 16k
//  texels and rebuilding it every frame costs less than reading it would if it
//  were any bigger.
//
//  TWO TARGETS, because both halves of the answer are needed and they are not
//  the same colour:
//     0  the light the air ADDS   (in-scattered, RGB)
//     1  the light the air LEAVES (transmittance, RGB, per channel)
//  Packing the second into one alpha channel - the usual shortcut - throws away
//  exactly the wavelength dependence that makes the far hills blue.
// ============================================================================

in vec2 v_UV;
layout(location = 0) out vec4 OutScatter;
layout(location = 1) out vec4 OutTransmittance;

uniform sampler2D u_TransmittanceLUT;
uniform sampler2D u_MultiScatterLUT;

uniform mat4  u_InvViewProj;
uniform vec3  u_CameraPos;         // world space, engine units
uniform vec3  u_SunDir;            // toward the sun
uniform vec3  u_SunIlluminance;
uniform float u_ViewHeight;        // km from the planet centre
uniform float u_MetresPerUnit;
uniform float u_MaxDistanceKm;     // the far end of the volume
uniform int   u_SliceCount;
uniform int   u_Slice;             // which one this draw is filling
uniform int   u_Steps;

#include "lib/AtmosphereUniforms.glsl"

void main()
{
    FZEAtmosphere atmo = FZE_AtmosphereFromUniforms();

    // The view ray for this froxel column, from the screen.
    vec4 world = u_InvViewProj * vec4(v_UV * 2.0 - 1.0, 1.0, 1.0);
    world /= world.w;
    vec3 dir = normalize(world.xyz - u_CameraPos);

    // ⚠️ SLICES ARE SPACED BY THE SQUARE, NOT EVENLY. Aerial perspective changes
    // fastest in the first few hundred metres and barely at all in the last few
    // kilometres; sixteen evenly spaced slices put fifteen of them where nothing
    // is happening and leave the near field, which is the part a player walks
    // through, to a single one.
    float t = (float(u_Slice) + 1.0) / float(u_SliceCount);
    float distKm = u_MaxDistanceKm * t * t;

    // Into the atmosphere's frame: the planet's centre is below the camera, and
    // the sun sits in the +X half of the XY plane the way the tables expect.
    float viewHeight = max(u_ViewHeight, atmo.BottomRadius + 1e-4);
    vec3 pos = vec3(0.0, viewHeight, 0.0);

    // The view direction has to be expressed relative to the local up, which is
    // +Y in the engine and +Y here, so only the azimuth needs rebuilding: the
    // sun goes to +X and the ray keeps its angle to it.
    float cosSunZenith = clamp(u_SunDir.y, -1.0, 1.0);
    vec3 sunDir = vec3(sqrt(max(1.0 - cosSunZenith * cosSunZenith, 0.0)),
                       cosSunZenith, 0.0);

    vec3 upComp   = vec3(0.0, dir.y, 0.0);
    vec3 flatDir  = dir - upComp;
    float flatLen = length(flatDir);
    vec3 sunFlat  = normalize(vec3(u_SunDir.x, 0.0, u_SunDir.z) + vec3(1e-6, 0.0, 0.0));
    vec3 rayDir;
    if (flatLen > 1e-6) {
        float cosAzi = clamp(dot(flatDir / flatLen, sunFlat), -1.0, 1.0);
        float sinAzi = sqrt(max(1.0 - cosAzi * cosAzi, 0.0));
        rayDir = normalize(vec3(flatLen * cosAzi, dir.y, flatLen * sinAzi));
    } else {
        rayDir = vec3(0.0, sign(dir.y + 1e-6), 0.0);
    }

    FZEScatterResult r = FZE_IntegrateScatteredLuminance(
        atmo, u_TransmittanceLUT, u_MultiScatterLUT,
        pos, rayDir, sunDir, u_SunIlluminance,
        max(u_Steps, 4), distKm, true, true, 0.5,
        false);   // the scene's own geometry is the ground here, not a sphere

    OutScatter       = vec4(r.Luminance, 1.0);
    OutTransmittance = vec4(r.Transmittance, 1.0);
}
