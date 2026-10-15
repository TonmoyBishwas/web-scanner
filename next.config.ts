import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Inlined at build time into the page AND the API routes, so both always
  // read the same print-gate setting (lib/label-gate.ts labelPrintGateEnabled).
  // Default off (client request (d), 2026-10-15). A change needs a redeploy.
  env: {
    LABEL_PRINT_GATE: process.env.LABEL_PRINT_GATE ?? 'off',
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          },
          {
            key: 'Pragma',
            value: 'no-cache',
          },
          {
            key: 'Expires',
            value: '0',
          },
        ],
      },
    ];
  },
  webpack: (config) => {
    // Ensure WASM files are properly handled
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    // Add rule for .wasm files
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'webassembly/async',
    });
    return config;
  },
};

export default nextConfig;
