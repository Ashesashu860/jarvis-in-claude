/** Hexagonal layering, enforced in CI: dependencies point inwards only. */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment: "src/domain imports nothing outside itself: no application, adapters, node built-ins or packages.",
      severity: "error",
      from: { path: "^src/domain" },
      to: { pathNot: "^src/domain" },
    },
    {
      name: "application-stays-inside",
      comment: "src/application may use the domain but never adapters, node built-ins or packages (the SDK included).",
      severity: "error",
      from: { path: "^src/application" },
      to: { pathNot: "^src/(application|domain)" },
    },
    {
      name: "adapters-dont-import-main",
      severity: "error",
      from: { path: "^src/adapters" },
      to: { path: "^src/main\\.ts$" },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(spike|tests)/" },
  },
};
