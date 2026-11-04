const options = {
  loader: "tsx",
  // Bun accepts these JSX options before @types/bun declares them.
  jsx: { runtime: "automatic", importSource: "solid-js/h", development: true },
} as const
const transpiler = new Bun.Transpiler(options)

// Bun's automatic JSX resolver cannot link Solid's placeholder runtime.
Bun.plugin({
  name: "deepagent-solid-test-jsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: transpiler.transformSync(await Bun.file(path).text()),
      loader: "ts",
    }))
  },
})
