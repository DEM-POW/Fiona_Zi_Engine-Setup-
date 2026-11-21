#version 460 core
// ============================================================================
//  A LIGHTNING CHANNEL (Weather/Lightning): one segment an instance
//
//  The channel comes as pairs of points; w is how thick that part is (1 the
//  main stroke, less for its branches). The glowing channel is a few metres
//  across; kilometres away that is under a pixel, so it is drawn three pixels
//  wide at least with its light spread to match.
// ============================================================================

uniform mat4  u_ViewProj;
uniform vec3  u_CameraPos;
uniform float u_PixelAngle;     // radians per pixel, vertically
uniform vec4  u_Bolt[256];

out vec2  v_UV;
out float v_Alpha;

void main() {
    int corner = gl_VertexID;                    // triangle strip: 0 1 2 3
    vec2 q = vec2((corner & 1) == 0 ? -1.0 : 1.0, (corner & 2) == 0 ? 0.0 : 1.0);
    vec4 a4 = u_Bolt[2 * gl_InstanceID], b4 = u_Bolt[2 * gl_InstanceID + 1];
    vec3 axis = b4.xyz - a4.xyz;
    float segLen = length(axis);
    axis /= max(segLen, 1e-4);
    vec3 mid = 0.5 * (a4.xyz + b4.xyz);
    float dist = length(u_CameraPos - mid);
    vec3 toCam = (u_CameraPos - mid) / max(dist, 1e-4);
    vec3 side = normalize(cross(axis, toCam) + vec3(1e-5, 0.0, 0.0));
    const float core = 3.0;
    float width = max(core, 3.0 * dist * u_PixelAngle);
    // Each segment overlaps the next by half its width, so the joints of a
    // jagged channel do not open into gaps.
    vec3 pos = mix(a4.xyz - axis * width * 0.5, b4.xyz + axis * width * 0.5, q.y) + side * q.x * width * 0.5;
    gl_Position = u_ViewProj * vec4(pos, 1.0);
    // ⚠️ KILOMETRES OUT, BEYOND THE FAR PLANE. A strike eight kilometres away
    // is past where the camera clips, so it is held just inside it - in front
    // of the sky and the clouds (it is under their base), behind everything
    // the scene drew.
    if (gl_Position.w > 0.0) gl_Position.z = min(gl_Position.z, gl_Position.w * 0.99999);
    v_UV = q;
    v_Alpha = a4.w * min(1.0, core / width);     // w: a branch is dimmer, not narrower
}
