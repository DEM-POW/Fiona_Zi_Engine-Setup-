#version 460 core

in vec4  v_Color;
in vec2  v_UV;
in vec2  v_UV2;
in float v_Blend;
in float v_ViewDepth;
in vec3  v_Ambient;
in vec3  v_Sun;
in vec3  v_Right;
in vec3  v_Up;

uniform sampler2D u_Texture;
uniform sampler2D u_SceneDepth;
uniform sampler2D u_NormalMap;
uniform int   u_HasNormal;
uniform int   u_Lit;
uniform vec3  u_SunDir;
// What the colour becomes as light when it is not lit by the scene: emitted
// (additive), the flat daylight card (unlit blended) or 1 (multiply). See
// Renderer::EmissionScale / SpriteLighting.
uniform vec3  u_Radiance;
// x = soft distance (0 = off), y = camera fade distance (0 = off),
// z, w = the projection's [2][2] and [3][2], to turn stored depth back into metres.
uniform vec4  u_Fade;
uniform vec4  u_Viewport;   // x, y, width, height
uniform int   u_Multiply;

out vec4 FragColor;

float SceneMetres()
{
    vec2 uv = (gl_FragCoord.xy - u_Viewport.xy) / u_Viewport.zw;
    float ndc = texture(u_SceneDepth, uv).r * 2.0 - 1.0;
    return u_Fade.w / (ndc + u_Fade.z);
}

void main()
{
    // ⚠️ TWO FRAMES, FADED. A 6x6 flipbook played over a puff's three-second
    // life shows each frame for a tenth of a second - a visible step every
    // tenth of a second unless the next frame fades in under it.
    vec4 t = texture(u_Texture, v_UV);
    if (v_Blend > 0.0) t = mix(t, texture(u_Texture, v_UV2), v_Blend);
    vec4 c = t * v_Color;

    // ⚠️ SOFT PARTICLES. A flat card meeting a wall or the ground draws a hard
    // straight line exactly where it intersects - the single most recognisable
    // sign of a cheap effect. Fading by how close the card is to what is already
    // drawn behind it turns that line into a soft contact.
    if (u_Fade.x > 0.0)
        c.a *= clamp((SceneMetres() - v_ViewDepth) / u_Fade.x, 0.0, 1.0);
    // ...and a particle that drifts into the lens fades instead of filling the
    // screen with one enormous sprite.
    if (u_Fade.y > 0.0)
        c.a *= clamp((v_ViewDepth - 0.05) / u_Fade.y, 0.0, 1.0);

    if (u_Multiply != 0) {
        // Darkens what is behind it: soot, scorch. White = no change.
        FragColor = vec4(mix(vec3(1.0), c.rgb, c.a), 1.0);
        return;
    }

    vec3 light = u_Radiance;
    if (u_Lit == 1) {
        // The sun shaped by the puff's own normal when it has one; without,
        // a card lit half-on (wrapped), as a soft round volume is on average.
        float shape = 0.6;
        if (u_HasNormal == 1) {
            vec3 nt = texture(u_NormalMap, v_UV).xyz * 2.0 - 1.0;
            vec3 back = normalize(cross(v_Right, v_Up));
            vec3 n = normalize(v_Right * nt.x + v_Up * nt.y + back * max(nt.z, 0.0));
            shape = clamp(dot(n, u_SunDir) * 0.5 + 0.5, 0.0, 1.0);
            shape = shape * shape * 1.3;
        }
        light = v_Ambient + v_Sun * shape;
    }
    // PREMULTIPLIED: the blend functions expect it, and it is what makes a fading
    // additive particle add LESS light rather than the same amount until it dies.
    c.rgb *= c.a * light;
    if (c.a < 0.002) discard;
    FragColor = c;
}
