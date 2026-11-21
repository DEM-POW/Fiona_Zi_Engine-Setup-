#ifndef FZE_SURFACE_DETAIL_GLSL
#define FZE_SURFACE_DETAIL_GLSL
// =============================================================================
//  WHERE A MATERIAL'S MAPS ARE READ, AND HOW DEEP THEY LOOK
//  (Renderer/MaterialDetail.h; bound by Renderer::BindMaterial).
//
//  Every distance here is in METRES - the tile a texture covers, the depth of
//  its relief, where the parallax and the detail fade - because UV units mean
//  something different on every mesh: the same ground set on a 40 m box was one
//  copy stretched over forty metres with two metres of parallax.
//
//  Mapping:
//    0  the mesh's UVs x Tiling (as before)
//    1  world, along the face's dominant axis (as WorldUV was)
//    2  triplanar: three world projections blended by the normal
//
//  ⚠️ EVERY READ INSIDE A BRANCH TAKES ITS OWN GRADIENTS. A triplanar read
//  skips a projection whose weight is near zero, and a parallax march stops
//  when it hits; an implicit-derivative texture() inside either is undefined,
//  so the gradients are taken once, up front, where control flow is uniform.
// =============================================================================

uniform int   u_MatQuality;       // 0 Low, 1 Medium, 2 High, 3 Ultra
uniform int   u_Mapping;
uniform float u_TileSize;         // metres a copy covers (world/triplanar); 0 = 1 / Tiling
uniform float u_TriSharpness;
uniform float u_ReliefDepth;      // metres; 0 = the legacy u_HeightScale, in UV units
uniform int   u_Parallax;
uniform int   u_ParallaxSteps;
uniform vec2  u_ParallaxFade;     // metres from the camera: starts to flatten, gone
uniform int   u_ParallaxShadows;
uniform float u_Variation;
uniform float u_Breakup;

uniform sampler2D u_DetailAlbedoMap;
uniform int       u_HasDetailAlbedo;
uniform sampler2D u_DetailNormalMap;
uniform int       u_HasDetailNormal;
uniform float     u_MatDetailTile;
uniform float     u_MatDetailStrength;
uniform float     u_MatDetailFade;

uniform sampler2D u_OpacityMap;
uniform int       u_HasOpacityMap;

uniform int       u_Cover;
uniform sampler2D u_CoverAlbedoMap;
uniform int       u_HasCoverAlbedo;
uniform sampler2D u_CoverNormalMap;
uniform int       u_HasCoverNormal;
uniform vec3      u_CoverColor;       // sRGB
uniform float     u_CoverRoughness;
uniform float     u_CoverTile;
uniform float     u_CoverAmount;
uniform float     u_CoverSlope;
uniform float     u_CoverNoise;
uniform float     u_CoverNoiseSize;
uniform float     u_CoverHeightBias;

struct FZEMapCoords {
    int   mode;          // 0 one projection (mesh or world), 2 triplanar
    vec2  uv;            // the one projection (triplanar: its dominant one)
    vec4  g;             // d(uv)/dx, d(uv)/dy
    vec2  uvX, uvY, uvZ; // triplanar
    vec4  gX, gY, gZ;
    vec3  w;             // triplanar weights, summing to 1
    vec2  planeP;        // world metres in the dominant plane: where the noise lives
    float metresPerUV;   // how many metres one UV unit spans here
};

// ---- noise: value noise on a hash, cheap and fixed to the world ---------------
float FZE_DHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float FZE_DNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(FZE_DHash(i), FZE_DHash(i + vec2(1.0, 0.0)), u.x),
               mix(FZE_DHash(i + vec2(0.0, 1.0)), FZE_DHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float FZE_DFbm(vec2 p) {
    return 0.5 * FZE_DNoise(p) + 0.3 * FZE_DNoise(p * 2.03 + 7.1) + 0.2 * FZE_DNoise(p * 4.11 + 3.3);
}

vec4 FZE_Grad(vec2 uv) { return vec4(dFdx(uv), dFdy(uv)); }

FZEMapCoords FZE_MapCoords(vec2 meshUV, vec3 P, vec3 Ngeo) {
    FZEMapCoords c;
    vec3 an = abs(Ngeo);
    const vec2 zero2 = vec2(0.0);
    vec2 s = u_TileSize > 0.0 ? vec2(1.0 / u_TileSize) : u_UVScale;
    float tile = u_TileSize > 0.0 ? u_TileSize : 1.0 / max(u_UVScale.x, 1e-4);
    bool yDom = an.y >= an.x && an.y >= an.z;
    bool xDom = !yDom && an.x >= an.z;
    c.planeP = yDom ? P.xz : (xDom ? P.zy : P.xy);
    c.w = vec3(0.0);
    c.uvX = c.uvY = c.uvZ = zero2;
    c.gX = c.gY = c.gZ = vec4(0.0);
    if (u_Mapping == 2) {
        c.mode = 2;
        // Mirrored on the negative faces, or their text and their normals
        // would read backwards (Golus, "Normal Mapping for a Triplanar Shader").
        vec3 sgn = vec3(Ngeo.x < 0.0 ? -1.0 : 1.0, Ngeo.y < 0.0 ? -1.0 : 1.0, Ngeo.z < 0.0 ? -1.0 : 1.0);
        c.uvX = P.zy * s + u_UVOffset; c.uvX.x *= sgn.x;
        c.uvY = P.xz * s + u_UVOffset; c.uvY.x *= sgn.y;
        c.uvZ = P.xy * s + u_UVOffset; c.uvZ.x *= -sgn.z;
        c.gX = FZE_Grad(c.uvX); c.gY = FZE_Grad(c.uvY); c.gZ = FZE_Grad(c.uvZ);
        vec3 w = pow(an, vec3(max(u_TriSharpness, 1.0)));
        c.w = w / max(w.x + w.y + w.z, 1e-5);
        c.uv = yDom ? c.uvY : (xDom ? c.uvX : c.uvZ);
        c.g  = yDom ? c.gY  : (xDom ? c.gX  : c.gZ);
        c.metresPerUV = tile;
        // A floor or a wall faces one axis: read it from that side alone. One
        // sample instead of three, and the relief (parallax) works there.
        if (max(c.w.x, max(c.w.y, c.w.z)) > 0.995) c.mode = 0;
    } else if (u_Mapping == 1) {
        c.mode = 0;
        c.uv = c.planeP * s + u_UVOffset;
        c.g = FZE_Grad(c.uv);
        c.metresPerUV = tile;
    } else {
        c.mode = 0;
        c.uv = meshUV * u_UVScale + u_UVOffset;
        c.g = FZE_Grad(c.uv);
        // Metres per UV unit, from how fast each changes across the pixel.
        float dp = length(dFdx(P)) + length(dFdy(P));
        float du = length(c.g.xy) + length(c.g.zw);
        c.metresPerUV = dp / max(du, 1e-7);
    }
    return c;
}

// ---- breaking up the repeat: a second copy, turned and larger, by noise ------
const mat2 FZE_BreakRot = mat2(0.7986, 0.6018, -0.6018, 0.7986);   // 37 degrees
const float FZE_BreakScale = 0.41;
float FZE_BreakMask(FZEMapCoords c) {
    if (u_Breakup <= 0.001 || c.mode == 2) return 0.0;
    float tile = max(c.metresPerUV, 1e-3);
    return smoothstep(0.30, 0.70, FZE_DFbm(c.planeP / (tile * 2.7))) * u_Breakup;
}
vec2 FZE_BreakUV(vec2 uv) { return FZE_BreakRot * uv * FZE_BreakScale + vec2(0.37, 0.71); }
vec4 FZE_BreakG(vec4 g)  { return vec4(FZE_BreakRot * g.xy, FZE_BreakRot * g.zw) * FZE_BreakScale; }

// One map, read where the coordinates say.
vec4 FZE_Sample(sampler2D t, FZEMapCoords c) {
    if (c.mode == 2) {
        vec4 r = vec4(0.0);
        float ws = 0.0;
        if (c.w.x > 0.01) { r += textureGrad(t, c.uvX, c.gX.xy, c.gX.zw) * c.w.x; ws += c.w.x; }
        if (c.w.y > 0.01) { r += textureGrad(t, c.uvY, c.gY.xy, c.gY.zw) * c.w.y; ws += c.w.y; }
        if (c.w.z > 0.01) { r += textureGrad(t, c.uvZ, c.gZ.xy, c.gZ.zw) * c.w.z; ws += c.w.z; }
        return r / max(ws, 1e-4);
    }
    vec4 a = textureGrad(t, c.uv, c.g.xy, c.g.zw);
    float m = FZE_BreakMask(c);
    if (m > 0.001) {
        vec4 g2 = FZE_BreakG(c.g);
        a = mix(a, textureGrad(t, FZE_BreakUV(c.uv), g2.xy, g2.zw), m);
    }
    return a;
}

// A tangent-space normal for the single projection, in ITS frame: the turned
// copy's normals are turned back before they are blended.
vec3 FZE_UnpackNormal(vec3 t, int flipY) {
    if (flipY == 1) t.g = 1.0 - t.g;
    return t * 2.0 - 1.0;
}
vec3 FZE_SampleNormalTS(sampler2D t, FZEMapCoords c, int flipY) {
    vec3 n = FZE_UnpackNormal(textureGrad(t, c.uv, c.g.xy, c.g.zw).rgb, flipY);
    float m = FZE_BreakMask(c);
    if (m > 0.001) {
        vec4 g2 = FZE_BreakG(c.g);
        vec3 n2 = FZE_UnpackNormal(textureGrad(t, FZE_BreakUV(c.uv), g2.xy, g2.zw).rgb, flipY);
        n2.xy = transpose(FZE_BreakRot) * n2.xy;
        n = mix(n, n2, m);
    }
    return n;
}

// Triplanar normals, world space: each projection's tangent normal swizzled
// into the world and "whiteout"-blended with the surface normal (Golus).
// `lenOut` is the filtered normal's length (the Toksvig term's input).
vec3 FZE_TriplanarNormal(sampler2D t, FZEMapCoords c, vec3 N, int flipY, float strength, out float lenOut) {
    vec3 sgn = vec3(N.x < 0.0 ? -1.0 : 1.0, N.y < 0.0 ? -1.0 : 1.0, N.z < 0.0 ? -1.0 : 1.0);
    vec3 tx = FZE_UnpackNormal(textureGrad(t, c.uvX, c.gX.xy, c.gX.zw).rgb, flipY);
    vec3 ty = FZE_UnpackNormal(textureGrad(t, c.uvY, c.gY.xy, c.gY.zw).rgb, flipY);
    vec3 tz = FZE_UnpackNormal(textureGrad(t, c.uvZ, c.gZ.xy, c.gZ.zw).rgb, flipY);
    lenOut = clamp(length(tx) * c.w.x + length(ty) * c.w.y + length(tz) * c.w.z, 1e-3, 1.0);
    tx.xy *= strength; ty.xy *= strength; tz.xy *= strength;
    tx.x *= sgn.x; ty.x *= sgn.y; tz.x *= -sgn.z;
    tx = vec3(tx.xy + N.zy, abs(tx.z) * N.x);
    ty = vec3(ty.xy + N.xz, abs(ty.z) * N.y);
    tz = vec3(tz.xy + N.xy, abs(tz.z) * N.z);
    return normalize(tx.zyx * c.w.x + ty.xzy * c.w.y + tz.xyz * c.w.z);
}

// ---- relief ------------------------------------------------------------------
// The height map's full range, in this projection's UV units.
float FZE_ReliefUV(FZEMapCoords c) {
    return u_ReliefDepth > 0.0 ? u_ReliefDepth / max(c.metresPerUV, 1e-4) : u_HeightScale;
}
float FZE_ReliefAt(vec2 uv, vec4 g) { return 1.0 - textureGrad(u_HeightMap, uv, g.xy, g.zw).r; }

// Parallax occlusion, in metres, fading with distance and at grazing views
// (where it smears rather than deepens). `depthOut` is how far down it hit,
// 0..1, for the self-shadow.
vec2 FZE_ParallaxUV(FZEMapCoords c, mat3 TBN, vec3 V, float depthUV, float camDist, out float depthOut) {
    depthOut = 0.0;
    vec3 Vt = normalize(transpose(TBN) * V);
    float fade = (1.0 - smoothstep(u_ParallaxFade.x, u_ParallaxFade.y, camDist))
               * smoothstep(0.05, 0.25, Vt.z);
    if (fade < 0.01 || Vt.z <= 0.02) return c.uv;
    float steps = mix(float(u_ParallaxSteps), max(float(u_ParallaxSteps) * 0.35, 4.0), clamp(Vt.z, 0.0, 1.0));
    float layer = 1.0 / steps;
    vec2 shift = (Vt.xy / Vt.z) * depthUV * fade;
    vec2 cur = c.uv;
    float curDepth = 0.0;
    float curH = FZE_ReliefAt(cur, c.g);
    for (int i = 0; i < 96 && curDepth < curH; ++i) {
        if (float(i) >= steps) break;
        cur -= shift * layer;
        curDepth += layer;
        curH = FZE_ReliefAt(cur, c.g);
    }
    vec2 prev = cur + shift * layer;
    float aft = curH - curDepth;
    float bef = FZE_ReliefAt(prev, c.g) - (curDepth - layer);
    float t = clamp(bef / max(bef - aft, 1e-5), 0.0, 1.0);
    depthOut = (curDepth - (1.0 - t) * layer) * fade;
    return mix(prev, cur, t);
}

// The relief's shadow from the sun: climb from the hit toward the light.
float FZE_ParallaxShadow(FZEMapCoords c, mat3 TBN, float depth, vec3 L, float depthUV) {
    if (u_ParallaxShadows == 0 || depth <= 0.001) return 1.0;
    vec3 Lt = normalize(transpose(TBN) * L);
    if (Lt.z <= 0.05) return 1.0;
    const float steps = 12.0;
    float layer = depth / steps;
    vec2 shift = (Lt.xy / Lt.z) * depthUV * (depth / steps);
    vec2 cur = c.uv;
    float curDepth = depth;
    float shade = 0.0;
    for (int i = 0; i < 12 && curDepth > 0.0; ++i) {
        cur += shift;
        curDepth -= layer;
        float h = FZE_ReliefAt(cur, c.g);
        shade = max(shade, (curDepth - h) * (1.0 - float(i) / steps));
    }
    return 1.0 - clamp(shade * 6.0, 0.0, 0.75);   // never fully black: light bleeds
}

// ---- detail: finer texture up close ------------------------------------------
void FZE_ApplyDetail(inout vec3 albedo, inout vec3 N, FZEMapCoords c, float camDist) {
    if (u_MatDetailStrength <= 0.0 || (u_HasDetailAlbedo == 0 && u_HasDetailNormal == 0)) return;
    float k = c.metresPerUV / max(u_MatDetailTile, 1e-4);
    vec2 duv = c.uv * k;
    vec4 dg = c.g * k;
    float fade = (1.0 - smoothstep(u_MatDetailFade * 0.5, u_MatDetailFade, camDist)) * u_MatDetailStrength;
    if (fade <= 0.001) return;
    if (u_HasDetailAlbedo == 1) {
        // Overlaid: a mid-grey (0.5) detail texel changes nothing.
        vec3 d = textureGrad(u_DetailAlbedoMap, duv, dg.xy, dg.zw).rgb * 2.0;
        albedo *= mix(vec3(1.0), pow(max(d, 0.0), vec3(2.2)), fade);
    }
    if (u_HasDetailNormal == 1) {
        vec3 tn = textureGrad(u_DetailNormalMap, duv, dg.xy, dg.zw).rgb * 2.0 - 1.0;
        tn.xy *= fade;
        N = PerturbNormal(N, duv, normalize(tn));
    }
}

// ---- variation: broad patches, so a large surface is not one flat print ------
void FZE_ApplyVariation(inout vec3 albedo, FZEMapCoords c) {
    if (u_Variation <= 0.001) return;
    float tile = max(c.metresPerUV, 1e-3);
    float v = FZE_DFbm(c.planeP / (tile * 5.3));
    float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 tinted = mix(vec3(lum), albedo, 1.0 + (v - 0.5) * 0.6);       // a little more or less colour
    albedo = mix(albedo, tinted * (0.7 + 0.6 * v), u_Variation);        // and brighter or darker
}

// ---- cover: snow, dust, moss laid over the base --------------------------------
// On faces flat enough to hold it (Slope), patchy at its edge (Noise), and in
// the hollows or on the peaks of the relief (HeightBias). It hides the base's
// relief where it lies.
void FZE_ApplyCover(inout vec3 albedo, inout float roughness, inout float metallic, inout vec3 N,
                    FZEMapCoords c, vec3 Ngeo, float height01) {
    if (u_Cover == 0) return;
    float slope = mix(Ngeo.y, N.y, 0.5);
    float slopeMask = smoothstep(1.0 - u_CoverSlope - 0.12, 1.0 - u_CoverSlope + 0.08, slope);
    if (slopeMask <= 0.001) return;
    float n = FZE_DFbm(c.planeP / max(u_CoverNoiseSize, 0.01)) - 0.5;
    float h = height01 - 0.5;
    float amount = u_CoverAmount * 2.0 - 1.0 + n * u_CoverNoise * 1.6 + h * u_CoverHeightBias * 1.4;
    float m = smoothstep(-0.07, 0.07, amount) * slopeMask;
    if (m <= 0.001) return;
    float k = c.metresPerUV / max(u_CoverTile, 1e-4);
    vec2 cuv = c.uv * k;
    vec4 cg = c.g * k;
    vec3 col = pow(max(u_CoverColor, 0.0), vec3(2.2));
    if (u_HasCoverAlbedo == 1) col *= pow(textureGrad(u_CoverAlbedoMap, cuv, cg.xy, cg.zw).rgb, vec3(2.2));
    albedo    = mix(albedo, col, m);
    roughness = mix(roughness, u_CoverRoughness, m);
    metallic  = mix(metallic, 0.0, m);
    N = normalize(mix(N, Ngeo, m * 0.85));
    if (u_HasCoverNormal == 1) {
        vec3 tn = textureGrad(u_CoverNormalMap, cuv, cg.xy, cg.zw).rgb * 2.0 - 1.0;
        tn.xy *= m;
        N = PerturbNormal(N, cuv, normalize(tn));
    }
}

#endif  // FZE_SURFACE_DETAIL_GLSL
