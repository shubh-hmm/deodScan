// Chart colours. Kept in a plain module (not a 'use client' file) so server components can read the real values.
// Series: categorical slots 1-3, validated with the dataviz validator against the dark navy surfaces (blue / orange / aqua).
export const SERIES = { in: '#3987e5', out: '#d95926', net: '#199e70' } as const;

// Share ramps for part-to-whole charts. Blue stays "inflow" and orange stays "outflow" everywhere on the dashboard, so an
// inflow share uses blue steps and an outflow share uses orange steps (both ramps validated: light -> dark, single hue).
export const RAMPS = {
  in: ['#3987e5', '#6da7ec', '#9ec5f4', '#c6dcf7'],
  out: ['#d95926', '#e8805a', '#f2b199', '#f8d6c6'],
} as const;
