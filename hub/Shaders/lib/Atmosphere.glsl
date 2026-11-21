// ============================================================================
//  THE ATMOSPHERE, AS PHYSICS, IN ONE PLACE.
//
//  ⚠️ THE SKY WAS TWO GRADIENTS AND A PILE OF HEURISTICS, WRITTEN TWICE. Sky.frag
//  mixed SkyTop toward SkyHorizon by exp(-h*3.2) and then warmed the result
//  toward the sun with a pow() lobe; IBLIrradiance.frag had the same line copied
//  into it so the lighting would agree with the picture. That works and it is
//  where this engine started, but it cannot do the things the sky actually does:
//  the colour of a sunset is not an artist's orange, it is what is LEFT of white
//  sunlight after it has crossed eight hundred kilometres of air, and no amount
//  of tinting a gradient produces the band of blue that sits above the orange, or
//  the way the shadow of the planet climbs the eastern sky at dusk.
//
//  So this is the real thing: light scattering off air molecules (Rayleigh), off
//  aerosols (Mie), and being eaten by ozone, integrated along the view ray.
//  Everything else - the horizon, twilight, aerial perspective on a distant
//  mountain, the colour the clouds are lit with - falls out of that one
//  calculation instead of being a separate control.
//
//  ⚠️ AND IT IS ONE FILE BECAUSE THE PICTURE AND THE LIGHTING HAVE TO AGREE.
//  Two copies of a sky model drift the first time one is touched, and the
//  symptom is the worst kind: the world lit as though the sky were a colour it
//  visibly is not.
//
//  MODEL: Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere
//  Rendering Technique" - the LUT decomposition every modern engine ships -
//  over Bruneton's precomputed scattering. Distances are KILOMETRES in here.
//  The engine works in metres; the conversion happens at the boundary, once.
// ============================================================================

#ifndef FZE_ATMOSPHERE_GLSL
#define FZE_ATMOSPHERE_GLSL

const float FZE_ATMO_PI = 3.14159265358979323846;

// ---------------------------------------------------------------------------
//  Parameters. Nothing here is a constant: an alien sky is this struct with
//  different numbers in it, which is the whole reason it is a struct.
// ---------------------------------------------------------------------------
struct FZEAtmosphere {
    float BottomRadius;      // km, planet surface
    float TopRadius;         // km, top of the atmosphere

    vec3  RayleighScattering;  // 1/km, per channel - this is why the sky is blue
    float RayleighScaleHeight; // km

    vec3  MieScattering;       // 1/km
    vec3  MieAbsorption;       // 1/km
    float MieScaleHeight;      // km
    float MieAnisotropy;       // g, forward-scattering strength of the haze

    // ⚠️ OZONE IS NOT OPTIONAL AND IT IS NOT SCATTERING. It absorbs in the
    // yellow-green, it sits in a layer ~25 km up rather than falling off from
    // the ground, and it is the reason a clear zenith stays deep blue instead of
    // washing out and the reason twilight goes blue rather than grey. A model
    // without it looks like a photograph with the saturation pulled down.
    vec3  OzoneAbsorption;     // 1/km at the peak of the layer
    float OzoneCentre;         // km, altitude of the peak
    float OzoneWidth;          // km, half-width of the tent

    vec3  GroundAlbedo;        // what the planet bounces back into the sky
};

// ---------------------------------------------------------------------------
//  Geometry
// ---------------------------------------------------------------------------

// Distance to the nearest positive intersection with a sphere at the origin.
// Returns -1 when the ray misses or the sphere is behind.
float FZE_RaySphere(vec3 ro, vec3 rd, float radius) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - radius * radius;
    if (c > 0.0 && b > 0.0) return -1.0;           // outside and pointing away
    float disc = b * b - c;
    if (disc < 0.0) return -1.0;
    disc = sqrt(disc);
    float t0 = -b - disc, t1 = -b + disc;
    if (t1 < 0.0) return -1.0;
    return t0 < 0.0 ? t1 : t0;
}

// How far a ray travels before it leaves the atmosphere or hits the ground.
// `outHitGround` says which of the two happened, because the two mean opposite
// things to everything downstream: a ray that leaves gets the sky behind it, a
// ray that lands gets the planet.
float FZE_AtmoRayLength(FZEAtmosphere atmo, vec3 pos, vec3 dir, out bool outHitGround) {
    float ground = FZE_RaySphere(pos, dir, atmo.BottomRadius);
    float top    = FZE_RaySphere(pos, dir, atmo.TopRadius);
    outHitGround = ground > 0.0;
    return outHitGround ? ground : max(top, 0.0);
}

// ---------------------------------------------------------------------------
//  Medium
// ---------------------------------------------------------------------------
struct FZEMedium {
    vec3 Scattering;     // 1/km, what redirects light toward the eye
    vec3 Extinction;     // 1/km, what removes it from the beam
    vec3 RayleighScat;
    vec3 MieScat;
};

FZEMedium FZE_SampleMedium(FZEAtmosphere atmo, float heightKm) {
    FZEMedium m;
    float rayleighDensity = exp(-max(heightKm, 0.0) / max(atmo.RayleighScaleHeight, 1e-4));
    float mieDensity      = exp(-max(heightKm, 0.0) / max(atmo.MieScaleHeight, 1e-4));
    // A tent, not an exponential: the ozone layer has a peak with air above and
    // below it, so its density RISES with altitude and then falls again.
    float ozoneDensity = max(0.0,
        1.0 - abs(heightKm - atmo.OzoneCentre) / max(atmo.OzoneWidth, 1e-4));

    m.RayleighScat = atmo.RayleighScattering * rayleighDensity;
    m.MieScat      = atmo.MieScattering * mieDensity;
    m.Scattering   = m.RayleighScat + m.MieScat;
    m.Extinction   = m.Scattering
                   + atmo.MieAbsorption * mieDensity
                   + atmo.OzoneAbsorption * ozoneDensity;
    // Extinction can never be less than scattering, or a step would create light.
    m.Extinction   = max(m.Extinction, m.Scattering);
    return m;
}

// ---------------------------------------------------------------------------
//  Phase functions - which way scattered light goes.
// ---------------------------------------------------------------------------

// Rayleigh: symmetric, slightly stronger straight ahead and straight back. This
// gentle shape is why the whole sky glows rather than just the part near the sun.
float FZE_PhaseRayleigh(float cosTheta) {
    return 3.0 / (16.0 * FZE_ATMO_PI) * (1.0 + cosTheta * cosTheta);
}

// Mie, Cornette-Shanks: strongly forward. The haze around the sun, the bright
// band at the horizon, and the glare through a dusty afternoon are all this
// lobe. Preferred over plain Henyey-Greenstein because it stays finite and
// keeps the correct backscatter shoulder.
float FZE_PhaseMie(float cosTheta, float g) {
    g = clamp(g, -0.95, 0.95);
    float g2 = g * g;
    float num = 3.0 * (1.0 - g2) * (1.0 + cosTheta * cosTheta);
    float den = 8.0 * FZE_ATMO_PI * (2.0 + g2)
              * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
    return num / den;
}

// ---------------------------------------------------------------------------
//  Transmittance LUT parameterisation.
//
//  ⚠️ NOT A LINEAR MAP OF THE ANGLE. Almost all of the interesting variation in
//  transmittance happens within a couple of degrees of the horizon, where the
//  path length through the air changes by orders of magnitude; a linear cos
//  mapping spends nearly the whole texture on the boring half of the sky and
//  then bands badly exactly where the sunset is. Bruneton's mapping stretches
//  the horizon out using the distance to the atmosphere top, which is the
//  quantity actually varying.
// ---------------------------------------------------------------------------
vec2 FZE_TransmittanceUV(FZEAtmosphere atmo, float r, float mu) {
    float H   = sqrt(max(atmo.TopRadius * atmo.TopRadius
                       - atmo.BottomRadius * atmo.BottomRadius, 0.0));
    float rho = sqrt(max(r * r - atmo.BottomRadius * atmo.BottomRadius, 0.0));
    float discriminant = r * r * (mu * mu - 1.0) + atmo.TopRadius * atmo.TopRadius;
    float d    = max(0.0, -r * mu + sqrt(max(discriminant, 0.0)));
    float dMin = atmo.TopRadius - r;
    float dMax = rho + H;
    float xMu  = (d - dMin) / max(dMax - dMin, 1e-6);
    float xR   = rho / max(H, 1e-6);
    return vec2(xMu, xR);
}

void FZE_TransmittanceFromUV(FZEAtmosphere atmo, vec2 uv, out float r, out float mu) {
    float xMu = uv.x, xR = uv.y;
    float H   = sqrt(max(atmo.TopRadius * atmo.TopRadius
                       - atmo.BottomRadius * atmo.BottomRadius, 0.0));
    float rho = H * xR;
    r = sqrt(max(rho * rho + atmo.BottomRadius * atmo.BottomRadius, 0.0));
    float dMin = atmo.TopRadius - r;
    float dMax = rho + H;
    float d = dMin + xMu * (dMax - dMin);
    mu = (d == 0.0) ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
    mu = clamp(mu, -1.0, 1.0);
}

// Integrate extinction from a point out to the top of the atmosphere. Only ever
// called while BUILDING the transmittance LUT; everything else reads the table.
vec3 FZE_ComputeTransmittanceToTop(FZEAtmosphere atmo, float r, float mu, int steps) {
    vec3 origin = vec3(0.0, r, 0.0);
    vec3 dir    = vec3(sqrt(max(1.0 - mu * mu, 0.0)), mu, 0.0);
    bool hitGround;
    float len = FZE_AtmoRayLength(atmo, origin, dir, hitGround);
    if (hitGround) return vec3(0.0);            // the planet is in the way

    vec3 depth = vec3(0.0);
    float dt = len / float(steps);
    for (int i = 0; i < steps; ++i) {
        vec3 p = origin + dir * (float(i) + 0.5) * dt;
        FZEMedium m = FZE_SampleMedium(atmo, length(p) - atmo.BottomRadius);
        depth += m.Extinction * dt;
    }
    return exp(-depth);
}

// Transmittance between two points, as a ratio of two table reads. This is the
// identity that makes the whole LUT scheme work: T(A->B) = T(A->top)/T(B->top).
vec3 FZE_TransmittanceLookup(FZEAtmosphere atmo, sampler2D lut, float r, float mu) {
    vec2 uv = FZE_TransmittanceUV(atmo, r, mu);
    return texture(lut, uv).rgb;
}

// ---------------------------------------------------------------------------
//  Sky-View LUT parameterisation.
//
//  A latitude/longitude map around the VIEWER, with the sun placed at longitude
//  zero so the table only has to cover half of it. Latitude is warped so that
//  half the rows sit in the few degrees either side of the horizon - the same
//  reason the transmittance mapping is warped, and the difference between a
//  clean horizon and a stack of bands.
// ---------------------------------------------------------------------------
vec2 FZE_SkyViewUV(FZEAtmosphere atmo, float viewHeight, vec3 viewDir, vec3 sunDir) {
    // Horizon angle from the viewer's altitude: below this, you are looking at
    // the planet.
    float cosHorizon = -sqrt(max(viewHeight * viewHeight
                    - atmo.BottomRadius * atmo.BottomRadius, 0.0)) / max(viewHeight, 1e-4);
    float horizonAngle = acos(clamp(cosHorizon, -1.0, 1.0)) - 0.5 * FZE_ATMO_PI;
    float viewAngle    = 0.5 * FZE_ATMO_PI - acos(clamp(viewDir.y, -1.0, 1.0));

    float v;
    float rel = viewAngle - horizonAngle;
    if (rel < 0.0) {
        float t = rel / min(-0.5 * FZE_ATMO_PI - horizonAngle, -1e-4);
        v = 0.5 - 0.5 * sqrt(clamp(t, 0.0, 1.0));      // below the horizon
    } else {
        float t = rel / max(0.5 * FZE_ATMO_PI - horizonAngle, 1e-4);
        v = 0.5 + 0.5 * sqrt(clamp(t, 0.0, 1.0));      // above it
    }

    // Longitude measured from the sun, folded: the sky is symmetric about the
    // plane through the viewer, the zenith and the sun.
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 sunSide = normalize(sunDir - up * dot(sunDir, up) + vec3(1e-6, 0.0, 0.0));
    vec3 viewSide = viewDir - up * dot(viewDir, up);
    float len = length(viewSide);
    float u = 0.5;
    if (len > 1e-6) {
        viewSide /= len;
        float cosAzi = clamp(dot(viewSide, sunSide), -1.0, 1.0);
        u = acos(cosAzi) / FZE_ATMO_PI;
    }
    return vec2(u, v);
}

void FZE_SkyViewFromUV(FZEAtmosphere atmo, float viewHeight, vec2 uv,
                       out float cosViewZenith, out float cosAzimuth) {
    float cosHorizon = -sqrt(max(viewHeight * viewHeight
                    - atmo.BottomRadius * atmo.BottomRadius, 0.0)) / max(viewHeight, 1e-4);
    float horizonAngle = acos(clamp(cosHorizon, -1.0, 1.0)) - 0.5 * FZE_ATMO_PI;

    float viewAngle;
    if (uv.y < 0.5) {
        float t = 1.0 - 2.0 * uv.y;
        viewAngle = horizonAngle + t * t * (-0.5 * FZE_ATMO_PI - horizonAngle);
    } else {
        float t = 2.0 * uv.y - 1.0;
        viewAngle = horizonAngle + t * t * (0.5 * FZE_ATMO_PI - horizonAngle);
    }
    cosViewZenith = sin(viewAngle);
    cosAzimuth    = cos(uv.x * FZE_ATMO_PI);
}


// ---------------------------------------------------------------------------
//  The march.
//
//  One function does the sky, the multiple-scattering table and the aerial
//  perspective volume, because they are the same integral stopped at different
//  places. Splitting them into three marches is how the three end up disagreeing
//  about the colour of the same air.
// ---------------------------------------------------------------------------
struct FZEScatterResult {
    vec3 Luminance;        // what arrives at the eye
    vec3 Transmittance;    // what survives the trip, for compositing
    vec3 MultiScatterAs1;  // the "one bounce" term the multi-scatter LUT needs
};

FZEScatterResult FZE_IntegrateScatteredLuminance(
        FZEAtmosphere atmo, sampler2D transLUT, sampler2D msLUT,
        vec3 rayStart, vec3 rayDir, vec3 sunDir, vec3 sunIlluminance,
        int steps, float maxDistanceKm, bool applyMultiScatter, bool applyPhase,
        float ditherOffset, bool usePlanetGround)
{
    FZEScatterResult res;
    res.Luminance = vec3(0.0);
    res.Transmittance = vec3(1.0);
    res.MultiScatterAs1 = vec3(0.0);

    // ⚠️ THE AERIAL VOLUME MUST NOT KNOW ABOUT THE PLANET, and this is not a
    // detail. The sky is drawn against an idealised sphere - looking down past
    // the horizon you should see the planet's ground, and its bounce is real
    // light. The volume between the eye and the WORLD is a different question:
    // whatever is at the end of that ray is the scene's own terrain, already
    // being shaded by the renderer, and it is nowhere near the sphere. Letting
    // the sphere terminate those rays made every froxel in front of a
    // downward-looking camera return the same thing - the ray hit the planet
    // after a few metres, so slice 15 at eight kilometres held slice 0's answer,
    // and the whole volume stopped varying with distance while still looking
    // like plausible haze. Measured: all sixteen slices identical, transmittance
    // 0.9995 at 8 km where the real figure is 0.892.
    bool hitGround = false;
    float len;
    if (usePlanetGround) {
        len = FZE_AtmoRayLength(atmo, rayStart, rayDir, hitGround);
    } else {
        len = max(FZE_RaySphere(rayStart, rayDir, atmo.TopRadius), 0.0);
    }
    if (len <= 0.0) return res;
    if (maxDistanceKm > 0.0) { len = min(len, maxDistanceKm); hitGround = hitGround && (len < maxDistanceKm); }

    float cosTheta   = dot(rayDir, sunDir);
    float phaseR     = applyPhase ? FZE_PhaseRayleigh(cosTheta) : 1.0 / (4.0 * FZE_ATMO_PI);
    float phaseM     = applyPhase ? FZE_PhaseMie(cosTheta, atmo.MieAnisotropy)
                                  : 1.0 / (4.0 * FZE_ATMO_PI);

    float dt = len / float(steps);
    for (int i = 0; i < steps; ++i) {
        // ⚠️ THE SAMPLE SITS INSIDE ITS SLICE, NOT AT THE EDGE. Marching from the
        // start of each segment biases the whole integral toward the near end and
        // shows up as a bright rim at the horizon; the offset also carries the
        // caller's dither so the step pattern breaks up instead of banding.
        float t = (float(i) + ditherOffset) * dt;
        vec3 p = rayStart + rayDir * t;
        float height = length(p) - atmo.BottomRadius;
        FZEMedium medium = FZE_SampleMedium(atmo, height);

        vec3 stepTransmittance = exp(-medium.Extinction * dt);

        // Sunlight reaching this point, and whether the planet is in the way.
        float r  = length(p);
        float muS = dot(normalize(p), sunDir);
        vec3 sunT = FZE_TransmittanceLookup(atmo, transLUT, r, muS);
        float shadow = (FZE_RaySphere(p, sunDir, atmo.BottomRadius) > 0.0) ? 0.0 : 1.0;

        vec3 scattered = medium.RayleighScat * phaseR + medium.MieScat * phaseM;
        vec3 inScatter = sunT * scattered * shadow;

        if (applyMultiScatter) {
            // The rest of the light: everything that bounced more than once
            // before it got here. Without it the sky is far too dark near the
            // horizon and a hazy day looks like a clear one.
            vec2 msUV = vec2(clamp(muS * 0.5 + 0.5, 0.0, 1.0),
                             clamp((r - atmo.BottomRadius)
                                   / max(atmo.TopRadius - atmo.BottomRadius, 1e-4), 0.0, 1.0));
            vec3 ms = texture(msLUT, msUV).rgb;
            inScatter += ms * medium.Scattering;
        }

        // ⚠️ ANALYTIC INTEGRATION OVER THE SEGMENT, NOT A RECTANGLE. Multiplying
        // the in-scatter by dt assumes the light is not being absorbed on its way
        // out of the very slice it was scattered in, which over-brightens every
        // step and compounds along the ray. The closed form of that integral is
        // exact for a constant medium over the segment and costs one divide.
        vec3 safeExt = max(medium.Extinction, vec3(1e-7));
        vec3 integral = (inScatter - inScatter * stepTransmittance) / safeExt;
        res.Luminance += res.Transmittance * integral;

        vec3 msIntegral = (medium.Scattering - medium.Scattering * stepTransmittance) / safeExt;
        res.MultiScatterAs1 += res.Transmittance * msIntegral;

        res.Transmittance *= stepTransmittance;
    }

    // Light bounced off the planet back up into the air the ray passed through.
    if (hitGround && length(atmo.GroundAlbedo) > 0.0) {
        vec3 p = rayStart + rayDir * len;
        float NdotL = clamp(dot(normalize(p), sunDir), 0.0, 1.0);
        vec3 sunT = FZE_TransmittanceLookup(atmo, transLUT, length(p), NdotL);
        res.Luminance += res.Transmittance * sunT * NdotL * atmo.GroundAlbedo / FZE_ATMO_PI;
    }

    res.Luminance *= sunIlluminance;
    return res;
}

#endif  // FZE_ATMOSPHERE_GLSL
