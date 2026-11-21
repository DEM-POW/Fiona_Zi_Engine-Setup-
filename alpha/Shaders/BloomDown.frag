#version 460 core
#include "lib/Finite.glsl"     // one bad pixel never spreads (R0)

// ============================================================================
//  THE LENS SPREADS LIGHT FAR, AND IT SPREADS IT ROUND.
//
//  A camera or an eye does not keep a point of light in its pixel: some of it
//  lands around it, a little of it lands far away, and a source a hundred
//  thousand times brighter than the sky - the sun - shows that tail across a
//  good part of the frame. The old bloom was one half-resolution buffer blurred
//  by a 9-tap kernel five times, three passes across and two down: a glow a
//  few pixels wide, taller than it was wide, and at half resolution its edge
//  came out in steps - the sun sat in a white ROUNDED SQUARE.
//
//  This is the standard answer (Jimenez, "Next Generation Post Processing in
//  Call of Duty: Advanced Warfare", 2014): halve the image six times, each step
//  a 13-tap filter that covers a 4x4 block of the level above, then climb back
//  up adding each level on the way (BloomUp.frag). The sum of six blurs whose
//  widths double is a round kernel with a long, smooth tail - the shape a real
//  lens's glare has - and every step is filtered, so nothing shows its pixels.
// ============================================================================

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Src;
uniform vec2  u_SrcTexel;     // one texel of the level being read

// ⚠️ THE SUN'S DISC DOES NOT GO DOWN THIS CHAIN AT ITS OWN BRIGHTNESS. Half float ends at
// 65504 and the disc is over it, and one infinity in a weighted average is a NaN that
// spreads through all six levels: that is why there is a ceiling at all. It stood at 60000,
// and at that the disc is a few pixels with the weight of the whole sky: the frame it came
// over the edge of the screen, or out from behind a roof, the picture round it jumped by a
// third of its brightness in two frames (measured in the Lab on a camera tilting up: 114,
// 123, 159, where without bloom the same frames go 114, 116, 118). No picture of the sun
// shows that; a player sees it every time. The long veil round the sun is SunGlare's, in
// Composite.frag, which fades in as the sun nears the frame. This chain is left the glow of
// things in the picture, lamps and hot metal, for which this ceiling is still far above white.
vec3 Safe(vec3 c) { return min(max(FZE_Finite(c), vec3(0.0)), vec3(32.0)); }

// ⚠️ NO THRESHOLD AND NO KARIS WEIGHT. The lens scatters every ray, so the
// whole image goes down the chain (Environment::BloomIntensity). And the
// usual firefly guard - weighting each block by 1 / (1 + its brightness) -
// is built for one flickering pixel; the sun is a steady disc many pixels
// across, and the guard took it for a firefly: it weighed the disc at 1/60000
// of the sky beside it, and the sun had almost no glow at all.
vec3 Tap(vec2 o) { return Safe(texture(u_Src, v_UV + u_SrcTexel * o).rgb); }

void main() {
    vec3 a = Tap(vec2(-2.0,  2.0)), b = Tap(vec2(0.0,  2.0)), c = Tap(vec2(2.0,  2.0));
    vec3 d = Tap(vec2(-2.0,  0.0)), e = Tap(vec2(0.0,  0.0)), f = Tap(vec2(2.0,  0.0));
    vec3 g = Tap(vec2(-2.0, -2.0)), h = Tap(vec2(0.0, -2.0)), i = Tap(vec2(2.0, -2.0));
    vec3 j = Tap(vec2(-1.0,  1.0)), k = Tap(vec2(1.0,  1.0));
    vec3 l = Tap(vec2(-1.0, -1.0)), m = Tap(vec2(1.0, -1.0));

    vec3 s = e * 0.125
           + (a + c + g + i) * 0.03125
           + (b + d + f + h) * 0.0625
           + (j + k + l + m) * 0.125;
    FragColor = vec4(s, 1.0);
}
