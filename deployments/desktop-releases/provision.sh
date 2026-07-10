#!/usr/bin/env bash
#
# provision.sh
#
# One-shot provisioner for the AWS side of the WorkX desktop auto-updater,
# modeled on the proven pi-dash `pidash-desktop-releases` setup:
#
#   S3 bucket (versioned, SSE-S3, public-read by bucket policy) that holds the
#   signed Tauri bundles + .sig files and the per-target latest.json manifests,
#   plus friendly first-install installers under downloads/latest/:
#
#     s3://<bucket>/<target>/<version>/<file>        # updater bundle + .sig
#     s3://<bucket>/<target>/latest.json             # Tauri updater manifest
#     s3://<bucket>/downloads/<version>/<file>        # pinned installers
#     s3://<bucket>/downloads/latest/<file>           # stable installer URLs
#
# Everything is served directly over S3 HTTPS (no CloudFront), matching pi-dash.
#
# Idempotency: NOT safe to re-run after partial success — create-bucket fails if
# the bucket already exists. To adjust an existing bucket, apply the
# public-access-block / versioning / policy sections individually.
#
# Requires admin-ish S3 permissions (s3:CreateBucket, PutBucketPolicy, etc.)
# plus sts:GetCallerIdentity. Region hardcoded to us-west-2 to match the rest
# of the AI Republic infra.
set -euo pipefail

AWS_REGION="us-west-2"
BUCKET="workx-desktop-releases"
RELEASES_BASE_URL="https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if ! [[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    echo "ERROR: aws sts get-caller-identity returned '$ACCOUNT_ID' (not a 12-digit account ID)."
    echo "       Configure AWS credentials with S3 admin permissions and retry."
    exit 1
fi
echo "Account: $ACCOUNT_ID  Region: $AWS_REGION  Bucket: $BUCKET"
echo

echo "[1/4] Creating S3 bucket s3://$BUCKET ..."
aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region "$AWS_REGION" \
    --create-bucket-configuration "LocationConstraint=$AWS_REGION" \
    >/dev/null

# ACLs disabled, but allow an explicit public-read bucket policy below.
aws s3api put-public-access-block \
    --bucket "$BUCKET" \
    --public-access-block-configuration \
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"

# Versioning guards against an accidental overwrite of an already-released
# bundle: the old signature is baked into the manifest clients already fetched,
# so a re-upload without versioning could brick the update flow.
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

aws s3api put-bucket-tagging \
    --bucket "$BUCKET" \
    --tagging 'TagSet=[
        {Key=Project,Value=workx},
        {Key=Component,Value=desktop-updates},
        {Key=ManagedBy,Value=manual}
    ]'

echo "       OK: bucket created, versioning on, SSE-S3 on, public policies allowed."

echo "[2/4] Applying bucket policy (public read + github-action publish) ..."
# The release workflow authenticates as the shared org CI user
# arn:aws:iam::${ACCOUNT_ID}:user/github-action (org GHA secrets
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, visibility ALL). That user's
# identity policy (s3_release) is scoped to the pidash bucket only, so we grant
# it PutObject on THIS bucket here via the bucket policy — no IAM admin needed
# and no per-repo publisher user to rotate. Same-account access is allowed if
# either the identity or the bucket policy permits it.
CI_USER_ARN="arn:aws:iam::${ACCOUNT_ID}:user/github-action"
POLICY_FILE="$(mktemp)"
cat >"$POLICY_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowPublicReadReleaseObjects",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "AllowGithubActionPublish",
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
echo "       OK: ${RELEASES_BASE_URL}/... is publicly readable; github-action can publish."

echo
echo "[3/4] Provisioned."
echo "       Bucket:             s3://${BUCKET}"
echo "       Public release URL: ${RELEASES_BASE_URL}"
echo

cat <<EOF
[4/4] Next steps (NOT automated by this script):

  a) Publisher credentials: NONE to create. The release workflow uses the
     existing org-level GitHub Actions secrets AWS_ACCESS_KEY_ID /
     AWS_SECRET_ACCESS_KEY (visibility ALL -> already available to the workx
     repo), which map to the shared ${CI_USER_ARN}
     user. Step [2/4] above already granted that user PutObject on this bucket
     via the bucket policy, so no new IAM user and no per-repo secret rotation
     is required.

  b) Confirm the Tauri signing key secrets are present in the workx repo
     (already used by release.yml):
       TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD
     The matching pubkey must be the one in tauri/tauri.conf.json.

  c) Point home-page / marketing download links at:
       ${RELEASES_BASE_URL}/downloads/latest/

  d) Run the "Release desktop bundles (S3)" workflow (workflow_dispatch) to
     publish the first signed release. tauri.conf.json updater endpoints already
     point at ${RELEASES_BASE_URL}/{{target}}/latest.json.
EOF
