//! AppContainer profile creation and management via Win32 API.
//!
//! AppContainer is a Windows process isolation mechanism that restricts a process
//! to a minimal set of capabilities. By default an AppContainer process has no
//! filesystem, network, or registry access beyond what is explicitly granted.

#[cfg(windows)]
mod imp {
    use crate::profile::NetworkMode;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::path::Path;
    use windows::core::{HSTRING, PCWSTR, PWSTR, PSID};
    use windows::Win32::Foundation::{
        CloseHandle, BOOL, ERROR_ALREADY_EXISTS, HANDLE, LUID, WIN32_ERROR,
    };
    use windows::Win32::Security::{
        CreateWellKnownSid, FreeSid, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
        WinCapabilityInternetClientSid, WinCapabilityInternetClientServerSid,
        WELL_KNOWN_SID_TYPE,
    };
    use windows::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES;

    // FFI declarations for AppContainer APIs not yet in the `windows` crate bindings.
    // These live in userenv.dll.
    #[link(name = "userenv")]
    extern "system" {
        fn CreateAppContainerProfile(
            pszAppContainerName: PCWSTR,
            pszDisplayName: PCWSTR,
            pszDescription: PCWSTR,
            pCapabilities: *const SID_AND_ATTRIBUTES,
            dwCapabilityCount: u32,
            ppSidAppContainerSid: *mut PSID,
        ) -> windows::core::HRESULT;

        fn DeleteAppContainerProfile(
            pszAppContainerName: PCWSTR,
        ) -> windows::core::HRESULT;

        fn DeriveAppContainerSidFromAppContainerName(
            pszAppContainerName: PCWSTR,
            ppsidAppContainerSid: *mut PSID,
        ) -> windows::core::HRESULT;
    }

    /// A deterministic container name derived from the workspace path.
    pub fn container_name(workspace: &Path) -> String {
        let mut hasher = DefaultHasher::new();
        workspace.to_string_lossy().to_lowercase().hash(&mut hasher);
        format!("browserx-sandbox-{:016x}", hasher.finish())
    }

    /// RAII wrapper around an AppContainer SID allocated by the system.
    pub struct AppContainerSid {
        pub sid: PSID,
    }

    impl Drop for AppContainerSid {
        fn drop(&mut self) {
            if !self.sid.is_invalid() {
                unsafe { let _ = FreeSid(self.sid); }
            }
        }
    }

    /// Create a new AppContainer profile or retrieve the SID of an existing one.
    pub fn create_or_get_profile(name: &str) -> Result<AppContainerSid, String> {
        let wide_name = HSTRING::from(name);
        let wide_display = HSTRING::from(name);
        let wide_desc = HSTRING::from("browserx sandbox container");
        let mut sid = PSID::default();

        let hr = unsafe {
            CreateAppContainerProfile(
                PCWSTR(wide_name.as_ptr()),
                PCWSTR(wide_display.as_ptr()),
                PCWSTR(wide_desc.as_ptr()),
                std::ptr::null(),
                0,
                &mut sid,
            )
        };

        if hr.is_ok() {
            log::info!("Created new AppContainer profile: {}", name);
            return Ok(AppContainerSid { sid });
        }

        // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS) = 0x800700B7
        let already_exists: i32 = 0x800700B7_u32 as i32;
        if hr.0 == already_exists {
            log::info!("AppContainer profile already exists, deriving SID: {}", name);
            let mut sid = PSID::default();
            let hr2 = unsafe {
                DeriveAppContainerSidFromAppContainerName(
                    PCWSTR(wide_name.as_ptr()),
                    &mut sid,
                )
            };
            if hr2.is_ok() {
                return Ok(AppContainerSid { sid });
            }
            return Err(format!(
                "Failed to derive AppContainer SID for '{}': HRESULT 0x{:08X}",
                name, hr2.0 as u32
            ));
        }

        Err(format!(
            "Failed to create AppContainer profile '{}': HRESULT 0x{:08X}",
            name, hr.0 as u32
        ))
    }

    /// Delete an AppContainer profile. Errors are logged but not fatal.
    pub fn delete_profile(name: &str) {
        let wide_name = HSTRING::from(name);
        let hr = unsafe { DeleteAppContainerProfile(PCWSTR(wide_name.as_ptr())) };
        if hr.is_err() {
            log::warn!(
                "Failed to delete AppContainer profile '{}': HRESULT 0x{:08X}",
                name,
                hr.0 as u32
            );
        }
    }

    /// Create a well-known capability SID.
    fn create_capability_sid(sid_type: WELL_KNOWN_SID_TYPE) -> Result<Vec<u8>, String> {
        let mut size: u32 = 128;
        let mut buffer = vec![0u8; size as usize];
        let ok = unsafe {
            CreateWellKnownSid(
                sid_type,
                PSID::default(),
                PSID(buffer.as_mut_ptr() as *mut _),
                &mut size,
            )
        };
        if ok.is_err() {
            return Err(format!("CreateWellKnownSid failed for {:?}", sid_type));
        }
        buffer.truncate(size as usize);
        Ok(buffer)
    }

    /// Holds capability SIDs and the SECURITY_CAPABILITIES structure that
    /// references them. All allocations must live as long as the structure is
    /// used (e.g. passed to CreateProcessW).
    pub struct SecurityCaps {
        pub caps: SECURITY_CAPABILITIES,
        // Keep allocations alive
        _capability_sids: Vec<Vec<u8>>,
        _attrs: Vec<SID_AND_ATTRIBUTES>,
    }

    /// Build a `SECURITY_CAPABILITIES` structure for the given AppContainer SID
    /// and network mode.
    pub fn build_security_capabilities(
        container_sid: PSID,
        network_mode: &NetworkMode,
    ) -> Result<SecurityCaps, String> {
        let mut capability_sids = Vec::new();
        let mut attrs = Vec::new();

        if *network_mode == NetworkMode::Host {
            // Grant internet client and server capabilities
            let client_sid = create_capability_sid(WinCapabilityInternetClientSid)?;
            let server_sid = create_capability_sid(WinCapabilityInternetClientServerSid)?;

            capability_sids.push(client_sid);
            capability_sids.push(server_sid);
        }
        // NetworkMode::Sandbox: no capabilities → AppContainer blocks network by default

        for sid_buf in &capability_sids {
            attrs.push(SID_AND_ATTRIBUTES {
                Sid: PSID(sid_buf.as_ptr() as *mut _),
                Attributes: 0x00000004, // SE_GROUP_ENABLED
            });
        }

        let caps = SECURITY_CAPABILITIES {
            AppContainerSid: container_sid,
            Capabilities: if attrs.is_empty() {
                std::ptr::null_mut()
            } else {
                attrs.as_ptr() as *mut _
            },
            CapabilityCount: attrs.len() as u32,
            Reserved: 0,
        };

        Ok(SecurityCaps {
            caps,
            _capability_sids: capability_sids,
            _attrs: attrs,
        })
    }
}

#[cfg(windows)]
pub use imp::*;

// Stubs for non-Windows compilation (allows cargo check on Linux/macOS)
#[cfg(not(windows))]
pub fn container_name(workspace: &std::path::Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    workspace.to_string_lossy().to_lowercase().hash(&mut hasher);
    format!("browserx-sandbox-{:016x}", hasher.finish())
}

#[cfg(not(windows))]
pub fn delete_profile(_name: &str) {}
