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

    set -l root $GWT_ROOT
    test -z "$root"; and set root ~/Documents/dev/.worktrees
    set -l path $root/(path basename $repo)/(string replace -a / - $branch)

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

function _gwt_delete -a repo branch force keep
    if test "$branch" = main -o "$branch" = master
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

    if test "$keep" != 1
        if git branch -d $branch 2>/dev/null
            echo "Deleted branch $branch"
        else
            if test "$force" != 1
                echo "gwt: branch '$branch' is not fully merged; keeping it" >&2
                return 1
            end
            _gwt_confirm "Branch '$branch' is not merged. Delete anyway"
            or begin
                echo "gwt: kept branch '$branch'" >&2
                return 1
            end
            git branch -D $branch
            or return 1
        end
    end
end

function gwt -d 'Create, list, and remove git worktrees'
    argparse 'h/help' 'd/delete' 'l/list' 'f/force' 'k/keep-branch' -- $argv
    or begin
        echo 'Usage: gwt [-h] [-l] [-d <branch>] [-f] [-k]' >&2
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

    if set -ql _flag_d
        set -l target $argv[1]
        if test -z "$target"
            echo 'gwt: -d needs a branch' >&2
            echo 'Usage: gwt [-h] [-l] [-d <branch>] [-f] [-k]' >&2
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
