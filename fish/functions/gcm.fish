function _gcm_usage
    printf '%s\n' \
        'gcm — check out a branch and pull it' \
        '' \
        'Usage:' \
        '  gcm              check out main, then pull' \
        '  gcm <branch>     check out <branch>, then pull' \
        '  gcm -h           show this help' \
        '' \
        'Options:' \
        '  -h, --help       show this help' \
        '' \
        'The pull does not run when the checkout fails.' \
        '' \
        'Examples:' \
        '  gcm' \
        '  gcm fix/login-timeout'
end

function gcm -d 'Checkout a branch and pull (default: main)'
    argparse 'h/help' -- $argv
    or begin
        echo 'Usage: gcm [-h] [<branch>]' >&2
        return 1
    end

    if set -ql _flag_h
        _gcm_usage
        return 0
    end

    if test (count $argv) -gt 1
        echo 'gcm: expected at most one branch' >&2
        echo 'Usage: gcm [-h] [<branch>]' >&2
        return 1
    end

    set -l branch main
    if set -q argv[1]
        set branch $argv[1]
    end

    git checkout $branch
    or return
    git pull
end
