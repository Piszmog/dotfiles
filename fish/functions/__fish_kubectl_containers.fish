function __fish_kubectl_containers -a pod
    test -n "$pod"; or return 1
    kubectl get pod $pod -o 'jsonpath={.spec.containers[*].name}' 2>/dev/null | string split ' '
end
