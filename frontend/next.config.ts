import type { NextConfig } from 'next';

const config: NextConfig = {
  // The frontend is a standalone project, so its own folder is the root.
  turbopack: { root: __dirname },
  poweredByHeader: false,
};

export default config;
