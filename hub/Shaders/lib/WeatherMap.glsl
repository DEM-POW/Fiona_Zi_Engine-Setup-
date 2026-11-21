// ---------------------------------------------------------------
//  Fiona Zi Engine — the weather map, as every shader reads it
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//  Renderer/WeatherSurface's array texture: the world seen from straight
//  above round the camera. Layers u_WeatherLayers.x: the water on each texel
//  (r soak 0..1, g film 0..1, b standing mm, a snow mm); u_WeatherLayers.y:
//  the top surface there (r height - RefY in metres, g SurfaceType, a 1 if
//  anything is there). Shared by the surfaces (lib/Weather.glsl), the
//  falling particles and their splashes.
// ---------------------------------------------------------------
#ifndef FZE_WEATHERMAP_GLSL
#define FZE_WEATHERMAP_GLSL

uniform sampler2DArray u_WeatherMap;
uniform int   u_HasWeatherMap;
uniform vec4  u_WeatherRect;     // x, z of the map's corner, 1 / its size, the RefY its heights are from
uniform vec2  u_WeatherLayers;   // the water layer, the static layer
uniform float u_WeatherRes;      // texels across

vec2 FZE_WeatherUV(vec2 xz) { return (xz - u_WeatherRect.xy) * u_WeatherRect.z; }
bool FZE_WeatherInside(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0))); }
ivec2 FZE_WeatherTexel(vec2 uv) { return clamp(ivec2(uv * u_WeatherRes), ivec2(0), ivec2(int(u_WeatherRes) - 1)); }

vec4 FZE_WeatherStatic(vec2 uv) {
    return texelFetch(u_WeatherMap, ivec3(FZE_WeatherTexel(uv), int(u_WeatherLayers.y)), 0);
}
vec4 FZE_WeatherWater(vec2 uv) {
    return texelFetch(u_WeatherMap, ivec3(FZE_WeatherTexel(uv), int(u_WeatherLayers.x)), 0);
}

// The top surface's world height at uv, or very low where nothing is.
float FZE_WeatherTop(vec2 uv) {
    vec4 s = FZE_WeatherStatic(uv);
    return s.a > 0.5 ? s.r + u_WeatherRect.w : -1e9;
}

// Whether a ray from p toward `dir` (up and out: the sky, the sun) leaves the
// map's heights before anything is over it. 1 open, 0 blocked.
float FZE_WeatherOpen(vec3 p, vec3 dir) {
    if (u_HasWeatherMap == 0) return 1.0;
    const float kT[6] = float[](0.3, 0.9, 2.0, 4.0, 8.0, 16.0);
    for (int i = 0; i < 6; ++i) {
        vec3 q = p + dir * kT[i];
        vec2 uv = FZE_WeatherUV(q.xz);
        if (!FZE_WeatherInside(uv)) return 1.0;
        if (FZE_WeatherTop(uv) > q.y) return 0.0;
    }
    return 1.0;
}

#endif // FZE_WEATHERMAP_GLSL
