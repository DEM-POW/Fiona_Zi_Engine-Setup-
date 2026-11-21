#version 460 core

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Src;
uniform vec2 u_Direction;   // texel-sized step (x,0) or (0,y)

void main()
{
    // 9-tap Gaussian.
    float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
    vec3 result = texture(u_Src, v_UV).rgb * w[0];
    for (int i = 1; i < 5; ++i) {
        result += texture(u_Src, v_UV + u_Direction * float(i)).rgb * w[i];
        result += texture(u_Src, v_UV - u_Direction * float(i)).rgb * w[i];
    }
    FragColor = vec4(result, 1.0);
}
