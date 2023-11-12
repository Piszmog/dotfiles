return {
	-- Theme inspired by Atom
	'navarasu/onedark.nvim',
	enabled = false,
	priority = 1000,
	config = function()
		vim.cmd.colorscheme 'onedark'
	end,
}
