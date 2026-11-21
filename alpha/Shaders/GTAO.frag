#version 460 core

// ============================================================================
//  GROUND TRUTH AMBIENT OCCLUSION
//
//  The old pass answered "how many of my sample points are buried?" - it threw
//  darts into a hemisphere, counted the ones that landed behind a surface, and
//  called the fraction occlusion. That number is not the occlusion integral. It
//  has no cosine weighting, so a blocker lying flat against the surface counts
//  exactly as much as one directly overhead; it is noisy, because it is Monte
//  Carlo with twelve samples; and it has no correct answer to converge to,
//  which is why AO strength has always been a taste knob rather than a measured
//  quantity.
//
//  GTAO asks a different question, per direction: HOW HIGH IS THE HORIZON? It
//  walks along a line across the screen, finds the largest angle anything rises
//  to, and then solves the visibility integral over that arc ANALYTICALLY -
//  cosine weighting included. Every sample contributes to a horizon rather than
//  to a count, so a handful of them already describe the arc, and the error
//  that remains is in the horizon's position, not in the integral.
//
//  ⚠️ THE ARC INTEGRAL IS WHERE THE "GROUND TRUTH" IS, AND IT IS THE PART
//  PEOPLE DROP. Having found the two horizon angles it is very tempting to
//  return 1 - (h1 + h2)/pi and be done. That is the UNIFORM visibility of the
//  arc, and ambient light does not arrive uniformly - it arrives weighted by
//  the cosine to the surface. The closed form below is that weighted integral,
//  and it is the difference between matching a reference and merely being dark.
//
//  ⚠️ AND THE NORMAL IS TAKEN FROM THE CLOSER NEIGHBOUR ON EACH AXIS, not from
//  dFdx/dFdy of the reconstructed position. Screen derivatives straddle every
//  silhouette: at the edge of a lamp post one of the two samples is twenty
//  metres away and the normal points somewhere absurd, which draws a dark halo
//  around every object standing against the sky. The same trap, and the same
//  fix, as the reflection pass.
//
//  Jimenez et al., "Practical Realtime Strategies for Accurate Indirect
//  Occlusion" (SIGGRAPH 2016).
// ============================================================================

in vec2 v_UV;
out float FragColor;

uniform sampler2D u_Depth;      // camera depth prepass
uniform mat4  u_InvVP;          // inverse(view-projection): NDC -> world
uniform vec3  u_CameraPos;
uniform vec2  u_TexelSize;      // 1 / AO buffer size
uniform float u_Radius;         // world metres the horizon search reaches
uniform float u_Intensity;
uniform int   u_Samples;        // total taps, split between slices and steps
uniform int   u_Slices;         // directions across the screen

const float PI      = 3.14159265359;
const float HALF_PI = 1.57079632679;

vec3 Reconstruct(vec2 uv, float d) {
    vec4 w = u_InvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return w.xyz / w.w;
}

void main() {
    float d = texture(u_Depth, v_UV).r;
    if (d >= 1.0) { FragColor = 1.0; return; }   // sky: nothing occludes it

    vec3 P = Reconstruct(v_UV, d);
    vec3 V = normalize(u_CameraPos - P);

    // ---- the normal, from whichever neighbour is on the same surface --------
    vec2 tx = u_TexelSize;
    float dr = texture(u_Depth, v_UV + vec2(tx.x, 0.0)).r;
    float dl = texture(u_Depth, v_UV - vec2(tx.x, 0.0)).r;
    float du = texture(u_Depth, v_UV + vec2(0.0, tx.y)).r;
    float dd = texture(u_Depth, v_UV - vec2(0.0, tx.y)).r;
    vec3 ddx = abs(dr - d) < abs(dl - d)
             ? Reconstruct(v_UV + vec2(tx.x, 0.0), dr) - P
             : P - Reconstruct(v_UV - vec2(tx.x, 0.0), dl);
    vec3 ddy = abs(du - d) < abs(dd - d)
             ? Reconstruct(v_UV + vec2(0.0, tx.y), du) - P
             : P - Reconstruct(v_UV - vec2(0.0, tx.y), dd);
    vec3 N = normalize(cross(ddx, ddy));
    if (dot(N, V) < 0.0) N = -N;

    // ---- how far the radius reaches across the screen at this depth --------
    //
    // ⚠️ THE SEARCH IS A WORLD RADIUS AND THE MARCH IS IN PIXELS, so the two
    // have to be related per pixel. Reconstructing a second point at the SAME
    // depth a known distance away in UV gives exactly that conversion: metres
    // per UV unit on this depth plane. A fixed pixel radius instead - which is
    // what most quick implementations use - makes occlusion shrink with
    // distance, so a wall's skirting darkens as you walk towards it.
    float metresPerUV = length(Reconstruct(v_UV + vec2(0.01, 0.0), d) - P) * 100.0;
    float uvRadius = clamp(u_Radius / max(metresPerUV, 1e-4), tx.x * 2.0, 0.12);

    // Interleaved gradient noise: the slice angle and the step offset both come
    // from it, so neighbouring pixels sample different directions and the blur
    // afterwards averages them into each other.
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy,
                                             vec2(0.06711056, 0.00583715))));

    int slices = clamp(u_Slices, 1, 8);
    int steps  = clamp(u_Samples / slices, 2, 16);

    float visibility = 0.0;
    for (int s = 0; s < slices; ++s) {
        float phi = (float(s) + ign) * PI / float(slices);
        vec2  dir = vec2(cos(phi), sin(phi));

        // The slice is the plane through the view ray and this screen direction.
        vec3 sliceDir = Reconstruct(v_UV + dir * 0.01, d) - P;
        float sl = length(sliceDir);
        if (sl < 1e-6) continue;
        sliceDir /= sl;

        // The normal projected into that plane, and its angle from the view ray.
        vec3 sliceN = cross(sliceDir, V);
        float snl = length(sliceN);
        if (snl < 1e-5) continue;
        sliceN /= snl;
        vec3 projN = N - sliceN * dot(N, sliceN);
        float projLen = length(projN);
        if (projLen < 1e-4) continue;
        projN /= projLen;
        // ⚠️ THE SIDE OF THE VIEW RAY IS ASKED OF THE DIRECTION SQUARED TO IT
        // (Jimenez et al. 2016: orthoDirectionVec). sliceDir lies in the plane of
        // constant view depth, not across the ray; near the edge of a wide view
        // (this camera is 121 degrees across) it runs half along V, and that half
        // decided the sign. A step of the camera tipped it, n changed sign, and
        // every wall facing the camera at the side of the picture jumped between
        // two occlusions - 0.29 and 0.85 on one pixel of the Lab's cover wall in
        // consecutive frames, measured, which a player sees as the light on that
        // wall going off and on as they walk.
        vec3 orthoDir = sliceDir - V * dot(sliceDir, V);
        float ol = length(orthoDir);
        if (ol < 1e-5) continue;
        float n = sign(dot(projN, orthoDir / ol)) * acos(clamp(dot(projN, V), -1.0, 1.0));

        // ---- walk both ways and keep the highest horizon -------------------
        float cH1 = -1.0, cH2 = -1.0;      // cos(angle from V); -1 = flat
        for (int i = 1; i <= steps; ++i) {
            vec2 off = dir * uvRadius * ((float(i) - 0.5 + ign) / float(steps));

            vec2 uvA = v_UV + off;
            float dA = texture(u_Depth, uvA).r;
            if (dA < 1.0) {
                vec3 S = Reconstruct(uvA, dA) - P;
                float len = length(S);
                float c = dot(S / max(len, 1e-5), V);
                // ⚠️ ONE TERM DOES TWO JOBS HERE AND BOTH ARE NECESSARY. It
                // fades the horizon out at the edge of the radius, so occlusion
                // ends smoothly instead of at a visible circle; and because a
                // new horizon is only PARTLY accepted, a thin object - a
                // railing, a cable, a lamp post seen edge on - lifts the
                // horizon a little instead of shadowing everything behind it.
                // Screen space cannot see how thick a blocker is; this is the
                // admission of that, rather than a pretence otherwise.
                float w = 1.0 - smoothstep(u_Radius * 0.6, u_Radius, len);
                if (c > cH2) cH2 = mix(cH2, c, w);
            }

            vec2 uvB = v_UV - off;
            float dB = texture(u_Depth, uvB).r;
            if (dB < 1.0) {
                vec3 S = Reconstruct(uvB, dB) - P;
                float len = length(S);
                float c = dot(S / max(len, 1e-5), V);
                float w = 1.0 - smoothstep(u_Radius * 0.6, u_Radius, len);
                if (c > cH1) cH1 = mix(cH1, c, w);
            }
        }

        // ---- the arc between the two horizons, cosine weighted -------------
        float h1 = -acos(clamp(cH1, -1.0, 1.0));
        float h2 =  acos(clamp(cH2, -1.0, 1.0));
        h1 = n + max(h1 - n, -HALF_PI);
        h2 = n + min(h2 - n,  HALF_PI);
        float sn = sin(n), cn = cos(n);
        float a = 0.25 * ((-cos(2.0 * h1 - n) + cn + 2.0 * h1 * sn)
                        + (-cos(2.0 * h2 - n) + cn + 2.0 * h2 * sn));
        visibility += projLen * a;
    }

    visibility /= float(slices);
    FragColor = clamp(1.0 - (1.0 - visibility) * u_Intensity, 0.0, 1.0);
}
