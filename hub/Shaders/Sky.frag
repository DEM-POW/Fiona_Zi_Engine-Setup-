#version 460 core

// ============================================================================
// FZE sky: the physical atmosphere, lit by the scene's sun.
//
// ⚠️ THERE IS NO PAINTED SKY ANY MORE. This shader used to be "hybrid by
// design": a top and a horizon colour anyone could pick, with scattering, a
// sun disc and stars layered over them, and a day/night cycle that rewrote
// those two colours every frame from its own table. The atmosphere (built by
// SkyAtmosphere from the same sun that lights the ground) replaced it where it
// was on, and the painted path stayed behind as a second answer to "what
// colour is the sky" that disagreed with the first. Now:
//
//   * the sky is read out of the sky-view table - the scattering integral for
//     this sun and this altitude, in the same pre-exposed units as every light;
//   * the sun disc is the sun's own illuminance spread over its solid angle,
//     through the same air that reddens the sky around it;
//   * the stars and the airglow are real luminances, so they appear exactly
//     when the camera has opened up far enough to see them - at night - with
//     no day/night blend;
//   * with the atmosphere switched off there is no air: a black sky, a white
//     sun and the stars, as in space.
//
// The HDRI skybox is a separate pass on a real sphere mesh (Skybox.vert/frag).
// ============================================================================

in vec2 v_NDC;
out vec4 FragColor;

uniform mat4  u_InvViewProj;
uniform vec3  u_CameraPos;
uniform vec3  u_SunDir;            // towards the sun
uniform vec3  u_SunIlluminance;    // lux x colour x pre-exposure, above the air
uniform float u_PreExposure;       // for the night sky's own luminances
uniform float u_Time;

uniform int   u_SunDisc;
uniform float u_SunSize;           // angular RADIUS in radians

// The night (SunComponent > The Night; docs/SKY-PLAN.md, phase 2).
uniform int   u_MoonOn;
uniform vec3  u_MoonDir;           // toward the moon
uniform vec3  u_MoonSunDir;        // toward the sun, which lights the moon's face
uniform vec3  u_MoonSunE;          // the sun's illuminance above the air, x pre-exposure
uniform float u_MoonRadius;        // angular RADIUS in radians (0.26 degrees)
uniform mat4  u_StarSky;           // world -> the stars' own frame, turned to the hour
uniform float u_Cirrus;            // cirrus amount 0..1 (Clouds > High Cloud; docs/SKY-PLAN.md, phase 4)
uniform vec2  u_CirrusWind;        // m/s at nine kilometres, world x / z

uniform int       u_Clouds;
uniform sampler2D u_CloudTex;

// The clouds, composited from the cloud layer's quarter-resolution target.
// Four bilinear taps a half-texel apart: a single tap magnified from a
// quarter-size target shows its texels as soft squares along every cloud
// edge; the box of four is the same shape at twice the smoothness.
vec4 FZE_CloudLayer(vec2 ndc) {
    vec2 cuv = ndc * 0.5 + 0.5;
    vec2 tx  = 1.0 / vec2(textureSize(u_CloudTex, 0));
    return 0.25 * (texture(u_CloudTex, cuv + tx * vec2(-0.5, -0.5))
                 + texture(u_CloudTex, cuv + tx * vec2( 0.5, -0.5))
                 + texture(u_CloudTex, cuv + tx * vec2(-0.5,  0.5))
                 + texture(u_CloudTex, cuv + tx * vec2( 0.5,  0.5)));
}

uniform int   u_TonemapMode;

#include "lib/Fog.glsl"
#include "lib/Tonemap.glsl"
#include "lib/AtmosphereUniforms.glsl"

uniform int       u_AtmoEnabled;
uniform sampler2D u_SkyViewLUT;
uniform sampler2D u_TransmittanceLUT;
uniform float     u_AtmoViewHeight;    // km from the planet centre

float Hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Smooth value noise 0..1 (the cirrus).
float FZE_VNoise(vec2 p) {
    vec2 c = floor(p), f = fract(p), m = f * f * (3.0 - 2.0 * f);
    return mix(mix(Hash12(c), Hash12(c + vec2(1.0, 0.0)), m.x),
               mix(Hash12(c + vec2(0.0, 1.0)), Hash12(c + vec2(1.0, 1.0)), m.x), m.y);
}

void main()
{
    vec4 world = u_InvViewProj * vec4(v_NDC, 1.0, 1.0);
    world /= world.w;
    vec3 dir = normalize(world.xyz - u_CameraPos);
    vec3 sunDir = normalize(u_SunDir);

    FZEAtmosphere atmo = FZE_AtmosphereFromUniforms();
    bool air = u_AtmoEnabled == 1;
    float viewHeight = max(u_AtmoViewHeight, atmo.BottomRadius + 1e-4);

    // ---- the air, lit by the sun ----
    // One texture fetch, not a ray march: the table was built in
    // SkyAtmosphere::Update, only when the sun or the camera's ALTITUDE
    // changed - turning the camera costs nothing.
    // The table holds the sky per unit of sunlight (AtmosphereUniforms.glsl).
    vec3 radiance = air ? texture(u_SkyViewLUT, FZE_SkyViewUV(atmo, viewHeight, dir, sunDir)).rgb
                          * u_AtmoRadianceScale
                        : vec3(0.0);
    // How much of what lies beyond the air reaches the eye along this ray.
    vec3 through = air ? FZE_TransmittanceLookup(atmo, u_TransmittanceLUT, viewHeight, dir.y)
                       : vec3(1.0);
    bool aboveGround = !air || FZE_RaySphere(vec3(0.0, viewHeight, 0.0), dir, atmo.BottomRadius) < 0.0;
    // The planet's ground, lit by the sun and the sky (SkyAtmosphere::SetGroundLight):
    // the table holds only the air in front of it.
    if (air && !aboveGround) radiance += FZE_GroundSeen(atmo, viewHeight, dir);

    // ---- the sun itself ----
    if (u_SunDisc == 1) {
        float r = max(u_SunSize, 1e-4);
        float ang = acos(clamp(dot(dir, sunDir), -1.0, 1.0));
        vec3 sunT = air ? FZE_TransmittanceLookup(atmo, u_TransmittanceLUT, viewHeight, sunDir.y)
                        : vec3(1.0);
        // ⚠️ THE DISC'S BRIGHTNESS COMES FROM ITS ANGULAR SIZE. u_SunIlluminance
        // is what arrives on a surface facing the sun; the disc is the radiance
        // that produces it, the illuminance over the solid angle it covers:
        // omega = 2 pi (1 - cos r). At the real 0.53 degrees that is 6.8e-5 sr -
        // the disc is fifteen thousand times its illuminance, and it is
        // supposed to be blinding. Twice as wide, each part of it is four
        // times dimmer: the same light spread over four times the sky.
        if (ang < r && aboveGround) {
            float omega = 2.0 * FZE_ATMO_PI * (1.0 - cos(r));
            // Limb darkening: the sun is a sphere of gas, dimmer at the rim
            // because you are looking through cooler outer layers.
            float t = ang / r;
            float limb = pow(max(1.0 - t * t * 0.85, 0.0), 0.55);
            radiance += u_SunIlluminance * sunT * limb / max(omega, 1e-6);
        }
        // ⚠️ THE AUREOLE, WHICH THE TABLE CANNOT HOLD. Haze scatters sunlight
        // mostly straight on, into a bright glow a few degrees round the disc;
        // the sky-view table is 192 texels wide and smears it into a wash, and
        // its phase function (g 0.8) is far blunter than real aerosols, whose
        // forward peak is closer to g 0.95. Added here: the sharp lobe's excess
        // over the table's own, times the haze the sunlight crossed - its Mie
        // depth straight up, times the air mass at the sun's height (Kasten &
        // Young 1989). So it follows the WEATHER: clear air, a small hard
        // glow; humid air (more Mie), a big soft one; a sun on the horizon,
        // through thirty-eight times the air, a wide red blaze.
        if (air) {
            float c = cos(ang);
            float g1 = 0.95, g0 = atmo.MieAnisotropy;
            float sharp = (1.0 - g1 * g1) / pow(max(1.0 + g1 * g1 - 2.0 * g1 * c, 1e-6), 1.5);
            float blunt = (1.0 - g0 * g0) / pow(max(1.0 + g0 * g0 - 2.0 * g0 * c, 1e-6), 1.5);
            float lobe = max(sharp - blunt, 0.0) / (4.0 * FZE_ATMO_PI);
            float elev = degrees(asin(clamp(sunDir.y, -1.0, 1.0)));
            float airMass = 1.0 / max(sin(radians(max(elev, 0.0))) + 0.50572 * pow(max(elev, 0.0) + 6.07995, -1.6364), 1e-3);
            float mieDepth = dot(atmo.MieScattering, vec3(1.0 / 3.0)) * atmo.MieScaleHeight * airMass;
            radiance += u_SunIlluminance * sunT * mieDepth * lobe;
        }
    }

    // ---- the moon: a grey sphere lit by the sun, so it shows its own phase ----
    // Its surface is a Lambertian of albedo about 0.12 with darker seas, lit by the sun above the air:
    // the radiance of each point is E * albedo * (N.L) / pi - a full moon a few thousand cd/m^2, which
    // the day sky drowns and the night shows. The air between dims and reddens it like the sun.
    float moonCover = 0.0;
    if (u_MoonOn == 1 && aboveGround) {
        vec3 m = normalize(u_MoonDir);
        float c = dot(dir, m);
        if (c > cos(u_MoonRadius * 1.1)) {
            vec3 t1 = normalize(cross(m, abs(m.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
            vec3 t2 = cross(m, t1);
            vec2 q = vec2(dot(dir, t1), dot(dir, t2)) / sin(u_MoonRadius);   // -1..1 across the disc
            float rr = dot(q, q);
            moonCover = 1.0 - smoothstep(0.86, 1.0, rr);
            if (moonCover > 0.0) {
                vec3 n = normalize(q.x * t1 + q.y * t2 - sqrt(max(1.0 - rr, 0.0)) * m);
                float lit = max(dot(n, normalize(u_MoonSunDir)), 0.0);
                // The seas: a few broad dark patches and a fine grain, fixed to its face.
                float seas = 0.9 * (1.0 - smoothstep(0.0, 0.42, length(q - vec2(-0.25, 0.22))))
                           + 0.7 * (1.0 - smoothstep(0.0, 0.32, length(q - vec2(0.22, 0.32))))
                           + 0.6 * (1.0 - smoothstep(0.0, 0.30, length(q - vec2(0.08, -0.12))))
                           + 0.5 * (1.0 - smoothstep(0.0, 0.24, length(q - vec2(-0.38, -0.30))));
                float albedo = 0.13 * (1.0 - 0.4 * clamp(seas, 0.0, 1.0)) * (0.92 + 0.16 * Hash12(floor(q * 22.0)));
                vec3 moonT = air ? FZE_TransmittanceLookup(atmo, u_TransmittanceLUT, viewHeight, m.y) : vec3(1.0);
                vec3 L = u_MoonSunE * albedo * lit / FZE_ATMO_PI * moonT;
                radiance = radiance * (1.0 - moonCover) + (radiance + L) * moonCover;
            }
        }
    }

    // ---- the night sky, in cd/m^2 ----
    //
    // ⚠️ REAL LUMINANCES, SO THEY NEED NO DAY/NIGHT SWITCH. A bright star seen
    // through one pixel is a few cd/m^2 and the airglow between them a few
    // ten-thousandths; against a day sky of thousands both vanish, and with the
    // camera opened up to a moonless night they are what there is. The old sky
    // blended stars in by the sun's elevation, which lit them under a bright
    // dusk and hid them from a night lit only by a lamp.
    //
    // ⚠️ FIXED ON THE SPHERE AND TURNING WITH THE NIGHT (phase 2). They were cells of a plane through
    // the zenith: stretched toward the horizon, standing still all night, twinkling three times a
    // second. Now each lives in a cell of a cube round the eye, in the stars' own frame, which the
    // clock turns about the celestial pole once a sidereal day; a soft round point a pixel wide, a
    // slow and slight twinkle, and hidden by the moon's disc.
    if (dir.y > 0.0 && aboveGround) {
        vec3 sd = mat3(u_StarSky) * dir;
        vec3 ad = abs(sd);
        vec2 face; float side;
        if (ad.x >= ad.y && ad.x >= ad.z) { face = sd.yz / ad.x; side = sd.x > 0.0 ? 0.0 : 1.0; }
        else if (ad.y >= ad.z)            { face = sd.xz / ad.y; side = sd.y > 0.0 ? 2.0 : 3.0; }
        else                              { face = sd.xy / ad.z; side = sd.z > 0.0 ? 4.0 : 5.0; }
        vec2 g = face * 180.0;                                   // cells about half a degree wide
        vec2 cell = floor(g) + side * 517.0;
        float h = Hash12(cell);
        float star = step(0.988, h);
        vec2 at = vec2(Hash12(cell + 1.3), Hash12(cell + 2.9)) * 0.6 + 0.2;
        float spot = exp(-dot(fract(g) - at, fract(g) - at) * 30.0);
        // Magnitudes: most stars are faint, a few are bright.
        float mag = pow(Hash12(cell + 3.7), 6.0);
        float twinkle = 0.9 + 0.1 * sin(u_Time * 1.1 + Hash12(cell + 7.0) * 40.0);
        float stars = star * spot * twinkle * (0.2 + 12.0 * mag) * (1.0 - moonCover);   // cd/m^2
        vec3 tint = mix(vec3(1.0, 0.85, 0.7), vec3(0.8, 0.9, 1.0), Hash12(cell + 5.1));
        vec3 airglow = vec3(0.7, 0.85, 1.2) * 2.5e-4;                        // cd/m^2
        radiance += (tint * stars + airglow) * through * smoothstep(0.0, 0.25, dir.y) * u_PreExposure;
    }

    // ---- cirrus: thin ice streaks nine kilometres up, drawn out by the wind (phase 4) ----
    // A thin layer, not a volume: single scattering of the sun (a forward lobe and a broad part) and
    // of the sky, over an optical depth up to one. Behind the other clouds, in front of the stars;
    // the sunlight crossed the air to reach it, so it is white by day and pink at sunset.
    if (u_Cirrus > 0.001 && dir.y > 0.01 && aboveGround) {
        float tPlane = (9000.0 - u_CameraPos.y) / dir.y;
        vec2 xz = u_CameraPos.xz + dir.xz * tPlane + u_CirrusWind * u_Time;
        float ws = length(u_CirrusWind);
        vec2 ax = ws > 0.01 ? u_CirrusWind / ws : vec2(1.0, 0.0);
        // ⚠️ IN PATCHES, AS LONG SOFT FIBRES. Spread evenly as short dashes they read as motion lines
        // converging on the horizon; real cirrus lies in sheets and bands tens of kilometres across,
        // each a few long combed strands. So: a slow mask 25 km across says where there is any, and
        // inside it strands 14 km long and a kilometre wide, their ends hooked (mares' tails).
        float region = smoothstep(0.75 - 0.5 * u_Cirrus, 1.0 - 0.4 * u_Cirrus,
                                  FZE_VNoise(xz / 25000.0 + vec2(3.1, 7.7)));
        // Combed, not ruled: the strands are bent by a slow field 9 km across, so they curve and
        // fan out instead of running as straight lines to the horizon.
        vec2 bend = vec2(FZE_VNoise(xz / 9000.0), FZE_VNoise(xz / 9000.0 + vec2(5.2, 1.3))) - 0.5;
        vec2 xw = xz + bend * 7000.0;
        vec2 q = vec2(dot(xw, ax), dot(xw, vec2(-ax.y, ax.x))) / vec2(8000.0, 1600.0);
        q.y += 0.4 * sin(q.x * 1.3 + 1.3);                        // the hooks of mares' tails
        float f = 0.0, amp = 0.55;
        for (int o = 0; o < 3; ++o) {
            f += amp * FZE_VNoise(q);
            q = q * vec2(1.9, 2.3) + vec2(1.7, 9.2);
            amp *= 0.45;
        }
        float cover = smoothstep(0.45, 0.85, f) * region;
        float fade = smoothstep(0.01, 0.12, dir.y) * (1.0 - smoothstep(60000.0, 140000.0, tPlane));
        float tau = cover * fade * mix(0.35, 1.0, u_Cirrus);
        if (tau > 0.001) {
            vec3 sunT = air ? FZE_TransmittanceLookup(atmo, u_TransmittanceLUT, viewHeight, sunDir.y) : vec3(1.0);
            float c = dot(dir, sunDir);
            float g = 0.6;
            float hg = (1.0 - g * g) / (4.0 * FZE_ATMO_PI * pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5));
            // Ice throws light forward, but a strong lobe drew bright rays round the sun: kept small.
            float phase = 0.12 * hg + 0.88 / (4.0 * FZE_ATMO_PI);
            float up = smoothstep(-0.04, 0.04, sunDir.y);          // no sunlight on it below the horizon
            vec3 lit = u_SunIlluminance * sunT * phase * up + radiance * 0.35;
            float keep = exp(-tau);
            radiance = radiance * keep + lit * (1.0 - keep);
        }
    }

    // ---- the clouds, in front of all of it ----
    if (u_Clouds == 1) {
        vec4 cl = FZE_CloudLayer(v_NDC);
        radiance = cl.rgb + radiance * (1.0 - cl.a);
    }

    // ---- with no atmosphere, the scene's own fog is the only air ----
    // The atmosphere's table already carries the haze a surface's fog stands
    // in for, so the fog is laid over the sky only where there is no table.
    if (!air)
        radiance = FZE_ApplyFog(radiance,
                                FZE_SceneOut(FZE_FogRadiance(pow(max(u_FogColor, 0.0), vec3(2.2)), dir)),
                                FZE_FogDepthSky(u_CameraPos, dir));

    FragColor = vec4(FZE_SceneOut(radiance), 1.0);
}
