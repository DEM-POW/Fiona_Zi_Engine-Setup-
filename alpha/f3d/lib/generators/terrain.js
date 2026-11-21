// ---------------------------------------------------------------
//  Fiona Zi Engine — F3D generator: terrain (a mesh)
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// Ground from fractal noise: rolling hills, mountains with ridges, or an island falling
// to the sea. Painted by what it is - sand near the water, grass on the gentle slopes,
// rock on the steep ones, snow on the peaks - as sections of ONE mesh, and a water plane
// at `water`. A MESH: for the engine's own Terrain (painted layers, foliage, digging) the
// heights would go to the Terrain system instead - not this generator's job yet.
// ---------------------------------------------------------------
import { THREE, F3D, M, withDefaults, fbm } from 'f3d/generators/common.js';

export const info = {
    name: 'terrain',
    title: 'Terrain (mesh)',
    description: 'Hills, mountains or an island from fractal noise, painted sand/grass/rock/snow by height and slope, with optional water.',
    params: {
        size:       { default: 200, min: 20, max: 2000, label: 'Size (m)' },
        resolution: { default: 128, min: 16, max: 384, int: true, label: 'Resolution (cells)' },
        height:     { default: 30, min: 1, max: 400, label: 'Height (m)' },
        kind:       { default: 'hills', options: ['hills', 'mountains', 'island'], label: 'Kind' },
        scale:      { default: 1, min: 0.2, max: 6, label: 'Feature scale' },
        water:      { default: -1, min: -1, max: 400, label: 'Water level (m), -1 = none' },
        seed:       { default: 1, int: true, label: 'Seed' },
    },
};

export function build(p) {
    const n = p.resolution, S = p.size, H = p.height;
    const geo = new THREE.PlaneGeometry(S, S, n, n);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position');
    const f = (1.6 * p.scale) / 100;   // features about 60 m at scale 1
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        let h;
        if (p.kind === 'mountains') {
            const r = 1 - Math.abs(fbm(x * f, z * f, 6, p.seed));   // ridged
            h = Math.pow(r, 2.2) * H;
        } else {
            h = (fbm(x * f, z * f, 5, p.seed) * 0.5 + 0.5) * H;
        }
        if (p.kind === 'island') {
            const d = Math.sqrt(x * x + z * z) / (S / 2);
            h *= Math.max(0, 1 - d * d * 1.2);
            h -= H * 0.08;
        }
        pos.setY(i, h);
    }
    geo.computeVertexNormals();
    // UVs in metres (a tile every 4 m).
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 4, pos.getZ(i) / 4);

    // Each triangle to a section by what it is: 0 sand, 1 grass, 2 rock, 3 snow.
    const nrm = geo.getAttribute('normal');
    const index = geo.index.array;
    const lists = [[], [], [], []];
    const water = p.water >= 0 ? p.water : -1e9;
    for (let t = 0; t < index.length; t += 3) {
        const a = index[t], b = index[t + 1], c = index[t + 2];
        const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
        const up = (nrm.getY(a) + nrm.getY(b) + nrm.getY(c)) / 3;
        let k = 1;
        if (up < 0.78) k = 2;
        else if (y > H * 0.78) k = 3;
        else if (y < water + 1.2) k = 0;
        lists[k].push(a, b, c);
    }
    const materials = [M.sand(), M.grass(), M.rock(), M.snow()];
    const order = [], used = [];
    let start = 0;
    geo.clearGroups();
    lists.forEach((l, k) => {
        if (!l.length) return;
        for (const v of l) order.push(v);   // (not push(...l): QuickJS takes 65,535 arguments at most)
        geo.addGroup(start, l.length, used.length);
        used.push(materials[k]);
        start += l.length;
    });
    geo.setIndex(order);
    const ground = new THREE.Mesh(geo, used);
    ground.name = 'Ground';
    const group = new THREE.Group();
    group.name = 'Terrain';
    group.add(ground);
    if (p.water >= 0) {
        const w = new THREE.Mesh(new THREE.PlaneGeometry(S, S, 1, 1).rotateX(-Math.PI / 2).translate(0, p.water, 0), M.water());
        w.name = 'Water';
        w.userData.collider = 'none';
        group.add(w);
    }
    return group;
}

export function generate(params) {
    const p = withDefaults(info, params);
    F3D.add(build(p), { name: 'Terrain', collider: 'mesh' });
}
