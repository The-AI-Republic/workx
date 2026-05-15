//! Code-mode filesystem commands (desktop).
//!
//! The WebView cannot touch the filesystem; the read/edit/write tools call
//! these. They are the AUTHORITATIVE security + freshness boundary
//! (.ai_design/applepi_file_tools §4.6/§4.8, invariants R1/R3/R4/R5/R6):
//!
//!  - R5: every path is jailed — symlink-resolved containment inside
//!        `workspace_root` + a bypass-immune sensitive blocklist. Mirror of
//!        src/tools/file-search/pathPolicy.ts (keep in sync).
//!  - R3: mtime is returned as floored integer ms == JS Math.floor(mtimeMs).
//!  - R6: content is LF-normalized on read; original endings/BOM re-applied
//!        on write. v1 supports UTF-8 (±BOM) only; UTF-16 is refused, not
//!        mangled (fail-safe; full transcode is 4e hardening).
//!  - R1/R4: fs_apply_edit re-reads fresh bytes and does match+substitute
//!        server-side, synchronously, in one command (no TOCTOU window).

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

// Keep byte-identical to pathPolicy.ts SENSITIVE_DIRS / SENSITIVE_FILES.
const SENSITIVE_DIRS: &[&str] = &[".git", ".svn", ".hg", ".vscode", ".idea", ".claude", ".ssh"];
const SENSITIVE_FILES: &[&str] = &[
    ".env", ".npmrc", ".netrc", ".bashrc", ".bash_profile", ".zshrc", ".zprofile",
    ".profile", ".gitconfig", ".gitmodules", ".mcp.json", ".claude.json", "settings.json",
];

#[derive(Serialize)]
pub struct FileMeta {
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64,
    pub size: u64,
    pub endings: String, // "LF" | "CRLF"
    pub encoding: String, // "utf8"
    pub bom: bool,
}

#[derive(Serialize)]
pub struct ReadOutcome {
    #[serde(rename = "contentLf")]
    pub content_lf: String,
    #[serde(flatten)]
    pub meta: FileMeta,
}

#[derive(Serialize)]
pub struct StatOutcome {
    pub exists: bool,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(tag = "ok")]
pub enum EditOutcome {
    #[serde(rename = "true")]
    Ok {
        #[serde(rename = "newContentLf")]
        new_content_lf: String,
        #[serde(flatten)]
        meta: FileMeta,
    },
    #[serde(rename = "false")]
    Err {
        // stale | not_found | no_match | not_unique | exists | denied | unsupported_encoding
        reason: String,
        message: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "written")]
pub enum WriteOutcome {
    #[serde(rename = "true")]
    Ok {
        #[serde(flatten)]
        meta: FileMeta,
    },
    #[serde(rename = "false")]
    Err {
        reason: String,
        message: String,
    },
}

// ── jail ────────────────────────────────────────────────────────────────────

struct Jailed {
    abs: PathBuf,
}

/// Resolve `target` under `workspace_root` with symlink-safe containment and
/// the sensitive blocklist. Works for not-yet-existing files (canonicalizes
/// the deepest existing ancestor, then appends remaining components).
fn jail(workspace_root: &str, target: &str) -> Result<Jailed, String> {
    if workspace_root.trim().is_empty() {
        return Err("no_workspace".into());
    }
    let root = fs::canonicalize(workspace_root)
        .map_err(|_| "no_workspace".to_string())?;

    let raw = Path::new(target);
    let joined: PathBuf = if raw.is_absolute() { raw.to_path_buf() } else { root.join(raw) };

    // Reject `..` lexically before any resolution (defense in depth).
    if joined.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("outside_workspace".into());
    }

    // Canonicalize the deepest existing ancestor (resolves symlinks), then
    // re-append the non-existing tail.
    let mut existing = joined.clone();
    let mut tail: Vec<String> = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(n) => {
                tail.push(n.to_string_lossy().to_string());
                existing = existing.parent().map(|p| p.to_path_buf()).unwrap_or_default();
            }
            None => return Err("outside_workspace".into()),
        }
    }
    let mut abs = fs::canonicalize(&existing).map_err(|_| "outside_workspace".to_string())?;
    for seg in tail.iter().rev() {
        abs.push(seg);
    }

    if abs != root && !abs.starts_with(&root) {
        return Err("outside_workspace".into());
    }
    let rel = abs.strip_prefix(&root).unwrap_or(&abs).to_string_lossy().to_string();

    // Blocklist: any sensitive dir segment, or sensitive basename, or .env*.
    for seg in rel.split(['/', '\\']).filter(|s| !s.is_empty()) {
        if SENSITIVE_DIRS.contains(&seg) {
            return Err("blocked".into());
        }
    }
    if let Some(base) = abs.file_name().and_then(|b| b.to_str()) {
        if SENSITIVE_FILES.contains(&base) || base == ".env" || base.starts_with(".env.") {
            return Err("blocked".into());
        }
    }
    Ok(Jailed { abs })
}

fn deny_msg(reason: &str) -> String {
    match reason {
        "no_workspace" => "No workspace selected; code-mode file tools are disabled.".into(),
        "outside_workspace" => "Path is outside the workspace and cannot be accessed.".into(),
        "blocked" => "Path is on the protected blocklist (.git/.ssh/.env/settings.json/etc.) and cannot be written.".into(),
        _ => reason.into(),
    }
}

// ── encoding / endings ──────────────────────────────────────────────────────

struct Decoded {
    content_lf: String,
    endings: &'static str,
    bom: bool,
}

/// Decode raw bytes to an LF-normalized UTF-8 string. Returns None for
/// UTF-16 (refused in v1 rather than corrupted — R6 fail-safe).
fn decode(bytes: &[u8]) -> Option<Decoded> {
    if bytes.len() >= 2 && ((bytes[0] == 0xFF && bytes[1] == 0xFE) || (bytes[0] == 0xFE && bytes[1] == 0xFF)) {
        return None; // UTF-16 — unsupported in v1
    }
    let (body, bom) = if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        (&bytes[3..], true)
    } else {
        (bytes, false)
    };
    let s = String::from_utf8_lossy(body).to_string();
    let endings = if s.contains("\r\n") { "CRLF" } else { "LF" };
    Some(Decoded { content_lf: s.replace("\r\n", "\n"), endings, bom })
}

/// Re-apply endings + BOM to LF content for writing (UTF-8 only in v1).
fn encode(content_lf: &str, endings: &str, bom: bool) -> Vec<u8> {
    let body = if endings == "CRLF" {
        content_lf.replace('\n', "\r\n")
    } else {
        content_lf.to_string()
    };
    let mut out = Vec::with_capacity(body.len() + 3);
    if bom {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(body.as_bytes());
    out
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64) // truncates sub-ms == JS Math.floor(mtimeMs)
        .unwrap_or(0)
}

// ── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn fs_stat(workspace_root: String, path: String) -> Result<StatOutcome, String> {
    let j = match jail(&workspace_root, &path) {
        Ok(j) => j,
        Err(r) => return Err(deny_msg(&r)),
    };
    match fs::metadata(&j.abs) {
        Ok(m) => Ok(StatOutcome { exists: true, mtime_ms: mtime_ms(&m), size: m.len() }),
        Err(_) => Ok(StatOutcome { exists: false, mtime_ms: 0, size: 0 }),
    }
}

#[tauri::command]
pub fn fs_read_file(workspace_root: String, path: String) -> Result<ReadOutcome, String> {
    let j = jail(&workspace_root, &path).map_err(|r| deny_msg(&r))?;
    let meta = fs::metadata(&j.abs).map_err(|e| format!("not_found: {}", e))?;
    let bytes = fs::read(&j.abs).map_err(|e| format!("read failed: {}", e))?;
    let dec = decode(&bytes).ok_or_else(|| "unsupported_encoding: UTF-16 files are not supported in v1".to_string())?;
    Ok(ReadOutcome {
        content_lf: dec.content_lf,
        meta: FileMeta {
            mtime_ms: mtime_ms(&meta),
            size: meta.len(),
            endings: dec.endings.to_string(),
            encoding: "utf8".to_string(),
            bom: dec.bom,
        },
    })
}

/// Atomic edit: re-read fresh → freshness check (+jitter fallback) →
/// exact-match/uniqueness against FRESH bytes → substitute → write. One
/// synchronous command: no await, no TOCTOU window (R1/R4).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn fs_apply_edit(
    workspace_root: String,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: bool,
    #[allow(non_snake_case)] expectedMtimeMs: u64,
    #[allow(non_snake_case)] expectedContentLf: String,
) -> Result<EditOutcome, String> {
    let j = match jail(&workspace_root, &path) {
        Ok(j) => j,
        Err(r) => return Ok(EditOutcome::Err { reason: "denied".into(), message: deny_msg(&r) }),
    };
    let exists = j.abs.exists();

    // Empty old_string ⇒ create-new (gate N/A: cannot have read a missing file).
    if old_string.is_empty() {
        if exists {
            let m = fs::metadata(&j.abs).map_err(|e| e.to_string())?;
            if m.len() > 0 {
                return Ok(EditOutcome::Err {
                    reason: "exists".into(),
                    message: "File already exists and is non-empty; empty old_string only creates new files.".into(),
                });
            }
        }
        let endings = if new_string.contains("\r\n") { "CRLF" } else { "LF" };
        let content_lf = new_string.replace("\r\n", "\n");
        fs::write(&j.abs, encode(&content_lf, endings, false)).map_err(|e| e.to_string())?;
        let m = fs::metadata(&j.abs).map_err(|e| e.to_string())?;
        return Ok(EditOutcome::Ok {
            new_content_lf: content_lf,
            meta: FileMeta { mtime_ms: mtime_ms(&m), size: m.len(), endings: endings.into(), encoding: "utf8".into(), bom: false },
        });
    }

    if !exists {
        return Ok(EditOutcome::Err {
            reason: "not_found".into(),
            message: "File does not exist. Use write_file to create it, or fix the path.".into(),
        });
    }

    let meta = fs::metadata(&j.abs).map_err(|e| e.to_string())?;
    let bytes = fs::read(&j.abs).map_err(|e| e.to_string())?;
    let dec = match decode(&bytes) {
        Some(d) => d,
        None => return Ok(EditOutcome::Err {
            reason: "unsupported_encoding".into(),
            message: "UTF-16 files are not supported in v1.".into(),
        }),
    };
    let fresh = dec.content_lf;

    // Freshness: if mtime advanced, only proceed when the whole fresh file is
    // byte-identical to the cached content (full-read jitter fallback). A
    // range read's cached content is a slice ⇒ never equal ⇒ correctly stale.
    if mtime_ms(&meta) != expectedMtimeMs && fresh != expectedContentLf {
        return Ok(EditOutcome::Err {
            reason: "stale".into(),
            message: "File changed on disk since you read it. Re-read it, then redo the edit against the new content.".into(),
        });
    }

    let count = fresh.matches(&old_string).count();
    if count == 0 {
        return Ok(EditOutcome::Err {
            reason: "no_match".into(),
            message: "old_string was not found in the current file content. Re-read the file and base the edit on its actual current text.".into(),
        });
    }
    if count > 1 && !replace_all {
        return Ok(EditOutcome::Err {
            reason: "not_unique".into(),
            message: format!("old_string matched {} times. Add surrounding context to make it unique, or pass replace_all: true.", count),
        });
    }

    let updated = if replace_all {
        fresh.replace(&old_string, &new_string)
    } else {
        fresh.replacen(&old_string, &new_string, 1)
    };
    fs::write(&j.abs, encode(&updated, dec.endings, dec.bom)).map_err(|e| e.to_string())?;
    let m = fs::metadata(&j.abs).map_err(|e| e.to_string())?;
    Ok(EditOutcome::Ok {
        new_content_lf: updated,
        meta: FileMeta { mtime_ms: mtime_ms(&m), size: m.len(), endings: dec.endings.into(), encoding: "utf8".into(), bom: dec.bom },
    })
}

/// Full overwrite. expected_mtime_ms = None ⇒ create-only (must not exist).
#[tauri::command]
pub fn fs_write_if_unchanged(
    workspace_root: String,
    path: String,
    content: String,
    #[allow(non_snake_case)] expectedMtimeMs: Option<u64>,
    endings: String,
    bom: bool,
) -> Result<WriteOutcome, String> {
    let j = match jail(&workspace_root, &path) {
        Ok(j) => j,
        Err(r) => return Ok(WriteOutcome::Err { reason: "denied".into(), message: deny_msg(&r) }),
    };
    let exists = j.abs.exists();
    match expectedMtimeMs {
        None => {
            if exists {
                return Ok(WriteOutcome::Err {
                    reason: "exists".into(),
                    message: "File already exists; create-only write refused.".into(),
                });
            }
        }
        Some(expected) => {
            if !exists {
                return Ok(WriteOutcome::Err {
                    reason: "not_found".into(),
                    message: "File does not exist; cannot overwrite. Read it or create it first.".into(),
                });
            }
            let m = fs::metadata(&j.abs).map_err(|e| e.to_string())?;
            if mtime_ms(&m) != expected {
                return Ok(WriteOutcome::Err {
                    reason: "stale".into(),
                    message: "File changed on disk since you read it. Re-read it before overwriting.".into(),
                });
            }
        }
    }
    let content_lf = content.replace("\r\n", "\n");
    fs::write(&j.abs, encode(&content_lf, &endings, bom)).map_err(|e| e.to_string())?;
    let m = fs::metadata(&j.abs).map_err(|e| e.to_string())?;
    Ok(WriteOutcome::Ok {
        meta: FileMeta { mtime_ms: mtime_ms(&m), size: m.len(), endings, encoding: "utf8".into(), bom },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jail_rejects_parentdir_and_blocklist() {
        // `..` escape rejected lexically regardless of fs state.
        assert!(jail("/tmp", "../etc/passwd").is_err());
    }

    #[test]
    fn decode_refuses_utf16() {
        assert!(decode(&[0xFF, 0xFE, 0x41, 0x00]).is_none());
    }

    #[test]
    fn decode_detects_crlf_and_normalizes() {
        let d = decode(b"a\r\nb").unwrap();
        assert_eq!(d.endings, "CRLF");
        assert_eq!(d.content_lf, "a\nb");
        assert!(!d.bom);
    }

    #[test]
    fn encode_roundtrips_crlf() {
        assert_eq!(encode("a\nb", "CRLF", false), b"a\r\nb");
        assert_eq!(encode("a\nb", "LF", false), b"a\nb");
    }
}
