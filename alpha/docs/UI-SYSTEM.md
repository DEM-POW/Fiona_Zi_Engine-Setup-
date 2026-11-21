# FZE UI System — audit, architecture, progress

The game UI rebuilt from nothing: one system for every screen a game shows — a
HUD, a main menu, an inventory, a lobby — designed visually in FZEditor the way
Unity's uGUI and Unreal's UMG are, laid out by one engine, drawn by one
renderer, and shipped in the Player unchanged.

---

## 1. The audit (what was there, and why it was rebuilt)

### 1.1 Two game-UI systems, and a third that draws over both

| | Where | What it was | What was wrong with it |
|---|---|---|---|
| **A. Canvas on the entity** | `UI/UIComponent.h` (`UICanvasComponent` on the fat `Entity`, `HasUI`), `UI/UILayout`, `UI/UIRenderer`, scripts `ui_*` (Script/EngineAPI), graph events (VisualScriptSystem::DispatchUIEvents), `SceneSerializer` | A flat list of elements, each with one of nine anchors and an offset, scaled from a design resolution | **No tree** (no parent, no container, nothing laid out relative to anything else); **no layout** (no groups, no padding or spacing, no content size, no min/max), so every overlap was fixed by hand and broke at another aspect ratio; seven element kinds with every property of every kind on every element; drawn through **Dear ImGui** even in the shipped Player |
| **B. RmlUi documents** | `UI/Rml/*` (`GameUI`, `UiBlackboard`, `UiActions`, `UiNet`, `UiSettings`), `.rml`/`.rcss` under `Assets/UI`, `Editor/UIDesigner` (UI Designer 2.0) | An HTML/CSS engine (vendored RmlUi) with its own GL renderer, a blackboard bridge and action strings; the designer moved elements by rewriting CSS rules | A second layout model (CSS flow) beside A's anchors; the designer had to translate drags into CSS rules (`SetRule`) and could not express anchors, so positions jumped with the content; its own renderer, its own font engine, its own input path (`Application::OnEvent` → `GameUI::OnEvent`) and its own idea of the viewport, which had to be re-told the panel's rectangle in two places (`SetViewportRect` docked and fullscreen) |
| **C. The engine's overlays** | `UI/GameHUD` (crosshair and the built-in HUD; there are no engine menus), `UI/ScreenFX`, `UI/SceneTransition`, `UI/VideoPlayer` | Hard-coded drawing into `UI::DrawList` | Not authorable; fine as engine fallbacks, not as a game's UI |

### 1.2 The root causes

1. **Two layout models and no single owner of "where is this element"**: A computed rects in `UIRenderer::ElementRect`, B in RmlUi's CSS engine, the designer in a third place for its handles. Overlap and drift were the visible symptom; the cause was that nothing was *one* source of truth.
2. **Coordinates were implicit**: window points vs framebuffer pixels vs viewport panel vs design units were converted at each call site (`MouseInDesign`, `SetViewportRect`, `ReportPointer`, `Origin`), and every new host (fullscreen Play, the second view) had to remember all of them.
3. **Element identity was its name**: scripts and graphs found elements by name (`ui_set_text(tag, name)`), so a rename broke every reference silently.
4. **Rendering through the editor's widget library**: A's canvases reach the screen through `ImGuiUIBackend`, so the Player carries ImGui and the UI's blend state, fonts and clip rects are ImGui's.
5. **No change tracking**: A re-resolved everything every frame; bindings polled the blackboard by string every frame.

### 1.3 What is kept

- `Script/Blackboard` (the game's shared values) — given revision counters so bindings update on change, not by polling.
- `Core/Localization`'s Arabic joining tables — the new text shaper builds on them.
- `vendor/freetype` (2.13, with its SDF renderer) — the new font engine.
- `RHI` and the frame structure — the new renderer is an RHI client, as every other renderer.
- C (`GameHUD`, `ScreenFX`, `SceneTransition`, `VideoPlayer`) — engine overlays, unchanged.

### 1.4 What is removed when the new system is complete

A and B entirely: `UI/UIComponent.h`, `UI/UILayout`, `UI/UIRenderer`, `UI/Rml/*`, `Editor/UIDesigner`, the RmlUi vendor target, the `.rml`/`.rcss` screens (rebuilt as `.fzeui`). Scenes holding A's canvas convert on load.

---

## 2. The architecture

Module `Engine/Gui`, namespace `FZE::Gui`. No ImGui anywhere in it; the editor is a client.

```
   .fzeui (Document asset)  ──load──▶  Document  (tree of Nodes, stable ids)
                                          │
     Canvas component (scene) ──────────▶ CanvasInstance (one live copy per canvas)
     render mode, sort order, scaler          │
                                          ┌───┴──────────────────────────────┐
                                          │ Bindings  ◀── Blackboard, engine │
                                          │ Animation (clips, transitions)   │
                                          │ Layout    (measure → arrange)    │
                                          │ Events    (hit test, focus, nav) │
                                          │ Behaviours (Button, Slider, ...) │
                                          └───┬──────────────────────────────┘
                                              ▼
                                       Renderer (batches → RHI), Text (FreeType SDF)
```

### 2.1 The tree (Gui/Document)

- A **Node** has a stable 64-bit id (never reused, survives renames and saves), a name (the designer's, free to change), a **kind** (what it is: Panel, Image, Text, Button, Toggle, Slider, Progress, Scrollbar, ScrollView, InputField, Dropdown, Tabs, ListView, Radial, Compass, Marker, Template...), a **RectTransform**, and optional parts as Unity's GameObject has components: a layout group, a layout element, a content-size fitter, an aspect fitter, a mask, a canvas group (alpha, interactable, blocks raycasts), bindings.
- Composite widgets are made of nodes, as in Unity: a Button is a node with a child Label; a Slider has Track, Fill and Handle children its behaviour points at **by id**. Any of them can be restyled, replaced or removed — the style of a game is never fixed by the engine.
- The Document owns every node; parents and children are ids. Destruction is deferred to the end of a frame, so a handler deleting its own button finishes safely.

### 2.2 Coordinates (the rule that ends the drift)

| Space | Unit | Origin | Used for |
|---|---|---|---|
| **Canvas** | 1 unit = 1 pixel at the reference resolution | top-left, +y down | everything authored and laid out |
| **Target** | framebuffer pixels | top-left of the target (the viewport framebuffer, the Player's back buffer) | rendering |
| **Window** | OS window points | top-left of the window | where the pointer comes from |

`scale = CanvasScaler(target pixels)`; canvas → target is `p * scale + targetOrigin`. The pointer is converted **once**, by the host, from window points to target pixels (it knows the window/framebuffer ratio and where the target sits); the canvas converts target → canvas. Nothing else converts anything.

### 2.3 Layout (Gui/Layout) — one engine, two passes

RectTransform resolves as Unity's: anchors (min/max, 0..1 of the parent), pivot, anchored position, size delta; rotation and scale are **visual** (rendering and hit testing only — they never move a neighbour). Layout groups (horizontal, vertical, grid) with padding, spacing, child alignment, control/expand child size; layout elements (min / preferred / flexible, ignore layout); content-size fitter; aspect-ratio fitter; safe area; clipping by masks.

1. **Measure** (bottom-up, only dirty subtrees): min / preferred / flexible sizes from content (text, images) and from groups.
2. **Arrange** (top-down): rects from anchors, then groups drive their children's rects, fitters their own.
3. Clip rects, world (canvas-space) matrices for visual transforms, the hit-test order.

A change marks **paint** (colour, opacity, texture) or **layout** (size, text, structure) dirty; only layout dirt re-runs the passes, and only for the affected subtree up to the nearest root that absorbs the change. A cycle (a fitter sizing a parent that sizes it) is cut after a fixed number of iterations and reported, never looped.

### 2.4 Rendering (Gui/Renderer)

One shader (`Shaders/Gui.vert/.frag`) draws: rounded rectangles with borders as signed distance fields (crisp at any scale), gradients, images (stretched, tiled, nine-sliced), SDF text with outline / shadow / glow, radial and linear fills. Batches split only on texture and clip. Rect clips use the scissor; the canvas restores every GL state it touched. A missing image or font draws a magenta checker / the fallback font and logs once with the document, node and property.

### 2.5 Text (Gui/Text)

FreeType SDF glyphs in an atlas per font, a fallback chain (the project's font, then the system's), UTF-8, Arabic joining (presentation forms, lam-alef ligatures), a bidirectional pass (Arabic runs right-to-left, numbers and Latin left-to-right inside them), line breaking and wrapping, alignment, ellipsis, line and letter spacing, measurement identical to drawing, caret and selection for input fields.

### 2.6 Input (Gui/Events)

The host hands each canvas the pointer (in target pixels), buttons, wheel, keys, text and pad state. Hit testing walks the draw order backwards, respects masks, canvas groups and "raycast target". Pointer enter / exit / down / up / click / drag / scroll; focus and navigation (keyboard and gamepad, explicit or automatic by direction); modal capture; a canvas that wants the input says so, and the game's controls are paused until it closes.

### 2.7 Data and actions (Gui/Binding)

A property can be bound to a source (`bb:health` — the blackboard — or an engine value, `player.health`), with a format (`{0:0} / {1:0}`) and a range map; an event (click, change, submit) runs an **action**: `scene:<name>`, `show:<doc>`, `hide:<doc>`, `close`, `back`, `quit`, `event:<name>` (a graph's custom event), `set:<key>=<value>`. Game rules stay in the game.

### 2.8 Animation (Gui/Animation)

Clips in the document: tracks of a node's property (position, size, rotation, scale, opacity, colour, fill), keys with easing, delay, loop, ping-pong; played, paused, reversed, stopped, chained; events at the end. Visual properties animate without re-running layout.

### 2.9 Scene integration (Gui/Canvas)

A **Canvas** component on an entity: the document, render mode (screen overlay; world space later), sort order (its layer), the scaler (constant pixel size, scale with screen size with a width/height match, constant physical size), interactive, blocks game input. The Outliner's **Canvas** list shows the canvases as layers in sort order and each one's element tree; the editor's viewport and the Player draw them with the same code.

---

## 3. Phases

| # | Delivers | Proven by |
|---|---|---|
| 1-2 | This audit and design | — |
| 3 | Document + Layout | `FZEGuiLayoutTest` |
| 4 | Renderer + Text | `FZEGuiTextTest`, captures |
| 5 | Events, focus, navigation | `FZEGuiInputTest` |
| 6 | `.fzeui` + Canvas + runtime + migration | `FZEGuiDocTest`, Play captures |
| 7 | The UI Designer | captures, undo tests |
| 8 | Bindings, animation, the widget library | tests, captures |
| 9 | Stress, diagnostics, performance | `FZEGuiStressTest` |
| 10 | The demo project, export, removal of A and B | Player run, exported build |

---

## 4. Progress

**Phase 3 — done.** `Gui/GuiTypes`, `Gui/Node`, `Gui/Document`, `Gui/Layout`; `FZEGuiLayoutTest` 41 checks (anchors, scaler at 720p/1440p/ultrawide, presets, groups, wrap, grid, fitters, aspect, safe area, selective relayout 42 vs 422 measures, masks, hits).

**Phase 4 — done.** `Gui/Font` (FreeType distance fields in 1024² atlas pages, a fallback chain that warns once per missing character), `Gui/Text` (UTF-8, Arabic joining with lam-alef, a compact UAX #9 bidi pass, wrapping, ellipsis, auto-size, caret and hit index), `Gui/Renderer` + `Shaders/Gui.*` (boxes, borders, gradients, skew, soft shadows, sliced/tiled/filled images, radial fills, ring sectors, compass, radial wheel). `FZEGuiTextTest` 31 checks, and with a GL context it renders a sample screen to a PNG.

Lessons:
- ⚠️ **Glyph distance fields come from a coverage bitmap ("bsdf"), never the outline ("sdf").** Variable fonts (Bahnschrift, Segoe UI Variable) keep overlapping contours; the outline rasterizer turns each overlap into a streak across the letter.
- ⚠️ **A draw names its font page (`TexRef{face, page}`), it does not look the texture up.** Painting is CPU-only and may run before the atlas reaches the GPU; Submit uploads, then resolves. Looking the id up at paint time drew every glyph as a white block.
- **Shapes that sample nothing join whatever batch is open**, so panels and the text over them stay one draw (the sample screen: 13 nodes, 193 glyphs, 5 draws).
- **A radial fill is "the part cut away" (0 = none)**, so a zeroed parameter means "whole", not "nothing" — the compass ticks vanished when 0 meant an empty fill.
- **Nodes are culled against the target clip** (grown by shadow, border, outline, skew); text allowed to overflow its box is never culled.

**Phase 5 — done.** `Gui/Widgets` (Unity's Create ▸ UI menu and nothing more: Button, Toggle, Slider, Progress, Scrollbar, Scroll View, List View, Input Field, Dropdown, Tabs, Radial, Compass, Marker — each a set of plain nodes the behaviour finds by id), `Gui/Events` (one event system a canvas: hit testing in draw order through masks, rotation, alpha and disabled controls; enter/exit/down/up/click; drag with a threshold, scroll views taking a drag from their rows, inertia, rubber-band ends, the wheel, bars both ways; Unity's automatic navigation (dot / distance²), explicit links, Tab; Submit/Cancel with the nearest `OnCancel`; text fields with caret, selection, clipboard, filters, password, RTL arrows, scrolling to the caret; dropdown lists and tooltips made at run time as `Transient` nodes; modal dialogs; C++ handlers run after the frame settles; drop events). `FZEGuiInputTest` 73 checks.

Lessons:
- ⚠️ **A click's drag anchor is a selection anchor**: typing must clear it, or the second letter "replaces the selection" of the first (typing "Hello" gave "ello").
- **The overlay (caret, selection, focus ring) draws with the node it belongs to** through Paint's extra, from a snapshot taken at the end of Update — never from inside the event code.
- **Handlers run after the state is settled**; events for nodes a handler destroyed are dropped; the dead are freed after the handlers (`FlushDoomed`).

**Phase 6 — done.** `Gui/Properties` (ONE table of 146 properties: file keys, Inspector labels and sections, kinds, layout-or-paint; Remap and Validate read their node references from it), `Gui/Serialize` (`.fzeui` version 1: only what differs from a kind's defaults, enums by name, bindings, clips; damaged or newer files open with warnings; atomic save; subtree copy/paste; missing assets named), `UI/Canvas` (the Canvas component - screen or inline screen, sort order, scaler, visible, interactive, blocks game input, show cursor, show in editor - and CanvasSystem: one instance per canvas, reloaded when the file changes outside play; the keys go to the topmost canvas with something to drive; actions `scene: show: hide: toggle: open: close back quit event: set: sound:`; drawn after post-processing in the editor's viewport and the Player), `UI/LegacyCanvas` (old canvases convert exactly - the old corner anchor IS a RectTransform anchor+pivot; height scaling = Match 1). `InputSystem::SetSuspended` (a menu holds the keys), `Input::TakeScroll` (the wheel reaches the game), blackboard revision counters, `RuntimeFrame` InputFocus/Pointer/Picture. `FZEGuiDocTest` 47 checks; `FZEHudTest` now checks old canvases survive load+save and convert.

Lessons:
- ⚠️ **The Player's `Focus` is "the pointer is captured"** — false exactly when a menu frees it. The UI needs "the window has the input" (`InputFocus`), a different flag.
- ⚠️ **Scene/ cannot make a Canvas** (layering): an old `"ui"` block is kept as JSON on the entity (`LegacyCanvas`), converted by the UI module on sight, and written back untouched if never converted.
- ⚠️ **`CreateEntity` returns a reference into a vector the next CreateEntity moves** — keep ids.

**Phase 7 — done, Unity's way (after a first try as a separate designer window, which Nabras rejected: "everything crammed in one space").** There is no designer window. `Editor/UiDesign/UiScene` puts the UI where Unity puts it:
- **Outliner** — a Canvas object opens to its elements (Canvas ▸ MainPanel ▸ Button…), each with its kind's icon, drag to reparent/reorder (before / inside / after), eye (scene view only), double-click to rename; right-click gives what THAT kind offers (Set Native Size, Image Type, Fit Size to Text, Select Label/Fill/Handle/Content, Add Tab, Add Option, Direction, Dialog, Mask…) and then Create Child, Rename, Duplicate, Copy, Paste, Paste as Child, Delete, Group/Ungroup, Order, Anchors, Align, Select Parent/Children. The Outliner's Canvas tab lists the canvases as layers (sort order, drag to restack).
- **Inspector** — a selected element is a set of components: Rect Transform (anchor preset grid, Shift/Alt, Raw edit "R", Pos/Width or Left/Right/Top/Bottom by stretch, driven-by-layout note), Image, Text, the kind's own (Button, Toggle, Slider, Scrollbar, Progress Bar, Scroll Rect, List View, Input Field, Dropdown, Tabs, Radial Menu, Compass, World Marker, Template — with Interaction and Events inside), Layout Groups, Layout Element, Content Size Fitter, Aspect Ratio Fitter, Canvas Group, Mask, Safe Area, Dialog, Tooltip, Data Binding — each removable — and Add Component. The Canvas component draws as Canvas / Canvas Scaler (Match Width Or Height, Expand, Shrink) / Graphic Raycaster.
- **Scene view** — every canvas is a plane in the 3D scene at its design resolution (1 unit = 1 cm, bottom-left on the origin, facing +Z), drawn by the game's own renderer through the editor camera, so it recedes in perspective and stays crisp. The Rect Tool works on it: click to select (before the object pick), drag to move with snapping, handles to resize (Shift aspect, Alt symmetric), knob to rotate (Shift 15°), petals to re-anchor; F frames square on. View ▸ UI Canvases toggles it.
- **Undo** — every element edit pushes the scene's undo snapshot once per gesture; a screen kept in the scene is written back into it, a `.fzeui` file's edits ride in the snapshots as `screenEdits` and are written to the file when the scene is saved. Create ▸ UI ▸ Canvas keeps the screen in the scene (right-click ▸ UI ▸ Save Screen As makes it a file); a `.fzeui` double-clicked in the Content Browser is placed in the scene as a canvas (blue UI Screen icon).

Lessons:
- ⚠️ **Masks are clipped in the shader, not by a scissor** (a per-vertex clip rect), so one renderer draws a screen flat over the game and as a plane in a 3D view.
- ⚠️ **"The last item" is not the viewport picture once the viewport icons are drawn** — the Rect Tool reads the picture's own bounds and hover, as the object pick does.
- ⚠️ **An empty `PropertyLabel("")` breaks the Inspector's table** ("SetCursorPos to extend boundaries"): every row needs a label.
- ⚠️ **After an undo the restored canvas has not loaded its screen yet** — the selection is judged once it has, or it is lost.

**Phase 8 — done.** Data, motion, and the scripts:
- **Bindings** (`Gui/Binding`) — a property follows a source the host resolves (`bb:<key>`, `player.health` / `healthMax` / `health01` / `dead`, `entity:<name>.health`, `time`, `fps`, `scene`, `const:<value>`), formatted (`{0}`, `{0:0}`, `{0:0.0} m`, `{0:00}`, `{0:0%}`), range-mapped; only a value that changed touches its node, so a HUD of twenty bindings costs nothing while nothing moves.
- **Lists from data** — a List View clones its template once per item of `<source>.count`; inside a row `item.<field>` reads `<source>.<i>.<field>`, `item.index` is its number and `{index}` in an action is replaced (`set:inv.selected={index}`); several columns make a grid. Rows are `Transient` and never saved.
- **Animation** (`Gui/Animation`) — clips of keyed tracks with ten easings, loop / ping-pong / reverse, Play On Show, On End actions, the actions `play:` `reverse:` `stop:` `pause:` `resume:` (`play:<canvas>/<clip>` for another canvas). Visual channels (offset, scale, rotation, alpha, colour tint) sit on top of the layout and never move a neighbour; any other property (`fill`, `size`, `position`, `prop:<key>`) is set for real. A finished clip holds its pose.
- **The UI Animation window** (`Editor/UiDesign/UiAnimation`) — Unity's Animation window for a canvas's clips, docked at the bottom: tracks with their values at the playhead (typing one keys it), the dope sheet (ruler scrub, summary row, click / box / Ctrl select, drag on 60 Hz frames, Shift for free, double-click to key, right-click for the curve, the clip's end to drag, wheel zoom, middle-drag pan, F), Add Property (the visual channels, Position, Size, Fill, and every animatable property of the table by section), Preview, Record, Play, K keys every track, clip settings in its ⋮ menu. Right-click a Canvas ▸ UI ▸ Animation… opens it.
- **Scripts** — the graph's UI nodes and C# (`UI.SetText`, `GetText`, `SetVisible`, `Clicked`, `SetValue`, `GetValue`, `New`, `Remove`, `Clear`, `Rect`, `Offset`, `Color`, `FillColor`, `TextColor`, `Outline`, `Tint`, `HoverColor`, `Image`, `Typeface`, `Font`, `Style`, `Opacity`, `Show`, `Hovered`, `Changed`, `GetChecked`, `SetChecked`, `OnClick`, `OnChange`, and new `PlayAnimation`, `StopAnimation`, `RunAction`) now reach the new canvases: a canvas by its object's tag, its name or its screen's name ("" any), an element by name or path. `FZEGuiBindTest` 72 checks.

Lessons:
- ⚠️ **Preview never poses the screen itself.** The scene view, Outliner and Inspector see a posed COPY (`UiScene::Doc` returns it while previewing), so nothing posed can be saved or land in an undo snapshot. An edit made on the copy is diffed against it when the gesture ends: Record (or a property the clip already animates) makes a key at the playhead; anything else changes the screen; what a change derived on other elements (a slider's fill) is left to the keys while recording.
- ⚠️ **Adding, removing or moving elements during a preview works on the screen itself** (`UseRealDoc`), never on the copy - a copy's structure is thrown away on the next pose.
- **A key written as one number is uniform** (`"v": 0.5` on a scale track is 0.5, 0.5), so hand-written clips read the way they are meant.
- **A new track keyed away from the start gets a key at 0 with what the element had**, so recording a move animates from where it was.

**Phase 9 — part 1 done** (`d7ced56`): `FZEGuiStressTest` — a 10,106-node screen, 1,000 bindings at rest, a 2,000-row list, 500 animated nodes, a seeded 20,000-operation fuzzer, input whose handlers destroy nodes, a 20,000-byte bilingual paragraph; every incremental layout compared with a full one. It found and fixed: a save of non-UTF-8 text aborted the program; NaN/infinity reached properties; one changed label laid out the whole screen (the climb now stops where what a node asks of its group stops changing — 3 nodes measured instead of 20,212); hiding an element in a group did not re-arrange its siblings.

**Phase 10 — the old systems are gone** (2026-10-16, at Nabras's request: "the old UI Designer, delete it and rely on the new one"):
- **B, RmlUi**: `Engine/UI/Rml/*` (GameUI, its actions, blackboard, net and settings bridges), the viewport designer (`Editor/UIDesigner`, the RML/RCSS source patchers), their tests, the `--ui` / `--design*` flags, the application's RmlUi frame and event hooks, and `vendor/rmlui` itself. FreeType stays: the Gui module's fonts use it. A project's `.rml` / `.rcss` files are left alone (they are the project's), shown as files, editable as text.
- **The pause screen** is the game's: the engine draws no menu of its own. In fullscreen play: a canvas called **Pause** in the scene is shown, and works while the game is frozen; when its Resume hides it (`hide:` / `close`) the game resumes. A scene without one shows nothing: in the Player, Escape brings the pointer out and a click goes back in. A game that calls `Input.OwnEscape` answers the key itself.
- **A, the first canvas** (`UICanvasComponent`, `UIRenderer`, `UILayout`, `HasUI`): removed from the scene, the Player, the editor, prefabs and the graph's event dispatch. An old scene's `"ui"` block is still read as JSON (`Entity::LegacyCanvas`), converted into a Canvas on sight, and written back untouched until then.

**Phase 10 — the demo project** (2026-10-16): `FZEUIShowcase Samples/UIShowcase` writes a separate project — a shooter's main menu over the live level, Settings (four tabs: sliders, toggles, dropdowns, a scrolling key list; Apply saves), Loadout (a grid of weapon cards from data, the chosen one's stats), a multiplayer Lobby (the squad, ready states, a chat that takes messages), the game's own Pause screen, a modal Quit dialog and a HUD (heading-up radar, compass, objective marker in the world with its distance, kill feed, health/armor, weapon and ammo, score, crosshair) — in English and Arabic from one string table. The data a game's scripts would set comes from "Data" canvases' On Show. Every screen is then laid out at 1280×720, 1920×1080, 2560×1440 and 3440×1440 in both languages and checked: nothing off the screen, no text cut off, no two controls overlapping. The project exports (`FZEExport`), verifies and runs.

What the demo needed, now in the engine:
- **On Show** (a Canvas's action each time it appears, Unity's OnEnable) — run before its data is read that frame, also when a click opens it mid-frame.
- **World Markers in play**: over their target (clamped to the screen's edge; behind the camera on the bottom edge, on their own side) or, in Map mode, on a heading-up radar; placed when drawing, from this frame's camera. `camera.heading` for a compass.
- **String tables** (`.fzestrings`): `loc:<key>`, `loc:item.<field>` in list rows, `lang:` (`$index`, `next`), `lang` / `lang.names` / `lang.index` / `lang.rtl`; UI.Localize / GetLanguage / SetLanguage for graphs and C#. Builds always ship them (nothing names a table).
- **Right to left**: an RTL language lays each canvas out mirrored (Canvas › Mirror For Right-To-Left) — anchors, groups, padding, offsets, turns, corners, gradients and slide-in clips flip; sliders fill and drag from the right; every paragraph starts at the right; glyphs and the world (radar, compass, markers) do not flip. No letter spacing inside Arabic.
- **save:/load:** (PlayerPrefs) — the blackboard's `settings.*` in the player's own file under LOCALAPPDATA, never the project.
- `add:<list>|field=$text`, `text:<element>=`, `{key}` inside blackboard keys and `set:` values, `is:<key>=<value>`, `ui.menu` (1 while a menu holds the input — a HUD's alpha).
- **Q / E and LB / RB turn a screen's tabs.**
- The Player honours a scene's **Pause** canvas and the game's cursor wish (a menu over a first-person level is clickable in an exported game).

Bugs it found and fixed: an action raised by a control carried value 0 and its own text (`$value` from a dragged slider wrote 0); Play's copy of a scene dropped On Show (the canvas copy constructor lists fields by hand — now tested by comparing a copy's saved form); every new tab showed its underline; opening the Settings page from the pause screen resumed the game; the editor opened a project without a session as an empty "Untitled" while its Player started the project's scene.

**After phase 10 — the Winter menu** (2026-10-17, Nabras: "a God of War Ragnarok main menu: a realistic character moving behind it; on Play the same character, the same look, the rhythm changes at once, Sony's way"): `FZEWinterMenu FionaProject` builds `Winter Menu.fzescene` (a snowy clearing at dusk, a warrior with an axe seen from behind by a fire, a cinematic camera with a breathing drift, the title and the menu on the left) and `Winter Trail.fzescene` (the game: a torch-lit trail north), preloaded while the menu shows. NEW GAME fades the menu, eases the camera over 3.2 s to over the warrior's shoulder, streams the trail in and crossfades the music - no loading screen, no cut - and the HUD's objective comes in as the menu's exit clip ends. See docs/WINTER-MENU.md.

What it needed, now in the engine:
- Actions **`camera:<object>[,seconds]`** (that camera goes live, easing across), **`stream:` / `preload:` / `unstream:<scene>`** (Runtime/SceneStreaming), **`music:<file>[,fade]`** (the music crossfades; empty stops it).
- **A screen's focus ring can be turned off** (`Document::FocusRing`, "focusRing": false): a menu whose selected line already shows itself (a glow bar) does not want a box round it.
- **Clips by name** in an animator's states and blend samples (`ClipName`), resolved when the model and its extra clip files are in - a graph authored against the animation library survives a model with clips of its own.
