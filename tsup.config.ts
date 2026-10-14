import { readFile, writeFile } from "node:fs/promises";
import { defineConfig } from "tsup";

// esbuild drops module level directives, so "use client" is prepended to the
// React entry after the build. Shared code stays in common chunks, which keeps
// a single NemiError class across every subpath.
async function markReactEntryAsClient(): Promise<void> {
  for (const file of ["dist/react.js", "dist/react.cjs"]) {
    const code = await readFile(file, "utf8");
    if (!code.startsWith('"use client"')) {
      await writeFile(file, `"use client";\n${code}`);
    }
  }
}

export default defineConfig({
  entry: {
    index: "src/index.ts",
    browser: "src/browser.ts",
    server: "src/server.ts",
    react: "src/react.tsx",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  target: "es2020",
  treeshake: true,
  splitting: true,
  removeNodeProtocol: false,
  clean: true,
  outDir: "dist",
  external: ["react", "react/jsx-runtime", "node:crypto"],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
  onSuccess: markReactEntryAsClient,
});
