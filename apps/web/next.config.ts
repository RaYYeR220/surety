import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: `next build` writes a plain site to out/ for Vercel or any static host.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // Do not write AGENTS.md / CLAUDE.md into the app folder on dev start.
  agentRules: false,
};

export default nextConfig;
