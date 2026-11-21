// ---------------------------------------------------------------
//  Fiona Zi Engine — F3D generator: a building
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// Floors, a window grid on every face (quads a hand's width off the wall, one geometry
// for all of them), a plinth, and a roof: flat with a parapet and plant on top, a gable
// in tiles, a dome on a drum, or a skyscraper's setbacks. Styles: concrete, brick, or a
// glass curtain wall with its floor slabs showing. Everything in metres; it stands on
// y = 0 with its centre at x = z = 0.
// ---------------------------------------------------------------
import { THREE, F3D, M, box, boxUV, Batch, withDefaults } from 'f3d/generators/common.js';

export const info = {
    name: 'building',
    title: 'Building',
    description: 'A building of any height: floors, windows on every face, a plinth, and a flat, gable, dome or setback roof; concrete, brick or glass.',
    params: {
        width:         { default: 16, min: 4, max: 80, label: 'Width (m)' },
        depth:         { default: 14, min: 4, max: 80, label: 'Depth (m)' },
        floors:        { default: 8, min: 1, max: 90, int: true, label: 'Floors' },
        floorHeight:   { default: 3.2, min: 2.6, max: 6, label: 'Floor height (m)' },
        style:         { default: 'concrete', options: ['concrete', 'brick', 'glass'], label: 'Style' },
        roof:          { default: 'flat', options: ['flat', 'gable', 'dome', 'setback'], label: 'Roof' },
        windowSpacing: { default: 3.0, min: 1.6, max: 8, label: 'Window spacing (m)' },
        seed:          { default: 1, int: true, label: 'Seed' },
    },
};

// The windows of one face: a grid of quads standing off the wall along its normal.
function facadeWindows(batch, material, cx, cz, along, len, normal, floors, floorHeight, y0, spacing) {
    const cols = Math.max(1, Math.floor((len - 1.0) / spacing));
    const ww = Math.min(spacing * 0.58, 2.4), wh = floorHeight * 0.52;
    const start = -((cols - 1) * spacing) / 2;
    for (let f = 0; f < floors; f++) {
        const y = y0 + f * floorHeight + floorHeight * 0.55;
        for (let c = 0; c < cols; c++) {
            const s = start + c * spacing;
            const g = new THREE.PlaneGeometry(ww, wh);
            // A plane faces +z; turned to face out of this wall.
            g.rotateY(Math.atan2(normal.x, normal.z));
            g.translate(cx + along.x * s + normal.x * 0.03, y, cz + along.z * s + normal.z * 0.03);
            batch.add(material, g);
        }
    }
}

// One block of the building: walls (or curtain wall + slabs), windows on its four faces.
function tier(group, batch, p, w, d, y0, floors, rnd) {
    const h = floors * p.floorHeight;
    const wall = p.style === 'brick' ? (rnd.chance(0.5) ? M.brick() : M.brickClean()) : p.style === 'glass' ? M.curtain() : M.concrete();
    group.add(box(w, h, d, wall, 0, y0 + h / 2, 0, { tile: 2.5 }));
    if (p.style === 'glass') {
        // The floor slabs and the mullions show through a curtain wall.
        for (let f = 1; f <= floors; f++) batch.add(M.frame(), boxUV(new THREE.BoxGeometry(w + 0.12, 0.25, d + 0.12).translate(0, y0 + f * p.floorHeight - 0.12, 0), 2));
        const mull = (len, axis) => {
            const n = Math.max(1, Math.floor(len / 1.6));
            for (let i = 1; i < n; i++) {
                const s = -len / 2 + (i * len) / n;
                for (const side of [-1, 1]) {
                    const g = axis === 'x' ? new THREE.BoxGeometry(0.08, h, 0.08).translate(s, y0 + h / 2, side * (d / 2 + 0.04))
                                           : new THREE.BoxGeometry(0.08, h, 0.08).translate(side * (w / 2 + 0.04), y0 + h / 2, s);
                    batch.add(M.frame(), g);
                }
            }
        };
        mull(w, 'x');
        mull(d, 'z');
        return h;
    }
    const sp = p.windowSpacing;
    facadeWindows(batch, M.window(), 0, d / 2, { x: 1, z: 0 }, w, { x: 0, z: 1 }, floors, p.floorHeight, y0, sp);
    facadeWindows(batch, M.window(), 0, -d / 2, { x: -1, z: 0 }, w, { x: 0, z: -1 }, floors, p.floorHeight, y0, sp);
    facadeWindows(batch, M.window(), w / 2, 0, { x: 0, z: -1 }, d, { x: 1, z: 0 }, floors, p.floorHeight, y0, sp);
    facadeWindows(batch, M.window(), -w / 2, 0, { x: 0, z: 1 }, d, { x: -1, z: 0 }, floors, p.floorHeight, y0, sp);
    return h;
}

function flatTop(group, batch, w, d, y, rnd) {
    group.add(box(w, 0.2, d, M.roofFlat(), 0, y + 0.1, 0, { tile: 3 }));
    const t = 0.25, ph = 0.9;   // the parapet
    batch.add(M.concrete(), boxUV(new THREE.BoxGeometry(w, ph, t).translate(0, y + ph / 2, d / 2 - t / 2), 2.5));
    batch.add(M.concrete(), boxUV(new THREE.BoxGeometry(w, ph, t).translate(0, y + ph / 2, -d / 2 + t / 2), 2.5));
    batch.add(M.concrete(), boxUV(new THREE.BoxGeometry(t, ph, d).translate(w / 2 - t / 2, y + ph / 2, 0), 2.5));
    batch.add(M.concrete(), boxUV(new THREE.BoxGeometry(t, ph, d).translate(-w / 2 + t / 2, y + ph / 2, 0), 2.5));
    // Plant on the roof: a few boxes, a little different on every building.
    const n = rnd.int(1, 3);
    for (let i = 0; i < n; i++) {
        const bw = rnd.range(1.5, Math.min(4, w * 0.3)), bd = rnd.range(1.5, Math.min(4, d * 0.3)), bh = rnd.range(1, 2.2);
        batch.add(M.darkMetal(), new THREE.BoxGeometry(bw, bh, bd).translate(rnd.range(-w / 4, w / 4), y + bh / 2 + 0.2, rnd.range(-d / 4, d / 4)));
    }
}

export function build(p, rnd = F3D.makeRandom(p.seed)) {
    const group = new THREE.Group();
    group.name = 'Building';
    const batch = new Batch();
    const { width: w, depth: d } = p;
    // The plinth: a little wider, a little darker, a storefront's height.
    group.add(box(w + 0.6, 0.6, d + 0.6, M.concrete(), 0, 0.3, 0, { tile: 2 }));
    let top;
    if (p.roof === 'setback' && p.floors >= 6) {
        const f1 = Math.max(2, Math.round(p.floors * 0.55)), f2 = Math.max(1, Math.round(p.floors * 0.3)), f3 = Math.max(1, p.floors - f1 - f2);
        let y = 0.6;
        y += tier(group, batch, p, w, d, y, f1, rnd);
        flatTop(group, batch, w, d, y, rnd);
        y += tier(group, batch, p, w * 0.78, d * 0.78, y, f2, rnd);
        flatTop(group, batch, w * 0.78, d * 0.78, y, rnd);
        y += tier(group, batch, p, w * 0.55, d * 0.55, y, f3, rnd);
        top = y;
        flatTop(group, batch, w * 0.55, d * 0.55, top, rnd);
        // A mast on the very top.
        batch.add(M.darkMetal(), new THREE.CylinderGeometry(0.12, 0.2, p.floorHeight * 3, 6).translate(0, top + p.floorHeight * 1.5, 0));
    } else {
        top = 0.6 + tier(group, batch, p, w, d, 0.6, p.floors, rnd);
        if (p.roof === 'gable') {
            const rh = Math.min(w, d) * 0.35;
            const shape = new THREE.Shape();
            shape.moveTo(-w / 2 - 0.4, 0); shape.lineTo(w / 2 + 0.4, 0); shape.lineTo(0, rh); shape.lineTo(-w / 2 - 0.4, 0);
            const g = new THREE.ExtrudeGeometry(shape, { depth: d + 0.8, bevelEnabled: false });
            g.translate(0, top, -(d + 0.8) / 2);
            group.add(new THREE.Mesh(boxUV(g, 1.5), M.roof()));
        } else if (p.roof === 'dome') {
            const r = Math.min(w, d) * 0.42;
            batch.add(M.concrete(), boxUV(new THREE.CylinderGeometry(r, r, 1.2, 24).translate(0, top + 0.6, 0), 2));
            flatTop(group, batch, w, d, top, rnd);
            const dome = new THREE.SphereGeometry(r, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, top + 1.2, 0);
            group.add(new THREE.Mesh(dome, M.frame()));
        } else {
            flatTop(group, batch, w, d, top, rnd);
        }
    }
    batch.into(group);
    return group;
}

export function generate(params) {
    const p = withDefaults(info, params);
    F3D.add(build(p), { name: 'Building', merge: true, collider: 'mesh' });
}
