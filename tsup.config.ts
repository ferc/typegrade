import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const define = { __TYPEGRADE_VERSION__: JSON.stringify(pkg.version) };

export default defineConfig([
  {
    banner: {
      js: "#!/usr/bin/env node",
    },
    clean: true,
    define,
    dts: false,
    entry: { bin: "src/bin.ts" },
    format: ["esm"],
    sourcemap: true,
    target: "node18",
  },
  {
    clean: false,
    define,
    dts: true,
    entry: { index: "src/index.ts" },
    format: ["esm"],
    sourcemap: true,
    target: "node18",
  },
]);
