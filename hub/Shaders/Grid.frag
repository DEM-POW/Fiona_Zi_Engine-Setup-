#version 460 core

in vec3 v_NearPoint;
in vec3 v_FarPoint;

out vec4 FragColor;

uniform mat4  u_ViewProj;
uniform vec3  u_CameraPos;

uniform float u_Spacing;     // base cell size in metres (the finest level)
uniform vec3  u_ColorThin;   // ordinary cell lines
uniform vec3  u_ColorThick;  // every 10th line
uniform vec3  u_AxisXColor;  // the world X axis (the line where z == 0)
uniform vec3  u_AxisZColor;  // the world Z axis (the line where x == 0)
uniform float u_Opacity;
uniform float u_FadeRange;   // how far the grid reaches, in "camera heights"
uniform float u_DepthBias;   // tiny pull toward the camera (see below)
uniform int   u_ShowAxes;

// Coverage of the grid lines of one cell size, ANTI-ALIASED by the pixel
// footprint. `fwidth(coord)` is how much the cell coordinate changes across one
// pixel, so dividing by it measures distance to a line in PIXELS — a line ends up
// one pixel wide whether you look straight down at it or along it at a grazing
// angle. That is what stops the dashes and the crawling in the old line grid.
float GridCoverage(vec2 wpos, float cell)
{
    vec2 coord = wpos / cell;
    vec2 dd    = fwidth(coord);
    vec2 g     = abs(fract(coord - 0.5) - 0.5) / max(dd, vec2(1e-8));
    return 1.0 - min(min(g.x, g.y), 1.0);
}

void main()
{
    // Intersect this pixel's view ray with the y = 0 plane. Rays that never reach
    // it (looking up, or the plane behind the camera) simply have no grid.
    float denom = v_FarPoint.y - v_NearPoint.y;
    if (abs(denom) < 1e-8) discard;
    float t = -v_NearPoint.y / denom;
    if (t <= 0.0 || t >= 1.0) discard;

    vec3 wp = v_NearPoint + t * (v_FarPoint - v_NearPoint);

    // ---- level of detail -------------------------------------------------
    // Pick the cell size from the pixel footprint so cells never get denser than
    // legible: far away the metre grid would alias into mush, so it hands over to
    // the 10 m grid, then the 100 m grid, continuously. `fade` is the crossover.
    // Clamped at both ends on purpose. Toward the horizon the ray runs almost
    // parallel to the plane, so the footprint explodes and an unclamped
    // pow(10, lod) would reach inf — and inf/NaN cell sizes make every pixel read
    // as "on a line", i.e. a solid glowing band at the vanishing line. The
    // distance fade below is what actually removes that region; this only keeps
    // the arithmetic finite.
    float px  = max(length(fwidth(wp.xz)), 1e-8);
    float lod = clamp(log(px * 14.0 / u_Spacing) / log(10.0), 0.0, 10.0);
    float fade = fract(lod);

    float cell0 = u_Spacing * pow(10.0, floor(lod));   // finest visible level
    float cell1 = cell0 * 10.0;
    float cell2 = cell1 * 10.0;

    float g0 = GridCoverage(wp.xz, cell0);
    float g1 = GridCoverage(wp.xz, cell1);
    float g2 = GridCoverage(wp.xz, cell2);

    // The finest level dissolves as it becomes too dense (1 - fade); the two
    // coarser ones carry the structure and read as the "major" lines.
    float aFine   = g0 * (1.0 - fade) * 0.55;
    float aMedium = g1 * 0.85;
    float aCoarse = g2;
    float alpha   = max(max(aFine, aMedium), aCoarse);

    vec3 color = mix(u_ColorThin, u_ColorThick, clamp(aCoarse, 0.0, 1.0));

    // ---- world axes ------------------------------------------------------
    // Measured in pixels for the same reason as the lines, so the axes stay
    // crisp and single-pixel at any angle.
    if (u_ShowAxes != 0) {
        float ax = abs(wp.x) / max(fwidth(wp.x), 1e-8);
        float az = abs(wp.z) / max(fwidth(wp.z), 1e-8);
        if (az < 1.0) { color = u_AxisXColor; alpha = max(alpha, 1.0 - az); }
        if (ax < 1.0) { color = u_AxisZColor; alpha = max(alpha, 1.0 - ax); }
    }

    // ---- distance fade ---------------------------------------------------
    // Scaled by how high the camera is, so the grid always covers the view: up
    // close you get a tight metre grid, from far above it stretches to the
    // horizon instead of stopping at an arbitrary edge. The fade also kills the
    // pixel-thin moire that any grid turns into at the vanishing line.
    float reach = u_FadeRange * max(abs(u_CameraPos.y), 1.0);
    float dist  = length(wp - u_CameraPos);
    alpha *= 1.0 - smoothstep(reach * 0.35, reach, dist);

    // ⚠️ THE GRID IS A FLOOR, AND A FLOOR SEEN FROM UNDERNEATH IS JUST A LID.
    // Drop the camera below y = 0 - which happens constantly while sculpting
    // terrain, and any time the orbit pivot is at the origin - and the plane
    // fills the upper half of the view instead of the lower one, so the whole
    // SKY is behind a converging lattice of lines. It was reported as "the sky
    // has streaks in it", and it is the one thing in the frame that has nothing
    // to do with the sky.
    //
    // The lines also become far more visible against a bright sky than against
    // the ground they belong to: measured on the same view, the grid's contrast
    // against the physically-computed sky is 1.888/255 against a background of
    // 136, and 1.282 against 122 with the atmosphere switched off. The grid did
    // not change - the thing behind it got brighter.
    //
    // A metre of slack, so a camera resting exactly on the plane while working
    // on ground at y = 0 still sees it.
    alpha *= smoothstep(-1.0, 0.5, u_CameraPos.y);

    alpha *= u_Opacity;
    if (alpha <= 0.001) discard;

    // Real depth, so scene geometry occludes the grid correctly (and the grid
    // occludes nothing — depth writes are off on this pass).
    //
    // The bias matters: a level almost always has a ground plane sitting at
    // exactly y = 0, and two coplanar surfaces z-fight — which shows up as lines
    // that break into dashes and flicker as the camera moves, the very artefact
    // this grid exists to remove. Pulling the grid a hair toward the camera makes
    // it win that tie consistently instead of shimmering. It stays far below the
    // depth of anything genuinely in front of the floor.
    vec4 clip = u_ViewProj * vec4(wp, 1.0);
    gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5 - u_DepthBias, 0.0, 1.0);

    FragColor = vec4(color, alpha);
}
