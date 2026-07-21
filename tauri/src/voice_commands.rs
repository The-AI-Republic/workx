use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

const MANIFEST_URL_ENV: &str = "WORKX_VOICE_STT_MANIFEST_URL";
const MANIFEST_SHA256_ENV: &str = "WORKX_VOICE_STT_MANIFEST_SHA256";
const BUILT_MANIFEST_URL: Option<&str> = option_env!("WORKX_VOICE_STT_MANIFEST_URL");
const BUILT_MANIFEST_SHA256: Option<&str> = option_env!("WORKX_VOICE_STT_MANIFEST_SHA256");
const COMPONENT_DIR: &str = "voice-stt";
const INSTALL_FILE: &str = "install.json";
const SUPPORTED_PROTOCOL_VERSION: u32 = 1;
const MAX_AUDIO_BYTES: usize = 50 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_RUNTIME_BYTES: usize = 512 * 1024 * 1024;
const MAX_MODEL_BYTES: usize = 1024 * 1024 * 1024;
const MANIFEST_DOWNLOAD_TIMEOUT_SECS: u64 = 30;
const ASSET_DOWNLOAD_TIMEOUT_SECS: u64 = 600;
const TRANSCRIBE_TIMEOUT_MS: u64 = 120_000;

#[derive(Default)]
pub struct VoiceSttState {
    operation: Mutex<()>,
}

#[derive(Debug, Clone)]
struct ManifestConfig {
    url: String,
    sha256: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSttStatus {
    pub configured: bool,
    pub available: bool,
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

fn non_empty_built(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn is_valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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
    let url = runtime_url.or_else(|| non_empty_built(BUILT_MANIFEST_URL));
    let Some(url) = url else {
        return Ok(None);
    };
    let sha256 = runtime_sha256.or_else(|| non_empty_built(BUILT_MANIFEST_SHA256));
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
    if let Some(value) = sha256.as_deref() {
        if !is_valid_sha256(value) {
            return Err(format!(
                "{} must be exactly 64 hexadecimal characters.",
                MANIFEST_SHA256_ENV
            ));
        }
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
                    available: installed,
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
                available: false,
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
            available: false,
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
            available: false,
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

async fn fetch_response(
    url: &str,
    label: &str,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Failed to create voice STT download client: {}", e))?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download voice STT {}: {}", label, e))?
        .error_for_status()
        .map_err(|e| format!("Voice STT {} request failed: {}", label, e))
}

fn ensure_content_length(
    response: &reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<(), String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!(
            "Voice STT {} exceeds the {} byte download limit.",
            label, max_bytes
        ));
    }
    Ok(())
}

async fn fetch_bytes(url: &str, max_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
    let mut response = fetch_response(
        url,
        label,
        Duration::from_secs(MANIFEST_DOWNLOAD_TIMEOUT_SECS),
    )
    .await?;
    ensure_content_length(&response, max_bytes, label)?;
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or_default()
            .min(max_bytes as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to read voice STT {}: {}", label, e))?
    {
        if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
            return Err(format!(
                "Voice STT {} exceeds the {} byte download limit.",
                label, max_bytes
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
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

fn temporary_download_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("asset");
    path.with_file_name(format!(".{}.download-{}", file_name, uuid::Uuid::new_v4()))
}

async fn replace_file(source: &Path, destination: &Path, label: &str) -> Result<(), String> {
    #[cfg(windows)]
    if destination.exists() {
        tokio::fs::remove_file(destination)
            .await
            .map_err(|e| format!("Failed to replace voice STT {}: {}", label, e))?;
    }
    tokio::fs::rename(source, destination)
        .await
        .map_err(|e| format!("Failed to install voice STT {}: {}", label, e))
}

async fn download_verified_file(
    url: &str,
    expected_sha256: &str,
    path: &Path,
    max_bytes: usize,
    label: &str,
) -> Result<(), String> {
    let tmp = temporary_download_path(path);
    let result = async {
        let mut response =
            fetch_response(url, label, Duration::from_secs(ASSET_DOWNLOAD_TIMEOUT_SECS)).await?;
        ensure_content_length(&response, max_bytes, label)?;
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)
            .await
            .map_err(|e| format!("Failed to create temporary voice STT {}: {}", label, e))?;
        let mut hasher = Sha256::new();
        let mut total = 0usize;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Failed to read voice STT {}: {}", label, e))?
        {
            if chunk.len() > max_bytes.saturating_sub(total) {
                return Err(format!(
                    "Voice STT {} exceeds the {} byte download limit.",
                    label, max_bytes
                ));
            }
            total += chunk.len();
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Failed to write voice STT {}: {}", label, e))?;
        }
        file.flush()
            .await
            .map_err(|e| format!("Failed to flush voice STT {}: {}", label, e))?;
        let actual: String = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{:02x}", byte))
            .collect();
        if !actual.eq_ignore_ascii_case(expected_sha256) {
            return Err(format!(
                "{} SHA-256 mismatch. expected {}, got {}",
                label, expected_sha256, actual
            ));
        }
        drop(file);
        replace_file(&tmp, path, label).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}

async fn write_atomic(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let tmp = temporary_download_path(path);
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)
            .await
            .map_err(|e| format!("Failed to create temporary voice STT {}: {}", label, e))?;
        file.write_all(bytes)
            .await
            .map_err(|e| format!("Failed to write voice STT {}: {}", label, e))?;
        file.flush()
            .await
            .map_err(|e| format!("Failed to flush voice STT {}: {}", label, e))?;
        drop(file);
        replace_file(&tmp, path, label).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
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

fn validate_asset(asset: &VoiceAsset) -> Result<(), String> {
    if !is_allowed_download_url(&asset.runtime_url) || !is_allowed_download_url(&asset.model_url) {
        return Err(
            "Voice STT asset URLs must use HTTPS (or loopback HTTP for development).".to_string(),
        );
    }
    if !is_valid_sha256(&asset.runtime_sha256) || !is_valid_sha256(&asset.model_sha256) {
        return Err("Voice STT asset hashes must be 64 hexadecimal characters.".to_string());
    }
    safe_component_path(Path::new("."), &asset.executable_name, "executable name")?;
    safe_component_path(Path::new("."), &asset.model_file_name, "model file name")?;
    if asset
        .executable_name
        .eq_ignore_ascii_case(&asset.model_file_name)
    {
        return Err("Voice STT runtime and model must use different file names.".to_string());
    }
    if asset.executable_name.eq_ignore_ascii_case(INSTALL_FILE)
        || asset.model_file_name.eq_ignore_ascii_case(INSTALL_FILE)
    {
        return Err("Voice STT assets cannot overwrite install metadata.".to_string());
    }
    Ok(())
}

async fn fetch_manifest_asset(
    config: &ManifestConfig,
) -> Result<(VoiceManifest, VoiceAsset), String> {
    let manifest_bytes = fetch_bytes(&config.url, MAX_MANIFEST_BYTES, "manifest").await?;
    if let Some(expected) = config.sha256.as_deref() {
        verify_sha256(&manifest_bytes, expected, "manifest")?;
    }
    let manifest: VoiceManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Failed to parse voice STT manifest: {}", e))?;
    if manifest.component_version.trim().is_empty() {
        return Err("Voice STT manifest component version is empty.".to_string());
    }
    if manifest.protocol_version != SUPPORTED_PROTOCOL_VERSION {
        return Err(format!(
            "Voice STT manifest protocol {} is unsupported (expected {}).",
            manifest.protocol_version, SUPPORTED_PROTOCOL_VERSION
        ));
    }
    let asset = pick_asset(&manifest)?;
    validate_asset(&asset)?;
    Ok((manifest, asset))
}

#[tauri::command]
pub async fn voice_stt_status(app: AppHandle) -> VoiceSttStatus {
    let mut status = build_status(&app);
    if status.installed {
        return status;
    }
    let Ok(Some(config)) = manifest_config() else {
        return status;
    };
    match fetch_manifest_asset(&config).await {
        Ok(_) => {
            status.available = true;
            status.error = None;
        }
        Err(error) => {
            status.error = Some(error);
        }
    }
    status
}

#[tauri::command]
pub async fn install_voice_stt_component(
    app: AppHandle,
    state: State<'_, VoiceSttState>,
) -> Result<VoiceSttStatus, String> {
    let _operation = state.operation.lock().await;
    let status = build_status(&app);
    if status.installed {
        return Ok(status);
    }
    let config = manifest_config()?.ok_or_else(|| {
        format!(
            "Voice STT is not configured. Set {} and {} when building the desktop app.",
            MANIFEST_URL_ENV, MANIFEST_SHA256_ENV
        )
    })?;
    let (manifest, asset) = fetch_manifest_asset(&config).await?;

    let root = component_root(&app)?;
    fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create voice STT component directory: {}", e))?;

    let runtime_path = safe_component_path(&root, &asset.executable_name, "executable name")?;
    download_verified_file(
        &asset.runtime_url,
        &asset.runtime_sha256,
        &runtime_path,
        MAX_RUNTIME_BYTES,
        "runtime",
    )
    .await?;
    mark_executable(&runtime_path)?;

    let model_path = safe_component_path(&root, &asset.model_file_name, "model file name")?;
    download_verified_file(
        &asset.model_url,
        &asset.model_sha256,
        &model_path,
        MAX_MODEL_BYTES,
        "model",
    )
    .await?;

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
    write_atomic(
        &install_path(&app)?,
        metadata_json.as_bytes(),
        "install metadata",
    )
    .await?;

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

fn max_base64_len(decoded_bytes: usize) -> usize {
    decoded_bytes.saturating_add(2) / 3 * 4
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
    state: State<'_, VoiceSttState>,
    audio_base64: String,
    mime_type: Option<String>,
) -> Result<VoiceTranscriptionResult, String> {
    if audio_base64.len() > max_base64_len(MAX_AUDIO_BYTES) {
        return Err("Recorded audio is too large to transcribe locally.".to_string());
    }
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "Another voice STT operation is already in progress.".to_string())?;
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
            Some("a".repeat(64)),
        )
        .is_ok());
        assert!(validate_manifest_config(
            "https://cdn.example.com/stable.json".to_string(),
            Some("abc123".to_string()),
        )
        .is_err());
        assert!(
            validate_manifest_config("http://localhost:5173/stable.json".to_string(), None,)
                .is_ok()
        );
    }

    #[test]
    fn asset_validation_rejects_invalid_hashes_and_names() {
        let valid = VoiceAsset {
            target: current_target(),
            runtime_url: "https://cdn.example.com/runtime".to_string(),
            runtime_sha256: "a".repeat(64),
            model_url: "https://cdn.example.com/model".to_string(),
            model_sha256: "b".repeat(64),
            executable_name: "workx-stt".to_string(),
            model_file_name: "model.bin".to_string(),
            args: None,
        };
        assert!(validate_asset(&valid).is_ok());

        let mut invalid_hash = valid.clone();
        invalid_hash.runtime_sha256 = "not-a-hash".to_string();
        assert!(validate_asset(&invalid_hash).is_err());

        let mut invalid_name = valid;
        invalid_name.executable_name = "../workx-stt".to_string();
        assert!(validate_asset(&invalid_name).is_err());

        invalid_name.executable_name = "model.bin".to_string();
        assert!(validate_asset(&invalid_name).is_err());

        invalid_name.executable_name = INSTALL_FILE.to_string();
        assert!(validate_asset(&invalid_name).is_err());
    }

    #[test]
    fn base64_limit_covers_the_maximum_decoded_audio_size() {
        assert_eq!(max_base64_len(0), 0);
        assert_eq!(max_base64_len(1), 4);
        assert_eq!(max_base64_len(2), 4);
        assert_eq!(max_base64_len(3), 4);
        assert_eq!(max_base64_len(4), 8);
        assert!(max_base64_len(MAX_AUDIO_BYTES) > MAX_AUDIO_BYTES);
    }
}
