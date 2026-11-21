#version 460 core
// A lightning channel is a source, not a surface: light, added (premultiplied
// linear radiance, already dimmed by the air and rain between it and the eye).
in vec2  v_UV;
in float v_Alpha;
out vec4 FragColor;
uniform vec3 u_BoltLight;

void main() {
    if (v_Alpha <= 0.0) discard;
    float across = 1.0 - abs(v_UV.x);
    FragColor = vec4(u_BoltLight * (across * across) * v_Alpha, 0.0);
}
