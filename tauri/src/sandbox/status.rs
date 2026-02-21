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

/// Parse the distro ID from /etc/os-release content.
/// Returns the value of the ID= line, or empty string if not found.
fn parse_distro_id(os_release: &str) -> &str {
    os_release
        .lines()
        .find(|line| line.starts_with("ID="))
        .map(|line| line.trim_start_matches("ID=").trim_matches('"'))
        .unwrap_or("")
}

/// Select the package manager and args for a given distro ID.
/// Returns None if the distro is unsupported.
fn select_package_manager(distro_id: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match distro_id {
        "ubuntu" | "debian" | "pop" | "linuxmint" | "elementary" | "zorin" => {
            Some(("apt-get", vec!["install", "-y", "bubblewrap"]))
        }
        "fedora" | "rhel" | "centos" | "rocky" | "alma" => {
            Some(("dnf", vec!["install", "-y", "bubblewrap"]))
        }
        "arch" | "manjaro" | "endeavouros" => {
            Some(("pacman", vec!["-S", "--noconfirm", "bubblewrap"]))
        }
        "opensuse" | "suse" | "opensuse-leap" | "opensuse-tumbleweed" => {
            Some(("zypper", vec!["install", "-y", "bubblewrap"]))
        }
        _ => None,
    }
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
            status: "unavailable".to_string(),
            runtime: "appcontainer".to_string(),
            os: os.to_string(),
            version: None,
            message: Some("AppContainer sandbox is not yet implemented. Commands will run without sandbox isolation.".to_string()),
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
                    let message = if is_apparmor_userns_restricted() {
                        log::warn!("bwrap found but blocked by AppArmor unprivileged userns restriction");
                        "bubblewrap is installed but blocked by AppArmor. \
                         Click \"Install / Fix\" to create an AppArmor profile for bwrap."
                            .to_string()
                    } else if is_userns_clone_disabled() {
                        log::warn!("bwrap found but unprivileged_userns_clone is disabled");
                        "bubblewrap is installed but user namespaces are disabled. \
                         Click \"Install / Fix\" to enable them."
                            .to_string()
                    } else {
                        log::warn!("bwrap found but smoke test failed for unknown reason");
                        "bubblewrap is installed but not functional. \
                         Click \"Install / Fix\" to attempt automatic repair."
                            .to_string()
                    };

                    Ok(SandboxStatusResult {
                        status: "unavailable".to_string(),
                        runtime: "bwrap".to_string(),
                        os: os.to_string(),
                        version: None,
                        message: Some(message),
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

/// Check if AppArmor is restricting unprivileged user namespaces (Ubuntu 24.04+)
#[cfg(target_os = "linux")]
fn is_apparmor_userns_restricted() -> bool {
    std::fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
}

/// Check if the kernel sysctl blocks unprivileged user namespaces
/// (older Debian, hardened kernels)
#[cfg(target_os = "linux")]
fn is_userns_clone_disabled() -> bool {
    std::fs::read_to_string("/proc/sys/kernel/unprivileged_userns_clone")
        .map(|v| v.trim() == "0")
        .unwrap_or(false) // file missing means kernel doesn't have this knob (userns allowed)
}

/// Check if an AppArmor profile already exists for bwrap
#[cfg(target_os = "linux")]
fn has_bwrap_apparmor_profile() -> bool {
    let profile_path = std::path::Path::new("/etc/apparmor.d/bwrap");
    if !profile_path.exists() {
        return false;
    }
    // Verify it contains the userns permission
    std::fs::read_to_string(profile_path)
        .map(|content| content.contains("userns"))
        .unwrap_or(false)
}

/// Enable unprivileged user namespaces via sysctl.
/// Required on older Debian and hardened kernels where
/// kernel.unprivileged_userns_clone=0.
/// Sets the runtime value and persists it across reboots.
/// Uses pkexec for GUI-friendly privilege escalation.
#[cfg(target_os = "linux")]
async fn enable_userns_clone() -> Result<(), String> {
    // Set runtime value and persist across reboots in a single pkexec call
    let output = tokio::process::Command::new("pkexec")
        .args([
            "sh", "-c",
            "sysctl -w kernel.unprivileged_userns_clone=1 && \
             printf 'kernel.unprivileged_userns_clone=1\\n' > /etc/sysctl.d/99-bwrap-userns.conf"
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run pkexec: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to enable user namespaces: {}", stderr));
    }

    log::info!("Unprivileged user namespaces enabled successfully");
    Ok(())
}

/// Create an AppArmor profile for bwrap and load it.
/// Required on Ubuntu 24.04+ where unprivileged user namespaces are
/// restricted by AppArmor. Uses the same pattern as lxc-usernsexec.
/// Uses pkexec for GUI-friendly privilege escalation.
#[cfg(target_os = "linux")]
async fn install_bwrap_apparmor_profile() -> Result<(), String> {
    // Write profile and reload in a single pkexec call to only prompt once.
    // Uses a here-document via sh -c to write the profile content.
    let output = tokio::process::Command::new("pkexec")
        .args([
            "sh", "-c",
            r#"cat > /etc/apparmor.d/bwrap << 'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
PROFILE
apparmor_parser -r /etc/apparmor.d/bwrap"#
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run pkexec: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install AppArmor profile: {}", stderr));
    }

    log::info!("AppArmor profile for bwrap installed and loaded successfully");
    Ok(())
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
    let bwrap_exists = which::which("bwrap").is_ok();

    // If bwrap is already installed, try to fix known blockers
    if bwrap_exists {
        let mut fixed_something = false;

        // Fix 1: AppArmor userns restriction (Ubuntu 24.04+, possibly Debian/openSUSE)
        if is_apparmor_userns_restricted() && !has_bwrap_apparmor_profile() {
            log::info!("bwrap already installed; AppArmor userns restriction detected, installing profile...");
            if let Err(e) = install_bwrap_apparmor_profile().await {
                return Ok(SandboxInstallResult {
                    success: false,
                    message: format!("AppArmor profile setup failed: {}", e),
                });
            }
            fixed_something = true;
        }

        // Fix 2: unprivileged_userns_clone=0 (older Debian, hardened kernels)
        if is_userns_clone_disabled() {
            log::info!("bwrap already installed; unprivileged_userns_clone disabled, enabling...");
            if let Err(e) = enable_userns_clone().await {
                return Ok(SandboxInstallResult {
                    success: false,
                    message: format!("Failed to enable user namespaces: {}", e),
                });
            }
            fixed_something = true;
        }

        // Verify after fixes (or check if it was already working)
        let smoke = tokio::process::Command::new("bwrap")
            .args(["--ro-bind", "/usr", "/usr", "--", "/usr/bin/true"])
            .output()
            .await;

        if matches!(&smoke, Ok(o) if o.status.success()) {
            let message = if fixed_something {
                "System configuration fixed — bubblewrap is now functional".to_string()
            } else {
                "bubblewrap is already installed and functional".to_string()
            };
            return Ok(SandboxInstallResult {
                success: true,
                message,
            });
        }

        // If we tried fixes and still failed, report it
        if fixed_something {
            return Ok(SandboxInstallResult {
                success: false,
                message: "Applied fixes but bubblewrap smoke test still failed".to_string(),
            });
        }

        // bwrap exists but smoke test fails for an unknown reason — don't
        // fall through to the package-install path (reinstalling won't help).
        return Ok(SandboxInstallResult {
            success: false,
            message: "bubblewrap is installed but not functional for an unknown reason. \
                     Check kernel and AppArmor configuration manually.".to_string(),
        });
    }

    // Detect distro from /etc/os-release
    let os_release = tokio::fs::read_to_string("/etc/os-release")
        .await
        .unwrap_or_default();

    let distro_id = parse_distro_id(&os_release);

    let (pm, args) = match select_package_manager(distro_id) {
        Some(result) => result,
        None => {
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

    let output = tokio::process::Command::new("pkexec")
        .arg(pm)
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Failed to run pkexec {}: {}", pm, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        log::error!("Failed to install bubblewrap: {}", stderr);
        return Ok(SandboxInstallResult {
            success: false,
            message: format!(
                "Failed to install bubblewrap via {}. Authentication may have been cancelled. Error: {}",
                pm, stderr
            ),
        });
    }

    log::info!("bubblewrap package installed successfully");

    // Fix known blockers that prevent bwrap from working after installation.

    // AppArmor userns restriction (Ubuntu 24.04+, Debian, openSUSE with AppArmor)
    if is_apparmor_userns_restricted() && !has_bwrap_apparmor_profile() {
        log::info!("AppArmor userns restriction detected, installing bwrap profile...");
        if let Err(e) = install_bwrap_apparmor_profile().await {
            log::error!("Failed to install AppArmor profile: {}", e);
            return Ok(SandboxInstallResult {
                success: false,
                message: format!(
                    "bubblewrap installed but AppArmor profile setup failed: {}. \
                     Sandbox will not work until this is resolved.",
                    e
                ),
            });
        }
    }

    // Sysctl userns restriction (older Debian, hardened kernels)
    if is_userns_clone_disabled() {
        log::info!("unprivileged_userns_clone disabled, enabling...");
        if let Err(e) = enable_userns_clone().await {
            log::error!("Failed to enable user namespaces: {}", e);
            return Ok(SandboxInstallResult {
                success: false,
                message: format!(
                    "bubblewrap installed but failed to enable user namespaces: {}. \
                     Sandbox will not work until this is resolved.",
                    e
                ),
            });
        }
    }

    // Verify with a smoke test
    let smoke = tokio::process::Command::new("bwrap")
        .args(["--ro-bind", "/usr", "/usr", "--", "/usr/bin/true"])
        .output()
        .await;

    match smoke {
        Ok(result) if result.status.success() => {
            Ok(SandboxInstallResult {
                success: true,
                message: "bubblewrap installed and verified successfully".to_string(),
            })
        }
        _ => {
            Ok(SandboxInstallResult {
                success: false,
                message: "bubblewrap installed but smoke test failed. \
                         Sandbox may not work correctly in this environment."
                    .to_string(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_distro_id_ubuntu() {
        let content = "NAME=\"Ubuntu\"\nID=ubuntu\nVERSION_ID=\"24.04\"";
        assert_eq!(parse_distro_id(content), "ubuntu");
    }

    #[test]
    fn test_parse_distro_id_fedora() {
        let content = "NAME=Fedora\nID=fedora\nVERSION_ID=40";
        assert_eq!(parse_distro_id(content), "fedora");
    }

    #[test]
    fn test_parse_distro_id_arch() {
        let content = "NAME=\"Arch Linux\"\nID=arch\n";
        assert_eq!(parse_distro_id(content), "arch");
    }

    #[test]
    fn test_parse_distro_id_quoted() {
        let content = "ID=\"debian\"";
        assert_eq!(parse_distro_id(content), "debian");
    }

    #[test]
    fn test_parse_distro_id_missing() {
        let content = "NAME=SomeOS\nVERSION=1.0";
        assert_eq!(parse_distro_id(content), "");
    }

    #[test]
    fn test_parse_distro_id_empty() {
        assert_eq!(parse_distro_id(""), "");
    }

    #[test]
    fn test_select_package_manager_ubuntu() {
        let (pm, _) = select_package_manager("ubuntu").unwrap();
        assert_eq!(pm, "apt-get");
    }

    #[test]
    fn test_select_package_manager_debian() {
        let (pm, _) = select_package_manager("debian").unwrap();
        assert_eq!(pm, "apt-get");
    }

    #[test]
    fn test_select_package_manager_fedora() {
        let (pm, _) = select_package_manager("fedora").unwrap();
        assert_eq!(pm, "dnf");
    }

    #[test]
    fn test_select_package_manager_arch() {
        let (pm, _) = select_package_manager("arch").unwrap();
        assert_eq!(pm, "pacman");
    }

    #[test]
    fn test_select_package_manager_opensuse() {
        let (pm, _) = select_package_manager("opensuse").unwrap();
        assert_eq!(pm, "zypper");
    }

    #[test]
    fn test_select_package_manager_unsupported() {
        assert!(select_package_manager("gentoo").is_none());
    }

    #[test]
    fn test_select_package_manager_empty() {
        assert!(select_package_manager("").is_none());
    }
}
