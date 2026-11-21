// ---------------------------------------------------------------
//  Fiona Zi Engine — F3D generator: rocks
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// Subdivided spheres pushed in and out by noise, flattened a little, half sunk into the
// ground: boulders, a scree of small stones, or one big outcrop. Each rock is its own
// object with a convex collider, so they can be stood on and walked round.
// ---------------------------------------------------------------
import { THREE, F3D, M, boxUV, withDefaults, noise3 } from 'f3d/generators/common.js';

export const info = {
    name: 'rocks',
    title: 'Rocks',
    description: 'Noise-shaped boulders and stones, half sunk into the ground; each with a convex collider.',
    params: {
        count:     { default: 8, min: 1, max: 120, int: true, label: 'Count' },
        size:      { default: 1.6, min: 0.2, max: 20, label: 'Size (m)' },
        spread:    { default: 10, min: 0, max: 200, label: 'Spread (m)' },
        roughness: { default: 0.35, min: 0, max: 0.8, label: 'Roughness' },
        detail:    { default: 2, min: 1, max: 4, int: true, label: 'Detail' },
        seed:      { default: 1, int: true, label: 'Seed' },
    },
};

export function rock(size, roughness, detail, rnd) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const p = g.getAttribute('position');
    const o = rnd.range(0, 1000), sx = rnd.range(0.8, 1.3), sy = rnd.range(0.5, 0.85), sz = rnd.range(0.8, 1.3);
    for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const n = noise3(x * 1.3 + o, y * 1.3, z * 1.3) + 0.5 * noise3(x * 3.1 + o, y * 3.1, z * 3.1);
        const k = 1 + roughness * n;
        p.setXYZ(i, x * k * sx * size, y * k * sy * size, z * k * sz * size);
    }
    g.computeVertexNormals();
    return boxUV(g, Math.max(0.5, size));
}

export function build(p, rnd = F3D.makeRandom(p.seed)) {
    const group = new THREE.Group();
    group.name = 'Rocks';
    for (let i = 0; i < p.count; i++) {
        const s = p.size * rnd.range(0.45, 1.25);
        const m = new THREE.Mesh(rock(s, p.roughness, p.detail, rnd), M.rock());
        const a = rnd.range(0, Math.PI * 2), r = p.count > 1 ? Math.sqrt(rnd()) * p.spread / 2 : 0;
        m.position.set(Math.cos(a) * r, s * 0.25, Math.sin(a) * r);   // a third sunk
        m.rotation.y = rnd.range(0, Math.PI * 2);
        m.name = 'Rock';
        m.userData.collider = 'convex';
        group.add(m);
    }
    return group;
}

export function generate(params) {
    const p = withDefaults(info, params);
    F3D.add(build(p), { name: 'Rocks', collider: 'convex' });
}
