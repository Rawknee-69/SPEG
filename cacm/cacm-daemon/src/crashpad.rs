//! Crashpad — collects crash reports and logs so failures can be diagnosed,
//! and feeds the daemon's self-heal loop.
//!
//! On a panic the process-global hook appends the panic to `daemon.log` and
//! writes a `crash-<timestamp>.log` report (panic message, backtrace, version,
//! uptime, current memory footprint). All daemon logs are mirrored to
//! `daemon.log` by the tracing file sink, so `--crash-dir` (default
//! `~/.cacm/crashes/`) is the single place to collect everything after a
//! failure.

use chrono::{DateTime, Utc};
use serde::Serialize;
use std::backtrace::Backtrace;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Latest memory footprint (bytes), updated by the server's stats path so the
/// panic hook can include it in crash reports without a dependency cycle.
pub static CURRENT_MEMORY_USED: AtomicUsize = AtomicUsize::new(0);

/// Everything captured about a crash, serialized into the report file.
#[derive(Debug, Clone, Serialize)]
pub struct CrashInfo {
    pub version: &'static str,
    pub timestamp: DateTime<Utc>,
    pub uptime_secs: i64,
    pub panic_message: String,
    pub backtrace: String,
    pub memory_used_bytes: usize,
}

/// Owns the crash directory and writes reports / log lines.
#[derive(Debug, Clone)]
pub struct Crashpad {
    dir: Arc<PathBuf>,
    started_at: DateTime<Utc>,
}

impl Crashpad {
    /// Create (if needed) the crash directory.
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&dir)?;
        Ok(Self {
            dir: Arc::new(dir),
            started_at: Utc::now(),
        })
    }

    /// The directory all crash artifacts land in.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Seconds since this Crashpad was created.
    pub fn uptime_secs(&self) -> i64 {
        (Utc::now() - self.started_at).num_seconds()
    }

    /// Write a crash report file (`crash-<timestamp>-<pid>.log`) and return
    /// its path. The pid disambiguates same-second crashes from parallel
    /// processes (and parallel tests). Never panics.
    pub fn write_report(&self, info: &CrashInfo) -> std::io::Result<PathBuf> {
        let name = format!(
            "crash-{}-{}.log",
            info.timestamp.format("%Y%m%d-%H%M%S%.3f"),
            std::process::id()
        );
        let path = self.dir.join(name);
        let body = format!(
            "CACM daemon crash report\n{}\n{}\n{}\n",
            serde_json::to_string_pretty(info)
                .unwrap_or_else(|_| r#"{"serialize":"failed"}"#.into()),
            "-".repeat(60),
            info.backtrace
        );
        fs::write(&path, body)?;
        Ok(path)
    }

    /// Append a line to `daemon.log` (used by the panic hook so the crash is
    /// also in the collectible log stream). Never panics.
    pub fn append_log(&self, line: &str) {
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("daemon.log"))
        {
            let _ = writeln!(file, "{}", line);
        }
    }

    /// Install the process-global panic hook. Every panic appends to the
    /// daemon log and writes a crash report; the previous hook is chained so
    /// default stderr output still happens.
    pub fn install_hook(self) {
        let pad = Arc::new(self);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let message = info.to_string();
            let backtrace = Backtrace::force_capture();
            let report = CrashInfo {
                version: env!("CARGO_PKG_VERSION"),
                timestamp: Utc::now(),
                uptime_secs: pad.uptime_secs(),
                panic_message: message.clone(),
                backtrace: backtrace.to_string(),
                memory_used_bytes: CURRENT_MEMORY_USED.load(Ordering::Relaxed),
            };
            pad.append_log(&format!("PANIC: {message}"));
            match pad.write_report(&report) {
                Ok(path) => {
                    eprintln!(
                        "cacm-daemon panic — crash report written to {}",
                        path.display()
                    )
                }
                Err(err) => eprintln!("cacm-daemon panic — failed to write crash report: {err}"),
            }
            previous(info);
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cacm-crashpad-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn write_report_contains_panic_details() {
        let dir = temp_dir("report");
        let pad = Crashpad::new(dir.clone()).unwrap();
        let report = CrashInfo {
            version: "test",
            timestamp: Utc::now(),
            uptime_secs: 42,
            panic_message: "boom memory".into(),
            backtrace: "backtrace line".into(),
            memory_used_bytes: 1234,
        };
        let path = pad.write_report(&report).unwrap();
        let body = fs::read_to_string(&path).unwrap();
        assert!(
            body.contains("boom memory"),
            "report must contain the panic message"
        );
        assert!(body.contains("backtrace line"));
        assert!(body.contains("1234"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_log_creates_daemon_log() {
        let dir = temp_dir("append");
        let pad = Crashpad::new(dir.clone()).unwrap();
        pad.append_log("line one");
        pad.append_log("line two");
        let log = fs::read_to_string(dir.join("daemon.log")).unwrap();
        assert_eq!(log.lines().count(), 2);
        assert!(log.contains("line two"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn panic_hook_writes_crash_report() {
        let dir = temp_dir("hook");
        let pad = Crashpad::new(dir.clone()).unwrap();
        pad.install_hook();

        let result = std::panic::catch_unwind(|| panic!("synthetic panic {}", "here"));
        assert!(result.is_err());

        let crash = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("crash-"))
            .expect("a crash report must be written");
        let body = fs::read_to_string(crash.path()).unwrap();
        assert!(body.contains("synthetic panic here"));
        let _ = fs::remove_dir_all(&dir);
    }
}
