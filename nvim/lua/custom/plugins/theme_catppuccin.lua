return {
  "catppuccin/nvim",
  name = "catppuccin",
  priority = 1000,
  enabled = true,
  config = function()
    require('catppuccin').setup({
      flavour = 'mocha'
    })
    vim.cmd [[colorscheme catppuccin]]
  end,
}
