use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const MANIFEST_URL_ENV: &str = "WORKX_VOICE_STT_MANIFEST_URL";
const MANIFEST_SHA256_ENV: &str = "WORKX_VOICE_STT_MANIFEST_SHA256";
const BUILT_MANIFEST_URL: Option<&str> = option_env!("WORKX_VOICE_STT_MANIFEST_URL");
const BUILT_MANIFEST_SHA256: Option<&str> = option_env!("WORKX_VOICE_STT_MANIFEST_SHA256");
const COMPONENT_DIR: &str = "voice-stt";
const INSTALL_FILE: &str = "install.json";
const SUPPORTED_PROTOCOL_VERSION: u32 = 1;
const MAX_AUDIO_BYTES: usize = 50 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone)]
struct ManifestConfig {
    url: String,
    sha256: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSttStatus {
    pub configured: bool,
    pub installed: bool,
    pub target: String,
    pub component_version: Option<String>,
    pub protocol_version: Option<u32>,
    pub runtime_path: Option<String>,
    pub model_path: Option<String>,
    pub manifest_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceManifest {
    component_version: String,
    protocol_version: u32,
    assets: Vec<VoiceAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceAsset {
    target: String,
    runtime_url: String,
    runtime_sha256: String,
    model_url: String,
    model_sha256: String,
    executable_name: String,
    model_file_name: String,
    args: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceInstallMetadata {
    component_version: String,
    protocol_version: u32,
    target: String,
    runtime_name: String,
    model_name: String,
    args: Option<Vec<String>>,
    #[serde(default)]
    manifest_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarTranscription {
    text: String,
    language: Option<String>,
    duration_ms: Option<u64>,
    confidence: Option<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptionResult {
    pub text: String,
    pub language: Option<String>,
    pub duration_ms: Option<u64>,
    pub confidence: Option<f32>,
    pub source: String,
}

fn current_target() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn non_empty(value: Result<String, std::env::VarError>) -> Option<String> {
    value
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn is_allowed_download_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() == "https" {
        return true;
    }
    parsed.scheme() == "http"
        && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

fn is_local_download_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

fn manifest_config() -> Result<Option<ManifestConfig>, String> {
    let runtime_url = non_empty(std::env::var(MANIFEST_URL_ENV));
    let runtime_sha256 = non_empty(std::env::var(MANIFEST_SHA256_ENV));
    let url = runtime_url.or_else(|| BUILT_MANIFEST_URL.map(str::to_owned));
    let Some(url) = url else {
        return Ok(None);
    };
    let sha256 = runtime_sha256.or_else(|| BUILT_MANIFEST_SHA256.map(str::to_owned));
    validate_manifest_config(url, sha256).map(Some)
}

fn validate_manifest_config(url: String, sha256: Option<String>) -> Result<ManifestConfig, String> {
    if !is_allowed_download_url(&url) {
        return Err(
            "Voice STT manifest URL must use HTTPS (or loopback HTTP for development).".to_string(),
        );
    }
    if sha256.is_none() && !is_local_download_url(&url) {
        return Err(format!(
            "Voice STT manifest is not pinned. Set {} when building the desktop app.",
            MANIFEST_SHA256_ENV
        ));
    }
    Ok(ManifestConfig { url, sha256 })
}

fn safe_component_path(root: &Path, name: &str, label: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
        || Path::new(name).is_absolute()
    {
        return Err(format!("Voice STT {} must be a single file name.", label));
    }
    Ok(root.join(name))
}

fn component_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))
        .map(|dir| dir.join(COMPONENT_DIR))
}

fn install_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(component_root(app)?.join(INSTALL_FILE))
}

fn read_install_metadata(app: &AppHandle) -> Result<Option<VoiceInstallMetadata>, String> {
    let path = install_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read voice STT metadata: {}", e))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("Failed to parse voice STT metadata: {}", e))
}

fn installed_paths(
    app: &AppHandle,
    metadata: &VoiceInstallMetadata,
) -> Result<(PathBuf, PathBuf), String> {
    let config = manifest_config()?
        .ok_or_else(|| "Voice STT is not configured for this desktop build.".to_string())?;
    if let Some(expected) = config.sha256.as_deref() {
        let installed = metadata.manifest_sha256.as_deref().unwrap_or_default();
        if !installed.eq_ignore_ascii_case(expected) {
            return Err(
                "Voice STT install predates or does not match this build's pinned manifest; reinstall it."
                    .to_string(),
            );
        }
    }
    if metadata.target != current_target() {
        return Err(format!(
            "Voice STT component target {} does not match this app target {}.",
            metadata.target,
            current_target()
        ));
    }
    if metadata.protocol_version != SUPPORTED_PROTOCOL_VERSION {
        return Err(format!(
            "Voice STT protocol {} is unsupported (expected {}).",
            metadata.protocol_version, SUPPORTED_PROTOCOL_VERSION
        ));
    }
    let root = component_root(app)?;
    Ok((
        safe_component_path(&root, &metadata.runtime_name, "runtime name")?,
        safe_component_path(&root, &metadata.model_name, "model name")?,
    ))
}

fn build_status(app: &AppHandle) -> VoiceSttStatus {
    let target = current_target();
    let config = manifest_config();
    let configured = matches!(config, Ok(Some(_)));
    let manifest_url = config
        .as_ref()
        .ok()
        .and_then(|value| value.as_ref())
        .map(|value| value.url.clone());
    let configuration_error = config.err();
    match read_install_metadata(app) {
        Ok(Some(metadata)) => match installed_paths(app, &metadata) {
            Ok((runtime_path, model_path)) => {
                let installed = runtime_path.exists() && model_path.exists();
                VoiceSttStatus {
                    configured,
                    installed,
                    target,
                    component_version: Some(metadata.component_version),
                    protocol_version: Some(metadata.protocol_version),
                    runtime_path: Some(runtime_path.to_string_lossy().to_string()),
                    model_path: Some(model_path.to_string_lossy().to_string()),
                    manifest_url,
                    error: if installed && configuration_error.is_none() {
                        None
                    } else if let Some(error) = configuration_error {
                        Some(error)
                    } else {
                        Some(
                            "Voice STT metadata exists, but runtime or model file is missing."
                                .to_string(),
                        )
                    },
                }
            }
            Err(e) => VoiceSttStatus {
                configured,
                installed: false,
                target,
                component_version: Some(metadata.component_version),
                protocol_version: Some(metadata.protocol_version),
                runtime_path: None,
                model_path: None,
                manifest_url,
                error: Some(configuration_error.unwrap_or(e)),
            },
        },
        Ok(None) => VoiceSttStatus {
            configured,
            installed: false,
            target,
            component_version: None,
            protocol_version: None,
            runtime_path: None,
            model_path: None,
            manifest_url,
            error: configuration_error,
        },
        Err(e) => VoiceSttStatus {
            configured,
            installed: false,
            target,
            component_version: None,
            protocol_version: None,
            runtime_path: None,
            model_path: None,
            manifest_url,
            error: Some(configuration_error.unwrap_or(e)),
        },
    }
}

async fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download voice STT asset: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Voice STT asset request failed: {}", e))?
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|e| format!("Failed to read voice STT asset: {}", e))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

fn verify_sha256(bytes: &[u8], expected: &str, label: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    if actual.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err(format!(
            "{} SHA-256 mismatch. expected {}, got {}",
            label, expected, actual
        ))
    }
}

fn write_verified_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("download");
    fs::write(&tmp, bytes)
        .map_err(|e| format!("Failed to write temporary voice STT asset: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("Failed to install voice STT asset: {}", e))
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|e| format!("Failed to read runtime permissions: {}", e))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|e| format!("Failed to mark voice STT runtime executable: {}", e))
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn pick_asset(manifest: &VoiceManifest) -> Result<VoiceAsset, String> {
    let target = current_target();
    manifest
        .assets
        .iter()
        .find(|asset| asset.target == target)
        .cloned()
        .ok_or_else(|| format!("No voice STT asset is available for target {}", target))
}

#[tauri::command]
pub fn voice_stt_status(app: AppHandle) -> VoiceSttStatus {
    build_status(&app)
}

#[tauri::command]
pub async fn install_voice_stt_component(app: AppHandle) -> Result<VoiceSttStatus, String> {
    let config = manifest_config()?.ok_or_else(|| {
        format!(
            "Voice STT is not configured. Set {} and {} when building the desktop app.",
            MANIFEST_URL_ENV, MANIFEST_SHA256_ENV
        )
    })?;
    let manifest_bytes = fetch_bytes(&config.url).await?;
    if let Some(expected) = config.sha256.as_deref() {
        verify_sha256(&manifest_bytes, expected, "manifest")?;
    }
    let manifest: VoiceManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Failed to parse voice STT manifest: {}", e))?;
    if manifest.protocol_version != SUPPORTED_PROTOCOL_VERSION {
        return Err(format!(
            "Voice STT manifest protocol {} is unsupported (expected {}).",
            manifest.protocol_version, SUPPORTED_PROTOCOL_VERSION
        ));
    }
    let asset = pick_asset(&manifest)?;
    if !is_allowed_download_url(&asset.runtime_url) || !is_allowed_download_url(&asset.model_url) {
        return Err("Voice STT asset URLs must use HTTPS.".to_string());
    }

    let root = component_root(&app)?;
    fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create voice STT component directory: {}", e))?;

    let runtime_bytes = fetch_bytes(&asset.runtime_url).await?;
    verify_sha256(&runtime_bytes, &asset.runtime_sha256, "runtime")?;
    let runtime_path = safe_component_path(&root, &asset.executable_name, "executable name")?;
    write_verified_file(&runtime_path, &runtime_bytes)?;
    mark_executable(&runtime_path)?;

    let model_bytes = fetch_bytes(&asset.model_url).await?;
    verify_sha256(&model_bytes, &asset.model_sha256, "model")?;
    let model_path = safe_component_path(&root, &asset.model_file_name, "model file name")?;
    write_verified_file(&model_path, &model_bytes)?;

    let metadata = VoiceInstallMetadata {
        component_version: manifest.component_version,
        protocol_version: manifest.protocol_version,
        target: asset.target,
        runtime_name: asset.executable_name,
        model_name: asset.model_file_name,
        args: asset.args,
        manifest_sha256: config.sha256,
    };
    let metadata_json = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize voice STT metadata: {}", e))?;
    fs::write(install_path(&app)?, metadata_json)
        .map_err(|e| format!("Failed to write voice STT metadata: {}", e))?;

    Ok(build_status(&app))
}

fn audio_extension(mime_type: Option<&str>) -> &'static str {
    let mime = mime_type.unwrap_or_default();
    if mime.contains("wav") {
        "wav"
    } else if mime.contains("mp4") || mime.contains("m4a") {
        "m4a"
    } else if mime.contains("ogg") {
        "ogg"
    } else {
        "webm"
    }
}

fn command_args(
    metadata: &VoiceInstallMetadata,
    model_path: &Path,
    audio_path: &Path,
) -> Vec<String> {
    match metadata.args.as_ref().filter(|args| !args.is_empty()) {
        Some(args) => args
            .iter()
            .map(|arg| {
                arg.replace("{model}", &model_path.to_string_lossy())
                    .replace("{input}", &audio_path.to_string_lossy())
            })
            .collect(),
        None => vec![
            "--model".to_string(),
            model_path.to_string_lossy().to_string(),
            "--input".to_string(),
            audio_path.to_string_lossy().to_string(),
            "--output-json".to_string(),
        ],
    }
}

fn read_capped<R: Read>(r: &mut R, cap: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let room = cap.saturating_sub(buf.len());
                if room > 0 {
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
            Err(_) => break,
        }
    }
    buf
}

fn run_transcription_sidecar(
    runtime_path: PathBuf,
    model_path: PathBuf,
    audio_path: PathBuf,
    metadata: VoiceInstallMetadata,
) -> Result<VoiceTranscriptionResult, String> {
    let mut child = Command::new(&runtime_path)
        .args(command_args(&metadata, &model_path, &audio_path))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start voice STT runtime: {}", e))?;

    let mut out_pipe = child
        .stdout
        .take()
        .ok_or("voice STT runtime had no stdout pipe")?;
    let mut err_pipe = child
        .stderr
        .take()
        .ok_or("voice STT runtime had no stderr pipe")?;
    let out_handle = std::thread::spawn(move || read_capped(&mut out_pipe, 1024 * 1024));
    let err_handle = std::thread::spawn(move || read_capped(&mut err_pipe, 256 * 1024));

    let start = Instant::now();
    let timeout = Duration::from_millis(TRANSCRIBE_TIMEOUT_MS);
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Voice transcription timed out.".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed waiting on voice STT runtime: {}", e));
            }
        }
    };

    let stdout = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).to_string();
    if exit_code != 0 {
        return Err(format!(
            "Voice STT runtime exited with code {}: {}",
            exit_code,
            stderr.trim()
        ));
    }

    if let Ok(parsed) = serde_json::from_str::<SidecarTranscription>(&stdout) {
        return Ok(VoiceTranscriptionResult {
            text: parsed.text,
            language: parsed.language,
            duration_ms: parsed.duration_ms,
            confidence: parsed.confidence,
            source: "local-sidecar".to_string(),
        });
    }

    let text = stdout.trim().to_string();
    if text.is_empty() {
        Err("Voice STT runtime returned an empty transcript.".to_string())
    } else {
        Ok(VoiceTranscriptionResult {
            text,
            language: None,
            duration_ms: None,
            confidence: None,
            source: "local-sidecar".to_string(),
        })
    }
}

#[tauri::command]
pub async fn transcribe_voice_audio(
    app: AppHandle,
    audio_base64: String,
    mime_type: Option<String>,
) -> Result<VoiceTranscriptionResult, String> {
    let metadata = read_install_metadata(&app)?
        .ok_or_else(|| "Voice STT component is not installed.".to_string())?;
    let (runtime_path, model_path) = installed_paths(&app, &metadata)?;
    if !runtime_path.exists() || !model_path.exists() {
        return Err("Voice STT component is incomplete. Reinstall the component.".to_string());
    }

    let audio = general_purpose::STANDARD
        .decode(audio_base64)
        .map_err(|e| format!("Failed to decode recorded audio: {}", e))?;
    if audio.is_empty() {
        return Err("Recorded audio was empty.".to_string());
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err("Recorded audio is too large to transcribe locally.".to_string());
    }

    let root = component_root(&app)?;
    let scratch = root.join("scratch");
    fs::create_dir_all(&scratch)
        .map_err(|e| format!("Failed to create voice STT scratch directory: {}", e))?;
    let audio_path = scratch.join(format!(
        "recording-{}.{}",
        uuid::Uuid::new_v4(),
        audio_extension(mime_type.as_deref())
    ));
    fs::write(&audio_path, audio).map_err(|e| format!("Failed to write recorded audio: {}", e))?;

    let task_result = tokio::task::spawn_blocking({
        let runtime_path = runtime_path.clone();
        let model_path = model_path.clone();
        let audio_path = audio_path.clone();
        move || run_transcription_sidecar(runtime_path, model_path, audio_path, metadata)
    })
    .await;

    let _ = fs::remove_file(&audio_path);
    task_result.map_err(|e| format!("voice STT task join error: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_value() {
        assert_eq!(
            sha256_hex(b"workx"),
            "3be1adfa4a5684d98dffd8878a109fd7926c0419eafaf871e00c8a4c3251d0bf"
        );
    }

    #[test]
    fn command_args_substitutes_manifest_placeholders() {
        let metadata = VoiceInstallMetadata {
            component_version: "1".to_string(),
            protocol_version: 1,
            target: current_target(),
            runtime_name: "runtime".to_string(),
            model_name: "model.bin".to_string(),
            args: Some(vec![
                "--model={model}".to_string(),
                "--audio={input}".to_string(),
            ]),
            manifest_sha256: None,
        };
        let args = command_args(&metadata, Path::new("/m.bin"), Path::new("/a.webm"));
        assert_eq!(args, vec!["--model=/m.bin", "--audio=/a.webm"]);
    }

    #[test]
    fn download_url_policy_allows_https_and_localhost_only() {
        assert!(is_allowed_download_url("https://cdn.example.com/model.bin"));
        assert!(is_allowed_download_url("http://localhost:5173/model.bin"));
        assert!(is_allowed_download_url("http://127.0.0.1:5173/model.bin"));
        assert!(!is_allowed_download_url("http://example.com/model.bin"));
        assert!(!is_allowed_download_url(
            "http://localhost.evil.example/model.bin"
        ));
        assert!(!is_allowed_download_url("file:///tmp/model.bin"));
    }

    #[test]
    fn component_paths_reject_traversal_and_nested_names() {
        let root = Path::new("/tmp/voice");
        assert_eq!(
            safe_component_path(root, "workx-stt", "runtime").unwrap(),
            root.join("workx-stt")
        );
        assert!(safe_component_path(root, "../workx-stt", "runtime").is_err());
        assert!(safe_component_path(root, "nested/workx-stt", "runtime").is_err());
        assert!(safe_component_path(root, "nested\\workx-stt.exe", "runtime").is_err());
        assert!(safe_component_path(root, "C:workx-stt.exe", "runtime").is_err());
    }

    #[test]
    fn remote_manifest_requires_a_pinned_hash() {
        assert!(
            validate_manifest_config("https://cdn.example.com/stable.json".to_string(), None,)
                .is_err()
        );
        assert!(validate_manifest_config(
            "https://cdn.example.com/stable.json".to_string(),
            Some("abc123".to_string()),
        )
        .is_ok());
        assert!(
            validate_manifest_config("http://localhost:5173/stable.json".to_string(), None,)
                .is_ok()
        );
    }
}
