export const EnvProtection = async ({ project, client, $, directory, worktree }) => {
	return {
		"tool.execute.before": async (input, output) => {
			if (input.tool === "read" && output.args.filePath.includes(".secret")) {
				throw new Error("Do not read .secret files")
			}
		},
	}
}
