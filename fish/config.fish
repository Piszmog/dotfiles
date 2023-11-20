# If using MacOS
fish_add_path /opt/homebrew/bin

source ~/.config/fish/alias.fish

# Fish syntax highlighting
set -g fish_color_autosuggestion '555'  'brblack'
set -g fish_color_cancel -r
set -g fish_color_command --bold
set -g fish_color_comment red
set -g fish_color_cwd green
set -g fish_color_cwd_root red
set -g fish_color_end brmagenta
set -g fish_color_error brred
set -g fish_color_escape 'bryellow'  '--bold'
set -g fish_color_history_current --bold
set -g fish_color_host normal
set -g fish_color_match --background=brblue
set -g fish_color_normal normal
set -g fish_color_operator bryellow
set -g fish_color_param cyan
set -g fish_color_quote yellow
set -g fish_color_redirection brblue
set -g fish_color_search_match 'bryellow'  '--background=brblack'
set -g fish_color_selection 'white'  '--bold'  '--background=brblack'
set -g fish_color_user brgreen
set -g fish_color_valid_path --underline

# Add custom tools to path
fish_add_path ~/tools
fish_add_path ~/.cargo/bin
fish_add_path /opt/homebrew/opt/openjdk/bin
fish_add_path ~/go/bin

# Env Vars
set GOPATH ~/go
# set set AWS_MFA_ARN <val>
set XDG_CONFIG_HOME /Users/randell/.config

set fish_greeting

starship init fish | source

# If using Homebrew and asdf
# source /opt/homebrew/opt/asdf/libexec/asdf.fish

# opam configuration
source /Users/randell/.opam/opam-init/init.fish > /dev/null 2> /dev/null; or true

# The next line updates PATH for the Google Cloud SDK.
if [ -f '/Users/randell/google-cloud-sdk/path.fish.inc' ]; . '/Users/randell/google-cloud-sdk/path.fish.inc'; end
