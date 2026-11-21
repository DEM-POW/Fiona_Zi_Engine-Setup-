#version 460 core
// ============================================================================
//  LOCAL EXPOSURE: THE PICTURE'S BRIGHTNESS, SMOOTHED, WITHOUT CROSSING EDGES
//
//  Unreal's Local Exposure (bilateral method): the image's luminance split
//  into a BASE - how bright this part of the picture is overall - and the
//  DETAIL on top of it. The composite then reduces the contrast of the base
//  alone, so a dark room seen with a bright window keeps its texture and its
//  shading, but the room is lifted and the window held back - what the eye
//  does looking from one to the other, without an exposure that moves.
//
//  Two modes of this one shader:
//    u_Mode 0  the log2 luminance of the scene, 8 x 8 texels averaged into one
//              (16 bilinear taps), at an eighth of the size.
//    u_Mode 1  one direction of the edge-aware blur: Gaussian in space, and a
//              neighbour whose brightness differs by more than about an EV
//              counts for less - so a window's light does not bleed onto the
//              wall round it (the halo a plain blur makes).
// ============================================================================

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Src;
uniform vec2  u_SrcTexel;     // a texel of what is read
uniform int   u_Mode;
uniform vec2  u_Dir;          // mode 1: (1,0) or (0,1), in texels of the source
uniform float u_Sigma;        // mode 1: the blur's spread, texels
uniform float u_SigmaEV;      // mode 1: how far apart in EV two texels may be and still mix

float Luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
    if (u_Mode == 0) {
        // 8 x 8 source texels: 16 bilinear taps, each the mean of a 2 x 2.
        float sum = 0.0;
        for (int y = 0; y < 4; ++y)
            for (int x = 0; x < 4; ++x) {
                vec2 o = (vec2(float(x), float(y)) * 2.0 - 3.0) * u_SrcTexel;
                sum += log2(max(Luma(texture(u_Src, v_UV + o).rgb), 1e-6));
            }
        FragColor = vec4(sum / 16.0, 0.0, 0.0, 1.0);
        return;
    }
    float centre = texture(u_Src, v_UV).r;
    int radius = int(ceil(u_Sigma * 2.5));
    float wsum = 0.0, vsum = 0.0;
    for (int i = -radius; i <= radius; ++i) {
        float v = texture(u_Src, v_UV + u_Dir * u_SrcTexel * float(i)).r;
        float d = v - centre;
        float w = exp(-float(i * i) / (2.0 * u_Sigma * u_Sigma)) * exp(-d * d / (2.0 * u_SigmaEV * u_SigmaEV));
        wsum += w;
        vsum += w * v;
    }
    FragColor = vec4(vsum / max(wsum, 1e-6), 0.0, 0.0, 1.0);
}
