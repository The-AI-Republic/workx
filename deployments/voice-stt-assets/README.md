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
buckets. The current desktop app can then set:

```text
WORKX_VOICE_STT_MANIFEST_URL=https://workx-voice-stt-assets.s3.us-west-2.amazonaws.com/stable.json
```

The initial published manifest contains the Linux x86_64 asset only. Add
macOS and Windows entries after publishing matching platform runtimes.
