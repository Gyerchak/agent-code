import * as esbuild from "esbuild"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { transformSolidSource, resolveNodeSolidRuntimeImport } from "../node_modules/@opentui/solid/scripts/solid-transform.js"

const solidPlugin = {
  name: "solid",
  setup(build) {
    // One reactive Solid instance: the browser build that @opentui/solid imports directly.
    build.onResolve({ filter: /^solid-js$/ }, () => ({ path: "solid-js/dist/solid.js", external: true }))
    build.onResolve({ filter: /^solid-js\/dist\/solid\.js$/ }, () => ({ path: "solid-js/dist/solid.js", external: true }))
    build.onResolve({ filter: /^solid-js\/store(\/dist\/store\.js)?$/ }, () => ({
      path: fileURLToPath(new URL("../node_modules/solid-js/store/dist/store.js", import.meta.url)),
    }))
    build.onLoad({ filter: /[/\\]src[/\\].*\.[cm]?jsx?$/ }, async (args) => {
      const code = await readFile(args.path, "utf8")
      const contents = await transformSolidSource(code, {
        filename: args.path,
        resolvePath: resolveNodeSolidRuntimeImport,
      })
      return { contents, loader: "js" }
    })
  },
}

const watch = process.argv.includes("--watch")
const ctx = await esbuild.context({
  entryPoints: ["src/index.jsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/index.js",
  packages: "external",
  sourcemap: "linked",
  plugins: [solidPlugin],
  logLevel: "info",
})
if (watch) await ctx.watch()
else {
  await ctx.rebuild()
  await ctx.dispose()
}
