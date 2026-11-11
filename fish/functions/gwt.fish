function _gwt_usage
    printf '%s\n' \
        'gwt — create and remove git worktrees' \
        '' \
        'Usage:' \
        '  gwt <branch>         create a worktree for <branch> and cd into it' \
        '  gwt, gwt -l          list worktrees' \
        '  gwt -d <branch>      remove the worktree and the branch' \
        '  gwt -h               show this help' \
        '' \
        'Branch handling:' \
        '  new branch           based on origin/HEAD, else origin/main, else' \
        '                       origin/master, else HEAD' \
        '  existing local       attached as-is' \
        '  remote-only          created locally, tracking origin/<branch>' \
        '' \
        'Options:' \
        '  -f, --force          allow removing a worktree with local changes, and' \
        '                       allow deleting an unmerged branch; each asks first' \
        '  -k, --keep-branch    keep the branch when removing the worktree' \
        '  -P, --print-path     print the worktree path for <branch> and exit;' \
        '                       creates nothing and does not change directory.' \
        '                       Prints the existing path when the branch already' \
        '                       has a worktree' \
        '' \
        'Location:' \
        '  $GWT_ROOT, or ~/Documents/dev/.worktrees/<repo>/<branch-dir>' \
        '  (slashes in the branch name become dashes in the directory name)' \
        '' \
        'Examples:' \
        '  gwt fix/login-timeout' \
        '  gwt -d fix/login-timeout' \
        '  gwt -k -d fix/login-timeout' \
        '  gwt -f -d fix/login-timeout'
end

function _gwt_confirm -a message
    if not isatty stdin
        echo "gwt: $message [y/N] (no terminal to confirm)" >&2
        return 1
    end
    read -l -P "$message [y/N] " answer
    or return 1
    string match -qi 'y*' -- "$answer"
end

function _gwt_repo
    set -l common (git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
    or return 1
    test -n "$common"
    or return 1
    if test (path basename $common) = .git
        path dirname $common
    else
        echo $common
    end
end

# Location used for every worktree: <root>/<repo-basename>/<branch with / -> ->.
# -P prints this without side effects, so the formula must live in one place.
function _gwt_root
    set -l root $GWT_ROOT
    test -z "$root"; and set root ~/Documents/dev/.worktrees
    echo $root
end

function _gwt_path -a repo branch
    echo (_gwt_root)/(path basename $repo)/(string replace -a -- / - $branch)
end

function _gwt_worktree_path -a branch
    set -l current
    for line in (git worktree list --porcelain)
        if string match -q 'worktree *' -- $line
            set current (string replace -r '^worktree ' '' $line)
        else if string match -q "branch refs/heads/$branch" -- $line
            echo $current
            return 0
        end
    end
    return 1
end

function _gwt_list
    set -l path
    set -l label
    for line in (git worktree list --porcelain; echo)
        switch $line
            case ''
                if test -n "$path"
                    set -l note ''
                    if test -n "$(git -C $path status --porcelain 2>/dev/null)"
                        set note ' (dirty)'
                    end
                    printf '%s  %s%s\n' (string replace -- "$HOME" '~' $path) "$label" "$note"
                    set path
                    set label
                end
            case 'worktree *'
                set path (string replace -r '^worktree ' '' $line)
            case 'branch refs/heads/*'
                set label (string replace -r '^branch refs/heads/' '' $line)
            case 'detached'
                set label '(detached)'
        end
    end
end

function _gwt_add -a repo branch
    if _gwt_worktree_path $branch >/dev/null
        echo "gwt: branch '$branch' already has a worktree" >&2
        return 1
    end

    set -l path (_gwt_path $repo $branch)

    if test -e "$path"
        echo "gwt: $path already exists" >&2
        return 1
    end

    mkdir -p (path dirname $path)

    set -l status_add
    if git show-ref --verify --quiet refs/heads/$branch
        git worktree add $path $branch
        set status_add $status
    else if git show-ref --verify --quiet refs/remotes/origin/$branch
        git worktree add $path $branch
        set status_add $status
    else
        set -l base
        for candidate in refs/remotes/origin/HEAD refs/remotes/origin/main refs/remotes/origin/master
            if git show-ref --verify --quiet $candidate
                set base $candidate
                break
            end
        end
        test -z "$base"; and set base HEAD
        git worktree add -b $branch $path $base
        set status_add $status
    end
    test $status_add -eq 0
    or return 1

    cd $path
end

function _gwt_merged -a repo branch
    set -l upstream (git -C $repo rev-parse --symbolic-full-name "$branch@{upstream}" 2>/dev/null)
    if test -n "$upstream"
        git -C $repo merge-base --is-ancestor "refs/heads/$branch" $upstream 2>/dev/null
    else
        git -C $repo merge-base --is-ancestor "refs/heads/$branch" HEAD 2>/dev/null
    end
end

function _gwt_delete -a repo branch force keep
    if test "$branch" = main; or test "$branch" = master
        echo "gwt: refusing to delete '$branch'" >&2
        return 1
    end

    set -l path (_gwt_worktree_path $branch)
    if test -z "$path"
        echo "gwt: no worktree for branch '$branch'" >&2
        return 1
    end
    if test "$path" = "$repo"
        echo "gwt: '$branch' is the main worktree of $repo" >&2
        return 1
    end

    # Decide about the branch before removing the worktree. Removal is
    # irreversible, and a worktree-less unmerged branch cannot be retried.
    set -l merged 0
    _gwt_merged $repo $branch
    and set merged 1

    if test "$keep" != 1; and test $merged = 0
        if test "$force" != 1
            echo "gwt: branch '$branch' is not fully merged; use -f to delete it, or -k to keep it" >&2
            return 1
        end
        _gwt_confirm "Branch '$branch' is not merged. Delete anyway"
        or begin
            echo 'gwt: aborted' >&2
            return 1
        end
    end

    set -l here (pwd -P)
    if test "$here" = "$path"; or string match -q -- "$path/*" "$here"
        cd $repo
        or return 1
    end

    set -l flags
    if test "$force" = 1
        set flags -f
        if test -n "$(git -C $path status --porcelain 2>/dev/null)"
            _gwt_confirm "Worktree $path has local changes. Remove anyway"
            or begin
                echo 'gwt: aborted' >&2
                return 1
            end
        end
    end

    git worktree remove $flags $path
    or return 1

    test "$keep" = 1; and return 0

    set -l delete_flag -d
    test $merged = 0; and set delete_flag -D
    git -C $repo branch $delete_flag $branch
    or begin
        echo "gwt: could not delete branch '$branch'" >&2
        return 1
    end
    echo "Deleted branch $branch"
end

function gwt -d 'Create, list, and remove git worktrees'
    argparse 'h/help' 'd/delete' 'l/list' 'f/force' 'k/keep-branch' 'P/print-path' -- $argv
    or begin
        echo 'Usage: gwt [-h] [-l] [-d <branch>] [-P <branch>] [-f] [-k]' >&2
        return 1
    end

    if set -ql _flag_h
        _gwt_usage
        return 0
    end

    set -l repo (_gwt_repo)
    or begin
        echo 'gwt: not inside a git repository' >&2
        return 1
    end

    set -l force 0
    set -q _flag_f; and set force 1
    set -l keep 0
    set -q _flag_k; and set keep 1

    if set -ql _flag_P
        if set -ql _flag_d; or set -ql _flag_l
            echo 'gwt: -P cannot be combined with -d or -l' >&2
            return 1
        end
        set -l target $argv[1]
        if test -z "$target"
            echo 'gwt: -P needs a branch' >&2
            echo 'Usage: gwt [-h] [-l] [-d <branch>] [-P <branch>] [-f] [-k]' >&2
            return 1
        end
        set -l existing (_gwt_worktree_path $target)
        if test -n "$existing"
            echo $existing
        else
            _gwt_path $repo $target
        end
        return 0
    end

    if set -ql _flag_l
        if test -n "$argv[1]"
            echo 'gwt: -l takes no branch' >&2
            return 1
        end
        _gwt_list
        return 0
    end

    if set -ql _flag_d
        set -l target $argv[1]
        if test -z "$target"
            echo 'gwt: -d needs a branch' >&2
            echo 'Usage: gwt [-h] [-l] [-d <branch>] [-P <branch>] [-f] [-k]' >&2
            return 1
        end
        _gwt_delete $repo $target $force $keep
        return $status
    end

    set -l branch $argv[1]
    if test -z "$branch"
        _gwt_list
        return 0
    end

    _gwt_add $repo $branch
end
