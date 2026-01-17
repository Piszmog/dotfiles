export const EnvProtection = async ({ project, client, $, directory, worktree }) => {
	return {
		"tool.execute.before": async (input, output) => {
			if (input.tool === "read" && output.args.filePath.includes(".secrets")) {
				throw new Error("Do not read .secrets files")
			}
		},
	}
}
