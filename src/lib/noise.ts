import type { Rng } from "./random";

export interface Noise2D {
  /** Value noise in [0, 1]. */
  (x: number, y: number): number;
  /** Fractal Brownian motion in [0, 1]. */
  fbm(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number;
}

/** Cheap seeded 2D value noise with smooth interpolation. */
export function makeNoise(rng: Rng): Noise2D {
  const SIZE = 256;
  const MASK = SIZE - 1;
  const perm = new Uint8Array(SIZE * 2);
  const values = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    perm[i] = i;
    values[i] = rng();
  }
  for (let i = SIZE - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < SIZE; i++) perm[i + SIZE] = perm[i];

  const lattice = (ix: number, iy: number) => values[perm[(perm[ix & MASK] + iy) & MASK]];
  const fade = (t: number) => t * t * (3 - 2 * t);

  const noise = ((x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const a = lattice(x0, y0);
    const b = lattice(x0 + 1, y0);
    const c = lattice(x0, y0 + 1);
    const d = lattice(x0 + 1, y0 + 1);
    const top = a + (b - a) * fx;
    const bottom = c + (d - c) * fx;
    return top + (bottom - top) * fy;
  }) as Noise2D;

  noise.fbm = (x, y, octaves = 4, lacunarity = 2, gain = 0.5) => {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise(x, y) * amp;
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
    }
    return sum / norm;
  };

  return noise;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
