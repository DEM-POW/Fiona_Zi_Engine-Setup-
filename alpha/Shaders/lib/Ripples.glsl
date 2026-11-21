// ---------------------------------------------------------------
//  Fiona Zi Engine — rain rings on standing water
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//  A raindrop landing in still water leaves a ring that spreads and dies in
//  about a second. There are far too many to track - hundreds a square metre
//  a second in heavy rain - so they are generated where they are shaded, from
//  position and time: the surface is divided into cells, each holding one ring
//  at a time on its own clock, and the clock runs faster the harder it rains.
//
//  The ring is a small damped wave packet: it travels at the speed of capillary
//  waves of its length (~0.25 m/s for the ~2 cm ripples a drop makes), its
//  crest a couple of centimetres wide, its height falling off as it spreads
//  and as it ages. The shader needs only its SLOPE - the normal it tilts.
//
//  Used by puddles (lib/Weather.glsl) and by open water (Water.frag): one
//  answer to "what does rain do to water".
// ---------------------------------------------------------------
#ifndef FZE_RIPPLES_GLSL
#define FZE_RIPPLES_GLSL

const float FZE_RING_CELL  = 0.33;    // metres between ring sources
const float FZE_RING_SPEED = 0.25;    // m/s, capillary-gravity waves ~2 cm long
const float FZE_RING_WIDTH = 0.018;   // metres, the width of the crest
const float FZE_RING_AMP   = 0.0012;  // metres, crest height at the start: a millimetre

vec2 FZE_RingHash2(vec2 c) {
    vec3 p3 = fract(vec3(c.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

// One layer of rings: cells offset by `layer`, each on its own clock.
vec2 FZE_RainRingLayer(vec2 p, float time, float rate, float layer) {
    // One ring per cell per period. The period shortens as the square root of
    // the rate - what the eye reads as "more rings" - from ~4 s in a drizzle
    // to ~0.4 s in a downpour.
    float period = clamp(3.0 / sqrt(rate), 0.35, 5.0);
    vec2 shift = FZE_RingHash2(vec2(layer * 7.7, layer * 3.1)) * FZE_RING_CELL;
    time += layer * 1.37;
    p += shift;
    vec2 g = p / FZE_RING_CELL;
    // ⚠️ THE FOUR NEAREST CELLS, NOT NINE. A ring is born in the middle 70% of
    // its cell and has damped away by the time it has spread a third of a
    // cell, so only the cells whose half the point is in can reach it: the
    // 2 x 2 block round the nearest corner. Nine was 2.25 times the work for
    // rings too faint to see.
    vec2 base = floor(g - 0.5);
    vec2 slope = vec2(0.0);
    for (int j = 0; j <= 1; ++j)
        for (int i = 0; i <= 1; ++i) {
            vec2 cell = base + vec2(float(i), float(j));
            vec2 h = FZE_RingHash2(cell + layer * 17.0);
            float tc = time / period + h.x * 7.31;
            float age = fract(tc) * period;              // seconds since this ring began
            // A new ring lands somewhere new in its cell each time.
            vec2 jitter = FZE_RingHash2(cell + floor(tc) * 1.618);
            vec2 c = (cell + 0.15 + jitter * 0.7) * FZE_RING_CELL;
            vec2 d = p - c;
            float dist = length(d) + 1e-5;
            float r = age * FZE_RING_SPEED;
            float x = (dist - r) / FZE_RING_WIDTH;
            if (abs(x) > 3.0) continue;
            // A crest with a trough either side, damped by age and spreading.
            float env = exp(-0.5 * x * x) * exp(-age * 2.5) / (1.0 + 8.0 * r);
            float dhdr = -FZE_RING_AMP * env * (x * cos(2.4 * x) + 2.4 * sin(2.4 * x)) / FZE_RING_WIDTH;
            slope += (d / dist) * dhdr;
        }
    return slope;
}

// Slope (dh/dx, dh/dz) of the rain rings at p (world x/z, metres).
// rate: mm/h falling here now.
//
// ⚠️ LAYERS, ADDED AS THE RAIN HARDENS (Lagarde, "Water drop 3b": four layers
// of rings, each enabled by a quarter of the intensity). One grid of cells
// holds one ring at a time each; a downpour has rings overlapping rings, so
// more grids join in, offset from each other - and a drizzle pays for one.
vec2 FZE_RainRingSlope(vec2 p, float time, float rate) {
    if (rate <= 0.01) return vec2(0.0);
    vec2 slope = FZE_RainRingLayer(p, time, rate, 0.0);
    if (rate > 4.0)  slope += FZE_RainRingLayer(p, time, rate, 1.0) * smoothstep(4.0, 8.0, rate);
    if (rate > 15.0) slope += FZE_RainRingLayer(p, time, rate, 2.0) * smoothstep(15.0, 25.0, rate);
    if (rate > 40.0) slope += FZE_RainRingLayer(p, time, rate, 3.0) * smoothstep(40.0, 60.0, rate);
    return slope;
}

#endif  // FZE_RIPPLES_GLSL
