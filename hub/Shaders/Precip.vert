#version 460 core
// ============================================================================
//  WHAT FALLS, AND WHAT IT THROWS UP, AS THE CAMERA SEES IT
//
//  One instance a particle, four corners each, read straight from the
//  simulation's buffers (PrecipSim.comp, SplashSim.comp):
//
//    * a DROP is the streak it makes while the shutter is open - from where
//      it is back along its velocity - as wide as the drop or two pixels,
//      whichever is wider, with the difference taken out of its opacity (a
//      streak at arm's length is a hair, not a plank);
//    * a FLAKE is a small disc facing the camera, tumbling, a little blurred
//      along its path; a PELLET a short bright streak; a MOTE a soft speck;
//    * a CROWN is a sheet standing round an impact, turned to the camera
//      about the vertical; DROPLETS and JETS are streaks; MIST a soft puff;
//      CHIPS of ice small bright specks.
//
//  Particles near the walls of their box fade, so the wrap is never seen.
// ============================================================================

struct Drop { vec4 PosSeed; vec4 VelSize; vec4 Light; };
layout(std430, binding = 9) readonly buffer Drops { Drop drops[]; };
struct Splash { vec4 PosAge; vec4 VelLife; vec4 Info; vec4 Light; };
layout(std430, binding = 11) readonly buffer Splashes { uint head; uint sPad0, sPad1, sPad2; Splash splashes[]; };

uniform mat4  u_ViewProj;
uniform vec3  u_CameraPos;
uniform float u_PixelAngle;     // radians per pixel, vertically
uniform float u_Shutter;        // seconds the shutter is open
uniform int   u_Mode;           // 0 the fall, 1 the splashes
uniform int   u_Form;           // 0 streak, 1 flake, 2 pellet, 3 mote
uniform int   u_Base;
uniform vec3  u_BoxMin, u_BoxSize;
uniform float u_Alpha;          // how much of the fall each drawn particle stands for
uniform float u_Time;
uniform int   u_Debug;          // FZE_RAINDEBUG=1: every particle 3 cm wide and opaque - where they are

out vec2  v_UV;        // x across (-1..1), y along (0 tail .. 1 head)
out float v_Alpha;
out vec3  v_Light;
flat out int v_Kind;   // 0..3 the fall's forms, 10 + splash kind
out float v_Age;
out float v_Seed;

void Cull() {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    v_Alpha = 0.0; v_UV = vec2(0.0); v_Light = vec3(0.0); v_Kind = 0; v_Age = 0.0; v_Seed = 0.0;
}

vec3 Side(vec3 axis, vec3 toCam) { return normalize(cross(axis, toCam) + vec3(1e-5, 0.0, 0.0)); }

void Streak(vec3 head, vec3 vel, float dM, float minLen, float alpha, vec2 q) {
    float speed = length(vel);
    vec3 axis = speed > 1e-4 ? vel / speed : vec3(0.0, -1.0, 0.0);
    float len = max(speed * u_Shutter, minLen);
    vec3 tail = head - axis * len;
    vec3 mid = 0.5 * (head + tail);
    vec3 toCam = u_CameraPos - mid;
    float dist = length(toCam);
    toCam /= max(dist, 1e-4);
    float pix = dist * u_PixelAngle;
    // ⚠️ TWO PIXELS AT LEAST, NOT ONE. One pixel wide on a slant falls between
    // pixel centres half the time and draws as a dotted line; the opacity
    // takes the extra width back out so the drop's light is the same.
    float width = max(dM, 2.0 * pix);
    if (u_Debug != 0) width = max(width, 0.03);
    // ⚠️ A FLOOR UNDER THE COVERAGE, NEAR THE EYE. Taken literally, a 2 mm drop
    // six metres off covers a seventh of its two-pixel streak and is drawn at a
    // twentieth of its opacity: a downpour vanished against a dark street.
    // What the eye sees there is the drop's refraction of the bright sky,
    // smeared along its fall - so within a few metres a streak keeps at least
    // a fifth of its opacity, fading back to the true coverage with distance.
    float floorCov = 0.22 * (1.0 - smoothstep(5.0, 40.0, dist));
    float coverage = u_Debug != 0 ? 1.0 : max(dM / width, floorCov);
    vec3 pos = mix(tail, head, q.y) + Side(axis, toCam) * q.x * width * 0.5;
    gl_Position = u_ViewProj * vec4(pos, 1.0);
    v_Alpha = u_Debug != 0 ? 1.0 : alpha * coverage * smoothstep(0.3, 1.0, dist);
}

void Billboard(vec3 c, float halfSize, vec3 stretch, float alpha, vec2 q) {
    vec3 toCam = u_CameraPos - c;
    float dist = length(toCam);
    toCam /= max(dist, 1e-4);
    float pix = dist * u_PixelAngle;
    float h = max(halfSize, 1.2 * pix);
    float coverage = min(1.0, (halfSize * halfSize) / (h * h));
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam) + vec3(1e-5, 0.0, 0.0));
    vec3 up = cross(toCam, right);
    vec3 pos = c + right * q.x * h + up * (q.y * 2.0 - 1.0) * h + stretch * (q.y - 0.5);
    gl_Position = u_ViewProj * vec4(pos, 1.0);
    v_Alpha = alpha * coverage * smoothstep(0.25, 0.8, dist);
}

void main() {
    int corner = gl_VertexID;                    // triangle strip: 0 1 2 3
    vec2 q = vec2((corner & 1) == 0 ? -1.0 : 1.0, (corner & 2) == 0 ? 0.0 : 1.0);
    v_UV = q;

    if (u_Mode == 0) {
        Drop d = drops[u_Base + gl_InstanceID];
        if (d.VelSize.w <= 0.0) { Cull(); return; }
        vec3 p = d.PosSeed.xyz;
        vec3 v = d.VelSize.xyz;
        float dM = d.VelSize.w * 0.001;
        v_Light = d.Light.rgb;
        v_Kind = u_Form;
        v_Seed = fract(d.PosSeed.w);
        v_Age = 0.0;
        vec3 rel = abs((p - u_BoxMin) / u_BoxSize * 2.0 - 1.0);
        float edge = (1.0 - smoothstep(0.78, 1.0, max(rel.x, rel.z))) * (1.0 - smoothstep(0.85, 1.0, rel.y));
        if (u_Form == 0) {
            Streak(p, v, dM, dM, u_Alpha * edge, q);
        } else if (u_Form == 2) {
            Streak(p, v, dM, dM * 2.0, u_Alpha * edge, q);
        } else if (u_Form == 1) {
            // A flake: face-on, a little blurred along its path.
            Billboard(p, dM * 0.5, v * u_Shutter * 0.6, u_Alpha * edge, q);
        } else {
            Billboard(p, dM * 0.5, vec3(0.0), u_Alpha * edge, q);
        }
        return;
    }

    // ---- the splashes ----
    Splash s = splashes[gl_InstanceID];
    float life = s.VelLife.w, age = s.PosAge.w;
    if (age >= life || life <= 0.0) { Cull(); return; }
    int kind = int(s.Info.x + 0.5);
    float dM = s.Info.y * 0.001;
    vec3 p = s.PosAge.xyz;
    v_Light = s.Light.rgb;
    v_Kind = 10 + kind;
    v_Age = age / life;
    v_Seed = s.Info.z;
    if (kind == 1) {
        // The crown: about ten drop diameters across and six high (a 2 mm
        // drop on a wet pavement throws one two centimetres wide).
        vec3 toCam = u_CameraPos - p;
        float dist = length(toCam);
        toCam /= max(dist, 1e-4);
        float pix = dist * u_PixelAngle;
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam) + vec3(1e-5, 0.0, 0.0));
        // Drawn half as big again as a real one: at a few metres a real crown is
        // three pixels, and the eye still catches it.
        float w = max(dM * 16.0, 2.0 * pix), h = max(dM * 10.0, 2.0 * pix);
        float coverage = max(min(1.0, dM * 16.0 / w) * min(1.0, dM * 10.0 / h), 0.3 * (1.0 - smoothstep(4.0, 16.0, dist)));
        vec3 pos = p + right * q.x * w + vec3(0.0, q.y * h, 0.0);
        gl_Position = u_ViewProj * vec4(pos, 1.0);
        v_Alpha = 0.9 * coverage * smoothstep(0.4, 1.4, dist);
    } else if (kind == 3) {
        float grow = mix(0.6, 1.6, v_Age);
        Billboard(p, dM * 0.5 * grow, vec3(0.0), 0.10 * (1.0 - v_Age), q);
    } else if (kind == 4) {
        Billboard(p, dM * 0.6, vec3(0.0), 0.9 * (1.0 - v_Age * 0.5), q);
    } else {
        // Droplets and the jet: streaks along their flight.
        Streak(p, s.VelLife.xyz, dM, dM, (kind == 5 ? 0.8 : 0.75) * (1.0 - v_Age * 0.6), q);
    }
}
