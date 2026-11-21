#version 460 core

// ============================================================================
//  BOUNCE LIGHT, GATHERED ONCE PER HALF-PIXEL INSTEAD OF ONCE PER PIXEL
//
//  ⚠️ THIS WAS THE MOST EXPENSIVE THING IN THE FRAME AND NOTHING SAID SO. Turned
//  off, the town at midday goes from 21.54 ms of GPU to 16.79 - so cone-traced
//  bounce light was 4.75 ms, 22% of the frame, more than the sun's shadows, the
//  lamps' shadows, the occlusion, the clouds and the bloom PUT TOGETHER (3.1 ms
//  between them). It was being paid inside the lit shader, where a profiler
//  scope cannot see it, which is why three phases of tuning walked past it.
//
//  ⚠️ AND IT WAS BEING PAID AT FULL RESOLUTION FOR A QUANTITY THAT HAS NO DETAIL.
//  Six cones, each marching up to twelve times through a 64-cube volume whose
//  finest cell is a fraction of a metre - that is seventy-two 3D texture fetches
//  to answer "roughly how much light is bouncing around here", and the answer
//  changes over metres, not over pixels. Sampling it per screen pixel is spending
//  detail where there is none to find.
//
//  So it is gathered in its own pass at the same reduced size the occlusion
//  already uses, and the lit shader reads one texel of it. The upsample is the
//  sampler's bilinear filter, which is the right filter for a field this smooth.
//
//  What this cannot do is bounce light onto anything the depth prepass did not
//  draw - transparent surfaces, and anything off screen. Neither had it before:
//  the volume only holds what was voxelised, and glass was never lit by it.
// ============================================================================

in vec2 v_UV;
out vec3 FragColor;

uniform sampler2D u_Depth;
uniform sampler3D u_VoxelGI;
uniform mat4  u_InvVP;
uniform vec3  u_CameraPos;
uniform vec2  u_TexelSize;
uniform vec3  u_VolumeMin;
uniform vec3  u_VolumeSize;
uniform float u_GIStrength;

vec3 WorldFromDepth(vec2 uv, float d) {
    vec4 h = u_InvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return h.xyz / h.w;
}

// The cone march, unchanged from the lit shader it came out of: front to back
// through the volume's own mip chain, the cone's width choosing the level.
vec4 TraceCone(vec3 origin, vec3 dir, float aperture) {
    float voxel = 1.0 / 64.0;
    vec4 acc = vec4(0.0);
    // ⚠️ START A VOXEL OUT, OR THE SURFACE LIGHTS ITSELF. The cell this point
    // sits in holds its own outgoing light; sampling it would feed the surface
    // its own colour and every bright thing would glow.
    float dist = voxel * 2.0;
    const float kMaxDist = 0.9;

    for (int i = 0; i < 12 && dist < kMaxDist && acc.a < 0.95; ++i) {
        float diameter = max(voxel, 2.0 * aperture * dist);
        float level = clamp(log2(diameter / voxel), 0.0, 5.0);
        vec3 p = origin + dir * dist;
        if (any(lessThan(p, vec3(0.0))) || any(greaterThan(p, vec3(1.0)))) break;

        vec4 s4 = textureLod(u_VoxelGI, p, level);
        acc += (1.0 - acc.a) * vec4(s4.rgb * s4.a, s4.a);
        dist += diameter * 0.6;
    }
    return acc;
}

void main() {
    float d = texture(u_Depth, v_UV).r;
    if (d >= 1.0) { FragColor = vec3(0.0); return; }      // sky bounces nothing

    vec3 P = WorldFromDepth(v_UV, d);
    vec3 o = (P - u_VolumeMin) / max(u_VolumeSize, vec3(1e-4));
    if (any(lessThan(o, vec3(0.0))) || any(greaterThan(o, vec3(1.0)))) {
        FragColor = vec3(0.0);                            // outside the volume
        return;
    }

    // ⚠️ THE NORMAL COMES FROM THE CLOSER NEIGHBOUR ON EACH AXIS. Taking right
    // and top blindly straddles every silhouette, and a normal that points
    // somewhere absurd sends six cones off in the wrong directions - which shows
    // up as a bright or dark fringe tracing every object. Same trap, same fix,
    // as the occlusion and contact passes.
    vec2 tx = u_TexelSize;
    float dr = texture(u_Depth, v_UV + vec2(tx.x, 0.0)).r;
    float dl = texture(u_Depth, v_UV - vec2(tx.x, 0.0)).r;
    float du = texture(u_Depth, v_UV + vec2(0.0, tx.y)).r;
    float dd = texture(u_Depth, v_UV - vec2(0.0, tx.y)).r;
    vec3 ddx = abs(dr - d) < abs(dl - d)
             ? WorldFromDepth(v_UV + vec2(tx.x, 0.0), dr) - P
             : P - WorldFromDepth(v_UV - vec2(tx.x, 0.0), dl);
    vec3 ddy = abs(du - d) < abs(dd - d)
             ? WorldFromDepth(v_UV + vec2(0.0, tx.y), du) - P
             : P - WorldFromDepth(v_UV - vec2(0.0, tx.y), dd);
    vec3 N = normalize(cross(ddx, ddy));
    if (dot(N, normalize(u_CameraPos - P)) < 0.0) N = -N;

    // Six directions: straight out, and five around at 60 degrees - the standard
    // diffuse cone set, built from the normal so no tangent frame is needed.
    vec3 T = normalize(abs(N.y) > 0.95 ? cross(N, vec3(1, 0, 0)) : cross(N, vec3(0, 1, 0)));
    vec3 B = cross(N, T);

    vec3 sum = TraceCone(o, N, 0.577).rgb;
    const float kSide = 0.866;
    const float kUp   = 0.5;
    for (int i = 0; i < 5; ++i) {
        float a = 6.2831853 * float(i) / 5.0;
        vec3 dir = normalize(N * kUp + (T * cos(a) + B * sin(a)) * kSide);
        sum += TraceCone(o, dir, 0.577).rgb * kUp;
    }
    // Faded out over the last two cells before the box's edge, as the sky's
    // visibility is: a hard stop there was a line across the ground where the
    // bounce ended, and it travelled with the box.
    vec3 edge = min(o, 1.0 - o) * vec3(textureSize(u_VoxelGI, 0));
    float fade = clamp(min(edge.x, min(edge.y, edge.z)) * 0.5, 0.0, 1.0);
    FragColor = sum * (1.0 / (1.0 + 5.0 * kUp)) * u_GIStrength * fade;
}
