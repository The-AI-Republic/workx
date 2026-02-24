//! windows-sandbox: AppContainer sandbox helper binary for Windows.
//!
//! This binary is spawned by portable-pty (via the Tauri app) and in turn
//! spawns the actual shell command inside an AppContainer sandbox with a
//! Job Object for process limits.
//!
//! Usage:
//!   windows-sandbox --profile <base64-json> -- <shell> <shell-flag> <command>
//!   windows-sandbox --self-test

mod acl;
mod appcontainer;
mod job;
mod profile;

use std::process::ExitCode;

fn main() -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage: windows-sandbox --profile <base64-json> -- <shell> <flag> <cmd>");
        eprintln!("       windows-sandbox --self-test");
        return ExitCode::from(1);
    }

    if args[1] == "--self-test" {
        return run_self_test();
    }

    if args[1] == "--profile" {
        if args.len() < 3 {
            eprintln!("Error: --profile requires a base64-encoded JSON argument");
            return ExitCode::from(1);
        }

        // Find the "--" separator
        let separator_pos = args.iter().position(|a| a == "--");
        let separator_pos = match separator_pos {
            Some(pos) if pos > 2 => pos,
            _ => {
                eprintln!("Error: expected -- separator followed by shell command");
                return ExitCode::from(1);
            }
        };

        let profile_b64 = &args[2];
        let child_args = &args[separator_pos + 1..];

        if child_args.len() < 3 {
            eprintln!("Error: expected <shell> <flag> <command> after --");
            return ExitCode::from(1);
        }

        return run_sandboxed(profile_b64, child_args);
    }

    eprintln!("Error: unrecognized arguments. Use --profile or --self-test.");
    ExitCode::from(1)
}

/// Run the self-test: create a temporary AppContainer profile, verify APIs
/// work, clean up, and exit.
fn run_self_test() -> ExitCode {
    #[cfg(windows)]
    {
        log::info!("Running self-test...");

        let test_name = "windows-sandbox-selftest";

        // Test AppContainer profile creation
        match appcontainer::create_or_get_profile(test_name) {
            Ok(_sid) => {
                log::info!("Self-test: AppContainer profile creation succeeded");
            }
            Err(e) => {
                eprintln!("Self-test FAILED: {}", e);
                return ExitCode::from(1);
            }
        }

        // Test Job Object creation
        match job::create_sandbox_job() {
            Ok(_job) => {
                log::info!("Self-test: Job Object creation succeeded");
            }
            Err(e) => {
                eprintln!("Self-test FAILED (Job Object): {}", e);
                appcontainer::delete_profile(test_name);
                return ExitCode::from(1);
            }
        }

        // Cleanup
        appcontainer::delete_profile(test_name);
        log::info!("Self-test PASSED");
        ExitCode::SUCCESS
    }

    #[cfg(not(windows))]
    {
        eprintln!("Self-test is only available on Windows");
        ExitCode::from(1)
    }
}

/// Decode the profile, set up the sandbox, and spawn the child process.
fn run_sandboxed(profile_b64: &str, child_args: &[String]) -> ExitCode {
    #[cfg(windows)]
    {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{
            CreateProcessW, GetExitCodeProcess, InitializeProcThreadAttributeList,
            UpdateProcThreadAttribute, WaitForSingleObject,
            EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
            PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            STARTUPINFOEXW, STARTUPINFOW,
        };

        // 1. Decode profile
        let sandbox_profile = match profile::decode_profile(profile_b64) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Failed to decode sandbox profile: {}", e);
                return ExitCode::from(1);
            }
        };

        log::info!(
            "Sandbox profile: workspace={}, access={:?}, network={:?}",
            sandbox_profile.workspace_dir.display(),
            sandbox_profile.workspace_access,
            sandbox_profile.network_mode,
        );

        // 2. Create/get AppContainer profile
        let container_name = appcontainer::container_name(&sandbox_profile.workspace_dir);
        let container_sid = match appcontainer::create_or_get_profile(&container_name) {
            Ok(sid) => sid,
            Err(e) => {
                eprintln!("Failed to create AppContainer: {}", e);
                return ExitCode::from(1);
            }
        };

        // 3. Build security capabilities
        let mut sec_caps = match appcontainer::build_security_capabilities(
            container_sid.sid,
            &sandbox_profile.network_mode,
        ) {
            Ok(caps) => caps,
            Err(e) => {
                eprintln!("Failed to build security capabilities: {}", e);
                return ExitCode::from(1);
            }
        };

        // 4. Grant ACLs on allowed paths
        let _acl_guards = match acl::grant_profile_access(&sandbox_profile, container_sid.sid) {
            Ok(guards) => guards,
            Err(e) => {
                eprintln!("Failed to grant ACLs: {}", e);
                return ExitCode::from(1);
            }
        };

        // 5. Create Job Object
        let sandbox_job = match job::create_sandbox_job() {
            Ok(j) => j,
            Err(e) => {
                eprintln!("Failed to create Job Object: {}", e);
                return ExitCode::from(1);
            }
        };

        // 6. Build the command line for CreateProcessW
        // Format: shell shell_flag "command"
        let shell = &child_args[0];
        let shell_flag = &child_args[1];
        let command = &child_args[2];
        let cmd_line = format!("\"{}\" {} {}", shell, shell_flag, command);
        let mut cmd_line_wide: Vec<u16> = cmd_line.encode_utf16().chain(std::iter::once(0)).collect();

        // 7. Set up STARTUPINFOEXW with AppContainer security capabilities
        let mut attr_list_size: usize = 0;
        unsafe {
            let _ = InitializeProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST::default(),
                1,
                0,
                &mut attr_list_size,
            );
        }

        let mut attr_list_buf = vec![0u8; attr_list_size];
        let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(attr_list_buf.as_mut_ptr() as *mut _);

        let ok = unsafe {
            InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_list_size)
        };
        if ok.is_err() {
            eprintln!("Failed to initialize ProcThreadAttributeList");
            return ExitCode::from(1);
        }

        let ok = unsafe {
            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                Some(
                    &mut sec_caps.caps as *mut _
                        as *mut std::ffi::c_void,
                ),
                std::mem::size_of::<windows::Win32::Security::SECURITY_CAPABILITIES>(),
                None,
                None,
            )
        };
        if ok.is_err() {
            eprintln!("Failed to update ProcThreadAttribute for security capabilities");
            return ExitCode::from(1);
        }

        let mut startup_info = STARTUPINFOEXW {
            StartupInfo: STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                ..Default::default()
            },
            lpAttributeList: attr_list,
        };

        let mut proc_info = PROCESS_INFORMATION::default();

        // 8. Spawn the child process
        // Do NOT pass CREATE_NO_WINDOW — child must inherit ConPTY console from parent.
        let ok = unsafe {
            CreateProcessW(
                None,
                PWSTR(cmd_line_wide.as_mut_ptr()),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT,
                None,
                None,
                &startup_info.StartupInfo,
                &mut proc_info,
            )
        };

        if ok.is_err() {
            let err = std::io::Error::last_os_error();
            eprintln!("CreateProcessW failed: {}", err);
            return ExitCode::from(1);
        }

        // 9. Assign child to Job Object
        if let Err(e) = job::assign_process(&sandbox_job, proc_info.hProcess) {
            log::warn!("Failed to assign process to job: {}", e);
            // Non-fatal: process is still sandboxed via AppContainer
        }

        // Close the thread handle (we don't need it)
        unsafe { let _ = CloseHandle(proc_info.hThread); }

        // 10. Wait for child to exit
        log::info!("Waiting for sandboxed child process to exit...");
        unsafe { WaitForSingleObject(proc_info.hProcess, u32::MAX); }

        // 11. Get exit code
        let mut exit_code: u32 = 1;
        unsafe { let _ = GetExitCodeProcess(proc_info.hProcess, &mut exit_code); }
        unsafe { let _ = CloseHandle(proc_info.hProcess); }

        log::info!("Child process exited with code {}", exit_code);

        // Explicitly drop RAII guards before exit() to ensure cleanup runs
        drop(_acl_guards);
        drop(sandbox_job);
        drop(container_sid);

        // Use process::exit to preserve the full 32-bit exit code
        std::process::exit(exit_code as i32)
    }

    #[cfg(not(windows))]
    {
        let _ = (profile_b64, child_args);
        eprintln!("Sandboxed execution is only available on Windows");
        ExitCode::from(1)
    }
}
