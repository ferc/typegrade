// Fast path: --version / -V exits before loading the CLI framework
if (process.argv[2] === "--version" || process.argv[2] === "-V") {
  console.log(__TYPEGRADE_VERSION__);
  process.exit(0);
}

const { runCli } = await import("./cli.js");
runCli();
