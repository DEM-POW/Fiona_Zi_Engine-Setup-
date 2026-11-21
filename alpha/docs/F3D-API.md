# F3D API — building geometry with Three.js for Fiona Zi Engine

F3D runs a JavaScript **ES module** in a sandbox (QuickJS-ng, three.js r187). It has no files, no network, a memory cap and a time limit. Three.js builds the **geometry**. The engine turns the result into its own `.fm` models, `.fzemat` materials, scene objects and colliders. Nothing of Three.js renders.

## Imports

```js
import * as THREE from 'three';
import { F3D } from 'f3d';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
// also: three/addons/geometries/*, three/addons/math/*, three/addons/modifiers/*
```

## `F3D`

| Member | What it does |
|---|---|
| `F3D.params` | The params given to `f3d_run` / `f3d_regenerate`, as an object. Read every tunable from here, with a default: `const floors = F3D.params.floors ?? 8;` |
| `F3D.random` | A seeded random from `params.seed` (default 1): the same seed builds the same thing. `F3D.random()` returns [0,1). Also `.range(lo,hi)`, `.int(lo,hi)`, `.pick(list)`, `.chance(p)`. |
| `F3D.makeRandom(seed)` | Another independent seeded random. |
| `F3D.add(object, { name, collider, merge })` | Hands an `Object3D` (Mesh, Group, InstancedMesh…) and everything under it to the engine. Nothing reaches the engine without this. |
| `F3D.material(name, props)` | A material the engine makes its own (see below). |
| `F3D.log(...)` | Prints to the result's console. |

### `F3D.add` options

- **`collider`**:
  - `'mesh'` is the default: exact and static.
  - `'box'` and `'convex'` are cheaper.
  - `'none'` adds no collider.
  - A mesh's own `userData.collider` wins.
- **`merge: true`** bakes the whole object into **one model**, one section per material. It is the fastest to draw on weak GPUs; use it for a city block, a building's shell or a fence.
- **`name`** is the object's name in the scene.

### `F3D.material(name, props)`

- `props` are the values of `MeshStandardMaterial`: `color`, `roughness`, `metalness`, `emissive`, `emissiveIntensity`, `opacity` + `transparent`, and `side: THREE.DoubleSide`.
- Plus engine choices:
  - **`look`** is an engine look: `gold`, `silver`, `chrome`, `steel`, `iron`, `copper`, `brass`, `aluminium`, `plastic`, `plastic_matte`, `rubber`, `car_paint`, `ceramic`, `glass`, `ice`, `clay`, `fabric`, `skin`, `neon`, `lava`. Values you set win over the look.
  - **`preset`** is a generated, textured engine surface, e.g. `'Brick_Weathered'`, `'Wood_Planks'`, `'Concrete_Cracked'`, `'Asphalt_Worn'`. **`recipe`** tunes it.
  - **`nits`** sets the glow's brightness in the engine's unit; a lit sign is about 1000. Without it, `emissiveIntensity: 1` means 1000 nits.

## Repeated things: `InstancedMesh`

One geometry with many transforms becomes **one model shared by many objects**: windows, lamp posts, trees, columns. The engine's limit is 6000 objects per run, so merge what doesn't need to be separate.

```js
const win = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 1.6, 0.1), F3D.material('Glass', { look: 'glass' }), count);
const m = new THREE.Matrix4();
for (let i = 0; i < count; i++) { m.makeTranslation(x(i), y(i), z(i)); win.setMatrixAt(i, m); }
F3D.add(win, { name: 'Windows', collider: 'none' });
```

## The hierarchy and the generation

- Every run makes **one root object** (the run's `name`). Everything you `F3D.add` goes under it, keeping its own parents, positions, rotations and scales.
- The root carries an **F3D Source** component. The script and params are kept as `<name>.f3d` beside the models (`Assets/F3D/<name>/`).
- **`f3d_regenerate { id, params }`** makes it again in place: the same root id, place and parent, with new insides, models and materials. The params are merged over the ones it was made with.
- If the run used `file`, the `.js` file is read again on each regeneration, so an edit takes effect.

## Generators

Ready-made builders in `f3d/generators/*.js`.
- **From MCP:** `f3d_run { generator: "city", params: {...} }`.
- **From a script:** `import { generate } from 'f3d/generators/city.js'; generate(F3D.params);`, or `build(params)` to get the `Object3D` without handing it over (to place it inside your own scene).

Every generator exports `info` (its params with defaults and ranges). Unknown params are passed through, and numbers are clamped to their ranges.

**In the editor:** Tools ▸ F3D shows every generator as a card with its params as sliders, read from `info`. A new `.js` placed in `f3d/lib/generators/` appears there without a rebuild.
- **Generate** builds a new generation.
- With a generation selected, **Regenerate** rebuilds it in place.
- The **Script** tab runs your own module, with **Check** (dry run) and **Run**.
- The panel uses the same `f3d_run` and `f3d_regenerate` as an AI client.
- Keep each `info` under 2000 characters: the sandbox cuts a log line there, and the panel reads `info` through the log.

| Generator | Params (defaults) | Makes |
|---|---|---|
| `city` | `blocksX` 5, `blocksZ` 5, `block` 44, `street` 12, `pavement` 3, `downtown` 1, `parks` 0.12, `streetTrees` true, `lights` true, `seed` | A street grid: asphalt, lane lines, zebra crossings, raised pavements, street lights, street trees, parks, and buildings by zone (towers in the middle, brick houses at the edge). Each block is one merged model. |
| `building` | `width` 16, `depth` 14, `floors` 8, `floorHeight` 3.2, `style` concrete/brick/glass, `roof` flat/gable/dome/setback, `windowSpacing` 3, `seed` | One building: plinth, windows on every face, parapet and roof plant, gable, dome or setbacks with a mast. |
| `road` | `points` [[x,z]...], `width` 8, `pavement` 2.5, `kerb` 0.15, `lights` 25 (m apart, 0 = none), `markings` true | A road along a smooth curve: asphalt, dashed centre line, edge lines, kerbs, pavements, street lights. |
| `bridge` | `length` 60, `width` 10, `height` 8, `style` beam/arch/suspension, `span` 15 | A deck with railings and asphalt, on piers, under an arch, or hung from towers by cables. |
| `tree` | `kind` broadleaf/pine, `height` 7, `count` 1, `spread` 20, `seed` | Low-poly trees; a grove when `count` > 1. |
| `rocks` | `count` 8, `size` 1.6, `spread` 10, `roughness` 0.35, `detail` 2, `seed` | Noise-shaped boulders, half sunk, each with a convex collider. |
| `terrain` | `size` 200, `resolution` 128, `height` 30, `kind` hills/mountains/island, `scale` 1, `water` -1 (none), `seed` | A ground mesh painted sand/grass/rock/snow by height and slope, with a water plane. A mesh, not the engine's Terrain system. |

**Measured on the UHD 620:**

| Generator | Result |
|---|---|
| city 5×5 | 181 objects, 78k triangles, about 25-35 s to build (most of it baking textured materials). It adds no measurable frame cost: 33 fps with it and 33 fps without, in the editor. |
| building | about 400 triangles |
| tree | about 600 |
| road | 1.6k |
| bridge | 2.9k |
| terrain 128 | 33k |

## Limits and good habits

- At most **4,000,000 triangles** and **6000 objects** per run.
- On UHD 620, aim for well under 1M triangles for a whole scene.
- Use `merge: true` for static clutter. Use few segments: a cylinder of 12 segments, not 64.
- Units are metres; Y is up.
- Errors come back with `script.js:<line>`. `dry_run: true` checks a script without writing anything.

## A complete example: a tower with parameters

```js
import * as THREE from 'three';
import { F3D } from 'f3d';

const floors = F3D.params.floors ?? 8, perSide = F3D.params.windows ?? 4;
const w = 12, d = 12, fh = 3.2, h = floors * fh;
const tower = new THREE.Group();
const shell = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), F3D.material('Concrete', { preset: 'Concrete_Cracked' }));
shell.position.y = h / 2;
tower.add(shell);
const glass = F3D.material('Glass', { look: 'glass' });
const win = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 1.8, 0.12), glass, floors * perSide * 4);
const m = new THREE.Matrix4(), q = new THREE.Quaternion();
let k = 0;
for (let f = 0; f < floors; f++)
  for (let side = 0; side < 4; side++)
    for (let i = 0; i < perSide; i++) {
      const t = (i + 0.5) / perSide - 0.5, y = f * fh + fh * 0.55;
      const a = side * Math.PI / 2;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
      const x = Math.cos(a) * t * w - Math.sin(a) * (d / 2 + 0.06), z = -Math.sin(a) * t * w - Math.cos(a) * (d / 2 + 0.06);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
      win.setMatrixAt(k++, m);
    }
tower.add(win);
F3D.add(tower, { name: 'Tower', collider: 'box' });
```

Then: `f3d_run { file: "Assets/Scripts/tower.js", name: "Tower", params: { floors: 8 } }`, and later `f3d_regenerate { id: <root>, params: { floors: 14 } }`.
