function aws_login_mfa -d 'Login to AWS with MFA' -a mfa_code
    set aws_session_token (aws sts get-session-token --serial-number $AWS_MFA_ARN --token-code $mfa_code)
    set -Ux AWS_ACCESS_KEY_ID (echo $aws_session_token | jq -r '.Credentials.AccessKeyId')
    set -Ux AWS_SECRET_ACCESS_KEY (echo $aws_session_token | jq -r '.Credentials.SecretAccessKey')
    set -Ux AWS_SESSION_TOKEN (echo $aws_session_token | jq -r '.Credentials.SessionToken')
end
