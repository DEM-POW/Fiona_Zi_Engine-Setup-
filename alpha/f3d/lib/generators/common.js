// ---------------------------------------------------------------
//  Fiona Zi Engine — F3D generators: what every generator shares
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// A generator is a module with:
//   export const info = { name, title, description, params: { key: { default, min, max, int, options, label } } }
//   export function build(p, rnd)   -> a THREE.Object3D (nothing handed over yet)
//   export function generate(params) -> builds it and hands it to the engine (F3D.add)
// `build` is what other generators call (the city builds buildings and trees with it);
// `generate` is what f3d_run { generator } runs.
//
// ⚠️ ONE MATERIAL OBJECT PER NAME. The engine makes one .fzemat per material OBJECT: a new
// F3D.material('Concrete') for every building was a hundred identical files and a
// hundred draw states. `mat` makes each name once per run and shares it.
// ⚠️ UVS IN METRES, NOT 0..1 PER FACE. A textured preset (brick, asphalt) on a BoxGeometry
// stretches ONE tile over a 40 m wall. `boxUV` projects each face along its normal in
// metres over `tile`, so a brick is a brick on every wall, and pieces side by side line up.
// ---------------------------------------------------------------
import * as THREE from 'three';
import { F3D } from 'f3d';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

export { THREE, F3D, mergeGeometries };

// ---- parameters ---------------------------------------------------------------------

export function withDefaults(info, params = {}) {
    const out = {};
    for (const [k, spec] of Object.entries(info.params)) {
        let v = params[k] ?? spec.default;
        if (typeof spec.default === 'number') {
            v = Number(v);
            if (!Number.isFinite(v)) v = spec.default;
            if (spec.min !== undefined) v = Math.max(spec.min, v);
            if (spec.max !== undefined) v = Math.min(spec.max, v);
            if (spec.int) v = Math.round(v);
        } else if (spec.options && !spec.options.includes(v)) {
            v = spec.default;
        }
        out[k] = v;
    }
    for (const [k, v] of Object.entries(params)) if (!(k in out)) out[k] = v;
    return out;
}

// ---- materials: one per name, per run -----------------------------------------------

const made = new Map();
export function mat(name, props) {
    if (!made.has(name)) made.set(name, F3D.material(name, props));
    return made.get(name);
}
export const M = {
    concrete: () => mat('Concrete', { preset: 'Concrete_Cracked' }),
    brick: () => mat('Brick', { preset: 'Brick_Weathered' }),
    brickClean: () => mat('Brick Clean', { preset: 'Brick_Clean' }),
    asphalt: () => mat('Asphalt', { preset: 'Asphalt_Worn' }),
    pavement: () => mat('Pavement', { preset: 'Tiles_Ceramic', color: 0xb8b2a8 }),
    rock: () => mat('Rock', { preset: 'Rock_Rough' }),
    sand: () => mat('Sand', { preset: 'Sand_Fine' }),
    soil: () => mat('Soil', { preset: 'Soil_Dry' }),
    snow: () => mat('Snow', { preset: 'Snow_Fresh' }),
    wood: () => mat('Wood', { preset: 'Wood_Planks' }),
    // Windows dark and reflective, not see-through: a building has no inside to see.
    window: () => mat('Window', { color: 0x1c2a36, roughness: 0.06, metalness: 0.7 }),
    // A blue-grey that takes the sky (at 0x2b4258 a glass tower read as a black monolith).
    curtain: () => mat('Curtain Wall', { color: 0x6d8aa3, roughness: 0.1, metalness: 0.55 }),
    frame: () => mat('Frame', { color: 0x8a8f94, roughness: 0.45, metalness: 0.6 }),
    roof: () => mat('Roof Tiles', { color: 0x7a3326, roughness: 0.75 }),
    roofFlat: () => mat('Roof', { color: 0x55585c, roughness: 0.9 }),
    paint: () => mat('Road Paint', { color: 0xeeeeea, roughness: 0.6 }),
    paintYellow: () => mat('Road Paint Yellow', { color: 0xe0b020, roughness: 0.6 }),
    grass: () => mat('Grass', { color: 0x3c6a28, roughness: 0.95 }),
    bark: () => mat('Bark', { color: 0x4e3a2a, roughness: 0.92 }),
    leaves: () => mat('Leaves', { color: 0x3a7430, roughness: 0.85 }),
    pine: () => mat('Pine Needles', { color: 0x24502c, roughness: 0.85 }),
    metal: () => mat('Metal', { look: 'steel' }),
    darkMetal: () => mat('Dark Metal', { color: 0x2c2f33, roughness: 0.5, metalness: 0.8 }),
    lamp: () => mat('Lamp Glow', { color: 0xfff1cc, emissive: 0xffe0a0, nits: 600 }),
    water: () => mat('Water', { color: 0x1c4a63, roughness: 0.04, metalness: 0.1, opacity: 0.85, transparent: true }),
};

// ---- geometry helpers ---------------------------------------------------------------

export function boxUV(geo, tile = 2) {
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const p = geo.getAttribute('position'), n = geo.getAttribute('normal');
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
        let u, v;
        if (ay >= ax && ay >= az) { u = x; v = z; }
        else if (ax >= az) { u = z; v = y; }
        else { u = x; v = y; }
        uv[i * 2] = u / tile;
        uv[i * 2 + 1] = v / tile;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return geo;
}

// A box placed by its geometry (not its object): its UVs follow where it stands.
export function box(w, h, d, material, x = 0, y = 0, z = 0, opts = {}) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (opts.rotY) g.rotateY(opts.rotY);
    g.translate(x, y, z);
    boxUV(g, opts.tile ?? 2);
    return new THREE.Mesh(g, material);
}

// Many small pieces of one material as ONE geometry: a facade's windows, a park's leaves.
export class Batch {
    constructor() { this.parts = new Map(); }
    add(material, geometry) {
        const g = geometry.index ? geometry.toNonIndexed() : geometry;
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
        if (!this.parts.has(material)) this.parts.set(material, []);
        this.parts.get(material).push(g);
    }
    meshes() {
        const out = [];
        for (const [material, list] of this.parts) out.push(new THREE.Mesh(list.length === 1 ? list[0] : mergeGeometries(list, false), material));
        return out;
    }
    into(group) { for (const m of this.meshes()) group.add(m); return group; }
}

// A flat strip along a curve on the ground, between two offsets from it (left -, right +),
// UV u across and v along, both in metres over `tile`.
export function ribbon(curve, from, to, y, segments, tile = 4) {
    const pos = [], uv = [], idx = [];
    const len = curve.getLength();
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = curve.getPointAt(t), tan = curve.getTangentAt(t);
        const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize();   // to the right of the way
        for (const off of [from, to]) {
            pos.push(p.x + side.x * off, y, p.z + side.z * off);
            uv.push(off / tile, (t * len) / tile);
        }
        if (i < segments) {
            const a = i * 2;
            idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Facing up whichever way the curve winds.
    const n = g.getAttribute('normal');
    if (n.count && n.getY(0) < 0) { g.setIndex(idx.map((_, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]])); g.computeVertexNormals(); }
    return g;
}

// A vertical strip along a curve at a lateral offset, from y0 to y1 (a kerb's face, a
// wall's side); both faces when `bothSides` (a strip has one).
export function wall(curve, offset, y0, y1, segments, tile = 2, bothSides = true) {
    const pos = [], uv = [], idx = [];
    const len = curve.getLength();
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = curve.getPointAt(t), tan = curve.getTangentAt(t);
        const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
        const x = p.x + side.x * offset, z = p.z + side.z * offset;
        pos.push(x, y0, z, x, y1, z);
        uv.push((t * len) / tile, y0 / tile, (t * len) / tile, y1 / tile);
        if (i < segments) {
            const a = i * 2;
            idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            if (bothSides) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
}

// Fractal noise in [-1, 1]-ish: octaves of Perlin, each half the size and half the weight.
const perlin = new ImprovedNoise();
export function fbm(x, z, octaves = 5, seed = 1) {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
        sum += a * perlin.noise(x * f, seed * 13.37 + o * 7.1, z * f);
        norm += a;
        a *= 0.5;
        f *= 2.0;
    }
    return sum / norm;
}
export function noise3(x, y, z) { return perlin.noise(x, y, z); }
