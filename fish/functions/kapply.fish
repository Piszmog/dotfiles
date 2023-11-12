function kapply -d 'Apply Kubernetes Resources' -a file
    set -q file[1]
    or set file "."

    kubectl apply -f $file
end
