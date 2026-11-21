#version 460 core
// ---------------------------------------------------------------
//  Fiona Zi Engine - the game UI (Gui/Renderer)
// ---------------------------------------------------------------
// One program for everything a screen draws, by mode (v_P0.z):
//   0  a box: rounded corners, border, gradient - a signed distance field,
//      so a 2 px corner and a 200 px one are both exact and anti-aliased
//   1  an image (the texture x colour), with the box's rounded mask
//   (both: a radial fill cuts v_P2.z of the turn away, from v_P2.w)
//   2  text: the glyph's distance field (Gui/Font) - fill, outline, glow,
//      bold, all from the one field
//   3  a ring sector (radial menus, circular gauges)
//   4  a soft shadow under a box
// Output is premultiplied (blend ONE, ONE_MINUS_SRC_ALPHA).

in vec2 v_UV;
in vec2 v_Local;
in vec4 v_Color;
in vec4 v_Color2;
in vec4 v_Border;
flat in vec4 v_P0;
flat in vec4 v_P1;
flat in vec4 v_P2;
in vec2 v_Pos;
flat in vec4 v_Clip;

uniform sampler2D u_Tex;

out vec4 FragColor;

// Distance to a rounded box (negative inside); r: tl, tr, br, bl.
float RoundedBox(vec2 p, vec2 half_, vec4 r)
{
    float rad = p.x < 0.0 ? (p.y < 0.0 ? r.x : r.w) : (p.y < 0.0 ? r.y : r.z);
    rad = min(rad, min(half_.x, half_.y));
    vec2 q = abs(p) - half_ + rad;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rad;
}

vec4 Gradient()
{
    int g = int(v_P2.x + 0.5);
    if (g == 0) return v_Color;
    vec2 half_ = max(v_P0.xy, vec2(1e-3));
    float t;
    if (g == 1) t = v_Local.y / half_.y * 0.5 + 0.5;
    else if (g == 2) t = v_Local.x / half_.x * 0.5 + 0.5;
    else t = clamp(length(v_Local / half_), 0.0, 1.0);
    return mix(v_Color, v_Color2, clamp(t, 0.0, 1.0));
}

void main()
{
    // The mask (and the target's edge): outside it, nothing.
    if (v_Pos.x < v_Clip.x || v_Pos.y < v_Clip.y || v_Pos.x > v_Clip.z || v_Pos.y > v_Clip.w) discard;
    int mode = int(v_P0.z + 0.5);
    vec4 outc;
    if (mode == 0 || mode == 1) {
        float d = RoundedBox(v_Local, v_P0.xy, v_P1);
        float aa = max(fwidth(d), 1e-4) * 0.75;
        float inside = 1.0 - smoothstep(-aa, aa, d);
        vec4 fill = mode == 0 ? Gradient() : texture(u_Tex, v_UV) * v_Color;
        // A radial fill (box or image): v_P2.z of the turn, ending at the start
        // angle, is cut away - softly, a pixel wide at this radius.
        if (v_P2.z > 0.0) {
            float a = atan(v_Local.x, -v_Local.y) / 6.2831853;     // 0 at the top, clockwise
            float half_ = (1.0 - v_P2.z) * 0.5;                   // the kept sector's half width
            float rel = fract(a - v_P2.w - half_ + 0.5) - 0.5;    // from the sector's middle
            float px = min(0.5 / (6.2831853 * max(length(v_Local), 1.0)), 0.02);
            inside *= 1.0 - smoothstep(-px, px, abs(rel) - half_);
        }
        float bw = v_P0.w;
        if (bw > 0.0) {
            // 1 in the border band (the painter sends a width only with a visible border).
            float b = smoothstep(-aa, aa, d + bw);
            fill = mix(fill, v_Border, b);
        }
        outc = vec4(fill.rgb, fill.a * inside);
    } else if (mode == 2) {
        float d = texture(u_Tex, v_UV).r;
        float w = max(fwidth(d), 1e-4) * 0.7 + v_P1.y;
        float edge = 0.5 - v_P1.z;                             // bold: a lower threshold
        float fillA = smoothstep(edge - w, edge + w, d);
        float outline = v_P1.x;
        vec4 c = v_Color;
        if (outline > 0.0 && v_Color2.a > 0.0) {
            float oA = smoothstep(edge - outline - w, edge - outline + w, d);
            c = mix(v_Color2, v_Color, fillA);
            c.a = mix(v_Color2.a * oA, v_Color.a, fillA);
            outc = vec4(c.rgb, c.a);
        } else {
            outc = vec4(c.rgb, c.a * fillA);
        }
    } else if (mode == 3) {
        // Ring sector: inner, outer radius (pixels), from angle, to angle (0 at the top, clockwise, radians).
        float r = length(v_Local);
        float aa = max(fwidth(r), 1e-4);
        float ring = smoothstep(v_P1.x - aa, v_P1.x + aa, r) * (1.0 - smoothstep(v_P1.y - aa, v_P1.y + aa, r));
        float a = atan(v_Local.x, -v_Local.y);
        if (a < 0.0) a += 6.2831853;
        float a0 = v_P1.z, a1 = v_P1.w;
        float span = mod(a1 - a0 + 6.2831853, 6.2831853);
        float rel = mod(a - a0 + 6.2831853, 6.2831853);
        // Soft edges along the cut, a pixel wide at this radius.
        float pxA = aa / max(r, 1.0);
        float sector = span >= 6.2831 ? 1.0 : smoothstep(-pxA, pxA, rel) * (1.0 - smoothstep(span - pxA, span + pxA, rel));
        vec4 fill = v_Color;
        // The border: the ring's outer band.
        if (v_P0.w > 0.0) {
            float b = smoothstep(v_P1.y - v_P0.w - aa, v_P1.y - v_P0.w + aa, r);
            fill = mix(fill, v_Border, b);
        }
        outc = vec4(fill.rgb, fill.a * ring * sector);
    } else {
        // A soft shadow: the box's field, blurred by v_P2.y pixels.
        float d = RoundedBox(v_Local, v_P0.xy, v_P1);
        float blur = max(v_P2.y, 0.5);
        float a = 1.0 - smoothstep(-blur, blur, d);
        outc = vec4(v_Color.rgb, v_Color.a * a * a);
    }
    if (outc.a <= 0.002) discard;
    FragColor = vec4(outc.rgb * outc.a, outc.a);
}
