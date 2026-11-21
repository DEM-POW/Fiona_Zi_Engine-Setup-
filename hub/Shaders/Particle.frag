#version 460 core

in vec4 v_Color;
in vec2 v_UV;
out vec4 FragColor;

// What the colour becomes as light: emitted (additive) or reflected (blended).
// See Renderer::EmissionScale / SpriteLighting.
uniform vec3 u_Radiance;

void main()
{
    // Soft round particle: radial falloff from the quad centre.
    float d = length(v_UV * 2.0 - 1.0);
    float a = smoothstep(1.0, 0.0, d);
    FragColor = vec4(v_Color.rgb * u_Radiance, v_Color.a * a);
}
