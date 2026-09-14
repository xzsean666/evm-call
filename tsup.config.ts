import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  outDir: "dist",
  platform: "node",
  target: "node22",
  treeshake: true,
  minify: false,
  external: ["axios", "zod", "node:sqlite"],
});
