#ifndef FZE_FOLIAGE_GLSL
#define FZE_FOLIAGE_GLSL
// =============================================================================
//  FOLIAGE: what the scatter pass and the plants' vertex shaders share.
//
//  Engine/Foliage/Foliage.cpp mirrors FZE_FHash / FZE_FValueNoise on the CPU
//  (the tests check the rule against it). Change one, change the other.
// =============================================================================

// One plant, as the scatter pass writes it and the draws read it (std430).
//   PosScale: xyz where its root is (world), w its height in metres
//   Data.x:   packHalf2x16(yaw radians, spread) - spread widens a far plant
//             so fewer of them still cover the ground
//   Data.y:   colour variation, 0..1 (a slow noise: patches, not speckle)
//   Data.z:   dryness, 0..1
//   Data.w:   packSnorm2x16(the ground's normal xz, times how much it leans)
struct FZEPlant { vec4 PosScale; vec4 Data; };

uint FZE_FHash(uint x) {
    x ^= x >> 16u; x *= 0x7feb352du;
    x ^= x >> 15u; x *= 0x846ca68bu;
    x ^= x >> 16u;
    return x;
}
uint FZE_FHash3(ivec2 c, uint seed) {
    return FZE_FHash(uint(c.x) * 0x8da6b343u ^ FZE_FHash(uint(c.y) * 0xd8163841u ^ seed * 0xcb1ab31fu));
}
// The k-th independent number in 0..1 from one hash.
float FZE_FRand(uint h, uint k) {
    return float(FZE_FHash(h + k * 0x9e3779b9u) & 0xffffffu) / 16777216.0;
}
float FZE_FValueNoise(vec2 p, uint seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    ivec2 c = ivec2(i);
    float a = float(FZE_FHash3(c, seed) & 0xffffu) / 65535.0;
    float b = float(FZE_FHash3(c + ivec2(1, 0), seed) & 0xffffu) / 65535.0;
    float d = float(FZE_FHash3(c + ivec2(0, 1), seed) & 0xffffu) / 65535.0;
    float e = float(FZE_FHash3(c + ivec2(1, 1), seed) & 0xffffu) / 65535.0;
    return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
// Patches: two octaves, 0..1, about half the ground above 0.5.
float FZE_FClump(vec2 xz, float size, uint seed) {
    return 0.65 * FZE_FValueNoise(xz / size, seed) + 0.35 * FZE_FValueNoise(xz / (size * 0.37), seed + 7u);
}

// ---- the wind ----------------------------------------------------------------
uniform vec2  u_WindDir;     // unit, xz: where it blows TO
uniform float u_WindSpeed;   // m/s at plant height
uniform float u_WindGust;    // 0..1
uniform float u_Time;        // seconds

// ⚠️ A GUST IS SOMETHING THAT CROSSES THE FIELD. Every plant swaying on its
// own clock is what grass in a game looks like; what a meadow in wind looks
// like is waves - a gust flattening one band of grass after another as it
// travels downwind. Taylor's frozen-turbulence picture says exactly that: the
// eddies are carried along at the mean wind speed, so the gust field is a
// noise moved downwind at u_WindSpeed, and a plant bends with the gust that
// is over it now.
//
// Returns the tangent of the bend at the tip, as a direction in xz: a blade
// bends under the wind's drag (the square of its speed) against its own
// stiffness, and sways about that at a couple of hertz.
vec2 FZE_FoliageWind(vec2 xz, float stiffness, float phase) {
    vec2 q = xz - u_WindDir * (u_WindSpeed * u_Time);
    float g = 0.65 * FZE_FValueNoise(q / 16.0, 11u) + 0.35 * FZE_FValueNoise(q / 5.0, 12u);
    float v = u_WindSpeed * mix(1.0 - 0.7 * u_WindGust, 1.0 + 1.3 * u_WindGust, g);
    float k = 1.0 / (0.25 + 1.5 * stiffness);
    float bend = min(v * v * 0.012 * k, 1.3);
    float sway = sin(u_Time * (2.4 + 1.2 * phase) + phase * 6.2831853) * v * 0.028 * k;
    vec2 across = vec2(-u_WindDir.y, u_WindDir.x);
    return u_WindDir * (bend + sway) + across * sway * 0.35;
}

// =============================================================================
//  A TREE IN THE WIND: THE TRUNK, THE BRANCHES, THE TIPS.
//
//  ⚠️ A TREE IS NOT A TALL BLADE OF GRASS. Trees were bent by the grass's wind and
//  then shaken: a 14 m pine leaned 2.8 m at 5 m/s, swayed 1.35 m either side three
//  times a second, and every vertex of its crown, trunk included, shook 30 cm at
//  7 to 9 Hz. It read as a tree made of jelly. A real one sways slowly, a few
//  tenths of a hertz, slower the taller it is (conifers behave as a cantilever:
//  Jackson et al. 2019), and the motion splits as Crysis split it (Sousa, GPU Gems
//  3 ch. 16): the whole tree bends with the wind, the branches bob on their own
//  phase, and only the tips flutter, finely.
//
//  `still`: the pose the cached sun shadow is drawn with. That shadow is kept for
//  many frames and redrawn when the view moves, so a swaying pose in it made the
//  trees' shadows jump at every redraw; it gets the wind's average lean instead,
//  and the lit tree sways a few centimetres about it.
// =============================================================================
vec2 FZE_TreeLean(vec2 xz, float height, float stiffness, float phase, bool still) {
    float v = u_WindSpeed;
    float k = 1.0 / (0.25 + 1.5 * stiffness);
    float mean = min(v * v * 0.0009 * k, 0.06);          // 5 m/s: 0.2 m at the top of 14 m
    vec2 across = vec2(-u_WindDir.y, u_WindDir.x);
    if (still) return u_WindDir * mean;
    // The gust crossing the wood, slowly, with the wind.
    float gust = FZE_FValueNoise((xz - u_WindDir * (v * u_Time)) / 40.0, 13u);
    gust = mix(1.0 - 0.6 * u_WindGust, 1.0 + 0.8 * u_WindGust, gust);
    float f0 = 0.32 * sqrt(14.0 / max(height, 2.0));     // Hz: a 14 m pine at a third of a hertz
    float sway = sin(6.2831853 * (f0 * u_Time + phase));
    return u_WindDir * mean * (gust + 0.25 * sway) + across * mean * 0.15 * sway;
}

// What moves on a tree on top of its lean, in world units. `m` is the vertex in the
// model's heights (the trunk is its axis), `n` its normal.
vec3 FZE_TreeBranches(vec3 m, vec3 n, float h01, float height, float phase, vec2 xz) {
    float v = u_WindSpeed;
    float strength = 0.3 + 0.12 * v;
    float gust = mix(0.6, 1.4, FZE_FValueNoise((xz - u_WindDir * (v * u_Time)) / 40.0, 13u));
    // A branch: away from the trunk, and moving as one piece - its phase changes slowly
    // across the crown, so the vertices of one branch keep together.
    float wb = smoothstep(0.02, 0.22, length(m.xz)) * h01;
    float bob = sin(6.2831853 * (1.1 + 0.4 * phase) * u_Time + dot(m, vec3(3.0, 2.1, 3.9)) + phase * 6.2831853);
    float amp = height * 0.004 * strength * gust * wb;   // 5 m/s: 5 cm on a 14 m pine
    vec3 off = vec3(u_WindDir.x, 0.5, u_WindDir.y) * bob * amp;
    // The tips of the needles and leaves, finer and faster, each cluster its own clock.
    float tipW = wb * wb;
    off += n * sin(6.2831853 * (4.5 + phase) * u_Time + dot(m, vec3(41.0, 29.0, 37.0))) * height * 0.0008 * strength * tipW;
    return off;
}

// A vertex `h01` of the way up a plant `height` tall, bent so its tip leans
// by `tipTan` (the tangent of the lean, in xz): the stem curves like a
// cantilever (the offset grows with the square of the height) and the top
// comes down as it leans, so the blade keeps roughly its length.
vec3 FZE_FoliageBend(vec3 p, vec3 root, float h01, float height, vec2 tipTan) {
    float t = h01 * h01;
    vec2 off = tipTan * height * t;
    float lean = length(tipTan) * h01;
    float drop = height * h01 * (1.0 - inversesqrt(1.0 + lean * lean));
    return p + vec3(off.x, -drop, off.y);
}

#endif
