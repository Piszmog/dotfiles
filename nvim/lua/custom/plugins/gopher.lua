return {
	"olexsmir/gopher.nvim",
	enabled = false,
	requires = { -- dependencies
		"nvim-lua/plenary.nvim",
		"nvim-treesitter/nvim-treesitter",
	},
	config = function()
		require('gopher').setup {
		}
	end
}
