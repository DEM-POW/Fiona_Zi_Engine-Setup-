#version 460 core

in vec3 v_Color;
out vec4 FragColor;

// The depth test, done here (DebugRenderer::BeginSceneDepth). The scene was
// drawn with TAA's sub-pixel jitter - a different half pixel in each of eight
// frames - and these lines are not. Tested by the hardware against that depth,
// a line lying on a slope passed in one frame and failed in the next: dashes
// that changed every frame, an 8-frame flicker over a mesh's whole wire.
//
// 1. The mesh the lines belong to decides its own hidden lines: it is drawn
//    again, unjittered, into u_MeshDepth (DebugRenderer::DrawMeshDepth) - the
//    same rasterisation as the lines, so the same answer in every frame, as with
//    no TAA. Half a pixel of the surface's slope is allowed for a line's pixel
//    lying off the line; the slope is the smaller one-sided step, so at an
//    outline it is the surface's own, not the jump to what lies behind.
// 2. Anything else in front, from the scene's jittered depth: the farthest of
//    the nine texels round the pixel, which covers every way the jitter moved
//    it. (Used alone it let the far side's edges through the mesh's outline in
//    some frames and not others - test 1 now settles those.)
uniform sampler2D u_SceneDepth;
uniform sampler2D u_MeshDepth;
uniform int  u_SceneTest;      // 1: tested here (the hardware test is off)
uniform vec2 u_DepthOrigin;    // the view's corner in the framebuffer

float DepthAt(sampler2D t, ivec2 p, ivec2 size)
{
    return texelFetch(t, clamp(p, ivec2(0), size - ivec2(1)), 0).r;
}

bool BehindScene()
{
    ivec2 size = textureSize(u_SceneDepth, 0);
    ivec2 p = ivec2(gl_FragCoord.xy - u_DepthOrigin);
    float z = gl_FragCoord.z;

    float d = DepthAt(u_MeshDepth, p, size);
    float gx = min(abs(DepthAt(u_MeshDepth, p + ivec2(1, 0), size) - d), abs(d - DepthAt(u_MeshDepth, p - ivec2(1, 0), size)));
    float gy = min(abs(DepthAt(u_MeshDepth, p + ivec2(0, 1), size) - d), abs(d - DepthAt(u_MeshDepth, p - ivec2(0, 1), size)));
    if (z > d + 0.5 * (gx + gy)) return true;

    float far = DepthAt(u_SceneDepth, p, size);
    far = max(far, DepthAt(u_SceneDepth, p + ivec2(-1, -1), size));
    far = max(far, DepthAt(u_SceneDepth, p + ivec2( 0, -1), size));
    far = max(far, DepthAt(u_SceneDepth, p + ivec2( 1, -1), size));
    far = max(far, DepthAt(u_SceneDepth, p + ivec2(-1,  0), size));
    far = max(far, DepthAt(u_SceneDepth, p + ivec2( 1,  0), size));
    far = max(far, DepthAt(u_SceneDepth, p + ivec2(-1,  1), size));
    far = max(far, DepthAt(u_SceneDepth, p + ivec2( 0,  1), size));
    far = max(far, DepthAt(u_SceneDepth, p + ivec2( 1,  1), size));
    return z > far;
}

void main()
{
    if (u_SceneTest == 1 && BehindScene()) discard;
    FragColor = vec4(v_Color, 1.0);
}
