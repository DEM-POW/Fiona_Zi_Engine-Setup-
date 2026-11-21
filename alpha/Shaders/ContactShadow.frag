#version 460 core

// ============================================================================
//  THE SHADOW WHERE THINGS TOUCH
//
//  A cascade covering 25 metres across 2048 texels is 12 mm per texel, and the
//  depth bias that stops it self-shadowing throws away another few centimetres.
//  Everything closer to the ground than that has no shadow at all: a book on a
//  table, a kerbstone, a chair leg, a slab lying 2 cm proud. The engine draws
//  them correctly and they look like they are hovering, because the one cue that
//  says "this is touching" is the dark line where it meets the floor.
//
//  ⚠️ THE SHADOW MAP CANNOT BE FIXED BY MAKING IT BIGGER. Four times the
//  resolution is four times the memory and one octave of improvement - 3 mm per
//  texel instead of 12 - and the bias problem does not move at all, because the
//  bias exists to hide the map's own depth quantisation. The gap this fills is
//  structural.
//
//  So the last few centimetres are done in screen space instead, where the
//  resolution is the resolution of the picture: from each pixel, walk a short
//  way towards the sun and ask the depth buffer whether anything is in the way.
//
//  ⚠️ AND IT IS A SHORT WALK ON PURPOSE. This is not a cheap replacement for the
//  shadow map - it cannot see anything off-screen or behind another surface, so
//  asked to reach metres it produces streaks that swim as the camera turns. A
//  third of a metre is about what a contact needs, and it is exactly the range
//  the cascade is worst at.
// ============================================================================

in vec2 v_UV;
// ⚠️ vec4, AND THE ANSWER GOES IN GREEN. This pass shares a texture with the
// ambient occlusion and is masked to the green channel, and `out float` writes
// RED - so the first version computed everything correctly and the colour mask
// threw all of it away. Measured: 0.00% of pixels changed, which is what a
// perfectly working shader looks like when it writes to the wrong channel.
out vec4 FragColor;           // .g: 1 = nothing in the way, 0 = fully occluded

uniform sampler2D u_Depth;
uniform mat4  u_InvVP;
uniform mat4  u_VP;
uniform vec3  u_CameraPos;
uniform vec3  u_SunDir;       // TOWARDS the sun
uniform vec2  u_TexelSize;
uniform float u_Length;       // metres the ray may reach
uniform float u_Thickness;    // how deep behind a surface still counts as a hit
uniform int   u_Steps;

vec3 WorldFromDepth(vec2 uv, float d) {
    vec4 h = u_InvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return h.xyz / h.w;
}

void main() {
    float d = texture(u_Depth, v_UV).r;
    if (d >= 1.0) { FragColor = vec4(0.0, 1.0, 0.0, 1.0); return; }   // sky

    vec3 P = WorldFromDepth(v_UV, d);
    vec3 L = normalize(u_SunDir);

    // ⚠️ IT FADES OUT WITH DISTANCE, AND THAT IS NOT A PERFORMANCE TRICK. What
    // this pass adds is detail below one shadow-map texel - a centimetre or two
    // of world. At arm's length that is many pixels and worth resolving; at
    // twenty-five metres the whole effect is thinner than a pixel, so all that
    // survives the march is its own sampling noise. Without the fade the far
    // edge of a flat field came out as a bright speckled band, 3.7% of the
    // frame, which is a shadow of nothing at all.
    float camDist = length(P - u_CameraPos);
    float reach = 1.0 - smoothstep(12.0, 30.0, camDist);
    if (reach <= 0.001) { FragColor = vec4(0.0, 1.0, 0.0, 1.0); return; }

    // ⚠️ THE NORMAL COMES FROM THE CLOSER NEIGHBOUR ON EACH AXIS. Taking right
    // and top blindly straddles every silhouette - at the edge of a post one of
    // the two samples is metres away and the normal points somewhere absurd,
    // which draws a dark fringe around every object. The same trap, and the same
    // fix, as the reflection and occlusion passes.
    vec2 tx = u_TexelSize;
    float dr = texture(u_Depth, v_UV + vec2(tx.x, 0.0)).r;
    float dl = texture(u_Depth, v_UV - vec2(tx.x, 0.0)).r;
    float du = texture(u_Depth, v_UV + vec2(0.0, tx.y)).r;
    float dd = texture(u_Depth, v_UV - vec2(0.0, tx.y)).r;
    vec3 ddx = abs(dr - d) < abs(dl - d)
             ? WorldFromDepth(v_UV + vec2(tx.x, 0.0), dr) - P
             : P - WorldFromDepth(v_UV - vec2(tx.x, 0.0), dl);
    vec3 ddy = abs(du - d) < abs(dd - d)
             ? WorldFromDepth(v_UV + vec2(0.0, tx.y), du) - P
             : P - WorldFromDepth(v_UV - vec2(0.0, tx.y), dd);
    vec3 N = normalize(cross(ddx, ddy));
    if (dot(N, normalize(u_CameraPos - P)) < 0.0) N = -N;

    float ndl = dot(N, L);
    // Already facing away from the sun: the lit pass has it in shadow anyway,
    // and marching from a back face is where contact shadows produce their
    // characteristic dark rim.
    if (ndl <= 0.02) { FragColor = vec4(0.0, 1.0, 0.0, 1.0); return; }

    int steps = clamp(u_Steps, 4, 24);

    // ⚠️ START ONLY MILLIMETRES OFF THE SURFACE, ALONG ITS OWN NORMAL. A ray
    // that begins exactly on the surface finds the surface; biasing it along the
    // ray instead means a grazing sun needs an enormous offset, which is the
    // same trigonometry that makes depth bias fail at grazing angles. A fixed
    // normal offset is a constant distance whatever the angle - and it has to be
    // small, because it is also the smallest gap this pass can ever see.
    vec3 origin = P + N * 0.004;

    // A per-pixel offset so neighbouring pixels do not all stop at the same
    // place; the blur afterwards turns that into a soft edge instead of a band.
    float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

    float occluded = 0.0;
    float tPrev = 0.0;
    for (int i = 1; i <= steps; ++i) {
        // ⚠️ THE STEPS GET LONGER AS THEY GO, AND THAT IS THE DIFFERENCE BETWEEN
        // FINDING A CONTACT AND NOT. Evenly spaced over half a metre, sixteen
        // steps are 3 cm apart, and the rejection bias can never be finer than
        // one step - so a slab lying 2 cm off the ground is invisible, which is
        // exactly the case this whole pass exists for. Measured: the 10 cm slab
        // got a contact shadow and the 2 cm one got nothing. Squaring the
        // parameter puts the first step 2 mm out and still reaches half a metre,
        // because what a contact shadow needs is resolution near the surface and
        // reach only as a fallback.
        float f = (float(i) - 0.5 + jitter) / float(steps);
        float t = f * f * u_Length;
        vec3 S = origin + L * t;
        vec4 clip = u_VP * vec4(S, 1.0);
        if (clip.w <= 0.0) break;
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

        float localStep = max(t - tPrev, 1e-4);
        tPrev = t;

        float sd = texture(u_Depth, uv).r;
        if (sd >= 1.0) continue;
        vec3 scenePos = WorldFromDepth(uv, sd);

        // ⚠️ COMPARE DISTANCES FROM THE CAMERA, NOT A PROJECTED SIGN. Earlier
        // versions asked whether the ray point was in front of or behind the
        // stored surface along the view direction, and were wrong the same way
        // in both directions: near the start of the march the ray is still
        // within millimetres of the surface it left, so precision decides the
        // answer, and the answer came out "occluded" for every pixel of flat
        // open ground - 21.6% of the frame one way round, 48.9% the other, where
        // an empty field should be 0%.
        //
        // The honest question is how much FURTHER the ray is than whatever the
        // depth buffer can see in that direction, with two thresholds: deeper
        // than the march's own resolution, and shallower than a thickness,
        // because a depth buffer holds one surface and everything behind it is
        // unknown rather than solid.
        float rayZ   = length(S - u_CameraPos);
        float sceneZ = length(scenePos - u_CameraPos);
        float diff   = rayZ - sceneZ;
        // ⚠️ AND THE BIAS GROWS WHEN THE SURFACE IS SEEN EDGE-ON. The depth
        // buffer is a grid of samples on the picture, so one texel of it covers
        // a few millimetres of a wall seen face on and tens of centimetres of a
        // floor seen at a grazing angle. Reconstructing a neighbour's position
        // on that floor is wrong by the whole texel, which is far more than any
        // fixed bias, and the result is a noisy band of self-shadow across the
        // middle distance of any flat ground - measured at 25.7% of the frame.
        // Dividing by N.V is the same slope-scaling a shadow map needs, for the
        // same reason.
        float slope  = 1.0 / max(dot(N, normalize(u_CameraPos - P)), 0.15);
        float bias   = (max(localStep * 0.6, 0.003) + 0.0004 * sceneZ) * slope;
        float thick  = max(u_Thickness, localStep * 2.0);
        if (diff > bias && diff < bias + thick) {
            // Strongest where the surfaces meet and gone by the time the cascade
            // takes over, so the two do not sum into a dark seam.
            occluded = 1.0 - t / max(u_Length, 1e-4);
            break;
        }
    }

    FragColor = vec4(0.0, clamp(1.0 - occluded * reach, 0.0, 1.0), 0.0, 1.0);
}
