return {
	"nvim-telescope/telescope-file-browser.nvim",
	dependencies = { "nvim-telescope/telescope.nvim", "nvim-lua/plenary.nvim" },
	config = function()
		local telescope = require('telescope')
		-- local file_browser = telescope.extensions.file_browser
		telescope.load_extension('file_browser')
	end
}
