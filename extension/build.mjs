// Builds the Chrome extension into extension/dist. `--watch` rebuilds on change.
import * as esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const here = import.meta.dirname;
const root = path.resolve(here, "..");
const dist = path.join(here, "dist");
const watch = process.argv.includes("--watch");

const fonts = {
  "plex-condensed-400.woff2": "@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-400-normal.woff2",
  "plex-condensed-500.woff2": "@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-500-normal.woff2",
  "plex-condensed-600.woff2": "@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-600-normal.woff2",
  "plex-condensed-700.woff2": "@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-700-normal.woff2",
  "plex-mono-400.woff2": "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
  "plex-mono-500.woff2": "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
};

// A case-file tab: a solid rule beside two lines of text. Flat, palette only.
const icon = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="3" fill="#1F2124"/>
  <rect x="8" y="7" width="4" height="18" fill="#D9DCE0"/>
  <rect x="15" y="9" width="10" height="3" fill="#D9DCE0"/>
  <rect x="15" y="15" width="7" height="3" fill="#8A9099"/>
</svg>`;

async function copyStatic() {
  await fs.mkdir(path.join(dist, "fonts"), { recursive: true });
  await fs.mkdir(path.join(dist, "icons"), { recursive: true });
  await fs.copyFile(path.join(here, "manifest.json"), path.join(dist, "manifest.json"));
  for (const f of await fs.readdir(path.join(here, "static"))) {
    await fs.copyFile(path.join(here, "static", f), path.join(dist, f));
  }
  for (const [out, from] of Object.entries(fonts)) {
    await fs.copyFile(path.join(root, "node_modules", from), path.join(dist, "fonts", out));
  }
  for (const s of [16, 32, 48, 128]) {
    await sharp(Buffer.from(icon(s))).png().toFile(path.join(dist, "icons", `${s}.png`));
  }
}

const options = {
  entryPoints: {
    panel: path.join(here, "src/panel/main.tsx"),
    preview: path.join(here, "src/preview/main.tsx"),
    background: path.join(here, "src/background.ts"),
  },
  outdir: dist,
  bundle: true,
  // Classic scripts (not modules) so preview.html also opens straight from disk.
  format: "iife",
  target: "chrome116",
  jsx: "automatic",
  tsconfig: path.join(root, "tsconfig.json"),
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  logLevel: "info",
  plugins: [{ name: "static", setup: (b) => b.onEnd(() => copyStatic()) }],
};

await fs.rm(dist, { recursive: true, force: true });
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
