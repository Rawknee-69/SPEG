import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@speg/marketing...'",
  buildCommand: "vp run --filter @speg/marketing build",
  outputDirectory: "dist",
};
