#version 460 core

// ============================================================================
//  TRANSMITTANCE LUT — how much of a beam survives the air.
//
//  256 x 64, one build when the atmosphere changes. Every other pass in the
//  system reads this instead of integrating extinction again, and the reason
//  that works is one identity:
//
//      T(A -> B) = T(A -> top) / T(B -> top)
//
//  so a single table indexed by (altitude, angle to the zenith) answers the
//  transmittance between ANY two points along a ray. That is the whole trick
//  that turns an atmosphere from a per-pixel ray march into a texture fetch.
//
//  40 steps: this runs once, not per frame, so there is no reason to be mean
//  with it - and the sun disc's colour at sunset is read straight off the
//  darkest, most curved corner of this table.
// ============================================================================

in vec2 v_UV;
out vec4 FragColor;

#include "lib/AtmosphereUniforms.glsl"

void main()
{
    FZEAtmosphere atmo = FZE_AtmosphereFromUniforms();
    float r, mu;
    FZE_TransmittanceFromUV(atmo, v_UV, r, mu);
    FragColor = vec4(FZE_ComputeTransmittanceToTop(atmo, r, mu, 40), 1.0);
}
