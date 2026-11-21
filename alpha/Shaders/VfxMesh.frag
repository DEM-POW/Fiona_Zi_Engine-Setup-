#version 460 core

in vec3 v_Normal;
in vec4 v_Color;

uniform vec3 u_Radiance;
uniform int  u_Lit;

out vec4 FragColor;

void main()
{
    // Debris and shells are solid things in the light: a soft sky term from above
    // and the rest from the side, so a falling rock reads as a rock and not as a
    // flat silhouette. Unlit (additive) meshes are light themselves.
    float shade = u_Lit != 0 ? 0.35 + 0.65 * clamp(v_Normal.y * 0.5 + 0.5, 0.0, 1.0) : 1.0;
    vec3 c = v_Color.rgb * shade * u_Radiance;
    FragColor = vec4(c * v_Color.a, v_Color.a);
}
