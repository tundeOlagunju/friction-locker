import type { NextConfig } from "next";

const staticExport = process.env.FRICTION_STATIC_EXPORT === "true";
const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? "";
const basePath = configuredBasePath
  ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
  : "";

const nextConfig: NextConfig = {
  output: staticExport ? "export" : undefined,
  trailingSlash: staticExport,
  basePath: basePath || undefined,
  images: {
    unoptimized: staticExport,
  },
};

export default nextConfig;
