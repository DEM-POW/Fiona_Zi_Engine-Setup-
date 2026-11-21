# Cameras

Two cameras, and the pieces that move them. There are no camera "modes": first
person, third person, orbit and security cameras are all a camera put somewhere
and driven by something.

## The two cameras

| Component | What it is | You set |
|---|---|---|
| **Camera** | The game's eye. | Projection, **FOV Axis** (Vertical, Horizontal, Auto = Hor+ with a 16:9 floor), Field of View to 0.001°, Ortho Height, clip planes, exposure, priority, blend, limits, recoil pattern. The Inspector shows the angle on all three axes at the game view's real shape, and the equivalent focal length. |
| **Cinematic Camera** | A physical camera. | Sensor (Super 35, Full Frame, APS-C, Micro 4/3, IMAX, Alexa LF, custom), focal length in mm, gate fit, lens shift, aperture (f-number), focus distance or a focus target with a focus-pull time, depth of field. Its angle is never typed: it is what that lens sees on that sensor. The Inspector shows the depth of field (sharp from / to, hyperfocal). |

An object holds one of the two. **Create ▸ Camera** makes either, placed where
the viewport is looking from.

## What moves them

| Component | Does | Typical use |
|---|---|---|
| **Spring Arm** | Holds the camera on a boom from a target (the player, an object, its parent, a point, or a bone on any of them). Rotation from the player's look, the target's facing, or its own yaw/pitch (+ auto rotate). Sphere-swept collision: pulled in fast, let out slowly, never left inside a wall; characters never push it. Position and rotation lag in seconds. | Length 0 + the player's look = first person (with **Hide Target's Body**). 4 m with a shoulder offset = third person. Its own rotation + auto rotate = a turntable. |
| **Look At** | Turns the camera towards a target, smoothly. | A security camera, a cutscene framing. |
| **Free Fly** | Moves the camera from input actions. | A spectator, photo mode. |
| **Camera Sequence** | A cut list: at each time a camera becomes live, arriving with its blend. | A scripted intro. |
| **Camera Shake Source** | A place that shakes any camera near it, fading to nothing at its radius. | An engine room, a waterfall. |

**Frame From Placement** (Spring Arm): place the camera by hand until the shot
looks right; at Play the arm takes its length and offset from where you put it.

## Which camera is live

The highest **Priority** among active cameras. Equal priorities: the one raised
last (`Camera.Activate`). A change blends from the old view to the new one -
position, rotation, field of view (in tan space, so a zoom is even), focus (in
log space), aperture and exposure - over the incoming camera's **Blend Time**
with its **Blend Curve**.

## The pipeline (once a frame, Gameplay/CameraSystem.cpp)

1. migrate cameras saved by the old systems
2. pick the live camera
3. its rig: target → spring arm / control rotation → look at → free fly
4. constraints (pitch, position, FOV range)
5. collision (inside the spring arm)
6. smoothing (inside each rig, in seconds)
7. blend
8. recoil, then shake - offsets on top, never written into the pose
9. lens → projection → `FinalCameraState`, which is all the renderer reads

All smoothing is solved exactly (exponentials and a closed-form critically damped
spring; the overshooting spring runs in fixed 1/480 s steps), so the same second
of play lands in the same place at 30, 60, 120 and 240 FPS - `FZECameraTest`
checks it.

## Effects are requests

Nothing outside the camera writes the view. A weapon asks for **Recoil**, an
explosion for a **Shake**; each is a layer added on top and gone on its own. The
player's own aim is never moved by recoil.

## Scripting (graph nodes and C#)

`Camera.Shake(amount)`, `Camera.ShakeAt(position, amount, radius)`,
`Camera.Recoil(intensity)`, `Camera.SetFOV(degrees)` (below 0 = back to its own),
`Camera.Activate(name)`, `Camera.BlendTo(name, seconds)`, `Camera.SetTarget(object)`,
`Camera.Roll(degrees)`, `Camera.Position()`, `Camera.Forward()`, `Camera.Ray(...)`.

## Presets

**Save Preset... / Load Preset...** under a camera's Inspector write and read a
`.fzcamera` file: the camera and its rig components.

## Old scenes

A scene saved with the first camera block or with a `CameraRig` component opens
with the new components: First Person becomes a Spring Arm of length 0 on the
player's look, Follow / Spring Arm / Orbit / Top Down become a Spring Arm, Fly
becomes Free Fly, a physical lens becomes a Cinematic Camera. A waypoint-track
camera keeps its first point and says so in the Console.

## In the editor

Selected (or View ▸ Camera Frustums): the frustum with the real lens - green when
live, blue when waiting, grey when switched off; a cinematic camera with depth of
field also shows its focus plane in amber; the live camera's spring arm shows its
pivot and turns red while a wall pushes it in. The picture-in-picture preview is
what the selected camera would show.
