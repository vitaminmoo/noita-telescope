// The cell kinds of a pixel scene's material map: what the alpha byte of each
// texel says the scene pixel IS. Written by buildSceneMaterialMap
// (pixel_scene_generation.js, in the overlay worker) and read by the scene
// material shader (gl/shaders.js), so both import them from here.
//   UNTOUCHED  alpha 0 / #000000 in the PNG: the world cell stays
//   AIR        FORCE AIR: the world cell is removed
//   DENSITY    gray/white under a biome with a band table: r is the biome's
//              band-table row; the shader runs the chooser at the cell's world
//              position (and may answer air)
//   MATERIAL   a material: r | g << 8 is its engine id; the shader samples its
//              texture at the cell's world position
//   COLOR      a plain opaque color in rgb: a wang color no material owns, air
//              a scene paints solid, a fill with no material
export const SCENE_CELL_UNTOUCHED = 0;
export const SCENE_CELL_AIR = 1;
export const SCENE_CELL_DENSITY = 2;
export const SCENE_CELL_MATERIAL = 3;
export const SCENE_CELL_COLOR = 4;
