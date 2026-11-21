#version 460 core
// ============================================================================
//  THE CLOUDS, MARCHED THROUGH AT A QUARTER OF THE SCREEN.
//
//  One ray per low-resolution pixel through the shell of air between the
//  cloud base and the top of the deepest column, over a curved planet. At
//  every step inside cloud:
//
//    * how much sun gets there - a short march towards the sun through the
//      same density, and the transmittance table for the air above it (the
//      sun reaching a cloud at sunset has crossed a hundred kilometres of air,
//      which is what turns the deck copper);
//    * how much of it turns towards the eye - a two-lobed Henyey-Greenstein
//      phase, strong forward (the silver lining when you look towards the sun
//      through a thin edge) with a weaker backward lobe;
//    * and the light that has already scattered many times, which is most of
//      what makes a thick cloud WHITE: single scattering alone leaves a
//      cumulus seen from the side at about a quarter of the brightness of a
//      white wall in the same sun. Wrenninge's octaves (Oz: The Great and
//      Volumetric, 2013) approximate it: each octave sees the sun through
//      less of the cloud (a), contributes less (b) and scatters less
//      forward (c). With a = 0.4, b = 0.75, c = 0.5 over four octaves, a thick
//      sunlit cumulus seen side-on returns about 0.15 of the sun's
//      illuminance per steradian - where a sunlit cloud actually sits,
//      between white paper (0.25) and the blue sky beside it (0.05);
//    * the sky, from above, and the sunlit ground, from below;
//
//  integrated per step in closed form (Hillaire, "Physically Based Sky,
//  Atmosphere and Cloud Rendering in Frostbite", 2016) so a thick step does
//  not throw away the light scattered inside it.
//
//  ⚠️ A QUARTER OF THE CLOUD PIXELS EACH FRAME. The first version marched
//  every one and the sky pass cost 13.1 ms of a 21 ms frame on the UHD 620.
//  This target is half the cloud buffer each way; each frame it marches the
//  pixels of one corner of every 2x2 block, turning through the four corners,
//  and CloudResolve.frag fills the other three from where the cloud was last
//  frame. A cloud changes over seconds, so four frames of latency on a fourth
//  of its pixels is invisible.
//
//  Output: premultiplied linear radiance (a = opacity), and in the second
//  target the distance the cloud's light came from, for the temporal resolve.
// ============================================================================
#include "lib/CloudVolume.glsl"
#include "lib/AtmosphereUniforms.glsl"
#include "lib/SkySample.glsl"

in vec2 v_NDC;
layout(location = 0) out vec4 o_Color;
layout(location = 1) out float o_Depth;

uniform mat4  u_InvViewProj;
uniform vec3  u_CameraPos;
uniform vec3  u_SunDir;            // towards the sun
uniform vec3  u_SunIlluminance;    // colour x intensity, at the top of the air
uniform float u_FrameJitter;       // 0..1, walks the golden ratio each frame
uniform int   u_Steps;             // march steps looking straight up
uniform vec2  u_Offset;            // which corner of each block this frame marches (0..u_Block-1 each)
uniform float u_Block;             // 2: one pixel in 4 a frame; 4: one in 16 (Clouds Marched 1 in 16)
uniform vec2  u_FullSize;          // the cloud buffer the corners belong to
uniform sampler2D u_CloudTransLUT; // the atmosphere's transmittance table
uniform vec3  u_GroundLight;       // radiance of the ground under the deck, lighting its base
uniform float u_RainShaft;         // extinction per metre under the heaviest raining cloud; 0 = none
uniform vec3  u_FlashPos;          // a lightning flash inside the cloud (Weather/Lightning)
uniform vec3  u_FlashLight;        // the radiance the cloud gives off beside it; 0 between flashes
uniform int   u_Exp;               // FZE_CLOUDEXP bits, for measuring: 1 no detail, 2 no sun march, 4 no fine steps, 8 no rain shafts
uniform int   u_Debug;             // FZE_CLOUDDEBUG=4: cloud/sky and cloud/sun radiance, read back raw

const float PI = 3.14159265358979;

float HG(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float Phase(float c, float scale) {
    return mix(HG(c, -0.3 * scale), HG(c, 0.8 * scale), 0.7);
}

// Where a ray from a viewer at height h, heading mu = dir.y, meets the sphere
// H above the ground: both roots, -1 when it misses.
//
// ⚠️ NOT dot(ro,ro) - r*r. With a 6360 km planet both terms are 4e13 and a
// float carries seven digits, so their difference - a few thousand metres
// squared - is lost entirely, and the first version of this pass drew no
// cloud at all. c is factored so it is computed from small numbers, and the
// near root comes from c / q (the stable form of the quadratic) instead of
// from -b + sqrt(disc), which is the same cancellation again.
vec2 ShellHit(float h, float H, float mu) {
    float R = u_PlanetRadius;
    float b = (R + h) * mu;
    float c = (h - H) * (2.0 * R + h + H);
    float disc = b * b - c;
    if (disc < 0.0) return vec2(-1.0);
    float q = -(b + (b >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
    float t0 = q, t1 = c / q;
    return vec2(min(t0, t1), max(t0, t1));
}

// How much of a point's light survives the air on the way to the eye: the
// atmosphere's extinction at the ground (Rayleigh, and Mie thickened by the
// humidity) averaged over the climb to the point's altitude, each with its
// scale height.
float AirTransmittance(FZEAtmosphere atmo, float dist, float altitude) {
    if (u_SkyLutEnabled != 1) return exp(-dist / 30000.0);
    float aKm = max(altitude, 1.0) * 0.001;
    float hr = atmo.RayleighScaleHeight, hm = atmo.MieScaleHeight;
    float fr = hr / aKm * (1.0 - exp(-aKm / hr));
    float fm = hm / aKm * (1.0 - exp(-aKm / hm));
    float sigR = atmo.RayleighScattering.g, sigM = atmo.MieScattering.g + atmo.MieAbsorption.g;
    return exp(-dist * 0.001 * (sigR * fr + sigM * fm));
}

float InterleavedGradient(vec2 px) {
    return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

// Optical depth towards the sun from p: a few steps growing by 3x from
// 18 m - most of the answer is in the first hundred metres - and then the rest
// of the way out. ⚠️ The steps reach a few hundred metres and a storm tower is
// eight kilometres: stopping there lit the base of a cumulonimbus like the
// base of a fair-weather puff. Where the last step is still in cloud, the
// column above it is counted at that density to the top of its kind, along the
// sun's slant.
float SunDepth(vec3 p, int n) {
    float tau = 0.0;
    float s = 18.0;
    vec3 q = p;
    float lastD = 0.0;
    vec4 lastW = vec4(0.0);
    float lastAlt = 0.0;
    for (int i = 0; i < n; ++i) {
        q += u_SunDir * s;
        lastAlt = FZE_CloudAltitude(q, u_CameraPos);
        if (lastAlt > u_CloudTop) { lastD = 0.0; break; }
        lastW = FZE_CloudWeather(q);
        lastD = FZE_CloudDensity(q, lastAlt, lastW, false);
        tau += lastD * s;
        s *= 3.0;
    }
    if (lastD > 0.0 && u_SunDir.y > 0.05) {
        float rest = max(u_CloudBase + FZE_CloudDepth(lastW.y) - lastAlt, 0.0);
        tau += lastD * 0.6 * rest / u_SunDir.y;
    }
    return tau * u_CloudSigma;
}

void main() {
    // The full cloud-buffer pixel this march texel stands for this frame.
    vec2 fullPx = floor(gl_FragCoord.xy) * u_Block + u_Offset + 0.5;
    vec2 ndc = fullPx / u_FullSize * 2.0 - 1.0;
    vec4 world = u_InvViewProj * vec4(ndc, 1.0, 1.0);
    vec3 dir = normalize(world.xyz / world.w - u_CameraPos);
    o_Color = vec4(0.0);
    o_Depth = 0.0;

    // The shell, around a planet whose centre is under the camera.
    float camAlt = max(u_CameraPos.y, 1.0);
    vec2 hitIn  = ShellHit(camAlt, u_CloudBase, dir.y);
    vec2 hitOut = ShellHit(camAlt, u_CloudTop, dir.y);
    vec2 hitGround = ShellHit(camAlt, 0.0, dir.y);
    float t0, t1;
    if (camAlt < u_CloudBase) {
        if (hitGround.x > 0.0) return;                 // the ray meets the ground first
        t0 = hitIn.y; t1 = hitOut.y;
    } else if (camAlt < u_CloudTop) {
        t0 = 0.0;
        t1 = (hitIn.x > 0.0) ? hitIn.x : hitOut.y;
    } else {
        if (hitOut.x < 0.0) return;
        t0 = hitOut.x;
        t1 = (hitIn.x > 0.0) ? hitIn.x : hitOut.y;
    }
    const float kFar = 60000.0;
    if (t0 > kFar || t1 <= t0) return;
    t1 = min(t1, t0 + 30000.0);

    // Near the horizon the path through the shell is tens of kilometres; the
    // step grows with it, capped, and the number of steps with it too.
    float len = t1 - t0;
    int steps = int(clamp(float(u_Steps) * sqrt(len / max(u_CloudTop - u_CloudBase, 1.0)), float(u_Steps), 2.0 * float(u_Steps)));
    float dt = len / float(steps);
    float jitter = fract(InterleavedGradient(fullPx) + u_FrameJitter);

    FZEAtmosphere atmo = FZE_AtmosphereFromUniforms();
    float cosV = dot(dir, u_SunDir);
    // The sky above a cloud and the ground below it light it from both sides.
    vec3 skyUp = (u_SkyLutEnabled == 1) ? FZE_SkyRadiance(atmo, normalize(vec3(0.0, 1.0, 0.0) + u_SunDir * 0.1))
                                        : vec3(0.05, 0.08, 0.14) * u_SunIlluminance;

    // The sun as it arrives at the clouds, through the air above them - once
    // per ray, at the middle of the layer: across a kilometre or two of height
    // the air above changes by a few percent.
    vec3 sunAtCloud = u_SunIlluminance;
    if (u_SkyLutEnabled == 1) {
        float r = atmo.BottomRadius + (u_CloudBase + 0.3 * (u_CloudTop - u_CloudBase)) * 0.001;
        // A cloud a kilometre up still sees a sun a degree below the ground's
        // horizon - the gold on the clouds after sunset - and not one further down.
        sunAtCloud *= FZE_TransmittanceLookup(atmo, u_CloudTransLUT, r, u_SunDir.y)
                    * FZE_SunAboveHorizon(atmo, r, u_SunDir.y);
    }
    vec3 fallsOnTop = sunAtCloud * max(u_SunDir.y, 0.0) + PI * skyUp;
    vec3 lastS = vec3(0.0);
    bool haveS = false;

    vec3  L = vec3(0.0);
    float T = 1.0;
    float depthSum = 0.0, weightSum = 0.0;

    // ---- the rain under the clouds ----
    // ⚠️ RAIN FALLS OUT OF A CLOUD, AND FROM A DISTANCE IT IS SEEN FALLING. A
    // shower is a curtain hanging from the base of one cloud to the ground,
    // grey against the brighter sky round it, and it is the one thing that
    // says a storm is over THERE and not here. Under showers the rain channel
    // of the weather map is where it falls; the curtain's extinction is the
    // rain's own (Environment::RainExtinction - two per kilometre in 25 mm/h,
    // so a shower two kilometres across is nearly opaque, as they look), and
    // its light is the grey light under a raining base, seen through the air
    // between it and the eye.
    //
    // ⚠️ FROM A KILOMETRE AND A HALF OUT, NOT FROM THE EYE. Standing inside a
    // shower, the first version marched the rain round the camera too - a
    // dozen kilometres of it, opaque - and the haze then painted that curtain
    // the colour of the sky: the clouds vanished behind a blue wall. The rain
    // round you is the drops' and the fog's; the curtain is the rain over there.
    vec3 skyDir = (u_SkyLutEnabled == 1) ? FZE_SkyRadiance(atmo, dir) : skyUp;
    vec3  Ls = vec3(0.0);
    float Ts = 1.0;
    vec3 fallsOnTopShaft = u_SunIlluminance * max(u_SunDir.y, 0.0) + PI * skyUp;
    float shaftDepth = 0.0, shaftWeight = 0.0;
    if (u_RainShaft > 0.0 && camAlt < u_CloudBase && (u_Exp & 8) == 0) {
        const float kNear = 1500.0;
        float tEnd = min(t0, 30000.0);
        if (tEnd > kNear) {
            float prevT = kNear;
            for (int i = 1; i <= 14; ++i) {
                float f = (float(i) - 1.0 + jitter) / 14.0;
                float tt = kNear + (tEnd - kNear) * f * f;
                float seg = max(tt - prevT, 1.0);
                prevT = tt;
                vec3 p = u_CameraPos + dir * tt;
                vec4 w = FZE_CloudWeather(p);
                float sig = u_RainShaft * w.z;
                if (sig <= 0.0) continue;
                float st = exp(-sig * seg);
                float taken = Ts * (1.0 - st);
                // ⚠️ THE AIR UNDER A STORM IS NOT THE CLEAR SKY. Tinted with the
                // sky table's haze - the colour of sunlit air - the curtains came
                // out sky-blue, and being opaque over ten kilometres they painted
                // a clear sky over the clouds. The air and the rain under a
                // raining base are both lit by the grey light that comes through
                // it, so that is their colour at any distance.
                //
                // What gets through a raining column is what diffuses through
                // it - the two-stream 1 / (1 + k tau) the cloud's own light uses,
                // over the column's depth at its presence and its rain - so a
                // cumulonimbus's curtain is a few percent of the sun, dark and
                // neutral, and a thin shower's is lighter.
                float tauCol = u_CloudSigma * FZE_CloudDepth(w.y) * 0.5 * w.x * (1.0 + FZE_CLOUD_RAIN_THICKENING * w.z);
                vec3 under = fallsOnTopShaft / (1.0 + 0.1125 * tauCol) / PI + u_GroundLight;
                // And the air between: a curtain ten kilometres off is seen
                // through ten kilometres of haze, which is why distant rain is
                // blue-grey and not the colour of the light inside it.
                float airS = AirTransmittance(atmo, tt, 300.0);
                Ls += (under * airS + skyDir * (1.0 - airS)) * taken;
                shaftDepth += tt * taken;
                shaftWeight += taken;
                Ts *= st;
            }
        }
    }

    // ⚠️ THREE STEP SIZES. Air the weather map says is empty is crossed in
    // long strides; cloud in ordinary steps - but the lit skin of a cloud is
    // one mean free path deep, about fifteen metres at real density, and a
    // hundred-metre step that lands fifty metres inside sees the sun through
    // an optical depth of four and paints the face grey. So on the first
    // density found the march backs up a step and takes its first few samples
    // inside finely; past the skin it lengthens again. Measured on the UHD
    // 620: fine steps all the way through cost 2.1 ms of a 5.7 ms sky, and
    // everything past the skin is behind it.
    float dtFine = max(dt * 0.35, 20.0);
    float t = t0 + jitter * dt;
    float stepLen = dt;
    int empty = 0, inside = 0;
    for (int i = 0; i < steps + 40 && t < t1; ++i) {
        vec3 p = u_CameraPos + dir * t;
        vec4 w = FZE_CloudWeather(p);
        if (w.x < 0.01) {                  // no cloud anywhere in this column
            t += dt * 1.5;
            stepLen = dt; inside = 0;
            continue;
        }
        float alt = FZE_CloudAltitude(p, u_CameraPos);
        // The rim's erosion is finer than a pixel past twenty kilometres.
        float d = FZE_CloudDensity(p, alt, w, t < 20000.0 && (u_Exp & 1) == 0);
        if (d <= 0.0) {
            if (stepLen < dt && ++empty > 4) { stepLen = dt; empty = 0; inside = 0; }
            t += stepLen;
            continue;
        }
        if (stepLen == dt && inside == 0 && dt > dtFine * 1.5 && (u_Exp & 4) == 0) {
            // Back up and come in again finely.
            t = max(t - dt + dtFine * jitter, t0);
            stepLen = dtFine;
            empty = 0;
            continue;
        }
        if (++inside == 5 && stepLen < dt) stepLen = mix(dtFine, dt, 0.6);   // past the skin
        empty = 0;

        float sigma = d * u_CloudSigma;
        float stepT = exp(-sigma * stepLen);
        float taken = T * (1.0 - stepT);

        // ⚠️ A STEP THAT ADDS ALMOST NOTHING REUSES THE LAST STEP'S LIGHT. The
        // light at a sample costs a march of its own towards the sun, and
        // billowed clouds are porous: a ray threads through dozens of wisps
        // that each change the picture by a fraction of a percent. Measured:
        // lighting every one of them took the sky pass from 3.8 to 8.0 ms.
        if (taken > 0.004 || !haveS) {
            // Beyond fifteen kilometres a cloud is a few pixels; three steps
            // towards the sun say as much as four.
            float tauSun = (u_Exp & 2) != 0 ? 0.0 : SunDepth(p, t > 15000.0 ? 2 : 3);
            float depth = FZE_CloudDepth(w.y);
            float hFrac = clamp((alt - u_CloudBase) / depth, 0.0, 1.0);

            // The sun, scattered once and the first few times more:
            // directional, which is where the silver lining and the dark heart
            // of a backlit cloud come from.
            vec3 S = vec3(0.0);
            float oa = 1.0, ob = 1.0, oc = 1.0;
            for (int o = 0; o < 3; ++o) {
                // ⚠️ POWDER (phase 4): thin cloud scatters less of the sun back toward the eye than its
                // optical depth says - light has not yet bounced enough inside it - so a cumulus seen
                // away from the sun has darker rims and bright folds, the cauliflower; toward the sun the
                // silver lining is left as it is.
                float powder = mix(1.0 - exp(-d * 6.0), 1.0, 0.5 + 0.5 * cosV);
                S += ob * exp(-tauSun * oa) * Phase(cosV, oc) * sunAtCloud * (o == 0 ? powder : 1.0);
                oa *= 0.25; ob *= 0.5; oc *= 0.5;
            }

            // ⚠️ AND THE LIGHT THAT HAS DIFFUSED THROUGH THE CLOUD, which is
            // most of what a thick cloud shows and all of what lights the
            // underside of an overcast. The octaves cannot carry sunlight
            // through a deck a kilometre thick - at an optical depth of a
            // hundred even the weakest is e^-6 - so the first version lit every
            // overcast from below with blue skylight alone and the deck came out
            // the colour of the sky it hid. In a conservative scatterer the
            // diffuse light falls off LINEARLY through the layer, not
            // exponentially: the two-stream solution for a slab of optical
            // depth tau_T puts the diffuse field at
            //
            //     (1 + k tau_below) / (1 + k tau_T),   k = 0.75 (1 - g), g = 0.85
            //
            // of what falls on its top - 1 at the lit top, 1 / (1 + k tau_T) at
            // the base (an eighth, for a deck of depth 70: white, which is why an
            // overcast is grey and not dark blue). Counting only the depth ABOVE
            // a point, as the second version did, forgot the light the cloud
            // below throws back up and dimmed every cloud's middle by half.
            //
            // The depth above comes from the sun march (the sun crosses a flat
            // layer's depth over mu); the depth below from this point's own
            // density carried down to the base - a column is densest in its
            // middle and thinnest at its rim, so this errs towards a lighter
            // base, which is the side an error should fall on.
            float tauUp = tauSun * max(u_SunDir.y, 0.05);
            float tauDown = sigma * (alt - u_CloudBase) * 0.8;
            const float kDiffuse = 0.1125;
            float field = (1.0 + kDiffuse * tauDown) / (1.0 + kDiffuse * (tauUp + tauDown));
            S += fallsOnTop * field / PI;
            // And the ground below, lighting the base.
            S += u_GroundLight * (1.0 - hFrac);
            lastS = S;
            haveS = true;
        }
        vec3 S = lastS;
        // A flash inside the cloud lights it from within. The channel runs
        // for kilometres through the cloud, and its light diffuses out
        // through the droplets, so the glow is a region a couple of
        // kilometres across, not a point - brightest along the channel.
        // Outside the reuse above: it lasts a few frames and must not be
        // carried from a step that was lit before it began.
        if (u_FlashLight.g > 0.0) S += u_FlashLight * exp(-length(p - u_FlashPos) / 1200.0);

        L += S * taken;
        depthSum += t * taken;
        weightSum += taken;
        T *= stepT;
        // ⚠️ STOPPING EARLY IS A SAVING, NOT A HOLE IN THE CLOUD. The march quits
        // once 2% gets through, but the cloud goes on past that point; the 2% it
        // used to KEEP let a fiftieth of the sun's disc through the thickest deck,
        // and the disc is ~15 000x the sun's illuminance - 300x, a blinding sun
        // hanging in an overcast sky. What is left behind the break is taken as
        // gone, which a cumulus a few hundred metres deep (optical depth tens)
        // makes true to far better than a per cent.
        if (T < 0.02) { T = 0.0; break; }
        t += stepLen;
    }

    float alpha = 1.0 - T;
    if (u_Debug == 4) {
        float lc = dot(L / max(alpha, 1e-4), vec3(0.2126, 0.7152, 0.0722));
        float ls = dot(skyDir, vec3(0.2126, 0.7152, 0.0722));
        float le = dot(u_SunIlluminance, vec3(0.2126, 0.7152, 0.0722));
        o_Color = vec4(lc / max(ls, 1e-6) / 16.0, lc / le, alpha, 1.0);
        return;
    }
    if (alpha <= 0.0005 && Ts > 0.9995) return;
    float cloudDist = depthSum / max(weightSum, 1e-6);

    // The air between the eye and the cloud: a cloud forty kilometres away is
    // seen through the same haze the sky is made of, so it fades into the
    // horizon rather than standing on it as a cut-out.
    //
    // ⚠️ THROUGH THE ATMOSPHERE'S OWN AIR, NOT A CONSTANT. A fixed 30 km fade
    // was the same on a desert noon and a humid afternoon, and distant storm
    // towers stood on a hazy horizon as sharp vertical curtains.
    vec4 cloud = vec4(0.0);
    if (alpha > 0.0005) {
        // The cloud's own distance, not the shafts' in front of it.
        vec3 pc = u_CameraPos + dir * cloudDist;
        float air = AirTransmittance(atmo, cloudDist, FZE_CloudAltitude(pc, u_CameraPos));
        cloud = vec4(L * air + skyDir * alpha * (1.0 - air), alpha);
    }
    // The shafts stand in front of the clouds.
    o_Color = vec4(Ls, 1.0 - Ts) + Ts * cloud;
    // Where the light came from, for the resolve: the shafts and the cloud
    // weighted by how much each gave.
    o_Depth = (depthSum + shaftDepth) / max(weightSum + shaftWeight, 1e-6);
}
