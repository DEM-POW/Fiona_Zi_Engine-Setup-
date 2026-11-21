# UI Decor

Dresses the Fiona Zi editor itself: its windows, its menus, its popups.

Switch it on in **File ▸ Extensions** and open **View ▸ Extensions ▸ UI Decor**.

| Section | What it does |
|---|---|
| **Colours** | Themes for the whole editor: *Navy Night*, *Rose*, *Mint*, *Mono*. Pick your own Accent, Windows, Title bars and Text colours. *Editor's own* puts the editor's colours back. |
| **Frames** | Turn **Window frames** off to take the border away from every window, popup and field. Set your own **Rounding** for corners. |
| **Decorations** | Drawn on the editor's windows every frame, the way a profile picture wears an animated frame. |

The decorations:

- **Neon frame:** light runs round the panel's edge, in your colour, with a glow around it.
- **Corner ornaments:** brackets and diamonds at the panel's corners, breathing slowly.
- **Sparkles:** stars twinkle along the edge. These come from `Resources/sparkle.gif`, an animated GIF.
- **Falling petals:** sakura petals drift down inside the panel, turning as they fall.
- **Flame corners:** flames burn on the panel's top corners. These come from `Resources/flame.png`, an 8-frame sprite strip.
- **Glow on menus and popups:** a soft glow around them, with a shimmer running along the top edge.

**Only the panel in use** keeps all of this on the window you are working in.

Settings are saved with the project in `ExtensionData/com.fionazi.uidecor/uidecor.cfg`.

## How it is built

It is an editor-only extension: one DLL, `Bin/UIDecorEditor.dll`. It never ships with a game. Everything goes through `IEditor` in the SDK:

- `RegisterDecorator`: called for every editor window on screen, with a `below` and an `above` pen;
- `SetStyleColor` / `SetStyleValue` / `ResetStyle`: the editor's colours, borders and rounding, all put back when the extension stops;
- `LoadImage` / `ImageInfo`: PNG, JPG, TGA or BMP pictures and animated GIFs, plus sprite strips cut into frames.

Any picture you put in `Resources/` can be used the same way. Draw it with `IPainter::Image` (or `ImageRotated`) and a frame number.
