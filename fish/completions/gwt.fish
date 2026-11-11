complete -c gwt -f
complete -c gwt -s h -l help -d 'Show help'
complete -c gwt -s l -l list -d 'List worktrees'
complete -c gwt -s d -l delete -d 'Remove the worktree and the branch'
complete -c gwt -s f -l force -d 'Allow destructive removal, asks first'
complete -c gwt -s k -l keep-branch -d 'Keep the branch when removing the worktree'
complete -c gwt -s P -l print-path -d 'Print the worktree path without changing directory'

# Branches with a linked worktree. The main worktree is listed first by git and
# is never removable, so its branch is skipped.
function __gwt_linked_branches
    set -l main
    set -l seen
    set -l path
    set -l branch
    for line in (git worktree list --porcelain 2>/dev/null; echo)
        switch $line
            case ''
                if test -n "$branch"; and test "$path" != "$main"
                    echo $branch
                end
                set path
                set branch
            case 'worktree *'
                set path (string replace 'worktree ' '' -- $line)
                if not set -q seen[1]
                    set main $path
                    set seen 1
                end
            case 'branch refs/heads/*'
                set branch (string replace 'branch refs/heads/' '' -- $line)
        end
    end
end

# Origin branches that do not exist locally yet; gwt creates them with tracking.
function __gwt_new_remote_branches
    set -l local (git branch --format='%(refname:short)' 2>/dev/null)
    for branch in (git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin 2>/dev/null)
        test "$branch" = HEAD; and continue
        contains -- $branch $local; and continue
        echo $branch
    end
end

complete -c gwt -f -n '__fish_seen_subcommand_from -d --delete' \
    -a '(__gwt_linked_branches)' -d 'Worktree branch'

complete -c gwt -f -n 'not __fish_seen_subcommand_from -h --help -l --list -d --delete' \
    -a '(git branch --format="%(refname:short)" 2>/dev/null)' -d 'Local branch'

complete -c gwt -f -n 'not __fish_seen_subcommand_from -h --help -l --list -d --delete' \
    -a '(__gwt_new_remote_branches)' -d 'Remote branch'
