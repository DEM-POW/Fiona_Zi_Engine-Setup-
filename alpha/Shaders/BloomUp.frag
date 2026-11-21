#version 460 core

// The climb back up the bloom chain (see BloomDown.frag): this level's own
// blur plus everything coarser, read through a 3x3 tent so the coarse levels'
// texels never show as blocks. The tent is what makes a level at 1/64 of the
// screen still come out as a smooth gradient instead of a grid of squares.

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Src;      // the coarser level, already summed
uniform sampler2D u_Base;     // this level's own downsample
uniform vec2  u_SrcTexel;     // one texel of u_Src

void main() {
    vec2 t = u_SrcTexel;
    vec3 s = texture(u_Src, v_UV + t * vec2(-1.0,  1.0)).rgb
           + texture(u_Src, v_UV + t * vec2( 0.0,  1.0)).rgb * 2.0
           + texture(u_Src, v_UV + t * vec2( 1.0,  1.0)).rgb
           + texture(u_Src, v_UV + t * vec2(-1.0,  0.0)).rgb * 2.0
           + texture(u_Src, v_UV).rgb * 4.0
           + texture(u_Src, v_UV + t * vec2( 1.0,  0.0)).rgb * 2.0
           + texture(u_Src, v_UV + t * vec2(-1.0, -1.0)).rgb
           + texture(u_Src, v_UV + t * vec2( 0.0, -1.0)).rgb * 2.0
           + texture(u_Src, v_UV + t * vec2( 1.0, -1.0)).rgb;
    FragColor = vec4(texture(u_Base, v_UV).rgb + s * (1.0 / 16.0), 1.0);
}
