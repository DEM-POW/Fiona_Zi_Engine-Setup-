#version 460 core

// ============================================================================
//  MULTIPLE-SCATTERING LUT — the light that has bounced more than once.
//
//  ⚠️ WITHOUT THIS THE SKY IS TOO DARK AND THE WRONG COLOUR, and the error is
//  not subtle. Single scattering follows sunlight from the sun to one air
//  molecule and then to the eye; every photon that bounced twice is thrown away.
//  In clear air near the zenith that is a small loss, but near the horizon,
//  under haze, and through the whole of twilight it is most of the light - which
//  is why a single-scattering sky has a horizon that goes black instead of
//  white, and a dusk that ends the moment the sun sets rather than fading for
//  half an hour.
//
//  Solving it properly is a slow iterative process over the full 4D table.
//  Hillaire's approximation, used here: assume the light bouncing around a point
//  arrives equally from all directions, which makes the infinite series of
//  bounces a geometric one that sums in closed form:
//
//      F_ms = 1 / (1 - L_f)          then      psi_ms = L_2 * F_ms
//
//  32 x 32 (sun angle, altitude) is enough because the result is very smooth -
//  it has no phase function in it by construction.
//
//  64 directions per texel, sampled over the whole sphere with a Fibonacci
//  spiral rather than a grid, because a grid clumps at the poles and the poles
//  are the zenith and the ground.
// ============================================================================

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_TransmittanceLUT;

#include "lib/AtmosphereUniforms.glsl"

const int   kDirs  = 64;
const int   kSteps = 20;
const float kGolden = 2.39996322972865332;   // the golden angle, radians

void main()
{
    FZEAtmosphere atmo = FZE_AtmosphereFromUniforms();

    float cosSunZenith = clamp(v_UV.x * 2.0 - 1.0, -1.0, 1.0);
    float height = mix(atmo.BottomRadius, atmo.TopRadius, clamp(v_UV.y, 0.0, 1.0));
    height = max(height, atmo.BottomRadius + 1e-3);

    vec3 pos    = vec3(0.0, height, 0.0);
    vec3 sunDir = normalize(vec3(sqrt(max(1.0 - cosSunZenith * cosSunZenith, 0.0)),
                                 cosSunZenith, 0.0));

    vec3 secondOrder = vec3(0.0);   // L_2: light scattered once, gathered here
    vec3 fms         = vec3(0.0);   // L_f: the fraction that will bounce again

    for (int i = 0; i < kDirs; ++i) {
        // Fibonacci sphere: even coverage, no seams, no pole clumping.
        float z   = 1.0 - 2.0 * (float(i) + 0.5) / float(kDirs);
        float rad = sqrt(max(1.0 - z * z, 0.0));
        float phi = kGolden * float(i);
        vec3 dir = vec3(rad * cos(phi), z, rad * sin(phi));

        // ⚠️ NO PHASE FUNCTION HERE, ON PURPOSE. This table is asked "how much
        // light is bouncing around at this altitude", not "which way is it
        // going" - the direction is decided later, by the pass that reads it.
        // Baking a phase in would apply it twice.
        FZEScatterResult r = FZE_IntegrateScatteredLuminance(
            atmo, u_TransmittanceLUT, u_TransmittanceLUT,
            pos, dir, sunDir, vec3(1.0),
            kSteps, -1.0, false, false, 0.5, true);

        secondOrder += r.Luminance;
        fms         += r.MultiScatterAs1;
    }

    // /!\ THE TWO SUMS DO NOT GET THE SAME SCALE, AND BOTH WRONG ANSWERS LOOK
    // LIKE A PLAUSIBLE SKY. They are different integrals:
    //
    //   psi_2 = INTEGRAL over the sphere of (single-scattered radiance) x p_u dw
    //   f_ms  = INTEGRAL over the sphere of (scattering throughput)     x p_u dw
    //
    // Both are averages weighted by the uniform phase p_u = 1/4pi, which
    // integrates to 1 over the sphere - so both are plain averages of their
    // samples. The difference is what the march already applied: the radiance
    // came back with p_u multiplied in (applyPhase = false sets the phase to
    // p_u), and the throughput did not. So the radiance needs that undone,
    // 4pi/N, and the throughput just needs 1/N.
    //
    // ⚠️ AND THE RADIANCE'S p_u IS NOT UNDONE: psi_2 HAS IT TWICE, ON PURPOSE.
    // Once inside the march (the second bounce scatters isotropically toward
    // this point) and once in the integral over the sphere above (the light
    // arriving from every direction is spread isotropically again). Hillaire's
    // reference (UnrealEngineSkyAtmosphere, NewMultiScattCS) does exactly that:
    // result.L * 4pi/N, then * IsotropicPhase - a plain average of the samples.
    // Undoing the march's p_u ("4pi/N") made this table 4pi = 12.6 times too
    // strong: the sky's light on a white card was 35% of the day's where a clear
    // sky gives 12-18%, and so blue (0.047 / 0.097 / 0.216 per unit of sun) that
    // every wall in the shade came out navy. (Scaling both by 1/(4pi N) - an
    // earlier attempt - takes the throughput's average below its true value as
    // well; 4pi/N on both makes f_ms exceed 1 and the series diverge.)
    secondOrder *= 1.0 / float(kDirs);                // psi_2: p_u in the march, p_u here
    fms         *= 1.0 / float(kDirs);                // f_ms: p_u here only

    // The geometric series: light that bounces, and bounces again, and again.
    vec3 infinite = secondOrder / max(vec3(1.0) - fms, vec3(1e-4));
    FragColor = vec4(infinite, 1.0);
}
