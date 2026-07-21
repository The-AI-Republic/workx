# WorkX Voice STT Assets

This directory contains the AWS provisioning entrypoint for optional local
speech-to-text assets.

The voice STT bucket is intentionally separate from the desktop release bucket:

- `workx-desktop-releases`: signed app updater bundles and installers
- `workx-voice-stt-assets`: optional STT runtime, model files, and manifest

Default public manifest URL:

```text
https://workx-voice-stt-assets.s3.us-west-2.amazonaws.com/stable.json
```

Expected object layout:

```text
s3://workx-voice-stt-assets/
  stable.json
  2026.07.17-whisper-v1.9.1-base.en-q5_1/
    models/
      ggml-base.en-q5_1.bin
    linux-x86_64/
      workx-stt
    macos-aarch64/
      workx-stt
    windows-x86_64/
      workx-stt.exe
```

Run `./provision.sh` with AWS credentials that can create and configure S3
buckets. Production desktop builds must embed both the manifest URL and the
SHA-256 of the exact manifest bytes:

```bash
manifest_url=https://workx-voice-stt-assets.s3.us-west-2.amazonaws.com/stable.json
manifest_file=$(mktemp)
curl --fail --silent --show-error "$manifest_url" --output "$manifest_file"
export WORKX_VOICE_STT_MANIFEST_URL="$manifest_url"
export WORKX_VOICE_STT_MANIFEST_SHA256="$(sha256sum "$manifest_file" | cut -d' ' -f1)"
npm run tauri:build
```

The Rust desktop binary captures these variables at compile time. At runtime it
verifies the manifest hash before trusting the runtime/model hashes contained
inside it. A release must therefore be rebuilt when `stable.json` changes.
Loopback development manifests may omit the checksum; non-loopback manifests
fail closed without one.

The initial published manifest contains the Linux x86_64 asset only. Add
macOS and Windows entries after publishing matching platform runtimes.
