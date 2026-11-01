function __fish_kubectl_pods
    kubectl get pods -o name 2>/dev/null | string replace 'pod/' ''
end
