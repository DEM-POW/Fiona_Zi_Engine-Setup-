#version 460 core
// ---------------------------------------------------------------
//  Fiona Zi Engine - a bone or a joint in the Character Preview
// ---------------------------------------------------------------
// Screen colours, not light: facing the eye is the colour, turning away
// darkens - enough to read the octahedron's facets and which way a bone
// points, never so dark a bone in shadow disappears.

in vec3 v_Normal;
in vec3 v_WorldPos;

uniform vec4 u_Color;
uniform vec3 u_Eye;

out vec4 FragColor;

void main()
{
    vec3 n = normalize(v_Normal);
    vec3 v = normalize(u_Eye - v_WorldPos);
    float facing = abs(dot(n, v));
    float rim = pow(1.0 - facing, 3.0);
    vec3 c = u_Color.rgb * (0.48 + 0.52 * facing) + rim * 0.18;
    FragColor = vec4(c, u_Color.a);
}
