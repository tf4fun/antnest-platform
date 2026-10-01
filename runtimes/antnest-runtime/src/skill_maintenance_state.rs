use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Default)]
pub(crate) struct MaintenanceGenerations {
    inner: Arc<Mutex<GenerationMap>>,
    changed: Arc<Notify>,
}

#[derive(Debug, Default)]
struct GenerationMap {
    next_id: u64,
    entries: HashMap<GenerationKey, GenerationEntry>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct GenerationKey {
    agent_id: String,
    job_id: String,
    generation: u64,
}

#[derive(Debug, Default)]
struct GenerationEntry {
    closed: bool,
    active: HashMap<u64, CancellationToken>,
}

#[derive(Debug)]
pub(crate) struct MaintenanceLease {
    generations: MaintenanceGenerations,
    key: GenerationKey,
    id: u64,
    cancel: CancellationToken,
}

impl MaintenanceLease {
    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.cancel.clone()
    }
}

impl Drop for MaintenanceLease {
    fn drop(&mut self) {
        let mut inner = self
            .generations
            .inner
            .lock()
            .expect("maintenance generations");
        let remove = if let Some(entry) = inner.entries.get_mut(&self.key) {
            entry.active.remove(&self.id);
            !entry.closed && entry.active.is_empty()
        } else {
            false
        };
        if remove {
            inner.entries.remove(&self.key);
        }
        drop(inner);
        self.generations.changed.notify_waiters();
    }
}

impl MaintenanceGenerations {
    pub(crate) fn enter(
        &self,
        agent_id: &str,
        job_id: &str,
        generation: u64,
    ) -> Result<MaintenanceLease, ()> {
        let key = GenerationKey::new(agent_id, job_id, generation);
        let mut inner = self.inner.lock().expect("maintenance generations");
        if inner.entries.get(&key).is_some_and(|entry| entry.closed) {
            return Err(());
        }
        inner.next_id = inner.next_id.wrapping_add(1);
        let id = inner.next_id;
        let cancel = CancellationToken::new();
        inner
            .entries
            .entry(key.clone())
            .or_default()
            .active
            .insert(id, cancel.clone());
        Ok(MaintenanceLease {
            generations: self.clone(),
            key,
            id,
            cancel,
        })
    }

    pub(crate) async fn close_and_settle(&self, agent_id: &str, job_id: &str, generation: u64) {
        let key = GenerationKey::new(agent_id, job_id, generation);
        {
            let mut inner = self.inner.lock().expect("maintenance generations");
            let entry = inner.entries.entry(key.clone()).or_default();
            entry.closed = true;
            for cancel in entry.active.values() {
                cancel.cancel();
            }
        }
        loop {
            let changed = self.changed.notified();
            let settled = self
                .inner
                .lock()
                .expect("maintenance generations")
                .entries
                .get(&key)
                .is_none_or(|entry| entry.active.is_empty());
            if settled {
                return;
            }
            changed.await;
        }
    }

    pub(crate) fn release_closed(&self, agent_id: &str, job_id: &str, generation: u64) {
        let key = GenerationKey::new(agent_id, job_id, generation);
        let mut inner = self.inner.lock().expect("maintenance generations");
        if inner
            .entries
            .get(&key)
            .is_some_and(|entry| entry.closed && entry.active.is_empty())
        {
            inner.entries.remove(&key);
        }
    }
}

impl GenerationKey {
    fn new(agent_id: &str, job_id: &str, generation: u64) -> Self {
        Self {
            agent_id: agent_id.to_owned(),
            job_id: job_id.to_owned(),
            generation,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::MaintenanceGenerations;

    #[tokio::test]
    async fn cancel_closes_admission_and_waits_until_active_executor_settles() {
        let generations = MaintenanceGenerations::default();
        let lease = generations.enter("agent-1", "job-1", 1).unwrap();
        let closing = {
            let generations = generations.clone();
            tokio::spawn(async move {
                generations.close_and_settle("agent-1", "job-1", 1).await;
            })
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            lease.cancellation().cancelled(),
        )
        .await
        .unwrap();
        assert!(generations.enter("agent-1", "job-1", 1).is_err());
        assert!(!closing.is_finished());
        drop(lease);
        closing.await.unwrap();
        assert!(generations.enter("agent-1", "job-1", 1).is_err());
        assert!(generations.enter("agent-1", "job-1", 2).is_ok());
    }
}
