#version 460 core

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Skybox;     // equirect panorama (REPEAT in U, CLAMP in V)
uniform float u_RotU;           // rotation as a plain U offset — the sampler wraps
uniform float u_Intensity;

void main()
{
    // No fract() on the U offset: fract would reintroduce the very derivative
    // jump the sphere exists to avoid. GL_REPEAT does the wrapping seamlessly.
    vec3 col = texture(u_Skybox, vec2(v_UV.x + u_RotU, v_UV.y)).rgb;
    FragColor = vec4(col * u_Intensity, 1.0);
}
