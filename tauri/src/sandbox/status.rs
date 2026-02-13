use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SandboxStatusResult {
    pub status: String,
    pub runtime: String,
    pub os: String,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SandboxInstallResult {
    pub success: bool,
    pub message: String,
}

/// Check sandbox runtime availability on the current platform
#[tauri::command]
pub async fn sandbox_check_status() -> Result<SandboxStatusResult, String> {
    let os = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unknown"
    };

    #[cfg(target_os = "linux")]
    {
        return check_linux_status(os).await;
    }

    #[cfg(target_os = "macos")]
    {
        return check_macos_status(os).await;
    }

    #[cfg(target_os = "windows")]
    {
        return Ok(SandboxStatusResult {
            status: "available".to_string(),
            runtime: "appcontainer".to_string(),
            os: os.to_string(),
            version: None,
            message: Some("AppContainer available (Windows 10+)".to_string()),
        });
    }

    #[allow(unreachable_code)]
    Ok(SandboxStatusResult {
        status: "unavailable".to_string(),
        runtime: "none".to_string(),
        os: os.to_string(),
        version: None,
        message: Some("Unsupported platform".to_string()),
    })
}

#[cfg(target_os = "linux")]
async fn check_linux_status(os: &str) -> Result<SandboxStatusResult, String> {
    // Check if bwrap exists
    match which::which("bwrap") {
        Ok(_) => {
            // Run functional smoke test
            let smoke = tokio::process::Command::new("bwrap")
                .args(["--ro-bind", "/usr", "/usr", "--", "/usr/bin/true"])
                .output()
                .await;

            match smoke {
                Ok(output) if output.status.success() => {
                    // Try to get version
                    let version = tokio::process::Command::new("bwrap")
                        .arg("--version")
                        .output()
                        .await
                        .ok()
                        .and_then(|v| {
                            String::from_utf8_lossy(&v.stdout)
                                .trim()
                                .strip_prefix("bubblewrap ")
                                .map(|s| s.to_string())
                        });

                    log::info!(
                        "Sandbox runtime: bwrap {} available",
                        version.as_deref().unwrap_or("(unknown version)")
                    );

                    Ok(SandboxStatusResult {
                        status: "available".to_string(),
                        runtime: "bwrap".to_string(),
                        os: os.to_string(),
                        version,
                        message: Some("bubblewrap is installed and functional".to_string()),
                    })
                }
                _ => {
                    log::warn!("bwrap found but smoke test failed — user namespaces may be disabled");
                    Ok(SandboxStatusResult {
                        status: "unavailable".to_string(),
                        runtime: "bwrap".to_string(),
                        os: os.to_string(),
                        version: None,
                        message: Some(
                            "bubblewrap is installed but not functional. User namespaces may be disabled. \
                             Try: sudo sysctl kernel.unprivileged_userns_clone=1"
                                .to_string(),
                        ),
                    })
                }
            }
        }
        Err(_) => {
            log::info!("Sandbox runtime: bwrap not found, needs installation");
            Ok(SandboxStatusResult {
                status: "needs-installation".to_string(),
                runtime: "bwrap".to_string(),
                os: os.to_string(),
                version: None,
                message: Some("bubblewrap is not installed".to_string()),
            })
        }
    }
}

#[cfg(target_os = "macos")]
async fn check_macos_status(os: &str) -> Result<SandboxStatusResult, String> {
    match which::which("sandbox-exec") {
        Ok(_) => {
            log::info!("Sandbox runtime: sandbox-exec available");
            Ok(SandboxStatusResult {
                status: "available".to_string(),
                runtime: "sandbox-exec".to_string(),
                os: os.to_string(),
                version: None,
                message: Some("sandbox-exec is available".to_string()),
            })
        }
        Err(_) => Ok(SandboxStatusResult {
            status: "unavailable".to_string(),
            runtime: "sandbox-exec".to_string(),
            os: os.to_string(),
            version: None,
            message: Some("sandbox-exec not found".to_string()),
        }),
    }
}

/// Install sandbox runtime (Linux only — installs bubblewrap)
#[tauri::command]
pub async fn sandbox_install_runtime() -> Result<SandboxInstallResult, String> {
    #[cfg(not(target_os = "linux"))]
    {
        return Err("Sandbox runtime ships with the OS on this platform. No installation needed.".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        install_bwrap_linux().await
    }
}

#[cfg(target_os = "linux")]
async fn install_bwrap_linux() -> Result<SandboxInstallResult, String> {
    // Detect distro from /etc/os-release
    let os_release = tokio::fs::read_to_string("/etc/os-release")
        .await
        .unwrap_or_default();

    let distro_id = os_release
        .lines()
        .find(|line| line.starts_with("ID="))
        .map(|line| line.trim_start_matches("ID=").trim_matches('"'))
        .unwrap_or("");

    let (pm, args): (&str, Vec<&str>) = match distro_id {
        "ubuntu" | "debian" | "pop" | "linuxmint" | "elementary" | "zorin" => {
            ("apt-get", vec!["install", "-y", "bubblewrap"])
        }
        "fedora" | "rhel" | "centos" | "rocky" | "alma" => {
            ("dnf", vec!["install", "-y", "bubblewrap"])
        }
        "arch" | "manjaro" | "endeavouros" => {
            ("pacman", vec!["-S", "--noconfirm", "bubblewrap"])
        }
        "opensuse" | "suse" | "opensuse-leap" | "opensuse-tumbleweed" => {
            ("zypper", vec!["install", "-y", "bubblewrap"])
        }
        _ => {
            return Ok(SandboxInstallResult {
                success: false,
                message: format!(
                    "Unsupported Linux distribution '{}'. Please install bubblewrap manually: \
                     https://github.com/containers/bubblewrap",
                    distro_id
                ),
            });
        }
    };

    log::info!("Installing bubblewrap via {}...", pm);

    let output = tokio::process::Command::new(pm)
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Failed to run {}: {}", pm, e))?;

    if output.status.success() {
        log::info!("bubblewrap installed successfully");
        Ok(SandboxInstallResult {
            success: true,
            message: "bubblewrap installed successfully".to_string(),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        log::error!("Failed to install bubblewrap: {}", stderr);
        Ok(SandboxInstallResult {
            success: false,
            message: format!(
                "Failed to install bubblewrap via {}. You may need sudo access. Error: {}",
                pm, stderr
            ),
        })
    }
}
