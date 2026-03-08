/** @type {import('semantic-release').GlobalConfig} */
export default {
	branches: ["main"],
	tagFormat: "v${version}",
	plugins: [
		[
			"@semantic-release/commit-analyzer",
			{
				preset: "conventionalcommits",
				releaseRules: [
					{ breaking: true, release: "major" },
					{ type: "feat", release: "minor" },
					{ type: "fix", release: "patch" },
					{ type: "perf", release: "patch" },
					{ type: "refactor", release: "patch" },
					{ type: "docs", release: "patch" },
					{ type: "test", release: "patch" },
					{ type: "build", release: "patch" },
					{ type: "ci", release: "patch" },
					{ type: "chore", release: "patch" },
					{ type: "style", release: "patch" },
					{ type: "revert", release: "patch" },
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
				message:
					"chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
		"@semantic-release/npm",
	],
};
