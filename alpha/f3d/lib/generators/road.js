// ---------------------------------------------------------------
//  Fiona Zi Engine — F3D generator: a road
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// A road along a smooth curve through `points` ([[x, z], ...]): asphalt, a dashed
// centre line and edge lines, kerbs, raised pavements either side, and street lights
// along one side. Everything follows the curve; asphalt and pavement tile in metres.
// ---------------------------------------------------------------
import { THREE, F3D, M, Batch, ribbon, wall, withDefaults } from 'f3d/generators/common.js';

export const info = {
    name: 'road',
    title: 'Road',
    description: 'A road along a curve through points: asphalt, lane lines, kerbs, pavements and street lights.',
    params: {
        points:     { default: [[0, 0], [30, 10], [60, 0], [90, -20]], label: 'Points [[x,z],...]' },
        width:      { default: 8, min: 3, max: 40, label: 'Road width (m)' },
        pavement:   { default: 2.5, min: 0, max: 10, label: 'Pavement (m)' },
        kerb:       { default: 0.15, min: 0, max: 0.4, label: 'Kerb height (m)' },
        lights:     { default: 25, min: 0, max: 100, label: 'Street light every (m), 0 = none' },
        markings:   { default: true, label: 'Lane markings' },
        seed:       { default: 1, int: true, label: 'Seed' },
    },
};

// A street light: a pole, an arm over the road, a glowing head.
export function streetLight(batch, x, z, facing, height = 7) {
    batch.add(M.darkMetal(), new THREE.CylinderGeometry(0.07, 0.11, height, 6).translate(x, height / 2, z));
    const arm = new THREE.BoxGeometry(1.6, 0.08, 0.08);
    arm.translate(0.8, 0, 0);
    arm.rotateY(-Math.atan2(facing.z, facing.x));
    arm.translate(x, height - 0.1, z);
    batch.add(M.darkMetal(), arm);
    const hx = x + facing.x * 1.55, hz = z + facing.z * 1.55;
    batch.add(M.darkMetal(), new THREE.BoxGeometry(0.5, 0.12, 0.25).translate(hx, height - 0.15, hz));
    batch.add(M.lamp(), new THREE.BoxGeometry(0.42, 0.03, 0.2).translate(hx, height - 0.225, hz));
}

export function build(p) {
    const pts = (Array.isArray(p.points) && p.points.length >= 2 ? p.points : info.params.points.default)
        .map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const len = curve.getLength();
    const segs = Math.max(8, Math.ceil(len / 2));
    const half = p.width / 2;
    const group = new THREE.Group();
    group.name = 'Road';
    const batch = new Batch();
    batch.add(M.asphalt(), ribbon(curve, -half, half, 0.02, segs, 6));
    if (p.pavement > 0) {
        for (const s of [-1, 1]) {
            const a = s * half, b = s * (half + p.pavement);
            batch.add(M.pavement(), ribbon(curve, Math.min(a, b), Math.max(a, b), p.kerb, segs, 2));
            // The kerb's face, from the road up to the pavement, and the pavement's outer edge.
            if (p.kerb > 0) {
                batch.add(M.concrete(), wall(curve, a, 0.0, p.kerb, segs, 1));
                batch.add(M.concrete(), wall(curve, b, 0.0, p.kerb, segs, 1));
            }
        }
    }
    if (p.markings) {
        // Dashes down the middle (3 m on, 6 m off), solid lines at the edges.
        const dash = 3, gap = 6, w = 0.14;
        for (let d = 0; d + dash < len; d += dash + gap) {
            const sub = new THREE.CatmullRomCurve3([curve.getPointAt(d / len), curve.getPointAt((d + dash * 0.5) / len), curve.getPointAt((d + dash) / len)]);
            batch.add(M.paint(), ribbon(sub, -w / 2, w / 2, 0.03, 2, 1));
        }
        for (const s of [-1, 1]) batch.add(M.paint(), ribbon(curve, s * (half - 0.35) - w / 2, s * (half - 0.35) + w / 2, 0.03, segs, 1));
    }
    if (p.lights > 0) {
        for (let d = p.lights / 2; d < len; d += p.lights) {
            const t = d / len, q = curve.getPointAt(t), tan = curve.getTangentAt(t);
            const right = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
            const off = half + Math.min(0.6, p.pavement * 0.4);
            streetLight(batch, q.x + right.x * off, q.z + right.z * off, right.clone().negate());
        }
    }
    return batch.into(group);
}

export function generate(params) {
    const p = withDefaults(info, params);
    F3D.add(build(p), { name: 'Road', merge: true, collider: 'mesh' });
}
