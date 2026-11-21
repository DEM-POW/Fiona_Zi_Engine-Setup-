# Physics

Bodies that fall, stack, slide and bounce; characters that walk, climb stairs and
crouch; cars on sprung wheels; ragdolls; joints; triggers; and the rays and
overlaps gameplay asks with. Jolt does the simulation. Nothing above the backend
knows that.

```
Gameplay, scripts, the editor
      │  components (Collider, Rigidbody, Character Controller, Vehicle, Ragdoll, Joint)
      ▼
ScenePhysics          Gameplay/ScenePhysics      keeps the scene and the world in step
      ▼
Phys::PhysicsWorld    Physics/Core/PhysicsWorld  fixed steps, commands, events, queries (no Scene)
      ▼
IPhysicsBackend       Physics/Backend            the only code that includes Jolt
      ▼
JoltBackend
```

1 unit = 1 metre, 1 kg, 1 second. Forward is -Z, right is +X, up is +Y.

## Time

The world never runs on the renderer's clock. Every step is **Physics Rate**
long (60 Hz by default). A frame runs as many steps as its time covers, at most
**Max Sub Steps**. A frame longer than that drops the rest of its time instead
of owing it. Bodies are **drawn between the last two steps** (Interpolation),
so they move smoothly at any frame rate, up to one step behind the simulation.

Each step happens in a fixed order:

1. commands
2. kinematic targets
3. characters and water
4. simulate (broad phase, narrow phase, solver and sweeps, inside Jolt)
5. triggers
6. contacts
7. sleep and wake
8. joint breaks
9. read back

Everything is handed to gameplay **after** the steps, on the main thread.

Nothing changes a body in the middle of a step. Setting a velocity, teleporting,
or changing a layer becomes a command that is applied when the next step begins.

## Who owns a transform

| Body | Owner | What happens when a script moves the object |
|---|---|---|
| Static (a Collider, no Rigidbody) | the scene | Its body follows. What rested on it, where it **was** as well as where it is, wakes and falls. |
| Kinematic | gameplay | The body travels there over the frame's steps, pushing what is in the way. |
| Dynamic | the physics | It is a teleport, and it is honoured: velocity kept, not snapped back. |
| Character | the Character Controller | A teleport (respawn, script). |

Colliders on children without their own Rigidbody join the nearest Rigidbody
above them as one compound body (the Unity rule).

## Components

| Component | What it is |
|---|---|
| **Collider** | The shape: Box, Sphere, Capsule, Cylinder, Mesh (exact triangles; on a moving body it is split into convex pieces), Convex (one hull). **Material**, **Layer**, **Is Trigger**, and an optional **Collision Mesh** (a simple model to collide with, beside the detailed one drawn). |
| **Rigidbody** | Static, Dynamic or Kinematic. Mass (or **By Density**: volume × the material's density), gravity, drag, **Detection** (Auto / Discrete / Continuous), Interpolate, speed limits, freeze axes, sleeping. **Own Surface** overrides the material's friction and bounce for this body. |
| **Character Controller** | A capsule that walks: slopes up to Max Slope, stairs up to Step Height, moving platforms, crouch (and refuses to stand under a ceiling), slide, jump with coyote time and buffer, air control, pushes rigidbodies. |
| **Vehicle** | Four sprung wheels under a Dynamic Rigidbody (the chassis): engine, gearbox, differentials (rear, front or all wheels), brakes, hand brake, steering. Wheel objects are optional and keep the turn they were placed with. Placed in metres, whatever the chassis' scale. |
| **Ragdoll** | On a skinned character: eleven capsules found by what its bones mean (Mixamo, Unreal and Rigify alike), jointed like a body. Knees only bend back. It goes limp on death or when asked, takes a push, and gets up where it lies, blending back into the animation (**Get Up State**). While limp, its Character Controller steps out of the world. |
| **Joint** | Holds this body to another (or to the world): Fixed, Hinge, Slider, Distance, Spring, Cone, Swing Twist, Six DOF. Limits, motors (speed or position) and break force or torque. Made where the two are when Play starts, so a hinge's limits count from how the door hangs. |

## Collision layers

Sixteen layers: World, Player, NPC, Vehicle, Ragdoll, Projectile, Weapon,
Trigger, Debris, Character, Water, Interactable, and four of the project's own.
**Project Settings ▸ Collision Layers** is the matrix of who touches whom (one
tick per pair). By default everything touches everything, except:

- triggers never see triggers;
- projectiles never hit projectiles;
- debris never pushes a character.

Rays and overlaps filter through the same table.

## Materials

| Material | Friction | Bounce | kg/m³ |
|---|---|---|---|
| Default | 0.40 | 0.20 | 1000 |
| Concrete | 0.70 | 0.10 | 2400 |
| Metal | 0.45 | 0.15 | 7800 |
| Wood | 0.50 | 0.25 | 650 |
| Glass | 0.30 | 0.20 | 2500 |
| Dirt | 0.65 | 0.05 | 1500 |
| Mud | 0.85 | 0.00 | 1700 |
| Sand | 0.60 | 0.00 | 1600 |
| Water | 0.05 | 0.00 | 1000 |
| Ice | 0.03 | 0.05 | 917 |
| Stone | 0.65 | 0.15 | 2600 |
| Grass | 0.55 | 0.05 | 1200 |
| Rubber | 0.90 | 0.75 | 1100 |
| Plastic | 0.35 | 0.35 | 950 |
| Flesh | 0.60 | 0.05 | 1050 |
| Fabric | 0.60 | 0.02 | 300 |

Two materials touching: friction is the geometric mean, bounce the larger of the
two. Each material also has a **surface** (what footsteps, impacts and decals
hear). Rays return it, and so do characters (what is under the feet) and contact
events.

## Fast things (CCD)

A body set to **Auto** is swept when it moves more than a tenth of its own
radius in one step. At Jolt's default threshold (three quarters), a crate
landing from 6 m sank **28 cm** into the floor before it was pushed out, and a
ball 17 cm. Now they sink 2.4 cm and 0.5 cm. A 300 m/s pellet stops at a 5 cm
wall (with Discrete it goes through).

## Events

Delivered after the steps, to both objects, as graph events and C# methods:

| Event | When |
|---|---|
| On Collision (Impact Speed, Point, Normal) / Stay / Exit | two solid bodies start, keep, stop touching |
| On Trigger Enter / Stay / Exit | something overlaps a trigger. One of the two must be able to move; a sleeping crate inside one is still inside it, and destroying it there says Exit. |
| On Sleep / On Wake | the body came to rest / was disturbed |
| On Joint Break (Other) | a Joint holding it broke |

The Stay events and Sleep/Wake are only told to objects that have a script.

## Queries

From graphs and C# (**Physics**): **Raycast**, **SphereCast**, **BoxCast**,
**OverlapSphere**, **OverlapBox**. After a cast, **Hit Entity**, **Hit Point**,
**Hit Normal**, **Hit Distance** and **Hit Surface** describe the hit.
`Phys::PhysicsWorld` has the full set for C++: capsule and shape casts, raycast
all, point inside, layer masks, ignore lists, triggers in or out. Bullets,
**Camera ▸ Ray** and these casts all use one ray (`ScenePhysics::GameRay`):
exact shapes while the game runs.

**Vehicle ▸ Drive / Speed / RPM / Wheels On Ground**, **Ragdoll ▸ Go Limp /
Get Up / Push / Is Limp** and **Joint ▸ Set Motor / Is Broken** drive the rest.

## Large worlds and streaming

`PhysicsWorld::CreateBodies` inserts a cell's bodies together (10 000 in one
call). `DestroyGroup` takes a whole cell away. `ShiftOrigin` moves the world's
origin so the region being played stays near (0, 0, 0). Every handle carries a
generation: a handle to something destroyed does nothing, even after its slot is
reused.

## Seeing it

- **View ▸ Physics (during Play):** the solver's own picture.
  - **Shapes**, coloured: green static, cyan awake, grey asleep, orange
    kinematic, yellow trigger, magenta swept this frame.
  - **Bounds:** the broad phase's boxes.
  - **Contacts & Normals:** red where a contact began, amber where it is held.
  - **Queries:** the last 64 rays and casts.
  - **Characters:** capsules, green when grounded.
- **Project Settings ▸ Profiler ▸ Physics:** each stage's time (simulation,
  characters, triggers, events, commands, read back, queries, scene sync), and
  the counts (bodies awake and asleep, contact pairs, swept bodies, queries,
  steps, and dropped time).
- **The validator** runs at every Play. It reports zero-size shapes, bad
  masses, inside-out meshes, huge or paper-thin bodies, static triggers, a
  Vehicle without a chassis, a Ragdoll without a skeleton, and a Joint holding
  nothing.

## Project Settings ▸ Physics

Character Gravity (20) and Body Gravity (9.81), Physics Rate, Max Sub Steps,
solver iterations, speed limits, Continuous Collision Detection, Interpolation,
Sleep Speed, Penetration Slop. They are read when Play starts.

## Tests

`FZEPhysicsSuiteTest` (94 checks) covers:

- **Basics:** free fall, landing depth, a ten-box stack that holds and sleeps,
  friction on a slope, bounce, sleep and wake.
- **Shapes:** capsules, cylinders and compounds.
- **Speed:** a 300 and a 600 m/s pellet against a 5 cm wall.
- **Characters:** walking, jumping, slopes, stairs, walls, edges, a moving
  platform, crouching under a roof, sliding.
- **Queries.**
- **Scale:** 1000 bodies, and a 10 000-body cell in and out.
- **Handles:** a slot reused 5000 times.
- **Frame rate:** the same 2 s at 30, 60 and 144 FPS.
- **Vehicles, ragdolls, joints.**
- **Regressions** (`PhysicsRegression_0001`–`0011`), one per bug that made
  bodies pass through each other or events go missing:
  - a moved static leaving an invisible wall;
  - a lowered floor leaving bodies hanging;
  - a long frame driving bodies into each other;
  - a teleport snapped back;
  - a runtime scale ignored;
  - a static trigger hearing nothing;
  - motion and layer swaps crashing;
  - character input lost across sub-steps;
  - a sleeping crate announced again;
  - destroying inside a trigger with no Exit;
  - projectiles hitting projectiles.

`FZEPhysicsTest`, `FZEPhysics2Test`, `FZEJoltTest`, `FZEMeshCollideAccuracyTest`
and `FZECharacterControllerTest` run against the same world.
