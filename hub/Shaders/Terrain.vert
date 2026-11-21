#version 460 core

// =============================================================================
//  THE GROUND, LIFTED FROM ITS HEIGHTS ON THE GPU.
//
//  One small grid (32 x 32 quads, plus a skirt) is drawn for every piece of the
//  terrain the quadtree picks, at whatever spacing that piece's distance needs.
//  Its height is read here from the SAME numbers the CPU, the physics and the
//  save file hold (a R32F texture of TerrainComponent::Heights), at exact
//  samples - so sculpting uploads a rectangle of floats and rebuilds nothing,
//  and a character standing on the ground stands on what is drawn.
//
//  Used by the depth passes and the lit pass alike, and `invariant`, so the lit
//  pass's LEQUAL test finds exactly the depth the prepass wrote.
// =============================================================================

layout(location = 0) in vec3 a_Position;   // x, z: 0..1 across the piece; y: 1 on the skirt

uniform mat4  u_ViewProjection;
uniform vec3  u_Origin;       // world position of sample (0, 0)
uniform float u_CellSize;     // metres between samples
uniform vec3  u_Node;         // first sample x, z; samples across
uniform float u_Skirt;        // metres the skirt hangs below the edge
uniform sampler2D u_Height;

out vec3 v_WorldPos;
out vec2 v_Cell;              // position in samples, for the fragment's lookups

invariant gl_Position;

void main() {
    vec2 cell = u_Node.xy + a_Position.xz * u_Node.z;
    // Every vertex of every level lands on a real sample: the pieces are whole
    // powers of two in size and 32 quads across.
    float h = texelFetch(u_Height, ivec2(round(cell)), 0).r;
    // ⚠️ A SKIRT, BECAUSE NEIGHBOURS AT DIFFERENT DETAIL DO NOT SHARE AN EDGE.
    // A coarse piece's edge skips the samples its fine neighbour bends through,
    // and the difference is a crack you can see the sky through. The skirt hangs
    // a curtain from every edge, deep enough to fill any such crack.
    vec3 p = u_Origin + vec3(cell.x * u_CellSize, h - a_Position.y * u_Skirt, cell.y * u_CellSize);
    v_WorldPos = p;
    v_Cell = cell;
    gl_Position = u_ViewProjection * vec4(p, 1.0);
}
