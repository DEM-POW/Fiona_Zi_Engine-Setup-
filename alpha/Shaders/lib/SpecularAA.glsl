// ---------------------------------------------------------------
//  Fiona Zi Engine — a highlight that is smaller than a pixel
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// ⚠️ THIS IS WHY WET GROUND LOOKED LIKE BLOCKS OF WHITE. Rain drives roughness
// down - 0.55x under the water film, and as low as 0.02 in standing water -
// which is the correct thing to do to a wet surface and turns it into a mirror.
// A mirror reflecting the sun has a highlight a fraction of a degree wide. On
// ground whose normal changes from one pixel to the next, that highlight lands
// inside some pixels and misses their neighbours entirely, so a smooth wet slope
// renders as a scatter of blown-out white dots that crawl when the camera moves.
// It reads as blockiness, or as noise, or as "the wetness is broken" - and every
// one of those is a description of the symptom rather than the cause.
//
// The cause is that a pixel is not a point. It covers an area of surface with a
// RANGE of normals in it, and the right answer for that pixel is the average of
// the highlight over the whole range - which is a wider, dimmer highlight, not a
// sampled one. So the width of the normal spread inside the pixel is folded into
// the roughness. Where the surface is flat across a pixel nothing changes at
// all; where it is curved or bumpy the highlight widens exactly enough to stop
// falling between samples.
//
// Kaplanyan et al., "Filtering Distributions of Normals for Shading
// Antialiasing" (2016), in the screen-space form Ubisoft published in 2019.
// Two constants: how much of the measured spread to believe, and a ceiling so
// that a surface seen edge-on does not go completely matte.

float FZE_SpecularAA(float roughness, vec3 N) {
    const float SIGMA = 0.55;   // how much of the pixel-footprint spread to use
    const float KAPPA = 0.18;   // ceiling, so a grazing surface stays a surface

    // How far the normal moves across one pixel, in both screen directions.
    vec3 dNdx = dFdx(N);
    vec3 dNdy = dFdy(N);
    float variance = SIGMA * (dot(dNdx, dNdx) + dot(dNdy, dNdy));

    // Roughness is the width of the microfacet distribution; the pixel footprint
    // is another distribution on top of it, and variances add. Squaring first is
    // not optional - roughness is not linear in the thing being added.
    float kernel = min(2.0 * variance, KAPPA);
    return sqrt(clamp(roughness * roughness + kernel, 0.0, 1.0));
}
