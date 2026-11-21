#version 460 core
// ============================================================================
//  WHAT A FALLING PARTICLE LOOKS LIKE
//
//  Its light was worked out in the simulation (lib/PrecipLight.glsl): the
//  sky, the lamps and the sun through a forward-scattering lobe. Here is only
//  its shape - a soft streak, a tumbling disc, a speck, a crown rising and
//  falling - and its colour. Output is premultiplied LINEAR radiance: the
//  frame is light until the composite pass puts it through the camera.
// ============================================================================

in vec2  v_UV;
in float v_Alpha;
in vec3  v_Light;
flat in int v_Kind;
in float v_Age;
in float v_Seed;
out vec4 FragColor;

uniform vec3  u_Color;      // the type's colour, linear
uniform float u_Time;
uniform int   u_Debug;

void main() {
    if (v_Alpha <= 0.0) discard;
    if (u_Debug == 1) { FragColor = vec4(v_Kind >= 10 ? vec3(4.0, 0.2, 0.2) : vec3(0.2, 2.0, 4.0), 1.0); return; }
    if (u_Debug == 2) { FragColor = vec4(v_Light, 1.0); return; }   // the light each one was given
    float a = 0.0;
    vec3 tint = u_Color;
    if (v_Kind == 0 || v_Kind == 2 || v_Kind == 12 || v_Kind == 15) {
        // A streak: soft across, brightest at the head, where the drop is when
        // the shutter closes and the light it gathered piles up least.
        float across = 1.0 - abs(v_UV.x);
        a = across * across * (3.0 - 2.0 * across);
        a *= mix(0.45, 1.0, v_UV.y);
        if (v_Kind == 2) a *= 1.25;
        if (v_Kind >= 10) tint = vec3(0.85, 0.9, 0.95);
    } else if (v_Kind == 1) {
        // A flake: a disc turning about its own axis, seen as an ellipse.
        vec2 c = vec2(v_UV.x, v_UV.y * 2.0 - 1.0);
        float ang = v_Seed * 6.2831853 + u_Time * (0.8 + 1.6 * v_Seed);
        mat2 r = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
        c = r * c;
        c.y /= mix(0.45, 1.0, abs(sin(ang * 0.7 + v_Seed * 3.0)));
        a = 1.0 - smoothstep(0.45, 1.0, length(c));
    } else if (v_Kind == 3 || v_Kind == 13) {
        vec2 c = vec2(v_UV.x, v_UV.y * 2.0 - 1.0);
        a = exp(-3.0 * dot(c, c));
        if (v_Kind == 13) tint = vec3(0.8, 0.84, 0.88);
    } else if (v_Kind == 14) {
        vec2 c = vec2(v_UV.x, v_UV.y * 2.0 - 1.0);
        a = 1.0 - smoothstep(0.3, 1.0, length(c));
        tint = vec3(0.95);
    } else if (v_Kind == 11) {
        // The crown, seen from the side: a thin sheet rising round the impact
        // - its two edges, where the eye looks along the sheet, are what
        // shows - the rim breaking into points. It rises through the first
        // third of its life and falls back through the rest.
        float x = abs(v_UV.x);
        float rise = sin(3.14159265 * clamp(v_Age, 0.0, 1.0));
        float spikes = 0.75 + 0.25 * abs(sin(v_UV.x * 9.0 + v_Seed * 20.0));
        float top = rise * spikes;
        float wall = smoothstep(0.55, 0.85, x) * (1.0 - smoothstep(0.9, 1.0, x));
        float sheet = 0.25 * (1.0 - smoothstep(0.85, 1.0, x));
        a = (wall + sheet) * step(v_UV.y, top) * (1.0 - smoothstep(top * 0.7, top, v_UV.y) * 0.6);
        a *= 1.0 - v_Age * 0.5;
        tint = vec3(0.85, 0.9, 0.95);
    }
    a = min(a * v_Alpha, 0.9);
    if (a <= 0.0004) discard;
    FragColor = vec4(v_Light * tint * a, a);
}
