//! Filesystem watcher that detects activity in agent session directories.
//!
//! [`SessionWatcher`] wraps the [`notify`] crate (cross-platform: inotify on
//! Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows) and forwards
//! relevant filesystem events over a [`tokio::sync::mpsc`] channel as
//! [`SessionActivity`] records.
//!
//! Path resolution for each agent type is centralized in
//! [`default_agent_dirs`]; callers can register additional roots with
//! [`SessionWatcher::watch`].

use crate::parsers::grok;
use crate::types::AgentType;
use chrono::{DateTime, Utc};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Backlog of pending session-activity events.
const CHANNEL_CAPACITY: usize = 256;

/// Kind of filesystem activity observed in a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionEventType {
    /// A session file/directory was created.
    Created,
    /// A session file was modified (content written, metadata changed).
    Modified,
    /// A session file/directory was deleted.
    Deleted,
    /// A session file/directory was renamed.
    Renamed,
    /// Activity that does not map to the above.
    Other,
}

/// A single observed session-activity event, emitted by [`SessionWatcher`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionActivity {
    pub session_id: String,
    pub agent_type: AgentType,
    pub event_type: SessionEventType,
    /// Turn number if it can be inferred from the path; `None` otherwise.
    /// Precise turn attribution is left to the session parsers.
    pub turn: Option<u32>,
    pub timestamp: DateTime<Utc>,
}

/// Errors produced while setting up or running a [`SessionWatcher`].
#[derive(Debug)]
pub enum WatcherError {
    /// Underlying filesystem-watcher failure.
    Notify(notify::Error),
    /// I/O failure (e.g. canonicalizing a watch path).
    Io(std::io::Error),
}

impl std::fmt::Display for WatcherError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WatcherError::Notify(err) => write!(f, "notify error: {err}"),
            WatcherError::Io(err) => write!(f, "io error: {err}"),
        }
    }
}

impl std::error::Error for WatcherError {}

impl From<notify::Error> for WatcherError {
    fn from(err: notify::Error) -> Self {
        WatcherError::Notify(err)
    }
}

impl From<std::io::Error> for WatcherError {
    fn from(err: std::io::Error) -> Self {
        WatcherError::Io(err)
    }
}

/// Resolve the user's home directory cross-platform.
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// Default per-agent session/transcript directories, resolved against the
/// current user's home directory.
///
/// | Agent      | Path                                        |
/// |------------|---------------------------------------------|
/// | ClaudeCode | `~/.claude/projects/`                       |
/// | Codex      | `~/.codex/sessions/`                        |
/// | OpenCode   | platform data dir (see [`opencode_dir`])    |
/// | Cursor     | `~/.cursor/projects/`                       |
/// | Grok       | `~/.grok/sessions/`                         |
/// | Speg       | `~/.speg/sessions/`                         |
pub fn default_agent_dirs() -> Vec<(AgentType, PathBuf)> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    vec![
        (AgentType::ClaudeCode, home.join(".claude").join("projects")),
        (AgentType::Codex, home.join(".codex").join("sessions")),
        (AgentType::OpenCode, opencode_dir(&home)),
        (AgentType::Cursor, home.join(".cursor").join("projects")),
        (AgentType::Grok, home.join(".grok").join("sessions")),
        (AgentType::Speg, home.join(".speg").join("sessions")),
    ]
}

/// OpenCode's platform-specific data directory.
///
/// OpenCode resolves its data dir as `$XDG_DATA_HOME/opencode` (or the
/// platform equivalent) — on macOS `~/Library/Application Support/opencode`,
/// on Windows the *local* app-data/XDG-style `~/.local/share/opencode`
/// (modern OpenCode writes `opencode.db` there), elsewhere
/// `~/.local/share/opencode`. The watcher prefers whichever of these paths
/// exists, falling back to the historical `%APPDATA%\opencode` guess.
fn opencode_dir(home: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home.join("Library").join("Application Support").join("opencode")
    }
    #[cfg(target_os = "windows")]
    {
        let xdg = home.join(".local").join("share").join("opencode");
        if xdg.is_dir() {
            return xdg;
        }
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("opencode")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join("opencode")
    }
}

/// Watch roots shared between the notify callback and the [`SessionWatcher`]
/// so `watch()` calls made after construction are visible to event mapping.
type SharedRoots = Arc<Mutex<Vec<(AgentType, PathBuf)>>>;

/// Watches agent session directories and emits [`SessionActivity`] events.
pub struct SessionWatcher {
    sender: mpsc::Sender<SessionActivity>,
    watcher: notify::RecommendedWatcher,
    roots: SharedRoots,
}

impl SessionWatcher {
    /// Create a watcher plus the receiving half of its event channel.
    pub fn new() -> Result<(Self, mpsc::Receiver<SessionActivity>), WatcherError> {
        Self::with_roots(default_agent_dirs())
    }

    /// Create a watcher seeded with the given agent roots.
    pub fn with_roots(
        roots: Vec<(AgentType, PathBuf)>,
    ) -> Result<(Self, mpsc::Receiver<SessionActivity>), WatcherError> {
        let (sender, receiver) = mpsc::channel(CHANNEL_CAPACITY);
        let roots: SharedRoots = Arc::new(Mutex::new(roots));
        let handler_roots = Arc::clone(&roots);
        let handler_sender = sender.clone();

        let watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
            let Ok(event) = result else { return };
            let roots = match handler_roots.lock() {
                Ok(roots) => roots,
                Err(_) => return,
            };
            if let Some(activity) = resolve_activity(&event, &roots) {
                // try_send: never block notify's thread on a full channel.
                let _ = handler_sender.try_send(activity);
            }
        })?;

        Ok((
            SessionWatcher {
                sender,
                watcher,
                roots,
            },
            receiver,
        ))
    }

    /// Register an agent root directory for future event mapping.
    pub fn add_root(&self, agent_type: AgentType, path: PathBuf) {
        if let Ok(mut roots) = self.roots.lock() {
            roots.retain(|(_, existing)| existing != &path);
            roots.push((agent_type, path));
        }
    }

    /// Start watching `path` (recursively when `recursive` is true) and map
    /// events under it to `agent_type`.
    pub fn watch(
        &mut self,
        agent_type: AgentType,
        path: impl AsRef<Path>,
        recursive: bool,
    ) -> Result<(), WatcherError> {
        let path = path.as_ref();
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        self.add_root(agent_type, canonical.clone());
        self.watcher.watch(
            &canonical,
            if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive },
        )?;
        Ok(())
    }

    /// Watch all default agent directories that currently exist.
    pub fn watch_defaults(&mut self) -> Result<usize, WatcherError> {
        let mut watched = 0;
        for (agent_type, dir) in default_agent_dirs() {
            if dir.is_dir() {
                self.watch(agent_type, &dir, true)?;
                watched += 1;
            }
        }
        Ok(watched)
    }

    /// A sender for forwarding additional events into the same channel.
    pub fn sender(&self) -> mpsc::Sender<SessionActivity> {
        self.sender.clone()
    }
}

/// Map a raw [`notify::Event`] to a [`SessionActivity`] using the given agent
/// roots. Returns `None` when the event does not touch any known root.
pub fn resolve_activity(
    event: &notify::Event,
    roots: &[(AgentType, PathBuf)],
) -> Option<SessionActivity> {
    let path = event.paths.first()?;
    let (agent_type, root) = longest_matching_root(path, roots)?;
    let relative = path.strip_prefix(root).ok()?;
    let session_id = session_id_from_relative(relative, &event.kind)?;

    Some(SessionActivity {
        session_id,
        agent_type,
        event_type: classify_event_kind(&event.kind),
        turn: None,
        timestamp: Utc::now(),
    })
}

/// Find the longest root that is an ancestor of `path`.
fn longest_matching_root<'a>(
    path: &Path,
    roots: &'a [(AgentType, PathBuf)],
) -> Option<(AgentType, &'a PathBuf)> {
    roots
        .iter()
        .filter(|(_, root)| path.starts_with(root))
        .max_by_key(|(_, root)| root.components().count())
        .map(|(agent_type, root)| (*agent_type, root))
}

/// Best-effort session-id extraction from the path relative to an agent root.
///
/// Heuristic (per-agent layouts):
/// - paths with a file extension: the file stem (Claude Code / Codex
///   transcripts are `<root>/<project>/<session-id>.jsonl`),
/// - other paths (session directories): the component directly under the root
///   (session directories are `<root>/<agent>/<session-id>/...`),
/// - Grok's `chat_history.jsonl`: the *parent directory* is the session id
///   (every grok session is `<root>/<encoded-cwd>/<session-id>/chat_history.jsonl`).
///
/// Extension-based (rather than event-kind-based) so the heuristic is stable
/// across platforms: Windows notify may deliver a create as `Create(Any)` or
/// a follow-up `Modify(Metadata)` before the file write event.
fn session_id_from_relative(relative: &Path, _kind: &EventKind) -> Option<String> {
    if relative.file_name().is_some_and(|n| n == grok::GROK_CHAT_HISTORY_FILE) {
        // The grok transcript lives one level under the session dir.
        return relative
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty());
    }
    if relative.extension().is_some() {
        if let Some(stem) = relative.file_stem() {
            let stem = stem.to_string_lossy().to_string();
            if !stem.is_empty() {
                return Some(stem);
            }
        }
    }
    relative
        .components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
}

/// Map a notify event kind to our coarse [`SessionEventType`].
fn classify_event_kind(kind: &EventKind) -> SessionEventType {
    match kind {
        EventKind::Create(_) => SessionEventType::Created,
        EventKind::Remove(_) => SessionEventType::Deleted,
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => SessionEventType::Renamed,
        EventKind::Modify(_) => SessionEventType::Modified,
        EventKind::Access(_) => SessionEventType::Modified,
        EventKind::Any | EventKind::Other => SessionEventType::Other,
    }
}

/// Snapshot of watched roots, primarily for tests/debugging.
pub fn watched_roots(session_watcher: &SessionWatcher) -> HashMap<AgentType, Vec<PathBuf>> {
    let mut map: HashMap<AgentType, Vec<PathBuf>> = HashMap::new();
    if let Ok(roots) = session_watcher.roots.lock() {
        for (agent_type, path) in roots.iter() {
            map.entry(*agent_type).or_default().push(path.clone());
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind};

    #[test]
    fn default_dirs_cover_all_agents() {
        let dirs = default_agent_dirs();
        assert_eq!(dirs.len(), AgentType::ALL.len());
        for agent in AgentType::ALL {
            assert!(
                dirs.iter().any(|(a, _)| *a == agent),
                "missing default dir for {agent}"
            );
        }
        let (_, claude) = dirs
            .iter()
            .find(|(a, _)| *a == AgentType::ClaudeCode)
            .unwrap();
        assert!(claude.ends_with(".claude/projects"));
    }

    #[test]
    fn resolve_activity_matches_longest_root() {
        let roots = vec![
            (AgentType::ClaudeCode, PathBuf::from("/home/u/.claude/projects")),
            (
                AgentType::Codex,
                PathBuf::from("/home/u/.codex/sessions"),
            ),
        ];
        let event = Event {
            kind: EventKind::Create(CreateKind::File),
            paths: vec![PathBuf::from(
                "/home/u/.claude/projects/demo/sess-abc.jsonl",
            )],
            attrs: notify::event::EventAttributes::default(),
        };
        let activity = resolve_activity(&event, &roots).expect("should resolve");
        assert_eq!(activity.agent_type, AgentType::ClaudeCode);
        assert_eq!(activity.session_id, "sess-abc");
        assert_eq!(activity.event_type, SessionEventType::Created);
        assert!(activity.turn.is_none());
    }

    #[test]
    fn resolve_activity_directory_session_uses_component_under_root() {
        let roots = vec![(AgentType::Speg, PathBuf::from("/home/u/.speg/sessions"))];
        let event = Event {
            kind: EventKind::Create(CreateKind::Folder),
            paths: vec![PathBuf::from(
                "/home/u/.speg/sessions/demo/sess-xyz",
            )],
            attrs: notify::event::EventAttributes::default(),
        };
        let activity = resolve_activity(&event, &roots).expect("should resolve");
        assert_eq!(activity.agent_type, AgentType::Speg);
        assert_eq!(activity.session_id, "demo");
    }

    #[test]
    fn resolve_activity_grok_chat_history_uses_parent_session_dir() {
        let roots = vec![(AgentType::Grok, PathBuf::from("/home/u/.grok/sessions"))];
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            paths: vec![PathBuf::from(
                "/home/u/.grok/sessions/C%3A%5Crepo/019f-abc/chat_history.jsonl",
            )],
            attrs: notify::event::EventAttributes::default(),
        };
        let activity = resolve_activity(&event, &roots).expect("should resolve");
        assert_eq!(activity.agent_type, AgentType::Grok);
        assert_eq!(activity.session_id, "019f-abc");
    }

    #[test]
    fn resolve_activity_ignores_unrelated_paths() {
        let roots = vec![(AgentType::Speg, PathBuf::from("/home/u/.speg/sessions"))];
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Any)),
            paths: vec![PathBuf::from("/home/u/other/foo.txt")],
            attrs: notify::event::EventAttributes::default(),
        };
        assert!(resolve_activity(&event, &roots).is_none());
    }

    #[test]
    fn classify_modify_kinds() {
        assert_eq!(
            classify_event_kind(&EventKind::Modify(ModifyKind::Name(
                notify::event::RenameMode::To
            ))),
            SessionEventType::Renamed
        );
        assert_eq!(
            classify_event_kind(&EventKind::Modify(ModifyKind::Data(
                notify::event::DataChange::Content
            ))),
            SessionEventType::Modified
        );
    }

    #[tokio::test]
    async fn watcher_emits_activity_on_file_create() {
        let dir = std::env::temp_dir().join(format!(
            "cacm-watcher-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // Seed the watcher with this temp dir as a fake "speg" root so event
        // mapping works without touching a real home directory.
        let (mut watcher, mut rx) =
            SessionWatcher::with_roots(vec![(AgentType::Speg, dir.clone())]).unwrap();
        watcher.watch(AgentType::Speg, &dir, true).unwrap();

        std::fs::write(dir.join("sess-1.jsonl"), "{}").unwrap();

        let activity = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for session activity")
            .expect("channel closed");
        assert_eq!(activity.agent_type, AgentType::Speg);
        assert_eq!(activity.session_id, "sess-1");
        assert_eq!(activity.event_type, SessionEventType::Created);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
