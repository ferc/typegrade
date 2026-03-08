import type { Options } from "semantic-release";

const config: Options = {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { breaking: true, release: "major" },
          { release: "minor", type: "feat" },
          { release: "patch", type: "fix" },
          { release: "patch", type: "perf" },
          { release: "patch", type: "refactor" },
          { release: "patch", type: "docs" },
          { release: "patch", type: "test" },
          { release: "patch", type: "build" },
          { release: "patch", type: "ci" },
          { release: "patch", type: "chore" },
          { release: "patch", type: "style" },
          { release: "patch", type: "revert" },
        ],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
      },
    ],
    [
      "@semantic-release/changelog",
      {
        changelogFile: "CHANGELOG.md",
      },
    ],
    [
      "@semantic-release/git",
      {
        assets: ["package.json", "CHANGELOG.md"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
    "@semantic-release/github",
    "@semantic-release/npm",
  ],
  tagFormat: "v${version}",
};

export default config;
