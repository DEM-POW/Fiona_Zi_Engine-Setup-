#version 460 core
// ============================================================================
//  WHAT IS SOLID: THE SCENE'S SURFACES, MARKED IN A VOLUME
//
//  The first half of the sky's visibility (SkyVisibility.h). One axis of three:
//  each pass looks down one world axis, so a wall seen edge-on in one pass is
//  seen face-on in another and no surface is missed. A fragment marks the cell
//  its surface passes through - only the cell; how much of the sky that cell
//  hides is the cone march's question, read from this volume's mip chain.
//
//  Written with imageStore, no colour target: the rasteriser only supplies one
//  fragment per cell column at the volume's own resolution.
// ============================================================================

in vec3 v_WorldPos;
in vec3 v_Normal;

layout(r8, binding = 0) writeonly uniform image3D u_Occupancy;
uniform vec3  u_VolumeMin;
uniform vec3  u_VolumeSize;
uniform vec3  u_Dim;           // cells, as floats

void main() {
    vec3 uvw = (v_WorldPos - u_VolumeMin) / u_VolumeSize;
    if (any(lessThan(uvw, vec3(0.0))) || any(greaterThanEqual(uvw, vec3(1.0)))) discard;
    imageStore(u_Occupancy, ivec3(uvw * u_Dim), vec4(1.0));
}
