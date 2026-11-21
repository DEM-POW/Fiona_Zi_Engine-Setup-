// =============================================================================
//  ONE BAD PIXEL MUST NOT BECOME A SQUARE, OR STAY FOR EVER.
//
//  A NaN (0/0, a normalize of nothing) or an Inf (a highlight past what a half
//  float holds) in one pixel is invisible on its own. Bloom blurs it into a
//  black or white square the size of its widest level; a pass that keeps its
//  last frame (clouds, reflections, the sun's visibility) mixes it into its
//  history and never lets it go. clamp() and max() do not catch it: what they
//  do with a NaN is undefined in GLSL.
//
//  NaN is found by its bits, not by isnan(): a driver allowed to assume there
//  are no NaNs may fold isnan() to false. It becomes 0; an Inf becomes the
//  largest half float, so the sun's glint stays bright instead of going black.
//  Nothing changes where every value is finite. Docs: docs/RENDER-PLAN.md R0.
// =============================================================================
#ifndef FZE_FINITE_GLSL
#define FZE_FINITE_GLSL

bool  FZE_IsNaN(float x) { return (floatBitsToUint(x) & 0x7fffffffu) > 0x7f800000u; }
float FZE_Finite(float x) { return FZE_IsNaN(x) ? 0.0 : clamp(x, -65000.0, 65000.0); }
vec3  FZE_Finite(vec3 c)  { return vec3(FZE_Finite(c.x), FZE_Finite(c.y), FZE_Finite(c.z)); }
vec4  FZE_Finite(vec4 c)  { return vec4(FZE_Finite(c.x), FZE_Finite(c.y), FZE_Finite(c.z), FZE_Finite(c.w)); }

#endif
