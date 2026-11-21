// ---------------------------------------------------------------
//  Fiona Zi Engine — F3D generator: trees
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// A broadleaf (a tapering trunk, branches splitting a few times, clumps of leaves made
// lumpy with noise) or a pine (a trunk and stacked cones). Low poly on purpose - a park
// is dozens of them on a laptop's GPU. `count` > 1 scatters a grove over `spread` metres.
// ---------------------------------------------------------------
import { THREE, F3D, M, Batch, withDefaults, noise3 } from 'f3d/generators/common.js';

export const info = {
    name: 'tree',
    title: 'Tree',
    description: 'Broadleaf or pine trees, low poly, each a little different; one or a scattered grove.',
    params: {
        kind:   { default: 'broadleaf', options: ['broadleaf', 'pine'], label: 'Kind' },
        height: { default: 7, min: 2, max: 30, label: 'Height (m)' },
        count:  { default: 1, min: 1, max: 200, int: true, label: 'Count' },
        spread: { default: 20, min: 2, max: 300, label: 'Spread (m)' },
        seed:   { default: 1, int: true, label: 'Seed' },
    },
};

function lumpy(radius, rnd) {
    const g = new THREE.IcosahedronGeometry(radius, 1);
    const p = g.getAttribute('position');
    const o = rnd.range(0, 100);
    for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const k = 1 + 0.28 * noise3(x * 0.9 + o, y * 0.9, z * 0.9);
        p.setXYZ(i, x * k, y * k * 0.85, z * k);
    }
    g.computeVertexNormals();
    return g;
}

// A branch from `from` toward `dir`, of `len` and `r`; returns where it ends.
function limb(batch, from, dir, len, r0, r1) {
    const g = new THREE.CylinderGeometry(r1, r0, len, 5, 1);
    g.translate(0, len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    g.applyQuaternion(q);
    g.translate(from.x, from.y, from.z);
    batch.add(M.bark(), g);
    return from.clone().addScaledVector(dir.clone().normalize(), len);
}

function broadleaf(batch, x, z, h, rnd) {
    const trunkH = h * rnd.range(0.38, 0.5), r = h * 0.035;
    const top = limb(batch, new THREE.Vector3(x, 0, z), new THREE.Vector3(rnd.range(-0.08, 0.08), 1, rnd.range(-0.08, 0.08)), trunkH, r, r * 0.7);
    const crown = h - trunkH;
    const n = rnd.int(3, 5);
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd.range(-0.4, 0.4);
        const dir = new THREE.Vector3(Math.cos(a) * rnd.range(0.5, 0.9), rnd.range(0.7, 1.1), Math.sin(a) * rnd.range(0.5, 0.9));
        const end = limb(batch, top, dir, crown * rnd.range(0.4, 0.6), r * 0.6, r * 0.25);
        batch.add(M.leaves(), lumpy(crown * rnd.range(0.28, 0.38), rnd).translate(end.x, end.y + crown * 0.05, end.z));
    }
    batch.add(M.leaves(), lumpy(crown * 0.42, rnd).translate(top.x, top.y + crown * 0.45, top.z));
}

function pine(batch, x, z, h, rnd) {
    const r = h * 0.03;
    limb(batch, new THREE.Vector3(x, 0, z), new THREE.Vector3(0, 1, 0), h * 0.3, r, r * 0.8);
    const tiers = rnd.int(3, 5);
    for (let i = 0; i < tiers; i++) {
        const t = i / tiers;
        const cr = h * 0.24 * (1 - t * 0.75), ch = h * 0.34 * (1 - t * 0.3);
        const g = new THREE.ConeGeometry(cr, ch, 7, 1);
        g.rotateY(rnd.range(0, Math.PI));
        g.translate(x, h * 0.22 + t * h * 0.62 + ch / 2, z);
        batch.add(M.pine(), g);
    }
}

export function build(p, rnd = F3D.makeRandom(p.seed)) {
    const group = new THREE.Group();
    group.name = p.count > 1 ? 'Grove' : 'Tree';
    const batch = new Batch();
    for (let i = 0; i < p.count; i++) {
        const x = p.count > 1 ? rnd.range(-p.spread / 2, p.spread / 2) : 0;
        const z = p.count > 1 ? rnd.range(-p.spread / 2, p.spread / 2) : 0;
        const h = p.height * rnd.range(0.8, 1.2);
        if (p.kind === 'pine') pine(batch, x, z, h, rnd);
        else broadleaf(batch, x, z, h, rnd);
    }
    return batch.into(group);
}

export function generate(params) {
    const p = withDefaults(info, params);
    // Trunks collide (convex would hug the leaves too); a grove is one model.
    F3D.add(build(p), { name: p.count > 1 ? 'Grove' : 'Tree', merge: true, collider: 'mesh' });
}
