-- [[ Basic Keymaps ]]

-- Keymaps for better default experience
-- See `:help vim.keymap.set()`
vim.keymap.set({ 'n', 'v' }, '<Space>', '<Nop>', { silent = true })

-- Remap for dealing with word wrap
vim.keymap.set('n', 'k', "v:count == 0 ? 'gk' : 'k'", { expr = true, silent = true })
vim.keymap.set('n', 'j', "v:count == 0 ? 'gj' : 'j'", { expr = true, silent = true })

-- Diagnostic keymaps
vim.keymap.set('n', '[d', vim.diagnostic.goto_prev, { desc = 'Go to previous diagnostic message' })
vim.keymap.set('n', ']d', vim.diagnostic.goto_next, { desc = 'Go to next diagnostic message' })
vim.keymap.set('n', '<leader>e', vim.diagnostic.open_float, { desc = 'Open floating diagnostic message' })
vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist, { desc = 'Open diagnostics list' })

-- Vim Commands
vim.keymap.set("n", "<leader>pv", vim.cmd.Ex, { desc = "Go to project view" })

-- Telescope
vim.keymap.set('n', '<leader>?', require('telescope.builtin').oldfiles, { desc = '[?] Find recently opened files' })
vim.keymap.set('n', '<leader><space>', require('telescope.builtin').buffers, { desc = '[ ] Find existing buffers' })
vim.keymap.set('n', '<leader>/', function()
	-- You can pass additional configuration to telescope to change theme, layout, etc.
	require('telescope.builtin').current_buffer_fuzzy_find(require('telescope.themes').get_dropdown {
		winblend = 10,
		previewer = false,
	})
end, { desc = '[/] Fuzzily search in current buffer' })
vim.keymap.set('n', '<leader>gf', require('telescope.builtin').git_files, { desc = 'Search [G]it [F]iles' })
vim.keymap.set('n', '<leader>sf', require('telescope.builtin').find_files, { desc = '[S]earch [F]iles' })
vim.keymap.set('n', '<leader>sh', require('telescope.builtin').help_tags, { desc = '[S]earch [H]elp' })
vim.keymap.set('n', '<leader>sw', require('telescope.builtin').grep_string, { desc = '[S]earch current [W]ord' })
vim.keymap.set('n', '<leader>sg', require('telescope.builtin').live_grep, { desc = '[S]earch by [G]rep' })
vim.keymap.set('n', '<leader>sG', ':LiveGrepGitRoot<cr>', { desc = '[S]earch by [G]rep on Git Root' })
vim.keymap.set('n', '<leader>sd', require('telescope.builtin').diagnostics, { desc = '[S]earch [D]iagnostics' })

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
