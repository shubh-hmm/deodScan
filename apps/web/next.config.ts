import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const config: NextConfig = {
  // Monorepo root, so Turbopack resolves hoisted workspace dependencies.
  turbopack: { root: resolve(__dirname, '../..') },
  poweredByHeader: false,
};

export default config;
