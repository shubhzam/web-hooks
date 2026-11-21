import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // self contained server for the docker image
  output: "standalone",
  // trace from the monorepo root so packages/shared is included
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
};

export default nextConfig;