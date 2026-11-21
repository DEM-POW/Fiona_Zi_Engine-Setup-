// ---------------------------------------------------------------
//  Fiona Zi Engine — a direction in two numbers
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// Octahedral encoding (Cigolle et al., "A Survey of Efficient Representations
// for Independent Unit Vectors", 2014): the sphere folded onto a square, so a
// normal fits two channels of the surface target with an even error everywhere
// - unlike storing xy and rebuilding z, which loses the sign and is worst at
// the horizon, where a floor seen at a grazing angle needs it most.
#ifndef FZE_OCTAHEDRAL_GLSL
#define FZE_OCTAHEDRAL_GLSL

vec2 FZE_OctSign(vec2 v) { return vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0); }

// Unit vector -> [-1, 1]^2.
vec2 FZE_OctEncode(vec3 n) {
    n /= max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6);
    return n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * FZE_OctSign(n.xy);
}

// [-1, 1]^2 -> unit vector.
vec3 FZE_OctDecode(vec2 e) {
    vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
    if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * FZE_OctSign(n.xy);
    return normalize(n);
}

#endif
