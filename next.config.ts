import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Route handlers only; native / Node-only packages stay external.
  serverExternalPackages: ["sharp", "@prisma/adapter-neon", "@neondatabase/serverless", "ws"],
};

export default nextConfig;
