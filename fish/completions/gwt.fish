complete -c gwt -f
complete -c gwt -s h -l help -d 'Show help'
complete -c gwt -s l -l list -d 'List worktrees'
complete -c gwt -s d -l delete -d 'Remove the worktree and the branch'
complete -c gwt -s f -l force -d 'Allow destructive removal, asks first'
complete -c gwt -s k -l keep-branch -d 'Keep the branch when removing the worktree'

complete -c gwt -f -n '__fish_seen_subcommand_from -d --delete' \
    -a '(git worktree list --porcelain 2>/dev/null | string match "branch refs/heads/*" | string replace "branch refs/heads/" "")'

complete -c gwt -f -n 'not __fish_seen_subcommand_from -h --help -l --list -d --delete -f --force -k --keep-branch' \
    -a '(git branch --format="%(refname:short)" 2>/dev/null)'
