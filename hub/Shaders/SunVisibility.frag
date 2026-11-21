#version 460 core
#include "lib/Finite.glsl"     // one bad pixel never spreads (R0)

// ============================================================================
//  HOW MUCH OF THE SUN THE EYE CAN SEE - one number, one pixel (docs/SKY-PLAN.md, phase 2).
//
//  The glare and the ghosts are made by light from the DISC going through the lens: a wall, a tree or a
//  cloud in front of the disc takes them away.
//
//  ⚠️ IT IS ASKED OF THE WORLD, NOT OF THE PICTURE. The old pass sampled the depth buffer round the disc
//  and counted every sample off the picture as "seen": with the sun just outside the frame, behind a
//  building, the glare came on at full strength at the edge of the view, and went off again as the sun
//  came back in behind the same building - light popping at the edges while the camera turned. Now the
//  answer is the sun's own SHADOW at the eye: if the eye is in shadow, something stands between it and
//  the sun, wherever the sun is on screen or off it. The picture only adds detail (a leaf, a thin pole
//  the shadow map is too coarse for) while the sun is well inside the frame, and never past its edge.
//
//  ⚠️ AND IT IS HELD OVER A FEW HUNDREDTHS OF A SECOND, in seconds, not frames: a disc behind moving
//  leaves no longer flickers the glare on and off from one frame to the next.
// ============================================================================

#include "lib/Shadows.glsl"

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Depth;
uniform sampler2D u_Clouds;     // the sky layer: alpha = how much cloud covers the sky there
uniform int   u_HasClouds;
uniform sampler2D u_History;    // last frame's answer
uniform float u_Keep;           // how much of it is kept this frame (0: a fresh start)
uniform vec2  u_SunUV;
uniform float u_SunRadiusUV;    // the disc's angular radius, in screen-height UV
uniform float u_Aspect;         // width / height
uniform float u_InFrame;        // 1 with the sun well inside the picture, 0 at its edge and beyond
uniform vec3  u_CameraPos;
uniform vec3  u_SunDir;         // toward the sun

void main() {
    // ---- the world: the sun's shadow at the eye, five taps across a hand's width ----
    vec3 side = normalize(cross(u_SunDir, abs(u_SunDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 over = cross(side, u_SunDir);
    const vec2 kTap[5] = vec2[5](vec2(0.0), vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));
    float world = 0.0;
    for (int i = 0; i < 5; ++i)
        world += SunShadowTapAt(u_CameraPos + (side * kTap[i].x + over * kTap[i].y) * 0.15, 0.0);
    world = world / 5.0 * CloudShadow(u_CameraPos, vec3(0.0, 1.0, 0.0));

    // ---- the picture: the disc and two rings round it, only where the picture has them ----
    float seen = 0.0, n = 0.0;
    const float kRadius = 1.6;   // a little past the rim: the aureole is blocked with it
    for (int ring = 0; ring <= 2; ++ring) {
        int count = ring == 0 ? 1 : ring * 6;
        float rr = u_SunRadiusUV * kRadius * float(ring) * 0.5;
        for (int k = 0; k < count; ++k) {
            float a = 6.2831853 * (float(k) + 0.5 * float(ring)) / float(count);
            vec2 p = u_SunUV + vec2(cos(a) / u_Aspect, sin(a)) * rr;
            if (any(lessThan(p, vec2(0.0))) || any(greaterThan(p, vec2(1.0)))) continue;
            float sky = step(0.9999, texture(u_Depth, p).r);
            float cloud = (u_CloudsOn == 0 && u_HasClouds == 1) ? clamp(texture(u_Clouds, p).a, 0.0, 1.0) : 0.0;
            seen += sky * (1.0 - cloud);
            n += 1.0;
        }
    }
    float screen = n > 0.0 ? seen / n : 1.0;
    float vis = world * mix(1.0, screen, u_InFrame * (n > 0.0 ? 1.0 : 0.0));

    FragColor = vec4(FZE_Finite(mix(vis, texture(u_History, vec2(0.5)).r, u_Keep)), 0.0, 0.0, 1.0);
}
