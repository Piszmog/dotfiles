function aws_login_mfa -d 'Login to AWS with MFA' -a mfa_code
    if test -z "$AWS_MFA_ARN"
        echo 'aws_login_mfa: AWS_MFA_ARN is not set' >&2
        return 1
    end
    if test -z "$mfa_code"
        echo 'Usage: aws_login_mfa <mfa-code>' >&2
        return 1
    end

    set -l parts (aws sts get-session-token --serial-number $AWS_MFA_ARN --token-code $mfa_code \
        | jq -er '.Credentials | [.AccessKeyId, .SecretAccessKey, .SessionToken] | @tsv' 2>/dev/null \
        | string split \t)
    or begin
        echo 'aws_login_mfa: could not get a session token' >&2
        return 1
    end

    set -Ux AWS_ACCESS_KEY_ID $parts[1]
    set -Ux AWS_SECRET_ACCESS_KEY $parts[2]
    set -Ux AWS_SESSION_TOKEN $parts[3]
end
