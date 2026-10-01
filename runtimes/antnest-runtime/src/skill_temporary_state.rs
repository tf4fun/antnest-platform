use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default)]
pub(crate) struct TemporaryScopes(Arc<Mutex<Scopes>>);

#[derive(Debug, Default)]
struct Scopes {
    active: Option<ActiveScope>,
    closed: HashMap<String, Instant>,
    saturated_until: Option<Instant>,
}

#[derive(Debug)]
struct ActiveScope {
    run: String,
    requests: HashMap<String, (String, String)>,
}

const CLOSED_RETENTION: Duration = Duration::from_secs(121);
const MAX_CLOSED: usize = 1024;

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum TemporaryAdmissionError {
    RunClosed,
    ScopeBusy,
    RequestConflict,
    LimitExceeded,
}

impl TemporaryScopes {
    pub(crate) fn begin(
        &self,
        run: &str,
        request: &str,
        content: &str,
        artifact: &str,
        now: Instant,
    ) -> Result<(), TemporaryAdmissionError> {
        let mut scopes = self.0.lock().expect("temporary scopes");
        scopes.expire(now);
        if scopes.closed.contains_key(run) {
            return Err(TemporaryAdmissionError::RunClosed);
        }
        if scopes.saturated_until.is_some() {
            return Err(TemporaryAdmissionError::ScopeBusy);
        }
        let active = scopes.active.get_or_insert_with(|| ActiveScope {
            run: run.into(),
            requests: HashMap::new(),
        });
        if active.run != run {
            return Err(TemporaryAdmissionError::ScopeBusy);
        }
        if let Some(previous) = active.requests.get(request) {
            return if previous.0 == content && previous.1 == artifact {
                Ok(())
            } else {
                Err(TemporaryAdmissionError::RequestConflict)
            };
        }
        if active.requests.len() >= 4 {
            return Err(TemporaryAdmissionError::LimitExceeded);
        }
        active
            .requests
            .insert(request.into(), (content.into(), artifact.into()));
        Ok(())
    }
    pub(crate) fn close(&self, run: &str, now: Instant) {
        let mut scopes = self.0.lock().expect("temporary scopes");
        scopes.expire(now);
        if scopes.closed.len() >= MAX_CLOSED && !scopes.closed.contains_key(run) {
            // Release must always remain available. One bounded global fence
            // covers every unexpired delayed ticket when the identity cache fills.
            scopes.saturated_until = Some(now + CLOSED_RETENTION);
        } else {
            scopes.closed.insert(run.into(), now);
        }
    }
    pub(crate) fn released(&self, run: &str) {
        let mut scopes = self.0.lock().expect("temporary scopes");
        if scopes
            .active
            .as_ref()
            .is_some_and(|active| active.run == run)
        {
            scopes.active = None;
        }
    }
    pub(crate) fn active(&self) -> bool {
        self.0.lock().expect("temporary scopes").active.is_some()
    }
}

impl Scopes {
    fn expire(&mut self, now: Instant) {
        self.closed
            .retain(|_, closed| now.saturating_duration_since(*closed) < CLOSED_RETENTION);
        if self.saturated_until.is_some_and(|until| now >= until) {
            self.saturated_until = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_closed_run_cannot_be_recreated_by_a_delayed_install() {
        let scopes = TemporaryScopes::default();
        let now = Instant::now();
        assert!(
            scopes
                .begin("run1", "load1", "digest1", "zip1", now)
                .is_ok()
        );
        assert!(scopes.active());
        scopes.close("run1", now);
        assert_eq!(
            scopes.begin("run1", "load1", "digest1", "zip1", now),
            Err(TemporaryAdmissionError::RunClosed)
        );
        scopes.released("run1");
        assert!(!scopes.active());
        assert_eq!(
            scopes.begin("run1", "load2", "digest2", "zip2", now),
            Err(TemporaryAdmissionError::RunClosed)
        );
        assert!(
            scopes
                .begin("run2", "load3", "digest1", "zip1", now)
                .is_ok()
        );
    }

    #[test]
    fn admission_is_single_run_and_replay_binds_content_with_four_loads() {
        let scopes = TemporaryScopes::default();
        let now = Instant::now();
        for index in 0..4 {
            assert!(
                scopes
                    .begin("run1", &format!("load{index}"), "digest1", "zip1", now)
                    .is_ok()
            );
        }
        assert!(
            scopes
                .begin("run1", "load0", "digest1", "zip1", now)
                .is_ok()
        );
        assert_eq!(
            scopes.begin("run1", "load0", "digest2", "zip1", now),
            Err(TemporaryAdmissionError::RequestConflict)
        );
        assert_eq!(
            scopes.begin("run1", "load4", "digest1", "zip1", now),
            Err(TemporaryAdmissionError::LimitExceeded)
        );
        assert_eq!(
            scopes.begin("run2", "load0", "digest1", "zip1", now),
            Err(TemporaryAdmissionError::ScopeBusy)
        );
    }

    #[test]
    fn closed_identity_saturation_is_bounded_and_never_prevents_release() {
        let scopes = TemporaryScopes::default();
        let now = Instant::now();
        for index in 0..1100 {
            scopes.close(&format!("run{index}"), now);
        }
        scopes.released("run1099");
        assert_eq!(
            scopes.begin("fresh", "load1", "digest1", "zip1", now),
            Err(TemporaryAdmissionError::ScopeBusy)
        );
        assert!(
            scopes
                .begin(
                    "fresh",
                    "load1",
                    "digest1",
                    "zip1",
                    now + Duration::from_secs(122)
                )
                .is_ok()
        );
    }
}
