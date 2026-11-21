// ---------------------------------------------------------------
//  Fiona Zi Engine — F3D generator: a bridge
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// A deck across `length` metres (along x, centred), at `height`: on beams and piers, on
// an arch with hangers, or hung from two towers by cables. Railings both sides; asphalt
// on top with a dashed line. Its deck is walkable and drivable (mesh collider).
// ---------------------------------------------------------------
import { THREE, F3D, M, box, boxUV, Batch, withDefaults } from 'f3d/generators/common.js';

export const info = {
    name: 'bridge',
    title: 'Bridge',
    description: 'A bridge deck on piers, under an arch, or hung from towers by cables; railings, asphalt and lane line.',
    params: {
        length: { default: 60, min: 10, max: 400, label: 'Length (m)' },
        width:  { default: 10, min: 3, max: 40, label: 'Width (m)' },
        height: { default: 8, min: 1, max: 60, label: 'Deck height (m)' },
        style:  { default: 'arch', options: ['beam', 'arch', 'suspension'], label: 'Style' },
        span:   { default: 15, min: 6, max: 80, label: 'Pier spacing (m)' },
        seed:   { default: 1, int: true, label: 'Seed' },
    },
};

export function build(p) {
    const group = new THREE.Group();
    group.name = 'Bridge';
    const batch = new Batch();
    const L = p.length, W = p.width, H = p.height, t = 0.8;
    // The deck, and the road on it.
    group.add(box(L, t, W, M.concrete(), 0, H - t / 2, 0, { tile: 3 }));
    batch.add(M.asphalt(), boxUV(new THREE.BoxGeometry(L, 0.05, W - 1.2).translate(0, H + 0.025, 0), 6));
    for (let x = -L / 2 + 1; x + 3 < L / 2; x += 9) batch.add(M.paint(), new THREE.BoxGeometry(3, 0.02, 0.14).translate(x + 1.5, H + 0.06, 0));
    // Railings: posts every 2 m, a top rail and a mid rail.
    for (const s of [-1, 1]) {
        const z = s * (W / 2 - 0.15);
        for (let x = -L / 2; x <= L / 2 + 1e-3; x += 2) batch.add(M.metal(), new THREE.BoxGeometry(0.08, 1.1, 0.08).translate(x, H + 0.55, z));
        batch.add(M.metal(), new THREE.BoxGeometry(L, 0.08, 0.1).translate(0, H + 1.1, z));
        batch.add(M.metal(), new THREE.BoxGeometry(L, 0.05, 0.06).translate(0, H + 0.6, z));
    }
    if (p.style === 'beam' || p.style === 'arch') {
        // Piers down to the ground: at the ends, and every `span` for a beam bridge.
        const xs = [-L / 2 + 1, L / 2 - 1];
        if (p.style === 'beam') for (let x = -L / 2 + p.span; x < L / 2 - p.span / 2; x += p.span) xs.push(x);
        for (const x of xs) group.add(box(1.6, H - t, W * 0.7, M.concrete(), x, (H - t) / 2, 0, { tile: 3 }));
    }
    if (p.style === 'arch') {
        // An arch each side, rising above the deck, with hangers down to it.
        const rise = Math.min(L * 0.22, 25);
        for (const s of [-1, 1]) {
            const z = s * (W / 2 + 0.4);
            const pts = [];
            for (let i = 0; i <= 24; i++) {
                const u = i / 24, x = -L / 2 + u * L;
                pts.push(new THREE.Vector3(x, H + 4 * rise * u * (1 - u), z));
            }
            const curve = new THREE.CatmullRomCurve3(pts);
            batch.add(M.frame(), new THREE.TubeGeometry(curve, 48, 0.45, 8, false));
            for (let x = -L / 2 + 4; x < L / 2 - 3; x += 4) {
                const u = (x + L / 2) / L, top = H + 4 * rise * u * (1 - u);
                if (top - H < 1) continue;
                batch.add(M.metal(), new THREE.CylinderGeometry(0.05, 0.05, top - H, 4).translate(x, H + (top - H) / 2, z));
            }
        }
    }
    if (p.style === 'suspension') {
        const towerH = H + Math.min(L * 0.25, 40);
        const tx = [-L * 0.3, L * 0.3];
        for (const x of tx) {
            for (const s of [-1, 1]) group.add(box(1.2, towerH, 1.2, M.concrete(), x, towerH / 2, s * (W / 2 + 0.6), { tile: 3 }));
            group.add(box(1.2, 1.5, W + 2.4, M.concrete(), x, towerH - 0.75, 0, { tile: 3 }));
        }
        // Main cables: tower to tower sagging, and down to the ends; hangers to the deck.
        for (const s of [-1, 1]) {
            const z = s * (W / 2 + 0.6);
            const pts = [new THREE.Vector3(-L / 2, H + 0.5, z)];
            for (let i = 0; i <= 20; i++) {
                const u = i / 20, x = tx[0] + u * (tx[1] - tx[0]);
                pts.push(new THREE.Vector3(x, towerH - (towerH - H - 2) * 4 * u * (1 - u), z));
            }
            pts.push(new THREE.Vector3(L / 2, H + 0.5, z));
            const cable = new THREE.CatmullRomCurve3(pts);
            batch.add(M.darkMetal(), new THREE.TubeGeometry(cable, 80, 0.18, 6, false));
            for (let x = tx[0] + 3; x < tx[1] - 2; x += 3) {
                const u = (x - tx[0]) / (tx[1] - tx[0]), top = towerH - (towerH - H - 2) * 4 * u * (1 - u);
                batch.add(M.metal(), new THREE.CylinderGeometry(0.04, 0.04, top - H, 4).translate(x, H + (top - H) / 2, z));
            }
        }
        for (const x of [-L / 2 + 1, L / 2 - 1]) group.add(box(1.6, H - t, W * 0.7, M.concrete(), x, (H - t) / 2, 0, { tile: 3 }));
    }
    return batch.into(group);
}

export function generate(params) {
    const p = withDefaults(info, params);
    F3D.add(build(p), { name: 'Bridge', merge: true, collider: 'mesh' });
}
