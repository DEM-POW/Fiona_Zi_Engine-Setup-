// ---------------------------------------------------------------
//  Fiona Zi Engine — F3D (Fiona 3D): the script's side
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
//  import * as THREE from 'three';
//  import { F3D } from 'f3d';
//
//  const tower = new THREE.Mesh(new THREE.BoxGeometry(10, 60, 10), F3D.material('Glass', { look: 'glass' }));
//  tower.position.y = 30;
//  F3D.add(tower, { collider: 'box' });
//
// Three.js builds the GEOMETRY. Everything else belongs to Fiona Zi Engine: this file
// only takes the built scene apart into what the engine reads - each geometry once (its
// vertices, normals, uvs, triangles and material sections), each material as values
// (colour, metal, roughness, glow, see-through) plus an engine look or preset, and the
// objects with their names, parents, places and colliders. The engine then makes its
// own models (.fm), materials (.fzemat) and physics from that. Nothing here renders.
// ---------------------------------------------------------------
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const params = JSON.parse(globalThis.__f3d_params_json || '{}');
const roots = [];

// A seeded random: the same seed builds the same city on every machine and every run.
function makeRandom(seed) {
    let a = (seed >>> 0) || 1;
    const next = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.range = (lo, hi) => lo + (hi - lo) * next();
    next.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * next());
    next.pick = (list) => list[Math.floor(next() * list.length) % list.length];
    next.chance = (p) => next() < p;
    return next;
}

export const F3D = {
    THREE,
    params,
    random: makeRandom(params.seed ?? 1),
    makeRandom,

    // Hand an object (and everything under it) to the engine.
    //   options.name      the root's name in the scene
    //   options.collider  'mesh' (exact, static - the default), 'box', 'convex' or 'none';
    //                     a mesh's own userData.collider wins
    //   options.merge     true: bake it into ONE model, one section per material - the
    //                     fastest to draw (a block of a city); false: keep every object
    add(object, options = {}) {
        if (!object || !object.isObject3D) throw new TypeError('F3D.add takes a THREE.Object3D (a Mesh, a Group...)');
        roots.push({ object, options });
        return object;
    },

    // A material the engine will make its own. Values follow Three.js's
    // MeshStandardMaterial; `look` ('gold', 'glass', 'neon'...) or `preset`
    // ('Brick_Weathered', 'Wood_Planks'...) choose one of the engine's - a preset is a
    // generated, textured surface (with `recipe` to tune it).
    material(name, props = {}) {
        const { look, preset, recipe, nits, ...values } = props;
        const m = new THREE.MeshStandardMaterial(values);
        m.name = name;
        // `given`: the values the script SET. Three.js fills the rest with its defaults
        // (white, roughness 1), which must not paint over a look - a white 'gold'.
        // `nits`: the glow's brightness in the engine's own unit (a sign is 1000);
        // otherwise emissiveIntensity 1 = 1000 nits.
        if (look || preset || recipe || nits !== undefined) m.userData.fze = { look, preset, recipe, nits, given: Object.keys(values) };
        return m;
    },

    log: (...a) => console.log(...a),
};

// ---- handing it over -----------------------------------------------------------------

function floats(attr, size) {
    if (!attr) return null;
    if (!attr.isInterleavedBufferAttribute && attr.array instanceof Float32Array && attr.itemSize === size && !attr.normalized)
        return attr.array.length === attr.count * size ? attr.array : attr.array.slice(0, attr.count * size);
    const out = new Float32Array(attr.count * size);
    for (let i = 0; i < attr.count; i++) {
        out[i * size] = attr.getX(i);
        if (size > 1) out[i * size + 1] = attr.getY(i);
        if (size > 2) out[i * size + 2] = attr.getZ(i);
    }
    return out;
}

function materialValues(m) {
    const c = m.color ? [m.color.r, m.color.g, m.color.b] : [0.8, 0.8, 0.8];
    const e = m.emissive ? [m.emissive.r, m.emissive.g, m.emissive.b] : [0, 0, 0];
    return {
        name: m.name || m.type,
        color: c,
        metalness: m.metalness ?? 0,
        roughness: m.roughness ?? 0.6,
        emissive: e,
        emissiveIntensity: m.emissiveIntensity ?? 1,
        opacity: m.opacity ?? 1,
        transparent: !!m.transparent,
        doubleSided: m.side === THREE.DoubleSide,
        fze: m.userData?.fze ?? null,
    };
}

// The meshes under `root` baked into one geometry per material (in root's space), then
// into one geometry with a section per material.
function bake(root) {
    root.updateMatrixWorld(true);
    const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const byMaterial = new Map();
    const put = (material, geo) => {
        if (!byMaterial.has(material)) byMaterial.set(material, []);
        byMaterial.get(material).push(geo);
    };
    const tidy = (geo) => {
        // One attribute set for all: position, normal, uv (mergeGeometries refuses a mix).
        for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
        if (!geo.getAttribute('normal')) geo.computeVertexNormals();
        if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
        geo.morphAttributes = {};
        return geo;
    };
    const take = (mesh, matrix) => {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        let geo = mesh.geometry.clone().applyMatrix4(matrix);
        if (mats.length > 1 && geo.groups.length) {
            if (geo.index) geo = geo.toNonIndexed();
            for (const g of geo.groups) {
                const part = new THREE.BufferGeometry();
                for (const [name, attr] of Object.entries(geo.attributes))
                    part.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(g.start * attr.itemSize, (g.start + g.count) * attr.itemSize), attr.itemSize));
                put(mats[g.materialIndex ?? 0], tidy(part));
            }
        } else put(mats[0], tidy(geo));
    };
    const m = new THREE.Matrix4();
    root.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        const local = new THREE.Matrix4().multiplyMatrices(toRoot, o.matrixWorld);
        if (o.isInstancedMesh) {
            for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); take(o, new THREE.Matrix4().multiplyMatrices(local, m)); }
        } else take(o, local);
    });
    const materials = [...byMaterial.keys()];
    const parts = materials.map((mat) => {
        const list = byMaterial.get(mat).map((g) => (g.index ? g.toNonIndexed() : g));
        return list.length === 1 ? list[0] : mergeGeometries(list, false);
    });
    if (!parts.length) return null;
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, true);
    if (parts.length === 1) { merged.clearGroups(); merged.addGroup(0, merged.getAttribute('position').count, 0); }
    return { geometry: merged, materials };
}

globalThis.__f3d_finish = function () {
    const materials = [];
    const materialIds = new Map();
    const geometryIds = new Map();
    const objects = [];
    let triangles = 0;

    const materialId = (m) => {
        if (!m) m = new THREE.MeshStandardMaterial();
        if (!materialIds.has(m)) { materialIds.set(m, materials.length); materials.push(materialValues(m)); }
        return materialIds.get(m);
    };
    const geometryOf = (geo) => {
        if (geometryIds.has(geo)) return geometryIds.get(geo);
        const pos = geo.getAttribute('position');
        if (!pos || pos.count === 0) return null;
        if (!geo.getAttribute('normal')) geo.computeVertexNormals();
        const index = geo.index ? Uint32Array.from(geo.index.array) : null;
        const id = __f3d_geometry(floats(pos, 3), floats(geo.getAttribute('normal'), 3), floats(geo.getAttribute('uv'), 2), index);
        const count = index ? index.length : pos.count;
        const groups = geo.groups.length ? geo.groups.map((g) => ({ start: g.start, count: Math.min(g.count, count - g.start), material: g.materialIndex ?? 0 }))
                                         : [{ start: 0, count, material: 0 }];
        triangles += count / 3;
        const entry = { id, groups };
        geometryIds.set(geo, entry);
        return entry;
    };
    const base = (o, parent, name) => ({
        id: objects.length + 1, parent, name: name || o.name || o.type,
        position: o.position.toArray(), quaternion: o.quaternion.toArray(), scale: o.scale.toArray(),
    });
    const visit = (o, parent, opts) => {
        if (!o.visible) return;
        const entry = base(o, parent);
        if (o.isMesh) {
            const g = geometryOf(o.geometry);
            if (g) {
                entry.geometry = g.id;
                // ⚠️ ONE MATERIAL IGNORES THE GEOMETRY'S SECTIONS, as Three.js draws it: an
                // ExtrudeGeometry's caps and sides (sections 0 and 1), a RoundedBox's six faces,
                // are all that one material - not "material 1" that does not exist.
                const total = g.groups.reduce((s, x) => Math.max(s, x.start + x.count), 0);
                entry.groups = Array.isArray(o.material) ? g.groups : [{ start: 0, count: total, material: 0 }];
                entry.materials = (Array.isArray(o.material) ? o.material : [o.material]).map(materialId);
                entry.collider = o.userData.collider ?? opts.collider ?? 'mesh';
                if (o.isInstancedMesh) {
                    const m = new THREE.Matrix4();
                    entry.instances = [];
                    for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); entry.instances.push(Array.from(m.elements)); }
                    triangles += (g.groups.reduce((s, x) => s + x.count, 0) / 3) * Math.max(0, o.count - 1);
                }
            }
        }
        if (o.userData.fze) entry.fze = o.userData.fze;
        objects.push(entry);
        for (const c of o.children) visit(c, entry.id, opts);
    };

    for (const { object, options } of roots) {
        object.updateMatrix();
        if (options.merge) {
            const baked = bake(object);
            if (!baked) continue;
            const entry = base(object, 0, options.name);
            const g = geometryOf(baked.geometry);
            entry.geometry = g.id;
            entry.groups = g.groups;
            entry.materials = baked.materials.map(materialId);
            entry.collider = options.collider ?? 'mesh';
            entry.merged = true;
            objects.push(entry);
        } else {
            const before = objects.length;
            visit(object, 0, options);
            if (options.name && objects.length > before) objects[before].name = options.name;
        }
    }
    __f3d_scene(JSON.stringify({ objects, materials, triangles: Math.round(triangles), params }));
};
