//! OS-level scheduler commands for desktop app.
//!
//! Creates/removes platform-specific scheduled jobs (launchd, schtasks, systemd)
//! so jobs fire even when the app is fully quit.
//!
//! Each job is registered as an OS-level scheduled entry that opens the app via deep link:
//! `applepi://scheduler/trigger?jobId={jobId}`

use std::fs;
use std::path::PathBuf;
use std::process::Command;

/// Validate that a job_id is a valid UUID to prevent path traversal / injection.
fn validate_job_id(job_id: &str) -> Result<(), String> {
    // UUID format: 8-4-4-4-12 hex chars
    let parts: Vec<&str> = job_id.split('-').collect();
    let valid = parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_hexdigit()));
    if !valid {
        return Err(format!("Invalid job_id: must be a valid UUID, got '{}'", job_id));
    }
    Ok(())
}

/// Register an OS-level scheduled job.
///
/// * `job_id` — unique job identifier
/// * `scheduled_time` — Unix timestamp in milliseconds when the job should fire
#[tauri::command]
pub async fn scheduler_register_os_job(
    job_id: String,
    scheduled_time: i64,
) -> Result<(), String> {
    validate_job_id(&job_id)?;

    #[cfg(target_os = "macos")]
    {
        register_launchd_job(&job_id, scheduled_time)
    }

    #[cfg(target_os = "windows")]
    {
        register_schtasks_job(&job_id, scheduled_time)
    }

    #[cfg(target_os = "linux")]
    {
        register_systemd_job(&job_id, scheduled_time)
    }
}

/// Remove an OS-level scheduled job.
#[tauri::command]
pub async fn scheduler_remove_os_job(job_id: String) -> Result<(), String> {
    validate_job_id(&job_id)?;

    #[cfg(target_os = "macos")]
    {
        remove_launchd_job(&job_id)
    }

    #[cfg(target_os = "windows")]
    {
        remove_schtasks_job(&job_id)
    }

    #[cfg(target_os = "linux")]
    {
        remove_systemd_job(&job_id)
    }
}

/// List all registered OS-level scheduler jobs.
/// Returns a JSON array of `{ jobId, scheduledTime }`.
#[tauri::command]
pub async fn scheduler_list_os_jobs() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        list_launchd_jobs()
    }

    #[cfg(target_os = "windows")]
    {
        list_schtasks_jobs()
    }

    #[cfg(target_os = "linux")]
    {
        list_systemd_jobs()
    }
}

/// Check if an OS-level scheduled job exists.
#[tauri::command]
pub async fn scheduler_has_os_job(job_id: String) -> Result<bool, String> {
    validate_job_id(&job_id)?;

    #[cfg(target_os = "macos")]
    {
        let plist_path = launchd_plist_path(&job_id)?;
        Ok(plist_path.exists())
    }

    #[cfg(target_os = "windows")]
    {
        let job_name = schtasks_name(&job_id);
        let output = Command::new("schtasks.exe")
            .args(["/Query", "/TN", &job_name, "/FO", "CSV"])
            .output()
            .map_err(|e| format!("Failed to query job: {}", e))?;
        Ok(output.status.success())
    }

    #[cfg(target_os = "linux")]
    {
        let timer_path = systemd_timer_path(&job_id)?;
        Ok(timer_path.exists())
    }
}

/// Remove all OS-level scheduler jobs.
#[tauri::command]
pub async fn scheduler_clear_os_jobs() -> Result<(), String> {
    let jobs = scheduler_list_os_jobs().await?;
    for job_id in jobs {
        if let Err(e) = scheduler_remove_os_job(job_id.clone()).await {
            eprintln!("[Scheduler] Failed to remove OS job {}: {}", job_id, e);
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// macOS (launchd)
// ─────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
const PLIST_PREFIX: &str = "com.airepublic.pi.scheduler.";

#[cfg(target_os = "macos")]
fn get_home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "HOME environment variable not set".to_string())
}

#[cfg(target_os = "macos")]
fn launchd_plist_path(job_id: &str) -> Result<PathBuf, String> {
    let home = get_home_dir()?;
    Ok(PathBuf::from(home)
        .join("Library/LaunchAgents")
        .join(format!("{}{}.plist", PLIST_PREFIX, job_id)))
}

#[cfg(target_os = "macos")]
fn register_launchd_job(job_id: &str, scheduled_time: i64) -> Result<(), String> {
    use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};

    let secs = scheduled_time / 1000;
    let dt: DateTime<Local> = Local
        .timestamp_opt(secs, 0)
        .single()
        .ok_or_else(|| "Invalid timestamp".to_string())?;

    let plist_path = launchd_plist_path(job_id)?;

    // Ensure LaunchAgents directory exists
    if let Some(parent) = plist_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let deep_link = format!("applepi://scheduler/trigger?jobId={}", job_id);

    let plist_file = format!("{}{}.plist", PLIST_PREFIX, job_id);
    let plist_content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{prefix}{job_id}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>/usr/bin/open -g "{deep_link}"; rm -f "$HOME/Library/LaunchAgents/{plist_file}"</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Month</key>
        <integer>{month}</integer>
        <key>Day</key>
        <integer>{day}</integer>
        <key>Hour</key>
        <integer>{hour}</integer>
        <key>Minute</key>
        <integer>{minute}</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>"#,
        prefix = PLIST_PREFIX,
        job_id = job_id,
        deep_link = deep_link,
        plist_file = plist_file,
        month = dt.month(),
        day = dt.day(),
        hour = dt.hour(),
        minute = dt.minute(),
    );

    fs::write(&plist_path, plist_content)
        .map_err(|e| format!("Failed to write plist: {}", e))?;

    // Load the job
    let output = Command::new("launchctl")
        .args(["load", "-w", plist_path.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Failed to run launchctl: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "already loaded" is not a real error
        if !stderr.contains("already loaded") {
            return Err(format!("launchctl load failed: {}", stderr));
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn remove_launchd_job(job_id: &str) -> Result<(), String> {
    let plist_path = launchd_plist_path(job_id)?;

    if plist_path.exists() {
        // Unload first
        let _ = Command::new("launchctl")
            .args(["unload", plist_path.to_str().unwrap()])
            .output();

        fs::remove_file(&plist_path)
            .map_err(|e| format!("Failed to remove plist: {}", e))?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn list_launchd_jobs() -> Result<Vec<String>, String> {
    let home = get_home_dir()?;
    let agents_dir = PathBuf::from(home).join("Library/LaunchAgents");

    if !agents_dir.exists() {
        return Ok(vec![]);
    }

    let mut job_ids = Vec::new();
    let entries = fs::read_dir(&agents_dir)
        .map_err(|e| format!("Failed to read LaunchAgents: {}", e))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(job_id) = name
            .strip_prefix(PLIST_PREFIX)
            .and_then(|s| s.strip_suffix(".plist"))
        {
            job_ids.push(job_id.to_string());
        }
    }

    Ok(job_ids)
}

// ─────────────────────────────────────────────────────────────────────────
// Windows (Task Scheduler)
// ─────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
const SCHTASKS_PREFIX: &str = "PiScheduler_";

#[cfg(target_os = "windows")]
fn schtasks_name(job_id: &str) -> String {
    format!("{}{}", SCHTASKS_PREFIX, job_id)
}

#[cfg(target_os = "windows")]
fn register_schtasks_job(job_id: &str, scheduled_time: i64) -> Result<(), String> {
    use chrono::{DateTime, Local, TimeZone};

    let secs = scheduled_time / 1000;
    let dt: DateTime<Local> = Local
        .timestamp_opt(secs, 0)
        .single()
        .ok_or_else(|| "Invalid timestamp".to_string())?;

    let job_name = schtasks_name(job_id);
    let date_str = dt.format("%m/%d/%Y").to_string();
    let time_str = dt.format("%H:%M").to_string();
    let deep_link = format!("applepi://scheduler/trigger?jobId={}", job_id);

    let output = Command::new("schtasks.exe")
        .args([
            "/Create",
            "/TN", &job_name,
            "/SC", "ONCE",
            "/SD", &date_str,
            "/ST", &time_str,
            "/TR", &format!("cmd /c start \"\" \"{}\"", deep_link),
            "/F",
        ])
        .output()
        .map_err(|e| format!("Failed to create scheduled job: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "schtasks create failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn remove_schtasks_job(job_id: &str) -> Result<(), String> {
    let job_name = schtasks_name(job_id);

    let output = Command::new("schtasks.exe")
        .args(["/Delete", "/TN", &job_name, "/F"])
        .output()
        .map_err(|e| format!("Failed to delete scheduled job: {}", e))?;

    // Don't treat "not found" as an error
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("does not exist") {
            return Err(format!("schtasks delete failed: {}", stderr));
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn list_schtasks_jobs() -> Result<Vec<String>, String> {
    let output = Command::new("schtasks.exe")
        .args(["/Query", "/FO", "CSV", "/NH"])
        .output()
        .map_err(|e| format!("Failed to list scheduled jobs: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut job_ids = Vec::new();

    for line in stdout.lines() {
        // CSV format: "\\TaskName","Next Run Time","Status"
        if let Some(name) = line.split(',').next() {
            let name = name.trim_matches('"').trim_start_matches('\\');
            if let Some(job_id) = name.strip_prefix(SCHTASKS_PREFIX) {
                job_ids.push(job_id.to_string());
            }
        }
    }

    Ok(job_ids)
}

// ─────────────────────────────────────────────────────────────────────────
// Linux (systemd user timers)
// ─────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
const SYSTEMD_PREFIX: &str = "pi-scheduler-";

#[cfg(target_os = "linux")]
fn get_home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "HOME environment variable not set".to_string())
}

#[cfg(target_os = "linux")]
fn systemd_user_dir() -> Result<PathBuf, String> {
    let home = get_home_dir()?;
    Ok(PathBuf::from(home).join(".config/systemd/user"))
}

#[cfg(target_os = "linux")]
fn systemd_service_path(job_id: &str) -> Result<PathBuf, String> {
    Ok(systemd_user_dir()?.join(format!("{}{}.service", SYSTEMD_PREFIX, job_id)))
}

#[cfg(target_os = "linux")]
fn systemd_timer_path(job_id: &str) -> Result<PathBuf, String> {
    Ok(systemd_user_dir()?.join(format!("{}{}.timer", SYSTEMD_PREFIX, job_id)))
}

#[cfg(target_os = "linux")]
fn register_systemd_job(job_id: &str, scheduled_time: i64) -> Result<(), String> {
    use chrono::{DateTime, Local, TimeZone};

    let secs = scheduled_time / 1000;
    let dt: DateTime<Local> = Local
        .timestamp_opt(secs, 0)
        .single()
        .ok_or_else(|| "Invalid timestamp".to_string())?;

    let user_dir = systemd_user_dir()?;
    fs::create_dir_all(&user_dir)
        .map_err(|e| format!("Failed to create systemd user dir: {}", e))?;

    let unit_name = format!("{}{}", SYSTEMD_PREFIX, job_id);
    let deep_link = format!("applepi://scheduler/trigger?jobId={}", job_id);

    // Find the right command to open deep links (xdg-open may not be available on headless)
    let open_cmd = if Command::new("xdg-open").arg("--version").output().is_ok() {
        "/usr/bin/xdg-open"
    } else {
        // Fallback: use our own binary to handle the deep link directly
        return register_crontab_fallback(job_id, scheduled_time);
    };

    // Write service file
    let service_content = format!(
        "[Unit]\nDescription=WorkX Scheduler Job {job_id}\n\n[Service]\nType=oneshot\nExecStart={open_cmd} \"{deep_link}\"\n",
        job_id = job_id,
        open_cmd = open_cmd,
        deep_link = deep_link,
    );
    fs::write(systemd_service_path(job_id)?, service_content)
        .map_err(|e| format!("Failed to write service file: {}", e))?;

    // Write timer file
    let calendar = dt.format("%Y-%m-%d %H:%M:%S").to_string();
    let timer_content = format!(
        "[Unit]\nDescription=WorkX Scheduler Job Timer {job_id}\n\n[Timer]\nOnCalendar={calendar}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n",
        job_id = job_id,
        calendar = calendar,
    );
    fs::write(systemd_timer_path(job_id)?, timer_content)
        .map_err(|e| format!("Failed to write timer file: {}", e))?;

    // Reload and enable
    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output();

    let output = Command::new("systemctl")
        .args(["--user", "enable", "--now", &format!("{}.timer", unit_name)])
        .output()
        .map_err(|e| format!("Failed to enable timer: {}", e))?;

    if !output.status.success() {
        // Fallback: try crontab if systemctl is not available
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[Scheduler] systemctl failed ({}), trying crontab fallback", stderr);
        return register_crontab_fallback(job_id, scheduled_time);
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn register_crontab_fallback(job_id: &str, scheduled_time: i64) -> Result<(), String> {
    use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};

    let secs = scheduled_time / 1000;
    let dt: DateTime<Local> = Local
        .timestamp_opt(secs, 0)
        .single()
        .ok_or_else(|| "Invalid timestamp".to_string())?;

    let deep_link = format!("applepi://scheduler/trigger?jobId={}", job_id);
    let marker = format!("pi-scheduler-{}", job_id);
    let cron_entry = format!(
        "{min} {hour} {day} {month} * xdg-open \"{deep_link}\"; crontab -l 2>/dev/null | grep -v '{marker}' | crontab - # {marker}",
        min = dt.minute(),
        hour = dt.hour(),
        day = dt.day(),
        month = dt.month(),
        deep_link = deep_link,
        marker = marker,
    );

    // Read existing crontab
    let existing = Command::new("crontab")
        .arg("-l")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    // Remove any existing entry for this job
    let filtered: Vec<&str> = existing
        .lines()
        .filter(|l| !l.contains(&marker))
        .collect();

    let mut new_crontab = filtered.join("\n");
    if !new_crontab.is_empty() && !new_crontab.ends_with('\n') {
        new_crontab.push('\n');
    }
    new_crontab.push_str(&cron_entry);
    new_crontab.push('\n');

    // Write new crontab
    let mut child = Command::new("crontab")
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn crontab: {}", e))?;

    use std::io::Write;
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(new_crontab.as_bytes())
        .map_err(|e| format!("Failed to write crontab: {}", e))?;

    let status = child.wait().map_err(|e| format!("crontab failed: {}", e))?;
    if !status.success() {
        return Err("crontab command failed".to_string());
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn remove_systemd_job(job_id: &str) -> Result<(), String> {
    let unit_name = format!("{}{}", SYSTEMD_PREFIX, job_id);

    // Disable and stop the timer
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", &format!("{}.timer", unit_name)])
        .output();

    // Remove files
    if let Ok(path) = systemd_service_path(job_id) {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = systemd_timer_path(job_id) {
        let _ = fs::remove_file(path);
    }

    // Also clean up crontab entry if it exists
    if let Ok(output) = Command::new("crontab").arg("-l").output() {
        let existing = String::from_utf8_lossy(&output.stdout).to_string();
        let marker = format!("pi-scheduler-{}", job_id);
        if existing.contains(&marker) {
            let filtered: Vec<&str> = existing
                .lines()
                .filter(|l| !l.contains(&marker))
                .collect();
            let new_crontab = filtered.join("\n") + "\n";

            if let Ok(mut child) = Command::new("crontab")
                .arg("-")
                .stdin(std::process::Stdio::piped())
                .spawn()
            {
                use std::io::Write;
                if let Some(stdin) = child.stdin.as_mut() {
                    let _ = stdin.write_all(new_crontab.as_bytes());
                }
                let _ = child.wait();
            }
        }
    }

    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output();

    Ok(())
}

#[cfg(target_os = "linux")]
fn list_systemd_jobs() -> Result<Vec<String>, String> {
    let user_dir = systemd_user_dir()?;

    if !user_dir.exists() {
        return Ok(vec![]);
    }

    let mut job_ids = Vec::new();
    let entries = fs::read_dir(&user_dir)
        .map_err(|e| format!("Failed to read systemd user dir: {}", e))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(job_id) = name
            .strip_prefix(SYSTEMD_PREFIX)
            .and_then(|s| s.strip_suffix(".timer"))
        {
            job_ids.push(job_id.to_string());
        }
    }

    Ok(job_ids)
}
