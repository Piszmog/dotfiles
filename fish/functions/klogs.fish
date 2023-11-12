function klogs -d 'Stream logs from a pod' -a pod -a container
    if set -q container[1]
        kubectl logs -f $pod -c $container
    else
        kubectl logs -f $pod
    end
end
