#version 460 core

// 4x4 box blur of the screen-space shading terms: R is ambient occlusion, G is
// the contact shadow. Both are produced by per-pixel randomised sampling and
// both want the same cheap smoothing, so they are blurred in one pass.

in vec2 v_UV;
out vec2 FragColor;

uniform sampler2D u_AO;
uniform vec2 u_Texel;   // 1 / AO texture size

void main() {
    vec2 sum = vec2(0.0);
    for (int x = -2; x <= 1; ++x)
        for (int y = -2; y <= 1; ++y)
            sum += texture(u_AO, v_UV + vec2(x, y) * u_Texel).rg;
    FragColor = sum / 16.0;
}
