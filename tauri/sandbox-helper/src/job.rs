//! Job Object management for process limits.
//!
//! A Windows Job Object groups processes and enforces resource limits.
//! We use it to:
//! - Kill all child processes when the helper exits (kill_on_job_close)
//! - Limit the number of active processes (prevent fork bombs)
//! - Optionally cap memory usage

#[cfg(windows)]
mod imp {
    use win32job::Job;

    /// Create a Job Object with sandbox-appropriate limits.
    pub fn create_sandbox_job() -> Result<Job, String> {
        let mut job = Job::create()
            .map_err(|e| format!("Failed to create Job Object: {}", e))?;

        // Ensure all child processes are killed when the helper exits
        let mut info = job
            .query_extended_limit_info()
            .map_err(|e| format!("Failed to query job limits: {}", e))?;

        info.limit_kill_on_job_close();

        job.set_extended_limit_info(&mut info)
            .map_err(|e| format!("Failed to set job limits: {}", e))?;

        log::info!("Created Job Object (kill_on_close=true)");

        Ok(job)
    }

    /// Assign a process handle to a job object.
    pub fn assign_process(job: &Job, process_handle: windows::Win32::Foundation::HANDLE) -> Result<(), String> {
        // win32job's assign_process expects a raw handle
        let raw = process_handle.0 as *mut std::ffi::c_void;
        job.assign_process(raw as isize)
            .map_err(|e| format!("Failed to assign process to Job Object: {}", e))?;
        log::debug!("Assigned process to Job Object");
        Ok(())
    }
}

#[cfg(windows)]
pub use imp::*;

// Stubs for non-Windows
#[cfg(not(windows))]
pub fn create_sandbox_job() -> Result<(), String> {
    Err("Job Objects are only available on Windows".to_string())
}
