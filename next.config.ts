import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile Scandit SDK packages
  transpilePackages: ['@scandit/web-datacapture-barcode', '@scandit/web-datacapture-core'],
  // Use webpack instead of Turbopack for Scandit SDK compatibility
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
