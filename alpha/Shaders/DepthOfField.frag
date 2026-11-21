#version 460 core
// -----------------------------------------------------------------------------
// DEPTH OF FIELD: what a real lens does to everything nearer or further than
// where it is focused.
//
// The blur is the thin-lens circle of confusion, from the cinematic camera's own
// numbers - not a "blur amount" slider:
//
//     c = A * f * |z - s| / (z * (s - f))      on the sensor, in millimetres
//
// A the aperture's diameter (focal length / f-number), f the focal length, s the
// focus distance, z the distance of what this pixel shows. Converted to pixels by
// how many pixels one millimetre of the frame covers. So a 85 mm at f/1.4 melts
// the background, a 24 mm at f/8 keeps nearly everything sharp, as they would.
//
// ⚠️ GATHERED IN HDR, BEFORE THE BLOOM. A street lamp out of focus is a disc of
// light because its pixels are many times brighter than 1.0; blurring after the
// tonemap would leave a grey smudge where the bokeh should be.
//
// One pass, a golden-angle spiral (after Dennis Gustafsson's single-pass bokeh):
// each sample counts if ITS blur reaches this pixel - so a blurred foreground
// spreads over a sharp background, and a sharp background never bleeds forward
// over a blurred subject in front of it.
// -----------------------------------------------------------------------------

in vec2 v_UV;
out vec4 FragColor;

uniform sampler2D u_Scene;
uniform sampler2D u_Depth;
uniform mat4  u_InvViewProj;
uniform vec3  u_CameraPos;
uniform vec3  u_CameraForward;
uniform vec2  u_TexelSize;
uniform float u_FocusMM;      // focus distance
uniform float u_FocalMM;      // focal length
uniform float u_ApertureMM;   // focal length / f-number
uniform float u_PxPerMM;      // frame height in pixels / frame height on the sensor
uniform float u_MaxRadius;    // the largest blur, in pixels

const float GOLDEN = 2.39996323;
const float STEP   = 0.75;     // spiral density: radius grows by STEP / radius per sample

// Distance along the lens axis, in millimetres. The sky is at infinity.
float AxisMM(vec2 uv) {
    float d = texture(u_Depth, uv).r;
    if (d >= 0.99999) return 1.0e9;
    vec4 h = u_InvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec3 w = h.xyz / h.w;
    return max(dot(w - u_CameraPos, u_CameraForward), 1.0e-3) * 1000.0;
}

// The blur's radius in pixels for something at z.
float CoC(float z) {
    float s = max(u_FocusMM, u_FocalMM * 1.001);
    float c = u_ApertureMM * u_FocalMM * abs(z - s) / (z * (s - u_FocalMM));
    return min(c * 0.5 * u_PxPerMM, u_MaxRadius);
}

void main() {
    vec3  center = texture(u_Scene, v_UV).rgb;
    float cz = AxisMM(v_UV);
    float cs = CoC(cz);

    vec3  acc = center;
    float tot = 1.0;
    float radius = STEP;
    float ang = 0.0;
    for (int i = 0; i < 512 && radius < u_MaxRadius; ++i) {
        vec2  tc = v_UV + vec2(cos(ang), sin(ang)) * u_TexelSize * radius;
        vec3  sc = texture(u_Scene, tc).rgb;
        float sz = AxisMM(tc);
        float ss = CoC(sz);
        // Behind this pixel: it may not reach further than this pixel's own blur.
        if (sz > cz) ss = clamp(ss, 0.0, cs * 2.0);
        float m = smoothstep(radius - 0.5, radius + 0.5, ss);
        acc += mix(acc / tot, sc, m);
        tot += 1.0;
        ang += GOLDEN;
        radius += STEP / radius;
    }
    FragColor = vec4(acc / tot, 1.0);
}
