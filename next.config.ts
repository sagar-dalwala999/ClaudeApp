import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pg, pg-boss and sharp are CommonJS/native and must stay outside the bundle.
  serverExternalPackages: ["pg", "pg-boss", "sharp"],
};

export default nextConfig;
