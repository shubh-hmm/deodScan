import type { NextConfig } from 'next';
import os from 'node:os';

// Development server only. Next.js blocks its dev resources for every address except localhost, and when they are blocked
// the interactive parts of a page (the charts) never load, while the plain parts still show. To make the dashboard work the
// same when it is opened by this computer's own network address (http://192.168.x.x:3000, for example from a phone), those
// addresses are allowed. Only this computer's own addresses are listed. It has no effect on a production build.
const ownAddresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((i): i is os.NetworkInterfaceInfo => Boolean(i) && i!.family === 'IPv4' && !i!.internal)
  .map((i) => i.address);

const config: NextConfig = {
  // The frontend is a standalone project, so its own folder is the root.
  turbopack: { root: __dirname },
  poweredByHeader: false,
  allowedDevOrigins: ownAddresses,
};

export default config;
