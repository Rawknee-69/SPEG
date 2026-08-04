//! Memory manager — bounds the daemon's memory so it degrades gracefully
//! instead of crashing (OOM) under load.
//!
//! The manager works on the *stored-data footprint* reported by the storage
//! backend (in-memory graph bytes, or the SQLite page footprint), which is
//! the dominant, daemon-controlled memory driver. It exposes two budgets:
//!
//! - **soft** — above this the daemon logs a warning and shrinks storage
//!   (evicting the oldest context entries) before admitting more writes.
//! - **hard** — writes that would push the footprint past this are rejected
//!   with `-32002 memory pressure`, so the process cannot grow without bound.
//!
//! The per-connection and per-frame caps in `server.rs` bound the rest of the
//! memory surface (sockets, buffers, the pending map).

use serde::{Deserialize, Serialize};

/// Default soft budget (256 MiB of stored data before shrinking kicks in).
pub const DEFAULT_SOFT_LIMIT: usize = 256 << 20;
/// Default hard budget (512 MiB — stores beyond this are rejected).
pub const DEFAULT_HARD_LIMIT: usize = 512 << 20;

/// Pressure level derived from current usage vs the budgets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryPressure {
    /// Under the soft budget — normal operation.
    Normal,
    /// Over the soft budget — warn and shrink storage before admitting.
    Soft,
    /// At/over the hard budget — reject new stores.
    Hard,
}

/// Snapshot of the daemon's memory state, exposed via `cacm.memory.stats`
/// and `/healthz`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryStats {
    pub used_bytes: usize,
    pub soft_limit: usize,
    pub hard_limit: usize,
    pub pressure: MemoryPressure,
    pub sessions: usize,
    pub connections: usize,
    pub pending: usize,
}

/// The daemon's memory manager.
#[derive(Debug, Clone)]
pub struct MemoryManager {
    soft_limit: usize,
    hard_limit: usize,
}

impl MemoryManager {
    pub fn new(soft_limit: usize, hard_limit: usize) -> Self {
        let hard_limit = hard_limit.max(soft_limit);
        Self {
            soft_limit,
            hard_limit,
        }
    }

    pub const fn defaults() -> Self {
        Self {
            soft_limit: DEFAULT_SOFT_LIMIT,
            hard_limit: DEFAULT_HARD_LIMIT,
        }
    }

    pub const fn soft_limit(&self) -> usize {
        self.soft_limit
    }

    pub const fn hard_limit(&self) -> usize {
        self.hard_limit
    }

    /// Current pressure for a given footprint.
    pub fn pressure(&self, used: usize) -> MemoryPressure {
        if used >= self.hard_limit {
            MemoryPressure::Hard
        } else if used >= self.soft_limit {
            MemoryPressure::Soft
        } else {
            MemoryPressure::Normal
        }
    }

    /// May a store of `incoming` bytes be admitted on top of `used`?
    ///
    /// Returns an error (the memory-pressure message) when the estimated
    /// footprint would reach the hard limit.
    pub fn admit(&self, used: usize, incoming: usize) -> Result<(), String> {
        let estimated = used.saturating_add(incoming);
        if estimated >= self.hard_limit {
            Err(format!(
                "memory pressure: ~{estimated} bytes would reach the {}-byte hard limit",
                self.hard_limit
            ))
        } else {
            Ok(())
        }
    }

    /// Footprint to shrink storage to under soft pressure (¾ of the soft
    /// budget, leaving headroom before the hard limit).
    pub fn shrink_target(&self) -> usize {
        self.soft_limit.saturating_mul(3) / 4
    }
}

impl Default for MemoryManager {
    fn default() -> Self {
        Self::defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pressure_levels_follow_budgets() {
        let manager = MemoryManager::new(100, 200);
        assert_eq!(manager.pressure(0), MemoryPressure::Normal);
        assert_eq!(manager.pressure(99), MemoryPressure::Normal);
        assert_eq!(manager.pressure(100), MemoryPressure::Soft);
        assert_eq!(manager.pressure(199), MemoryPressure::Soft);
        assert_eq!(manager.pressure(200), MemoryPressure::Hard);
        assert_eq!(manager.pressure(500), MemoryPressure::Hard);
    }

    #[test]
    fn admit_rejects_at_hard_limit_and_accepts_below() {
        let manager = MemoryManager::new(100, 200);
        assert!(manager.admit(150, 40).is_ok()); // 190 < 200
        assert!(manager.admit(150, 50).is_err()); // 200 → reject
        assert!(manager.admit(0, 199).is_ok());
        assert!(manager.admit(0, 200).is_err());
    }

    #[test]
    fn hard_limit_is_never_below_soft() {
        let manager = MemoryManager::new(500, 100);
        assert_eq!(manager.soft_limit(), 500);
        assert_eq!(manager.hard_limit(), 500);
    }

    #[test]
    fn shrink_target_leaves_headroom() {
        let manager = MemoryManager::new(100, 200);
        assert_eq!(manager.shrink_target(), 75);
        let manager = MemoryManager::default();
        assert!(manager.shrink_target() < manager.soft_limit());
        assert!(manager.shrink_target() > 0);
    }
}
