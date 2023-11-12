function kdelete -d 'Delete Kubernetes Resources' -a file
    set -q file[1]
    or set file "."

    kubectl delete -f $file
end
