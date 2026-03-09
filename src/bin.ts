// Fast path: --version / -V exits before loading the CLI framework
if (process.argv[2] === "--version" || process.argv[2] === "-V") {
  // Graceful fallback for running from source (before build injects __TYPEGRADE_VERSION__)
  const version = typeof __TYPEGRADE_VERSION__ === "undefined" ? "dev" : __TYPEGRADE_VERSION__;
  console.log(version);
  process.exit(0);
}

const { runCli } = await import("./cli.js");
runCli();
