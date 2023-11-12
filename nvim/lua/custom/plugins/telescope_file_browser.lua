return {
	"nvim-telescope/telescope-file-browser.nvim",
	dependencies = { "nvim-telescope/telescope.nvim", "nvim-lua/plenary.nvim" },
	enabled = false,
	config = function()
		local telescope = require('telescope')
		telescope.setup {
			extensions = {
				file_browser = {
					hijack_netrw = true,
					hidden = {
						file_browser = true,
						folder_browser = true
					}
				}
			}
		}
		-- local file_browser = telescope.extensions.file_browser
		telescope.load_extension('file_browser')
	end
}
