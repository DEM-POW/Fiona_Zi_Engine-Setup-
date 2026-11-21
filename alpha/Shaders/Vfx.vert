#version 460 core
// ============================================================================
//  AN EFFECT'S SPRITES, BUILT HERE AND NOT ON THE CPU (Effects/Vfx/VfxRenderer)
//
//  ⚠️ SIX VERTICES A PARTICLE WERE BUILT ON THE CPU EVERY FRAME - 216 bytes,
//  and the buffer re-allocated for every draw. 64 fires cost 4.3 ms of CPU to
//  draw on this laptop. A particle is now one 64-byte record in one buffer
//  uploaded once a frame; the four corners of its card are made here from
//  gl_VertexID, the record from gl_InstanceID.
//
//  u_Mode 1 draws a ribbon instead: its strip's vertices, already in the
//  world, read by gl_VertexID from their own buffer.
// ============================================================================

#include "lib/VfxLight.glsl"

struct VfxParticle {
    vec4 PosRot;       // xyz world position, w rotation (radians)
    vec4 SizeFrame;    // xy size (metres), z flipbook frame
    vec4 Color;        // rgb x intensity, a
    vec4 Axis;         // xyz world velocity (velocity facing) or surface normal (emitter up)
};
layout(std430, binding = 13) readonly buffer VfxParticles { VfxParticle vfxParticles[]; };

struct VfxRibbonVertex { vec4 Pos; vec4 Color; vec4 UV; };
layout(std430, binding = 14) readonly buffer VfxRibbon { VfxRibbonVertex vfxRibbon[]; };

uniform mat4  u_View;
uniform mat4  u_Projection;
uniform vec3  u_CameraPos;
uniform int   u_Mode;          // 0 sprites, 1 ribbon
uniform int   u_Base;          // this draw's first record (or vertex)
uniform int   u_Facing;        // 0 camera, 1 velocity, 2 horizontal, 3 vertical, 4 emitter up
uniform float u_Stretch;       // velocity facing: length per m/s
uniform vec2  u_Flip;          // flipbook columns, rows
uniform int   u_FrameBlend;
uniform int   u_Lit;           // 1: lit by the scene (VfxLight.glsl)
uniform vec2  u_TargetSize;    // pixels of the target the light clusters were built for

out vec4  v_Color;
out vec2  v_UV;
out vec2  v_UV2;               // the next flipbook frame
out float v_Blend;             // between the two
out float v_ViewDepth;         // metres in front of the camera, for the soft and near fades
out vec3  v_Ambient;           // sky + lamps + flash (lit only)
out vec3  v_Sun;               // the shadowed sun (lit only)
out vec3  v_Right;             // the card's axes in the world: its normal map's frame
out vec3  v_Up;

vec2 FrameUV(float frame, vec2 corner) {
    float cols = max(u_Flip.x, 1.0), rows = max(u_Flip.y, 1.0);
    float n = cols * rows;
    float f = mod(floor(frame), n);
    float u0 = mod(f, cols) / cols;
    float v1 = 1.0 - floor(f / cols) / rows;
    return vec2(u0 + corner.x / cols, v1 - (1.0 - corner.y) / rows);
}

void Light(vec3 P, vec4 clip) {
    v_Ambient = vec3(0.0);
    v_Sun = vec3(0.0);
    if (u_Lit == 0) return;
    vec2 ndc = clip.xy / max(clip.w, 1e-4);
    vec2 frag = (ndc * 0.5 + 0.5) * u_TargetSize;
    FZE_VfxLight(P, normalize(u_CameraPos - P), frag, v_Ambient, v_Sun);
}

void main()
{
    if (u_Mode == 1) {
        VfxRibbonVertex rv = vfxRibbon[u_Base + gl_VertexID];
        vec4 view = u_View * vec4(rv.Pos.xyz, 1.0);
        v_Color = rv.Color;
        v_UV = rv.UV.xy;
        v_UV2 = rv.UV.xy;
        v_Blend = 0.0;
        v_ViewDepth = -view.z;
        v_Right = vec3(1.0, 0.0, 0.0);
        v_Up = vec3(0.0, 1.0, 0.0);
        gl_Position = u_Projection * view;
        // The light at the strip's corner is the light along it.
        Light(rv.Pos.xyz, gl_Position);
        return;
    }

    VfxParticle p = vfxParticles[u_Base + gl_InstanceID];
    vec3 c = p.PosRot.xyz;
    vec2 size = p.SizeFrame.xy;
    // The strip's corners: (0,0) (1,0) (0,1) (1,1).
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    vec2 q = corner * 2.0 - 1.0;

    vec3 camRight = vec3(u_View[0][0], u_View[1][0], u_View[2][0]);
    vec3 camUp    = vec3(u_View[0][1], u_View[1][1], u_View[2][1]);
    vec3 right = camRight, up = camUp;
    bool rotate = true;
    if (u_Facing == 1) {
        vec3 vel = p.Axis.xyz;
        float speed = length(vel);
        if (speed > 1e-4) {
            vec3 axis = vel / speed;
            vec3 side = cross(axis, u_CameraPos - c);
            if (dot(side, side) > 1e-10) {
                right = normalize(side);
                up = axis * (1.0 + u_Stretch * speed / max(size.y, 1e-4));
                rotate = false;
            }
        }
    } else if (u_Facing == 2) {
        right = vec3(1.0, 0.0, 0.0);
        up = vec3(0.0, 0.0, 1.0);
    } else if (u_Facing == 3) {
        vec3 toCam = u_CameraPos - c;
        toCam.y = 0.0;
        toCam = dot(toCam, toCam) > 1e-8 ? normalize(toCam) : vec3(0.0, 0.0, 1.0);
        right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        up = vec3(0.0, 1.0, 0.0);
    } else if (u_Facing == 4) {
        vec3 n = normalize(p.Axis.xyz + vec3(0.0, 1e-6, 0.0));
        right = normalize(cross(abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), n));
        up = cross(n, right);
        c += n * 0.012;                   // lifted off the wall it lies on
    }
    if (rotate && abs(p.PosRot.w) > 1e-5) {
        float ca = cos(p.PosRot.w), sa = sin(p.PosRot.w);
        vec3 r0 = right, u0 = up;
        right = r0 * ca + u0 * sa;
        up = u0 * ca - r0 * sa;
    }
    vec3 world = c + right * (q.x * size.x * 0.5) + up * (q.y * size.y * 0.5);

    v_Color = p.Color;
    v_UV = FrameUV(p.SizeFrame.z, corner);
    v_UV2 = u_FrameBlend == 1 ? FrameUV(p.SizeFrame.z + 1.0, corner) : v_UV;
    v_Blend = u_FrameBlend == 1 ? fract(p.SizeFrame.z) : 0.0;
    v_Right = normalize(right);
    v_Up = normalize(up);
    vec4 view = u_View * vec4(world, 1.0);
    v_ViewDepth = -view.z;
    gl_Position = u_Projection * view;
    // Lit at its centre: every corner of one particle takes the same light.
    Light(c, u_Projection * (u_View * vec4(c, 1.0)));
}
