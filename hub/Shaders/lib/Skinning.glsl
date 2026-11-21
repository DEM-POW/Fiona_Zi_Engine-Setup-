// ---------------------------------------------------------------
//  Fiona Zi Engine - skinning (Animation 2.0)
// ---------------------------------------------------------------
// The bone palette and the blend of linear and dual-quaternion skinning, shared
// by every program that draws a character: the lit pass (Character.vert) and
// every depth pass (CharacterDepth.vert). One copy, so a shadow can never be cast
// by a differently skinned body than the one that is lit.
//
// The palette is a storage buffer: a uniform array caps the rig (see the note in
// Skinned.vert - 677 bones on the horse).
layout(std430, binding = 0) readonly buffer BoneBuffer {
    mat4 u_Bones[];
};
// 0 linear blend, 1 dual quaternion; the engine ships in between.
uniform float u_SkinBlend;

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


// Skin a position and a normal by up to four joints.
void FZE_Skin(vec3 pos, vec3 nrm, ivec4 joints, vec4 weights, out vec3 outPos, out vec3 outNrm)
{
    float wsum = weights.x + weights.y + weights.z + weights.w;
    if (wsum < 1e-4) { outPos = pos; outNrm = nrm; return; }   // a static part riding the mesh
    int   ji[4] = int[4](joints.x, joints.y, joints.z, joints.w);
    float jw[4] = float[4](weights.x, weights.y, weights.z, weights.w);
    mat4 lin = jw[0] * u_Bones[ji[0]] + jw[1] * u_Bones[ji[1]] + jw[2] * u_Bones[ji[2]] + jw[3] * u_Bones[ji[3]];
    lin /= wsum;
    vec3 linPos = (lin * vec4(pos, 1.0)).xyz;
    vec3 linNrm = mat3(lin) * nrm;
    // Scale cannot go down the dual-quaternion path.
    bool rigid = true;
    for (int i = 0; i < 4; ++i) {
        if (jw[i] <= 0.0) continue;
        if (abs(length(u_Bones[ji[i]][0].xyz) - 1.0) > 0.01) rigid = false;
    }
    if (u_SkinBlend <= 0.001 || !rigid) { outPos = linPos; outNrm = linNrm; return; }
    vec4 accR = vec4(0.0), accD = vec4(0.0), pivot = vec4(0.0);
    bool first = true;
    for (int i = 0; i < 4; ++i) {
        if (jw[i] <= 0.0) continue;
        mat4 m  = u_Bones[ji[i]];
        vec4 qr = quatFromMat(mat3(m));
        vec4 qd = dualFromTranslation(m[3].xyz, qr);
        if (first) { pivot = qr; first = false; }
        else if (dot(pivot, qr) < 0.0) { qr = -qr; qd = -qd; }   // the same rotation, aligned
        accR += jw[i] * qr;
        accD += jw[i] * qd;
    }
    float len = length(accR);
    if (len < 1e-6) { outPos = linPos; outNrm = linNrm; return; }
    accR /= len; accD /= len;
    outPos = mix(linPos, dqTransformPoint(accR, accD, pos), u_SkinBlend);
    outNrm = mix(linNrm, dqTransformVector(accR, nrm), u_SkinBlend);
}
