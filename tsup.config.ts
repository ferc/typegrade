import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const define = { __TYPEGRADE_VERSION__: JSON.stringify(pkg.version) };

const SHEBANG = "#!/usr/bin/env node\n";

export default defineConfig([
  {
    clean: true,
    define,
    dts: false,
    entry: { bin: "src/bin.ts" },
    external: ["commander", "picocolors", "ts-morph"],
    format: ["esm"],
    onSuccess: async () => {
      // Add shebang only to bin.js, strip from any chunks that got it
      const distDir = "dist";
      for (const file of readdirSync(distDir)) {
        if (!file.endsWith(".js")) {
          continue;
        }
        const filePath = join(distDir, file);
        const content = readFileSync(filePath, "utf8");
        if (file === "bin.js") {
          if (!content.startsWith("#!")) {
            writeFileSync(filePath, SHEBANG + content);
          }
        }
      }
    },
    sourcemap: true,
    splitting: true,
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
