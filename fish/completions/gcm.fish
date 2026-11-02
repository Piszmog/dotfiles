complete -c gcm -f
complete -c gcm -s h -l help -d 'Show help'

complete -c gcm -f \
    -n 'not __fish_seen_subcommand_from -h --help; and __fish_is_nth_token 1' \
    -a '(git branch --format="%(refname:short)" 2>/dev/null)' -d 'Branch'
