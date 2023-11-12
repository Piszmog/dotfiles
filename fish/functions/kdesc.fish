function kdesc -d 'Stream logs from a pod' -a pod
    kubectl describe pod $pod
end
