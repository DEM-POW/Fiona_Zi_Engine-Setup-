#version 460 core

// Simple hemispheric + key light shading. Enough to read a model's silhouette and
// form in a 128px thumbnail without dragging in the full PBR pipeline.

in vec3 v_Normal;
in vec2 v_TexCoord;

uniform vec3      u_BaseColor;
uniform sampler2D u_AlbedoMap;
uniform int       u_HasAlbedo;

out vec4 FragColor;

void main() {
    vec3 N = normalize(v_Normal);
    vec3 L = normalize(vec3(-0.45, 0.75, 0.5));      // key light, upper-front-left

    vec3 base = pow(max(u_BaseColor, 0.0), vec3(2.2));        // sRGB -> linear (see Lit.frag)
    if (u_HasAlbedo != 0) base *= texture(u_AlbedoMap, v_TexCoord).rgb;

    float key  = max(dot(N, L), 0.0);
    // Hemispheric ambient: cool from below, warm from above — gives shape to the
    // parts the key light misses instead of flat black.
    float hemi = N.y * 0.5 + 0.5;
    vec3  amb  = mix(vec3(0.16, 0.17, 0.20), vec3(0.42, 0.44, 0.48), hemi);

    vec3 color = base * (amb + key * 0.85);
    color = pow(color, vec3(1.0 / 2.2));             // to sRGB
    FragColor = vec4(color, 1.0);
}
