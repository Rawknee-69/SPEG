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
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Minimum interval between full crash-report writes (panics closer together
/// only append a log line).
pub const CRASH_REPORT_MIN_INTERVAL: Duration = Duration::from_secs(30);
/// Maximum crash reports written per process.
pub const CRASH_REPORT_MAX: usize = 1000;
/// Maximum `PANIC:` lines appended to `daemon.log` per process — bounds the
/// hook's own log stream against a flood of throttled panics. (The hook's
/// bare `daemon.log` is per-process capped; the tracing sink's mirrored log
/// is rotated daily by `main`.)
pub const MAX_PANIC_LOG_LINES: usize = 1000;

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
            info.timestamp.format("%Y%m%d-%H%M%S%.6f"),
            std::process::id()
        );
        let path = self.dir.join(name);
        let body = format!(
            "CACM daemon crash report\n{}\n{}\n",
            serde_json::to_string_pretty(info)
                .unwrap_or_else(|_| r#"{"serialize":"failed"}"#.into()),
            "-".repeat(60)
        );
        // Crash reports contain backtraces — create with 0600 up front on
        // Unix (no 0644 window between write and chmod).
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&path)?;
            file.write_all(body.as_bytes())?;
            file.flush()?;
        }
        #[cfg(not(unix))]
        {
            fs::write(&path, body)?;
        }
        Ok(path)
    }

    /// Append a line to `daemon.log` (used by the panic hook so the crash is
    /// also in the collectible log stream). Newlines in the payload are
    /// escaped so a crafted panic message cannot forge log lines. Never
    /// panics.
    pub fn append_log(&self, line: &str) {
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("daemon.log"))
        {
            let safe = line.replace(['\r', '\n'], "\\n");
            let _ = writeln!(file, "{}", safe);
        }
    }

    /// Install the process-global panic hook. Every panic appends to the
    /// daemon log and writes a crash report; the previous hook is chained so
    /// default stderr output still happens.
    ///
    /// Report writes are throttled (at most [`CRASH_REPORT_MIN_INTERVAL`]
    /// apart) and capped ([`CRASH_REPORT_MAX`] per process) so an attacker
    /// who can trigger panics (e.g. `--debug` + `cacm.debug.panic` from a
    /// loopback client) cannot fill the crash directory with backtraces.
    pub fn install_hook(self) {
        let pad = Arc::new(self);
        let previous = std::panic::take_hook();
        let last_report = Arc::new(Mutex::new(Instant::now() - CRASH_REPORT_MIN_INTERVAL));
        let report_count = Arc::new(AtomicUsize::new(0));
        // Bounds the log stream: only the first MAX_PANIC_LOG_LINES panics
        // append a line, and the (expensive) backtrace is captured only when
        // a report may actually be written.
        let panic_log_count = Arc::new(AtomicUsize::new(0));
        std::panic::set_hook(Box::new(move |info| {
            let message = panic_payload_message(info);
            // Always keep the panic in the collectible log (cheap, one line)
            // while under the per-process line cap.
            if panic_log_count.fetch_add(1, Ordering::Relaxed) < MAX_PANIC_LOG_LINES {
                pad.append_log(&format!("PANIC: {message}"));
            }
            let report_due = {
                let mut last = match last_report.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let due = last.elapsed() >= CRASH_REPORT_MIN_INTERVAL;
                if due {
                    *last = Instant::now();
                }
                due
            };
            // Count reports *written*, not panics: an attacker burning 1000
            // throttled panics must not silence reports for genuine crashes.
            let under_cap = report_count.load(Ordering::Relaxed) < CRASH_REPORT_MAX;
            if report_due && under_cap {
                let report = CrashInfo {
                    version: env!("CARGO_PKG_VERSION"),
                    timestamp: Utc::now(),
                    uptime_secs: pad.uptime_secs(),
                    panic_message: message.clone(),
                    backtrace: Backtrace::force_capture().to_string(),
                    memory_used_bytes: CURRENT_MEMORY_USED.load(Ordering::Relaxed),
                };
                match pad.write_report(&report) {
                    Ok(path) => {
                        report_count.fetch_add(1, Ordering::Relaxed);
                        eprintln!(
                            "cacm-daemon panic — crash report written to {}",
                            path.display()
                        )
                    }
                    Err(err) => {
                        eprintln!("cacm-daemon panic — failed to write crash report: {err}")
                    }
                }
            } else {
                eprintln!("cacm-daemon panic — {message} (crash report suppressed: throttled or cap reached)");
            }
            previous(info);
        }));
    }
}

/// Extract the panic payload's message (the `panic!("...")` string) without
/// the `PanicHookInfo` location header, so reports and log lines are clean
/// single lines.
fn panic_payload_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        info.to_string()
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
    fn append_log_escapes_newlines() {
        let dir = temp_dir("escape");
        let pad = Crashpad::new(dir.clone()).unwrap();
        pad.append_log("line one");
        pad.append_log("forged\ninjected\rline");
        let log = fs::read_to_string(dir.join("daemon.log")).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(
            lines.len(),
            2,
            "newlines in the payload must not forge lines"
        );
        // Both \r and \n are escaped to the two-char sequence `\n`.
        assert_eq!(lines[1], "forged\\ninjected\\nline");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn panic_hook_writes_and_throttles_reports() {
        // Single test so the process-global hook is installed exactly once
        // (parallel hook installations would race each other). Panics from
        // other tests may reach this hook too, so report counts are asserted
        // tolerantly while the log (append_log is never throttled) is
        // asserted deterministically.
        let dir = temp_dir("hook");
        let pad = Crashpad::new(dir.clone()).unwrap();
        pad.install_hook();

        let _ = std::panic::catch_unwind(|| panic!("synthetic panic {}", "here"));
        let _ = std::panic::catch_unwind(|| panic!("second panic"));
        let _ = std::panic::catch_unwind(|| panic!("third panic"));

        // Wiring: every panic lands in the collectible log.
        let log = fs::read_to_string(dir.join("daemon.log")).unwrap();
        assert!(log.contains("PANIC: synthetic panic here"));
        assert!(log.contains("PANIC: second panic"));
        assert!(log.contains("PANIC: third panic"));

        // Throttle: at most ONE report carries our messages (a racing panic
        // from another test may consume the 30s window first).
        let ours = ["synthetic panic here", "second panic", "third panic"];
        let with_ours = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("crash-"))
                    .unwrap_or(false)
            })
            .filter(|p| {
                let body = fs::read_to_string(p).unwrap_or_default();
                ours.iter().any(|m| body.contains(m))
            })
            .count();
        assert!(
            with_ours <= 1,
            "repeated panics must be throttled to at most one report, got {with_ours}"
        );
        // Log-stream bound: a flood of panics must not grow daemon.log past
        // the per-process line cap. The cap is exact (atomic RMW gates every
        // append), so once ≥1000 panics reach the hook the count is exactly
        // MAX regardless of concurrent panics from other tests.
        for i in 0..(MAX_PANIC_LOG_LINES + 5) {
            let _ = std::panic::catch_unwind(|| panic!("flood {i}"));
        }
        let log = fs::read_to_string(dir.join("daemon.log")).unwrap();
        let panic_lines = log.lines().filter(|l| l.starts_with("PANIC:")).count();
        assert_eq!(
            panic_lines, MAX_PANIC_LOG_LINES,
            "panic log lines must be capped exactly"
        );
        // The report-writing path itself is covered by
        // `write_report_contains_panic_details`.
        let _ = fs::remove_dir_all(&dir);
    }
}
