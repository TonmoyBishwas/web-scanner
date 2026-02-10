import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
