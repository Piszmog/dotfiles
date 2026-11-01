complete -c klogs -f -n 'test (count (commandline -opc)) -eq 1' \
    -a '(__fish_kubectl_pods)' -d Pod

complete -c klogs -f -n 'test (count (commandline -opc)) -eq 2' \
    -a '(__fish_kubectl_containers (commandline -opc)[2])' -d Container
