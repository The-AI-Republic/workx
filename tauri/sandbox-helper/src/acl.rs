//! NTFS ACL management for granting AppContainer SIDs access to specific paths.
//!
//! AppContainer processes cannot access any filesystem path unless the path's
//! DACL explicitly includes an ACE for the AppContainer SID. This module adds
//! and removes those ACEs.

#[cfg(windows)]
mod imp {
    use std::path::Path;
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::WIN32_ERROR;
    use windows::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
        EXPLICIT_ACCESS_W, SET_ACCESS, SE_FILE_OBJECT,
        TRUSTEE_W, TRUSTEE_IS_SID,
        NO_MULTIPLE_TRUSTEE, TRUSTEE_IS_WELL_KNOWN_GROUP,
    };
    // Note: In windows crate v0.58, PSID and SUB_CONTAINERS_AND_OBJECTS_INHERIT
    // moved from windows::core / Security::Authorization to windows::Win32::Security.
    use windows::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    };

    const FILE_GENERIC_READ: u32 = 0x0012_0089;
    const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
    const FILE_GENERIC_EXECUTE: u32 = 0x0012_00A0;
    const DELETE: u32 = 0x0001_0000;

    /// Access mode for ACL grants.
    #[derive(Debug, Clone, Copy)]
    pub enum AccessMode {
        ReadWrite,
        ReadOnly,
    }

    impl AccessMode {
        /// Return the Windows access mask for this mode.
        fn mask(self) -> u32 {
            match self {
                AccessMode::ReadWrite => {
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE
                }
                AccessMode::ReadOnly => FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            }
        }
    }

    /// RAII guard that restores the original DACL on drop.
    pub struct AclGuard {
        path: String,
        original_dacl: *mut ACL,
        security_descriptor: PSECURITY_DESCRIPTOR,
    }

    // SAFETY: The Win32 APIs used in Drop (SetNamedSecurityInfoW, LocalFree) are thread-safe.
    unsafe impl Send for AclGuard {}

    impl Drop for AclGuard {
        fn drop(&mut self) {
            let wide_path = HSTRING::from(&self.path);
            let result = unsafe {
                SetNamedSecurityInfoW(
                    PCWSTR(wide_path.as_ptr()),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    PSID::default(),
                    PSID::default(),
                    Some(self.original_dacl),
                    None,
                )
            };
            if result != WIN32_ERROR(0) {
                log::warn!(
                    "Failed to restore original DACL on '{}': error {}",
                    self.path,
                    result.0
                );
            } else {
                log::debug!("Restored original DACL on '{}'", self.path);
            }

            // Free the security descriptor allocated by GetNamedSecurityInfoW
            if !self.security_descriptor.0.is_null() {
                unsafe {
                    windows::Win32::Foundation::LocalFree(
                        windows::Win32::Foundation::HLOCAL(self.security_descriptor.0),
                    );
                }
            }
        }
    }

    /// Grant the AppContainer SID access to the given path and return a guard
    /// that restores the original DACL when dropped.
    pub fn grant_path_access(
        path: &Path,
        sid: PSID,
        access: AccessMode,
    ) -> Result<AclGuard, String> {
        let path_str = path.to_string_lossy().to_string();
        let wide_path = HSTRING::from(&path_str);

        // Read current DACL
        let mut old_dacl: *mut ACL = std::ptr::null_mut();
        let mut sd = PSECURITY_DESCRIPTOR::default();

        let err = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(wide_path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut old_dacl),
                None,
                &mut sd,
            )
        };
        if err != WIN32_ERROR(0) {
            return Err(format!(
                "GetNamedSecurityInfoW failed on '{}': error {}",
                path_str, err.0
            ));
        }

        // Build an explicit access entry for the AppContainer SID
        let trustee = TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
            ptstrName: PWSTR(sid.0 as *mut u16),
        };

        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: access.mask(),
            grfAccessMode: SET_ACCESS,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: trustee,
        };

        // Merge new ACE into existing DACL
        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        let err = unsafe {
            SetEntriesInAclW(
                Some(&[entry]),
                Some(old_dacl),
                &mut new_dacl,
            )
        };
        if err != WIN32_ERROR(0) {
            // Free sd before returning
            if !sd.0.is_null() {
                unsafe {
                    windows::Win32::Foundation::LocalFree(
                        windows::Win32::Foundation::HLOCAL(sd.0),
                    );
                }
            }
            return Err(format!(
                "SetEntriesInAclW failed on '{}': error {}",
                path_str, err.0
            ));
        }

        // Apply the new DACL
        let err = unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(wide_path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                PSID::default(),
                PSID::default(),
                Some(new_dacl),
                None,
            )
        };
        if err != WIN32_ERROR(0) {
            // Cleanup
            if !new_dacl.is_null() {
                unsafe {
                    windows::Win32::Foundation::LocalFree(
                        windows::Win32::Foundation::HLOCAL(new_dacl as *mut _),
                    );
                }
            }
            if !sd.0.is_null() {
                unsafe {
                    windows::Win32::Foundation::LocalFree(
                        windows::Win32::Foundation::HLOCAL(sd.0),
                    );
                }
            }
            return Err(format!(
                "SetNamedSecurityInfoW failed on '{}': error {}",
                path_str, err.0
            ));
        }

        // Free the new DACL (SetNamedSecurityInfoW copies it)
        if !new_dacl.is_null() {
            unsafe {
                windows::Win32::Foundation::LocalFree(
                    windows::Win32::Foundation::HLOCAL(new_dacl as *mut _),
                );
            }
        }

        log::info!(
            "Granted {:?} access on '{}' to AppContainer SID",
            access,
            path_str
        );

        Ok(AclGuard {
            path: path_str,
            original_dacl: old_dacl,
            security_descriptor: sd,
        })
    }

    /// Grant ACLs on all paths specified in a sandbox profile.
    /// Returns a Vec of guards; dropping them restores the original DACLs.
    pub fn grant_profile_access(
        profile: &crate::profile::SandboxProfile,
        sid: PSID,
    ) -> Result<Vec<AclGuard>, String> {
        use crate::profile::WorkspaceAccess;
        let mut guards = Vec::new();

        // Workspace directory
        match profile.workspace_access {
            WorkspaceAccess::Rw => {
                if profile.workspace_dir.exists() {
                    guards.push(grant_path_access(
                        &profile.workspace_dir,
                        sid,
                        AccessMode::ReadWrite,
                    )?);
                }
            }
            WorkspaceAccess::Ro => {
                if profile.workspace_dir.exists() {
                    guards.push(grant_path_access(
                        &profile.workspace_dir,
                        sid,
                        AccessMode::ReadOnly,
                    )?);
                }
            }
            WorkspaceAccess::None => {
                // No access to workspace
            }
        }

        // Standard writable paths
        for path in &profile.standard_writable {
            if path.exists() {
                guards.push(grant_path_access(path, sid, AccessMode::ReadWrite)?);
            }
        }

        // User-configured bind mounts
        for mount in &profile.bind_mounts {
            let mount_path = Path::new(&mount.host_path);
            if mount_path.exists() {
                let mode = if mount.access == "rw" {
                    AccessMode::ReadWrite
                } else {
                    AccessMode::ReadOnly
                };
                guards.push(grant_path_access(mount_path, sid, mode)?);
            }
        }

        // System paths needed for execution (read+execute)
        let system_paths = [
            r"C:\Windows\System32",
            r"C:\Windows\System32\WindowsPowerShell\v1.0",
        ];
        for sys_path in &system_paths {
            let p = Path::new(sys_path);
            if p.exists() {
                guards.push(grant_path_access(p, sid, AccessMode::ReadOnly)?);
            }
        }

        Ok(guards)
    }
}

#[cfg(windows)]
pub use imp::*;

// Stubs for non-Windows
#[cfg(not(windows))]
pub struct AclGuard;
