#!/usr/bin/env bash
#
# Provision the independent S3 bucket for optional WorkX voice STT assets.
#
# This bucket stores only local voice STT artifacts:
#   s3://workx-voice-stt-assets/stable.json
#   s3://workx-voice-stt-assets/<version>/models/<model>
#   s3://workx-voice-stt-assets/<version>/<target>/<runtime>
#
# Requires AWS credentials with S3 bucket administration permissions.
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-west-2}"
BUCKET="${WORKX_VOICE_STT_BUCKET:-workx-voice-stt-assets}"
BASE_URL="https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if ! [[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    echo "ERROR: aws sts get-caller-identity returned '$ACCOUNT_ID' (not a 12-digit account ID)." >&2
    exit 1
fi

echo "Account: $ACCOUNT_ID"
echo "Region:  $AWS_REGION"
echo "Bucket:  s3://$BUCKET"
echo

if aws s3api head-bucket --bucket "$BUCKET" --region "$AWS_REGION" >/dev/null 2>&1; then
    echo "[1/5] Bucket already exists and is reachable."
else
    echo "[1/5] Creating bucket..."
    aws s3api create-bucket \
        --bucket "$BUCKET" \
        --region "$AWS_REGION" \
        --create-bucket-configuration "LocationConstraint=$AWS_REGION" \
        >/dev/null
fi

echo "[2/5] Applying public-access configuration..."
aws s3api put-public-access-block \
    --bucket "$BUCKET" \
    --public-access-block-configuration \
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"

echo "[3/5] Enabling versioning and SSE-S3..."
aws s3api put-bucket-versioning \
    --bucket "$BUCKET" \
    --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
    --bucket "$BUCKET" \
    --server-side-encryption-configuration '{
        "Rules": [{
            "ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"},
            "BucketKeyEnabled": true
        }]
    }'

echo "[4/5] Tagging bucket..."
aws s3api put-bucket-tagging \
    --bucket "$BUCKET" \
    --tagging 'TagSet=[
        {Key=Project,Value=workx},
        {Key=Component,Value=voice-stt-assets},
        {Key=ManagedBy,Value=manual}
    ]'

echo "[5/5] Applying bucket policy..."
CI_USER_ARN="arn:aws:iam::${ACCOUNT_ID}:user/github-action"
POLICY_FILE="$(mktemp)"
cat >"$POLICY_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowPublicReadVoiceSttObjects",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "AllowGithubActionPublishVoiceSttAssets",
      "Effect": "Allow",
      "Principal": { "AWS": "${CI_USER_ARN}" },
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    }
  ]
}
EOF
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$POLICY_FILE"
rm -f "$POLICY_FILE"

cat <<EOF

Provisioned.

Public base URL:
  ${BASE_URL}

Voice manifest URL:
  ${BASE_URL}/stable.json

Configure desktop builds with:
  WORKX_VOICE_STT_MANIFEST_URL=${BASE_URL}/stable.json
EOF
