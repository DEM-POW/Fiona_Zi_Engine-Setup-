#version 460 core

layout(location = 0) in vec3  a_Position;
layout(location = 1) in vec3  a_Normal;
layout(location = 2) in vec2  a_TexCoord;
layout(location = 3) in ivec4 a_Joints;
layout(location = 4) in vec4  a_Weights;

uniform mat4 u_ViewProjection;
uniform mat4 u_Model;
uniform mat4 u_LightSpace;

// ⚠️ THE BONES COME FROM A BUFFER, NOT FROM A UNIFORM ARRAY, AND THE REASON IS
// NOT ELEGANCE. A uniform array has a size fixed in the source, and this one said
// 128. Every character with more bones than that was silently mangled: the
// importer clamped each vertex's bone index into range, so a vertex belonging to
// bone 500 was told to follow bone 127 - a bone somewhere else entirely on the
// body. Measured on a horse from this project's own assets: 677 bones, of which
// 549 did not exist as far as the shader was concerned, and the parts they carried
// followed whatever bone 127 happened to be doing.
//
// It is not a number that can simply be raised, either. A uniform array lives in
// the shader's uniform storage, and GL only guarantees 1024 components per vertex
// shader - 64 mat4. 128 already exceeds that and works only because real drivers
// are generous. A shader storage buffer has no such ceiling, so the limit becomes
// the rig rather than the renderer.
layout(std430, binding = 0) readonly buffer BoneBuffer {
    mat4 u_Bones[];
};

// How much DUAL-QUATERNION skinning to use. 0 is the classic linear blend, 1 is
// pure dual quaternion, and the engine ships in between — see the long note below.
uniform float u_SkinBlend;

out vec3 v_WorldPos;
out vec3 v_Normal;
out vec2 v_TexCoord;
out vec3 v_GridPos;       // Lit.frag's prototype grid: a skinned mesh never shows it
out vec3 v_GridNormal;
out vec4 v_LightSpacePos;
#include "lib/Retro.glsl"
noperspective out vec2 v_AffineUV;
noperspective out vec3 v_AffinePos;

// ⚠️ THE FRAGMENT SHADER IS SHARED, SO THE CONTRACT IS SHARED. Lit.frag reads
// its four surface numbers from the vertex stage now, because Lit.vert may be
// taking them from an instance buffer. A skinned character is never instanced,
// so these come straight from the uniforms - but they must be WRITTEN, or the
// two stages do not link at all. That failure is silent in the worst way: the
// program does not build, and whatever it drew simply stops appearing.
uniform vec3  u_BaseColor;
uniform float u_Metallic;
uniform float u_Roughness;
uniform float u_Reflectance;
flat out vec4 v_MatColorMetal;
flat out vec4 v_MatRoughRefl;

// ---------------------------------------------------------------------------
//  WHY THIS SHADER DOES NOT SIMPLY AVERAGE MATRICES.
//
//  Averaging matrices is not a rotation. Halfway between two frames pointing
//  opposite ways, the average is degenerate, and the surface driven by it
//  collapses. Measured on this engine's own character: twisting a forearm 135
//  degrees crushed edges near the elbow to 0.026 of their rest length — the limb
//  pinched to under 3% of its thickness. That is the "candy wrapper", it belongs
//  to the METHOD, and weight painting has never fixed it in any package.
//
//  A dual quaternion carries a rotation and a translation in a form whose average
//  IS a rigid transform, so the collapse becomes impossible rather than reduced.
//  Its own artefact is the opposite one: a hard bend BULGES slightly outward.
//  Measured across the same poses, turning the blend up always reduces the
//  collapse and always increases the bulge, with no reversal in between — so the
//  parameter is a dial with a predictable meaning rather than a magic number.
//
//  At the shipped 0.75, a 135 degree twist crushes to 0.323 instead of 0.026 (five
//  times more limb left standing) while a 90 degree bend stretches 1.447 instead of
//  1.221 — worse than linear, better than pure dual quaternion. Bulging skin reads
//  as muscle; collapsing skin reads as broken.
//
//  This mirrors Engine/Anim/Skin/DualQuat.h exactly. The two must agree: the CPU
//  path is what the weight-paint preview and the tests use, and a character that
//  deforms one way in a test and another on screen is worse than either.
// ---------------------------------------------------------------------------

// A rotation matrix as a quaternion, (x, y, z, w).
//
// Shepperd's method: of the four possible ways to extract it, take the one whose
// divisor is largest. The naive single-branch version divides by something near
// zero at a 180 degree rotation and produces garbage — which is precisely the
// pose this whole shader exists to handle.
vec4 quatFromMat(mat3 m)
{
    float t;
    vec4  q;
    if (m[2][2] < 0.0) {
        if (m[0][0] > m[1][1]) {
            t = 1.0 + m[0][0] - m[1][1] - m[2][2];
            q = vec4(t, m[0][1] + m[1][0], m[2][0] + m[0][2], m[1][2] - m[2][1]);
        } else {
            t = 1.0 - m[0][0] + m[1][1] - m[2][2];
            q = vec4(m[0][1] + m[1][0], t, m[1][2] + m[2][1], m[2][0] - m[0][2]);
        }
    } else {
        if (m[0][0] < -m[1][1]) {
            t = 1.0 - m[0][0] - m[1][1] + m[2][2];
            q = vec4(m[2][0] + m[0][2], m[1][2] + m[2][1], t, m[0][1] - m[1][0]);
        } else {
            t = 1.0 + m[0][0] + m[1][1] + m[2][2];
            q = vec4(m[1][2] - m[2][1], m[2][0] - m[0][2], m[0][1] - m[1][0], t);
        }
    }
    return q * (0.5 / sqrt(max(t, 1e-12)));
}

// The dual part: half the translation, expressed in the quaternion's own algebra.
vec4 dualFromTranslation(vec3 t, vec4 q)
{
    return 0.5 * vec4(q.w * t + cross(t, q.xyz), -dot(t, q.xyz));
}

vec3 dqTransformPoint(vec4 qr, vec4 qd, vec3 p)
{
    vec3 trans = 2.0 * (qr.w * qd.xyz - qd.w * qr.xyz + cross(qr.xyz, qd.xyz));
    return p + 2.0 * cross(qr.xyz, cross(qr.xyz, p) + qr.w * p) + trans;
}

vec3 dqTransformVector(vec4 qr, vec3 n)
{
    return n + 2.0 * cross(qr.xyz, cross(qr.xyz, n) + qr.w * n);
}

void main()
{
    float wsum = a_Weights.x + a_Weights.y + a_Weights.z + a_Weights.w;

    vec3 skinnedPos;
    vec3 skinnedNrm;

    if (wsum < 1e-4) {
        // No weights at all: a static vertex riding a skinned mesh.
        skinnedPos = a_Position;
        skinnedNrm = a_Normal;
    } else {
        int   ji[4]  = int[4](a_Joints.x, a_Joints.y, a_Joints.z, a_Joints.w);
        float jw[4]  = float[4](a_Weights.x, a_Weights.y, a_Weights.z, a_Weights.w);

        // ---- the linear blend, always computed --------------------------------
        // It is the fallback for a scaled rig and one end of the mix, and it costs
        // four multiply-adds.
        mat4 lin = jw[0] * u_Bones[ji[0]] + jw[1] * u_Bones[ji[1]]
                 + jw[2] * u_Bones[ji[2]] + jw[3] * u_Bones[ji[3]];
        lin /= wsum;
        vec3 linPos = (lin * vec4(a_Position, 1.0)).xyz;
        vec3 linNrm = mat3(lin) * a_Normal;

        // A dual quaternion carries rotation and translation and nothing else, so
        // any SCALE in the palette has to go down the linear path. Silently
        // dropping it would shrink one patch of the mesh with no explanation.
        bool rigid = true;
        for (int i = 0; i < 4; ++i) {
            if (jw[i] <= 0.0) continue;
            float s = length(u_Bones[ji[i]][0].xyz);
            if (abs(s - 1.0) > 0.01) rigid = false;
        }

        if (u_SkinBlend <= 0.001 || !rigid) {
            skinnedPos = linPos;
            skinnedNrm = linNrm;
        } else {
            vec4 accR = vec4(0.0);
            vec4 accD = vec4(0.0);
            vec4 pivot = vec4(0.0);
            bool first = true;

            for (int i = 0; i < 4; ++i) {
                if (jw[i] <= 0.0) continue;
                mat4 m  = u_Bones[ji[i]];
                vec4 qr = quatFromMat(mat3(m));
                vec4 qd = dualFromTranslation(m[3].xyz, qr);

                // A quaternion and its negation are the same rotation, so two
                // bones can hold numerically opposite values for nearly the same
                // orientation — and summing those cancels them, which shows up as
                // single vertices turned inside out. Everything is aligned to the
                // FIRST influence before it is added.
                if (first) { pivot = qr; first = false; }
                else if (dot(pivot, qr) < 0.0) { qr = -qr; qd = -qd; }

                accR += jw[i] * qr;
                accD += jw[i] * qd;
            }

            float len = length(accR);
            if (len < 1e-6) {
                skinnedPos = linPos;      // fully cancelled: nothing to normalise
                skinnedNrm = linNrm;
            } else {
                accR /= len;
                accD /= len;
                vec3 dqPos = dqTransformPoint(accR, accD, a_Position);
                vec3 dqNrm = dqTransformVector(accR, a_Normal);
                skinnedPos = mix(linPos, dqPos, u_SkinBlend);
                skinnedNrm = mix(linNrm, dqNrm, u_SkinBlend);
            }
        }
    }

    vec4 world = u_Model * vec4(skinnedPos, 1.0);
    v_WorldPos = world.xyz;
    v_GridPos = a_Position;
    v_GridNormal = vec3(0.0, 1.0, 0.0);
    // The model's normal matrix (inverse-transpose), so a non-uniformly scaled
    // character is lit correctly. The skinning part needs no such correction:
    // bone transforms are rigid, and the dual-quaternion path rotates the normal
    // rather than multiplying it by a blended matrix.
    mat3 normalMatrix = transpose(inverse(mat3(u_Model)));
    v_Normal   = normalize(normalMatrix * skinnedNrm);
    v_TexCoord = a_TexCoord;
    v_AffineUV = a_TexCoord;
    v_AffinePos = world.xyz;
    v_LightSpacePos = u_LightSpace * world;
    v_MatColorMetal = vec4(u_BaseColor, u_Metallic);
    v_MatRoughRefl  = vec4(u_Roughness, u_Reflectance, 0.0, 0.0);
    gl_Position = FZE_RetroSnap(u_ViewProjection * world);
}
