// ---------------------------------------------------------------
//  Fiona Zi Engine — F3D generator: a city
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// A grid of blocks with streets between them: asphalt with lane lines, raised pavements
// with kerbs, street lights, trees along some streets, parks, and buildings by zone -
// towers in the middle (glass and concrete, setbacks), mid-rise around it, low brick
// houses with gable roofs at the edge. Every block is ONE merged model with a section
// per material, the streets one, the lights one, the street trees one: a city of a
// hundred buildings is about thirty objects and a few hundred draw calls - for a
// laptop's GPU (UHD 620). Each block has an exact (mesh) collider.
// ---------------------------------------------------------------
import { THREE, F3D, M, box, boxUV, Batch, withDefaults } from 'f3d/generators/common.js';
import { build as buildBuilding } from 'f3d/generators/building.js';
import { build as buildTrees } from 'f3d/generators/tree.js';
import { streetLight } from 'f3d/generators/road.js';

export const info = {
    name: 'city',
    title: 'City',
    description: 'A city grid: streets with lane lines and street lights, pavements, parks, and buildings by zone (towers in the middle, low houses at the edge).',
    params: {
        blocksX:     { default: 5, min: 1, max: 16, int: true, label: 'Blocks across' },
        blocksZ:     { default: 5, min: 1, max: 16, int: true, label: 'Blocks deep' },
        block:       { default: 44, min: 20, max: 120, label: 'Block size (m)' },
        street:      { default: 12, min: 6, max: 40, label: 'Street width (m)' },
        pavement:    { default: 3, min: 1, max: 8, label: 'Pavement (m)' },
        downtown:    { default: 1, min: 0, max: 2, label: 'Downtown height (x)' },
        parks:       { default: 0.12, min: 0, max: 0.8, label: 'Share of parks' },
        streetTrees: { default: true, label: 'Trees along streets' },
        lights:      { default: true, label: 'Street lights' },
        seed:        { default: 1, int: true, label: 'Seed' },
    },
};

const KERB = 0.15;

// The buildings of one block, by how far it is from the middle (0 middle .. 1 edge).
function blockBuildings(group, p, inner, cx, cz, dist, rnd) {
    const tall = Math.max(0, 1 - dist) * p.downtown;
    const floorsAt = () => Math.max(1, Math.round(2 + tall * tall * rnd.range(18, 34) + rnd.range(0, 4)));
    const zoneStyle = () => (tall > 0.6 ? rnd.pick(['glass', 'glass', 'concrete']) : tall > 0.3 ? rnd.pick(['concrete', 'brick', 'glass']) : rnd.pick(['brick', 'brick', 'concrete']));
    const place = (w, d, x, z) => {
        const floors = floorsAt(), style = zoneStyle();
        const roof = floors >= 14 && rnd.chance(0.6) ? 'setback' : floors <= 4 && rnd.chance(0.55) ? 'gable' : floors >= 6 && rnd.chance(0.08) ? 'dome' : 'flat';
        const b = buildBuilding({ width: w, depth: d, floors, floorHeight: rnd.range(3.0, 3.6), style, roof, windowSpacing: rnd.range(2.6, 3.6), seed: rnd.int(1, 1e6) }, rnd);
        b.position.set(cx + x, KERB, cz + z);
        b.rotation.y = rnd.int(0, 3) * (Math.PI / 2) * (Math.abs(w - d) < 0.5 ? 1 : 0);   // square ones turn, for variety
        group.add(b);
    };
    const gap = 2.5;
    if (tall > 0.55 && rnd.chance(0.7)) {
        // One tower filling most of the block.
        const s = inner * rnd.range(0.62, 0.8);
        place(s, s * rnd.range(0.8, 1.0), 0, 0);
        return;
    }
    // Two by two lots (or one by two), each a building a little smaller than its lot.
    const nx = rnd.chance(0.75) ? 2 : 1, nz = 2;
    const lw = (inner - gap * (nx - 1)) / nx, ld = (inner - gap * (nz - 1)) / nz;
    for (let i = 0; i < nx; i++)
        for (let j = 0; j < nz; j++) {
            const x = -inner / 2 + lw / 2 + i * (lw + gap), z = -inner / 2 + ld / 2 + j * (ld + gap);
            place(lw * rnd.range(0.8, 0.95), ld * rnd.range(0.8, 0.95), x, z);
        }
}

export function generate(params) {
    const p = withDefaults(info, params);
    const rnd = F3D.makeRandom(p.seed);
    const pitch = p.block + p.street;
    const W = p.blocksX * p.block + (p.blocksX + 1) * p.street, D = p.blocksZ * p.block + (p.blocksZ + 1) * p.street;
    const cxOf = (i) => -W / 2 + p.street + p.block / 2 + i * pitch;
    const czOf = (j) => -D / 2 + p.street + p.block / 2 + j * pitch;

    // ---- the streets: one asphalt sheet under everything, lane lines between the blocks
    const streets = new THREE.Group();
    const sb = new Batch();
    sb.add(M.asphalt(), boxUV(new THREE.BoxGeometry(W, 0.04, D).translate(0, 0.0, 0), 6));
    const dash = 3, gapD = 6, lw = 0.15;
    for (let i = 0; i <= p.blocksX; i++) {   // streets running along z
        const x = -W / 2 + p.street / 2 + i * pitch;
        for (let j = 0; j < p.blocksZ; j++) {
            const z0 = czOf(j) - p.block / 2, z1 = czOf(j) + p.block / 2;
            for (let z = z0 + 2; z + dash < z1 - 2; z += dash + gapD) sb.add(M.paint(), new THREE.BoxGeometry(lw, 0.02, dash).translate(x, 0.03, z + dash / 2));
        }
    }
    for (let j = 0; j <= p.blocksZ; j++) {   // streets running along x
        const z = -D / 2 + p.street / 2 + j * pitch;
        for (let i = 0; i < p.blocksX; i++) {
            const x0 = cxOf(i) - p.block / 2, x1 = cxOf(i) + p.block / 2;
            for (let x = x0 + 2; x + dash < x1 - 2; x += dash + gapD) sb.add(M.paint(), new THREE.BoxGeometry(dash, 0.02, lw).translate(x + dash / 2, 0.03, z));
        }
    }
    // Crossings at every corner of every block (zebra stripes across the street).
    for (let i = 0; i < p.blocksX; i++)
        for (let j = 0; j <= p.blocksZ; j++) {
            const z = -D / 2 + p.street / 2 + j * pitch;
            for (const xEdge of [cxOf(i) - p.block / 2 + 2.5, cxOf(i) + p.block / 2 - 2.5])
                for (let s = -p.street / 2 + 1; s < p.street / 2 - 1; s += 1.2) sb.add(M.paint(), new THREE.BoxGeometry(2.4, 0.02, 0.6).translate(xEdge, 0.03, z + s));
        }
    sb.into(streets);
    F3D.add(streets, { name: 'Streets', merge: true, collider: 'mesh' });

    // ---- the blocks
    const lights = new Batch(), treesAlong = new THREE.Group();
    const maxDist = Math.hypot(W / 2, D / 2);
    for (let i = 0; i < p.blocksX; i++)
        for (let j = 0; j < p.blocksZ; j++) {
            const cx = cxOf(i), cz = czOf(j);
            const dist = Math.min(1, Math.hypot(cx, cz) / maxDist / 0.75);
            const blockGroup = new THREE.Group();
            const bb = new Batch();
            // The pavement: a raised island with its kerb.
            bb.add(M.pavement(), boxUV(new THREE.BoxGeometry(p.block, KERB, p.block).translate(cx, KERB / 2, cz), 2));
            const inner = p.block - p.pavement * 2;
            const park = dist > 0.2 && rnd.chance(p.parks);
            if (park) {
                bb.add(M.grass(), boxUV(new THREE.BoxGeometry(inner, 0.1, inner).translate(cx, KERB + 0.05, cz), 4));
                const grove = buildTrees({ kind: rnd.chance(0.3) ? 'pine' : 'broadleaf', height: rnd.range(6, 10), count: rnd.int(7, 14), spread: inner * 0.8, seed: rnd.int(1, 1e6) }, rnd);
                grove.position.set(cx, KERB + 0.1, cz);
                blockGroup.add(grove);
            } else {
                blockBuildings(blockGroup, p, inner, cx, cz, dist, rnd);
            }
            bb.into(blockGroup);
            F3D.add(blockGroup, { name: park ? `Park ${i + 1}-${j + 1}` : `Block ${i + 1}-${j + 1}`, merge: true, collider: 'mesh' });

            // Street lights at the block's corners and middles, on the pavement, facing the street.
            if (p.lights) {
                const e = p.block / 2 - 0.6;
                for (const [lx, lz, fx, fz] of [[-e, 0, -1, 0], [e, 0, 1, 0], [0, -e, 0, -1], [0, e, 0, 1], [-e, -e, -1, 0], [e, e, 1, 0]])
                    streetLight(lights, cx + lx, cz + lz, new THREE.Vector3(fx, 0, fz), 7);
            }
            // A few trees along the pavement, on some blocks.
            if (p.streetTrees && rnd.chance(0.5)) {
                const along = buildTrees({ kind: 'broadleaf', height: rnd.range(5, 7), count: 1, spread: 1, seed: rnd.int(1, 1e6) }, rnd);
                const n = 3;
                for (let k = 0; k < n; k++) {
                    const t = along.clone();
                    const s = -p.block / 2 + p.block * (k + 0.5) / n;
                    t.position.set(cx + s, KERB, cz - p.block / 2 + 1.2);
                    treesAlong.add(t);
                }
            }
        }
    if (p.lights) {
        const g = new THREE.Group();
        lights.into(g);
        F3D.add(g, { name: 'Street Lights', merge: true, collider: 'mesh' });
    }
    if (treesAlong.children.length) F3D.add(treesAlong, { name: 'Street Trees', merge: true, collider: 'mesh' });
    F3D.log(`city ${p.blocksX}x${p.blocksZ} blocks, ${W.toFixed(0)} x ${D.toFixed(0)} m`);
}
