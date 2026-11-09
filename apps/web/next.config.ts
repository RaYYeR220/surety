import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: `next build` writes a plain site to out/ for Vercel or any static host.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // Keep the app folder free of generated rule files on dev start.
  agentRules: false,
  // Mezo Passport's wallet connectors ship TypeScript sources (and import them by path), so they are compiled here.
  // They only ever load in the wallet dialog's own chunk.
  transpilePackages: [
    "@mezo-org/passport",
    "@mezo-org/orangekit",
    "@mezo-org/orangekit-smart-account",
    "@mezo-org/orangekit-contracts",
  ],
};

export default nextConfig;
