-- Vim Commands
vim.keymap.set("n", "<leader>pv", vim.cmd.Ex, { desc = "Go to project view" })

-- Telescope
local telescope = require("telescope.builtin")
vim.keymap.set("n", "<leader>ff", telescope.find_files, { desc = "Find files" })
vim.keymap.set('n', '<leader>fg', telescope.live_grep, { desc = "Live grep" })
vim.keymap.set('n', '<leader>fb', telescope.buffers, { desc = "Find buffer" })
vim.keymap.set('n', '<leader>fh', telescope.help_tags, { desc = "Find help tags" })
vim.keymap.set('n', '<leader>fs', function()
	telescope.grep_string({ search = vim.fn.input("Grep > ") })
end, { desc = "Find files with grep" })

-- Harpoon
local mark = require('harpoon.mark')
local ui = require('harpoon.ui')
vim.keymap.set('n', '<leader>ha', mark.add_file, { desc = "Harpoon current file" })
vim.keymap.set('n', '<C-e>', ui.toggle_quick_menu, { desc = "Harpoon toggle quick menu" })
vim.keymap.set('n', '<leader>hc', mark.clear_all, { desc = "Harpoon clear all" })

-- Undotree
vim.keymap.set('n', '<leader>u', vim.cmd.UndotreeToggle, { desc = "Toggle Undotree" })

-- Fugitive
vim.keymap.set('n', '<leader>gs', vim.cmd.Git, { desc = "Git status" })
vim.keymap.set('n', '<leader>gb', function()
	vim.cmd.Git('blame')
end, { desc = "Git blame" })
vim.keymap.set('n', '<leader>P', function()
	vim.cmd.Git('push')
end, { desc = "Git Push" })
vim.keymap.set('n', '<leader>pp', function()
	vim.cmd.Git('pull')
end, { desc = "Git Pull" })

-- Formatting
vim.keymap.set('n', '<leader>cf', '<cmd>lua vim.lsp.buf.format()<CR>', { desc = "Format" })

-- Trouble
vim.keymap.set("n", "<leader>xx", function() require("trouble").toggle() end, { desc = "Trouble" })
vim.keymap.set("n", "<leader>xw", function() require("trouble").toggle("workspace_diagnostics") end,
	{ desc = "Trouble workspace diagnostics" })
vim.keymap.set("n", "<leader>xd", function() require("trouble").toggle("document_diagnostics") end,
	{ desc = "Trouble document diagnostics" })
vim.keymap.set("n", "<leader>xq", function() require("trouble").toggle("quickfix") end, { desc = "Trouble quickfix" })
vim.keymap.set("n", "<leader>xl", function() require("trouble").toggle("loclist") end, { desc = "Trouble loclist" })
vim.keymap.set("n", "gR", function() require("trouble").toggle("lsp_references") end, { desc = "Trouble lsp references" })

-- Rename
--vim.keymap.set('n', '<leader>rn', '<cmd>IncRename<CR>', { desc = "Rename" })

-- Go
vim.keymap.set('n', '<leader>ge', '<cmd>GoIfErr<CR>', { desc = "Add Go if error" })

return {}
