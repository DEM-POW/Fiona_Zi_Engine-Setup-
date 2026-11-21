#version 460 core
// =============================================================================
//  A PLANT, WHERE THE SCATTER PASS GREW IT.
//
//  The model's own vertices, normalised to one unit of its height and stood on
//  its root; each instance is one FZEPlant from the list FoliageScatter.comp
//  wrote this frame (lib/Foliage.glsl). Then, in this order:
//
//    * yawed and scaled to its height (the scatter pass sets spread to 1:
//      stretching a clump sideways laid its leaning blades flat);
//    * leaned with the ground's slope, as much as the type says;
//    * bent: by the wind over it now (gusts cross the field), by whatever is
//      standing on it (the trample map - Engine/Foliage), and by the rain's
//      weight on its tips.
//
//  Used by the depth passes and the lit pass alike, and `invariant`, so the
//  lit pass's LEQUAL test finds exactly the depth the prepass wrote.
// =============================================================================
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Normal;
layout(location = 2) in vec2 a_TexCoord;

#include "lib/Foliage.glsl"
#include "lib/TreePicture.glsl"

layout(std430, binding = 0) readonly buffer Plants { FZEPlant plants[]; };

uniform mat4  u_ViewProjection;
uniform uint  u_Base;             // first plant of this level of detail
uniform vec3  u_ModelPivot;       // the model's root (x, lowest y, z), in its own units
uniform float u_ModelInvHeight;   // 1 / its height, in its own units
uniform float u_Stiffness;
uniform float u_Flutter;          // 0 grass; 1 a tree in the wind; -1 a tree as the cached sun shadow sees it

uniform int       u_HasTrample;
uniform sampler2D u_Trample;      // rg: the lean pressed into the plants here (tangent, xz); wraps
uniform vec4      u_TrampleRect;  // xy world corner of the window it holds, zw 1 / its size (m)

uniform float u_Rain;             // 0..1: how hard it is raining on the plants
// Far Trees as Pictures (lib/TreePicture.glsl): 1 draws each instance as a square of its pictures.
uniform int   u_Impostor;
uniform vec3  u_PicCenter;        // the crown's centre, in units of the height, before the yaw
uniform float u_PicRadius;        // the crown's radius, the same
uniform float u_PicGrid;          // pictures on each side of the grid
uniform vec3  u_Eye;
uniform int   u_SoftFar;          // Rendering Features > Soft Foliage Far Away
uniform int   u_Exp;              // FZE_FOLIAGEEXP, for measuring: 1 no wind or trample

out vec3  v_WorldPos;
out vec3  v_Normal;
out vec2  v_UV;
out float v_Height01;             // 0 at the root, 1 at the top
out vec2  v_Variation;            // x colour variation, y dryness
flat out float v_Fade;            // a tree changing level: lib/TreePicture.glsl, FZE_PicFadeCut
flat out vec4  v_Crown;           // a tree: its crown's centre and radius in the world; w 0 for grass
flat out float v_Soft;            // 0 near ... 1 far: how much it is shaded as a whole (Soft Foliage Far Away)
out vec4  v_PicUV01;              // a picture square: where it is in pictures 0 and 1...
out vec2  v_PicUV2;               // ...and 2
flat out vec4 v_PicW;             // the three pictures' weights, and the crown's radius in metres
flat out vec4 v_PicF01;           // pictures 0 and 1 on the grid
flat out vec2 v_PicF2;
flat out vec2 v_PicYaw;           // cos and sin of the tree's yaw

invariant gl_Position;

void main() {
    FZEPlant pl = plants[u_Base + uint(gl_InstanceID)];
    vec2  yawSpread = unpackHalf2x16(floatBitsToUint(pl.Data.x));
    // A tree never leans with the ground: its Data.w is how far it has gone in changing level.
    vec2  lean = u_Flutter != 0.0 ? vec2(0.0) : unpackSnorm2x16(floatBitsToUint(pl.Data.w));
    v_Fade = u_Flutter != 0.0 ? pl.Data.w : 0.0;
    v_PicUV01 = vec4(0.0); v_PicUV2 = vec2(0.0); v_PicW = vec4(0.0);
    v_PicF01 = vec4(0.0); v_PicF2 = vec2(0.0); v_PicYaw = vec2(1.0, 0.0);
    float H = pl.PosScale.w;
    vec3  root = pl.PosScale.xyz;

    vec3 m = (a_Position - u_ModelPivot) * u_ModelInvHeight;
    float h01 = clamp(m.y, 0.0, 1.0);
    float c = cos(yawSpread.x), s = sin(yawSpread.x);
    vec3 lp = vec3((c * m.x - s * m.z) * yawSpread.y, m.y, (s * m.x + c * m.z) * yawSpread.y) * H;
    vec3 n  = vec3(c * a_Normal.x - s * a_Normal.z, a_Normal.y, s * a_Normal.x + c * a_Normal.z);
    lp.xz += lean * lp.y;

    // ---- what bends it ----
    float phase = fract(pl.Data.y * 7.13 + yawSpread.x * 0.159);
    const bool tree = u_Flutter != 0.0;

    // ---- seen from far, a crown and a field, not their leaves ----
    // A tree from one height to three away; grass from 8 to 30 m. The same for a tree's leaves
    // and its pictures, so the two shade alike where one becomes the other.
    vec3 crownC = root + vec3(c * u_PicCenter.x - s * u_PicCenter.z, u_PicCenter.y, s * u_PicCenter.x + c * u_PicCenter.z) * H;
    v_Crown = vec4(crownC, tree ? max(u_PicRadius * H, 1e-3) : 0.0);
    v_Soft = u_SoftFar == 0 ? 0.0
           : tree ? smoothstep(H, 3.0 * H, length(u_Eye - crownC))
           : smoothstep(8.0, 30.0, length(u_Eye - root));

    // ---- a far tree as its pictures ----
    // A square facing the camera through the crown's centre, as big as the crown's sphere;
    // for each corner, where the ray from the eye through it meets each of the three nearest
    // pictures' own planes. Leaned by the trunk's wind as the tree is.
    if (u_Impostor == 1) {
        vec3 cen = root + vec3(c * u_PicCenter.x - s * u_PicCenter.z, u_PicCenter.y, s * u_PicCenter.x + c * u_PicCenter.z) * H;
        float R = u_PicRadius * H;
        vec3 toEye = u_Eye - cen;
        vec3 V = normalize(toEye);
        vec3 Vl = vec3(c * V.x + s * V.z, V.y, -s * V.x + c * V.z);   // the yaw undone
        float n1 = u_PicGrid - 1.0;
        vec2 gv = FZE_PicDirToGrid(Vl) * n1;
        vec2 b = clamp(floor(gv), vec2(0.0), vec2(n1 - 1.0));
        vec2 f = gv - b;
        vec2 F0, F1, F2;
        vec3 w;
        if (f.x + f.y <= 1.0) { F0 = b; F1 = b + vec2(1.0, 0.0); F2 = b + vec2(0.0, 1.0); w = vec3(1.0 - f.x - f.y, f.x, f.y); }
        else { F0 = b + vec2(1.0); F1 = b + vec2(1.0, 0.0); F2 = b + vec2(0.0, 1.0); w = vec3(f.x + f.y - 1.0, 1.0 - f.y, 1.0 - f.x); }
        vec3 Tv, Bv;
        FZE_PicBasis(V, Tv, Bv);
        vec3 Q = cen + (a_Position.x * Tv + a_Position.y * Bv) * R;
        vec3 el = vec3(c * toEye.x + s * toEye.z, toEye.y, -s * toEye.x + c * toEye.z);
        vec3 qw = Q - cen;
        vec3 ql = vec3(c * qw.x + s * qw.z, qw.y, -s * qw.x + c * qw.z);
        vec3 ray = ql - el;
        v_PicUV01 = vec4(FZE_PicUV(F0, n1, el, ray, R), FZE_PicUV(F1, n1, el, ray, R));
        v_PicUV2 = FZE_PicUV(F2, n1, el, ray, R);
        v_PicW = vec4(w, R);
        v_PicF01 = vec4(F0, F1);
        v_PicF2 = F2;
        v_PicYaw = vec2(c, s);
        float hq = clamp((Q.y - root.y) / H, 0.0, 1.0);
        vec2 tipq = (u_Exp & 1) != 0 ? vec2(0.0) : FZE_TreeLean(root.xz, H, u_Stiffness, phase, u_Flutter < 0.0);
        vec3 pq = FZE_FoliageBend(Q, root, hq, H, tipq);
        v_WorldPos = pq;
        v_Normal = V;
        v_UV = vec2(0.0);
        v_Height01 = hq;
        v_Variation = pl.Data.yz;
        gl_Position = u_ViewProjection * vec4(pq, 1.0);
        return;
    }
    vec2 tip = (u_Exp & 1) != 0 ? vec2(0.0)
             : tree ? FZE_TreeLean(root.xz, H, u_Stiffness, phase, u_Flutter < 0.0)
             : FZE_FoliageWind(root.xz, u_Stiffness, phase);
    // ⚠️ GRASS IS TRODDEN, A TREE IS NOT. The trample map is where feet and wheels went, and a
    // pine's root stood in it like a blade's: walking round a trunk bent the whole tree over
    // (Nabras's picture, 2026-11-13). A trunk does not yield to a person.
    if (u_HasTrample == 1 && !tree && (u_Exp & 1) == 0) {
        vec2 inWindow = (root.xz - u_TrampleRect.xy) * u_TrampleRect.zw;
        if (all(greaterThan(inWindow, vec2(0.0))) && all(lessThan(inWindow, vec2(1.0)))) {
            // The map is fixed to the world and wraps: sampled where the ground is.
            vec2 t = texture(u_Trample, root.xz * u_TrampleRect.zw).xy;
            // Pressed down, a plant stops answering the wind.
            tip = tip * (1.0 - 0.85 * clamp(length(t), 0.0, 1.0)) + t;
        }
    }
    vec3 p = FZE_FoliageBend(root + lp, root, h01, H, tip);

    // The rain: water on the tips weighs them down and out from the middle
    // of the plant, and the drops knock them about. A blade of grass; a pine does not
    // spread its crown three metres because it is wet.
    if (u_Rain > 0.0 && !tree) {
        vec2 out_ = lp.xz / max(length(lp.xz), 1e-3);
        float w = u_Rain * h01 * h01;
        float knock = sin(u_Time * 19.0 + phase * 40.0 + m.x * 60.0) * 0.25;
        p.xz += out_ * H * w * (0.22 + 0.08 * knock);
        p.y  -= H * w * 0.12;
    }
    // A tree's branches and their tips, on top of the trunk's lean (lib/Foliage.glsl).
    if (u_Flutter > 0.0 && (u_Exp & 1) == 0) p += FZE_TreeBranches(m, n, h01, H, phase, root.xz);

    v_WorldPos = p;
    v_Normal = n;
    v_UV = a_TexCoord;
    v_Height01 = h01;
    v_Variation = pl.Data.yz;
    gl_Position = u_ViewProjection * vec4(p, 1.0);
}
