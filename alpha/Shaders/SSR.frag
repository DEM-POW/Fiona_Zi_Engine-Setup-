#version 460 core

// ============================================================================
//  THE STREET REFLECTING THE STREET
//
//  What a wet road does, and the single largest difference between the
//  reference photographs and what this engine drew: every lamp, every sign and
//  every lit window is in the ground twice. The scene already has the answer on
//  screen - it is the frame itself - so the reflection is found by walking a ray
//  through the depth buffer and reading the colour where it stops.
//
//  ⚠️ GROUND ONLY, AND THAT IS AN HONEST LIMITATION, NOT A CHOICE OF STYLE.
//  Screen-space reflection needs to know how smooth each surface is, and a
//  FORWARD renderer has no G-buffer to ask - roughness lives in a uniform during
//  the lit pass and is gone by the time this runs. What this pass can work out
//  from the depth buffer alone is the surface's ORIENTATION, so it reflects
//  where the surface faces up (a road, a pavement, a table top, a puddle) and
//  leaves everything else alone. That is where a night street's reflections are.
//  Doing walls and glass properly means a normal+roughness target and a deferred
//  or hybrid pass, which is a much larger change than this one.
//
//  ⚠️ AND IT IS SCALED BY THE GROUND'S WETNESS, which the engine already derives
//  from the air's humidity. Dry stone reflects almost nothing; the same stone
//  after rain is a mirror at a grazing angle. One physical fact, one control -
//  raise the humidity on the Weather object and the street starts to shine.
//
//  ⚠️ THAT WAS MODE 0, AND IT IS NOW ONLY THE FALLBACK. The main view writes a
//  surface target (lib/Lighting.glsl, o_SurfaceInfo): the real normal and the
//  roughness of every opaque lit surface - the "normal + roughness target" the
//  paragraph above asked for. MODE 1 traces from that, for EVERY glossy
//  surface - a polished floor, a car, a puddle, a wet film - and writes what
//  the mirror direction found and how sure it is, NOT a weighted colour: the
//  next frame's lit pass puts it where the sky's reflection was (the
//  reflection hierarchy), so nothing is added on top of a reflection that is
//  already there. Mode 0 stays for views without the target.
// ============================================================================
#include "lib/Octahedral.glsl"

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Scene;
uniform sampler2D u_Depth;

uniform mat4  u_InvViewProj;
uniform mat4  u_ViewProj;
uniform vec3  u_CameraPos;
uniform vec2  u_TexelSize;

uniform float u_Wetness;      // 0 dry .. 1 soaked, from the ground
uniform int   u_Steps;        // marching steps
uniform float u_MaxDistance;  // world metres a ray may travel
uniform float u_Thickness;    // how deep behind a surface still counts as a hit

uniform int   u_Mode;         // 0 wet ground from depth, 1 the surface target
uniform sampler2D u_Surface;  // mode 1: octahedral normal, roughness, a 1 = traced (lib/Lighting.glsl)
uniform float u_Frame;        // mode 1: the frame's number, for the march's offset

vec3 WorldFromDepth(vec2 uv, float depth) {
    vec4 h = u_InvViewProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return h.xyz / h.w;
}

// ---------------------------------------------------------------------------
// MODE 1: from the surface target, for every surface smooth enough.
// ---------------------------------------------------------------------------
// ⚠️ THE STEPS ARE SHORT NEAR THE SURFACE AND LONG FAR AWAY. Even steps of two
// metres jumped clean over a chair leg standing on the floor - the place where
// a reflection is most noticed is where the object touches the surface. Steps
// grow with the square of their number: centimetres first, metres last.
vec4 TraceSurface(vec3 P, vec3 N, float rough) {
    vec3 V = normalize(P - u_CameraPos);
    vec3 R = reflect(V, N);
    // Interleaved gradient noise (Jimenez 2014), moved every frame: the
    // pattern changes and the temporal AA averages it away.
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy + u_Frame * 5.588238, vec2(0.06711056, 0.00583715))));
    vec3 O = P + N * 0.02;                     // off the surface: no hit on itself
    float prevT = 0.0;
    // ⚠️ A RAY THAT LEAVES THROUGH A WINDOW SEES THE SKY THAT IS ON SCREEN.
    // The sky has no depth to land on, so a ray out through a window never
    // "hit" anything and the floor showed the sky probe dimmed by the roof -
    // a dark window in a polished floor. Unity HDRP's Reflect Sky: when the
    // ray's last sample on screen is sky, the sky there is the answer.
    vec2 skyUV = vec2(-1.0);
    for (int i = 0; i < u_Steps; ++i) {
        float x = (float(i) + jitter) / float(u_Steps);
        float t = max(u_MaxDistance * x * x, 0.04);
        vec3 S = O + R * t;
        vec4 clip = u_ViewProj * vec4(S, 1.0);
        if (clip.w <= 0.0) break;
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        float sceneD = texture(u_Depth, uv).r;
        if (sceneD >= 1.0) { prevT = t; skyUV = uv; continue; }
        vec3 scenePos = WorldFromDepth(uv, sceneD);
        float behind = dot(S - scenePos, normalize(u_CameraPos - scenePos));
        // In front of a surface the screen shows, the ray is still in the
        // room it set out in; out through the window and behind the wall
        // round it, it is outside - where the sky it last crossed still is.
        if (behind >= 0.0) skyUV = vec2(-1.0);
        float thick = max(u_Thickness * 0.25, (t - prevT) * 1.6);
        // ⚠️ A HIT IS A CROSSING: the step before was in FRONT of this surface.
        // Out through a window, the ray rises behind the wall above it and
        // projects onto that wall - behind it by less than a long step, so it
        // read as a hit, and every window in a polished floor came out as its
        // dark frame. Measured against this pixel's surface, the last sample
        // was behind it too: the ray never crossed it.
        float behindPrev = dot(O + R * prevT - scenePos, normalize(u_CameraPos - scenePos));
        if (behind < 0.0 && behind > -thick && behindPrev > -0.05) {
            float a = prevT, b = t;
            for (int k = 0; k < 5; ++k) {
                float m = 0.5 * (a + b);
                vec3 Sm = O + R * m;
                vec4 cm = u_ViewProj * vec4(Sm, 1.0);
                vec2 um = cm.xy / cm.w * 0.5 + 0.5;
                float dm = texture(u_Depth, um).r;
                vec3 sp = WorldFromDepth(um, dm);
                if (dm < 1.0 && dot(Sm - sp, normalize(u_CameraPos - sp)) < 0.0) { b = m; uv = um; }
                else a = m;
            }
            // ⚠️ A SURFACE SEEN FROM BEHIND IS NOT WHAT THE MIRROR SEES. The
            // ray passed behind a wall whose front faces the other way - what
            // is there is the wall's far side, which the screen never held.
            vec4 hs = texture(u_Surface, uv);
            if (hs.a > 0.25) {
                vec3 hn = FZE_OctDecode(hs.xy);
                if (dot(hn, R) > 0.2) return vec4(0.0);
            }
            vec2 edge = smoothstep(0.0, 0.08, uv) * smoothstep(0.0, 0.08, 1.0 - uv);
            float far = 1.0 - smoothstep(0.8, 1.0, x);
            return vec4(texture(u_Scene, uv).rgb, edge.x * edge.y * far);
        }
        prevT = t;
    }
    if (skyUV.x >= 0.0) {
        vec2 edge = smoothstep(0.0, 0.08, skyUV) * smoothstep(0.0, 0.08, 1.0 - skyUV);
        return vec4(texture(u_Scene, skyUV).rgb, edge.x * edge.y);
    }
    return vec4(0.0);
}

void main() {
    float d = texture(u_Depth, v_UV).r;
    if (d >= 1.0) { FragColor = vec4(0.0); return; }     // sky reflects nothing

    if (u_Mode == 1) {
        vec4 si = texture(u_Surface, v_UV);
        if (si.a < 0.75 || si.z > 0.55) { FragColor = vec4(0.0); return; }
        vec3 P = WorldFromDepth(v_UV, d);
        FragColor = TraceSurface(P, FZE_OctDecode(si.xy), si.z);
        return;
    }

    vec3 P = WorldFromDepth(v_UV, d);

    // ⚠️ THE NORMAL COMES FROM THE DEPTH BUFFER, AND THE CROSS PRODUCT MUST USE
    // THE CLOSER NEIGHBOUR ON EACH AXIS. Taking the right and the top blindly
    // straddles every silhouette: at the edge of a lamp post one of the two
    // samples is twenty metres away and the normal points somewhere absurd,
    // which prints a bright fringe around every object. Choosing whichever of
    // the two neighbours is nearer in depth keeps the pair on the same surface.
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
    if (N.y < 0.0) N = -N;

    // Ground only - see the header.
    float upness = smoothstep(0.72, 0.92, N.y);
    if (upness <= 0.0 || u_Wetness <= 0.0) { FragColor = vec4(0.0); return; }

    vec3 V = normalize(P - u_CameraPos);
    vec3 R = reflect(V, N);
    if (R.y <= 0.02) { FragColor = vec4(0.0); return; }   // pointing into the ground

    // ⚠️ MARCHED IN WORLD SPACE AND PROJECTED EACH STEP, not stepped in screen
    // space. A screen-space step is a different world distance at every depth,
    // so a ray crawls in the distance and leaps in the foreground - which is
    // where the classic SSR streaks come from. Projecting a fixed world step is
    // one matrix multiply more and behaves the same everywhere in frame.
    float stepLen = u_MaxDistance / float(u_Steps);
    // A per-pixel offset so the steps of neighbouring pixels do not line up into
    // rings; the blur afterwards resolves it.
    float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

    vec3 hit = vec3(0.0);
    float hitMask = 0.0;
    for (int i = 1; i <= u_Steps; ++i) {
        vec3 S = P + R * (stepLen * (float(i) + jitter));
        vec4 clip = u_ViewProj * vec4(S, 1.0);
        if (clip.w <= 0.0) break;
        vec3 ndc = clip.xyz / clip.w;
        vec2 uv = ndc.xy * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

        float sceneD = texture(u_Depth, uv).r;
        if (sceneD >= 1.0) continue;                       // sky: keep going
        vec3 scenePos = WorldFromDepth(uv, sceneD);
        float behind = dot(S - scenePos, normalize(u_CameraPos - scenePos));

        // The ray has gone behind a surface: that is a hit, unless it is behind
        // by more than the thickness we are willing to believe in - past that it
        // has passed BEHIND an object rather than landed on it, and reflecting
        // whatever is there smears a lamp post across the whole road.
        // ⚠️ THE THICKNESS HAS TO BE AT LEAST ONE STEP, and this is why the first
        // version reflected almost nothing - 3.0% of pixels. With a 45 m reach
        // over 24 steps each step is 1.9 m, so a ray crossing a wall jumps from
        // "in front of it" to "two metres behind it" in a single step and the
        // 1.2 m thickness test threw the hit away. The test is asking "did I
        // pass through a surface between the last sample and this one", and the
        // answer cannot be narrower than the gap between samples.
        float thick = max(u_Thickness, stepLen * 1.6);
        if (behind < 0.0 && behind > -thick) {
            // ⚠️ AND THEN FOUND PROPERLY, NOT WHERE THE STEP HAPPENED TO LAND.
            // A step is over a metre, so "somewhere in the last step" put the
            // hit anywhere along a metre and a quarter of the wall: the
            // reflection of an edge came out as a staircase of blocks as wide
            // as a step. Five halvings of that step put it within four
            // centimetres - the surface, not the step.
            float a = stepLen * (float(i - 1) + jitter), b = stepLen * (float(i) + jitter);
            for (int k = 0; k < 5; ++k) {
                float m = 0.5 * (a + b);
                vec3 Sm = P + R * m;
                vec4 cm = u_ViewProj * vec4(Sm, 1.0);
                vec2 um = cm.xy / cm.w * 0.5 + 0.5;
                float dm = texture(u_Depth, um).r;
                vec3 sp = WorldFromDepth(um, dm);
                if (dm < 1.0 && dot(Sm - sp, normalize(u_CameraPos - sp)) < 0.0) { b = m; uv = um; }
                else a = m;
            }
            // Fade at the edges of the screen: a reflection that ends in a hard
            // line at the frame's border is the giveaway of every SSR.
            vec2 edge = smoothstep(0.0, 0.12, uv) * smoothstep(0.0, 0.12, 1.0 - uv);
            hit = texture(u_Scene, uv).rgb;
            // ⚠️ THE DISTANCE FADE WAS EATING THE RESULT. A linear 1 - i/steps
            // means a hit at step 20 of 24 keeps 17% of its brightness, and
            // almost every hit on a road IS far along the ray - the reflection
            // of a shopfront is twenty metres away, not two. Measured with the
            // linear fade: 3.2% of pixels changed, peak 30 of 255, which is a
            // reflection nobody would see. The screen-edge fade is what actually
            // has to be soft; distance only needs to take the last few steps.
            float far = 1.0 - smoothstep(0.75, 1.0, float(i) / float(u_Steps));
            hitMask = edge.x * edge.y * far;
            break;
        }
    }
    if (hitMask <= 0.0) { FragColor = vec4(0.0); return; }

    // Fresnel: a wet road is a mirror when you look along it and nearly matt
    // when you look straight down at it, and that difference is most of why a
    // reflective street reads as WET rather than as polished.
    float f = pow(1.0 - max(dot(-V, N), 0.0), 5.0);
    // A wet stone at a grazing angle returns most of what hits it; looked at
    // from straight above it returns a few percent. 0.06 is that floor - not
    // zero, because a wet surface is never completely matt.
    float strength = mix(0.06, 1.0, f) * upness * u_Wetness;

    FragColor = vec4(hit * strength, hitMask);
}
