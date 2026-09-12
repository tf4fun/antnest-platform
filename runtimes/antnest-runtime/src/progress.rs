use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

pub(crate) const MAX_PROGRESS_MESSAGE_BYTES: usize = 8192;
const MAX_REPORTS: usize = 256;
const QUEUE_SIZE: usize = 32;
const TRUNCATED: &str = "Live progress truncated; see the final tool result.";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProgressUpdate {
    pub(crate) progress: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) total: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

impl ProgressUpdate {
    pub(crate) fn message(progress: f64, message: impl Into<String>) -> Self {
        Self {
            progress,
            total: None,
            message: Some(message.into()),
        }
    }

    pub(crate) fn bound_message(&mut self) {
        let Some(message) = &mut self.message else {
            return;
        };
        if message.len() <= MAX_PROGRESS_MESSAGE_BYTES {
            return;
        }
        let mut end = MAX_PROGRESS_MESSAGE_BYTES - TRUNCATED.len() - 1;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.push('\n');
        message.push_str(TRUNCATED);
        message.shrink_to_fit();
    }
}

#[derive(Clone, Default)]
pub(crate) struct ProgressSink(Option<Arc<dyn Fn(ProgressUpdate) + Send + Sync>>);

impl ProgressSink {
    pub(crate) fn new(write: impl Fn(ProgressUpdate) + Send + Sync + 'static) -> Self {
        Self(Some(Arc::new(write)))
    }

    pub(crate) fn emit(&self, mut update: ProgressUpdate) {
        if let Some(write) = &self.0 {
            update.bound_message();
            write(update);
        }
    }
}

pub(crate) struct ProgressQueue {
    pub(crate) receiver: mpsc::Receiver<ProgressUpdate>,
    pub(crate) overflowed: Arc<AtomicBool>,
}

impl ProgressQueue {
    pub(crate) fn new() -> (ProgressSink, Self) {
        let (sender, receiver) = mpsc::channel(QUEUE_SIZE);
        let overflowed = Arc::new(AtomicBool::new(false));
        let overflow = overflowed.clone();
        let sink = ProgressSink::new(move |update| {
            if matches!(
                sender.try_send(update),
                Err(mpsc::error::TrySendError::Full(_))
            ) {
                overflow.store(true, Ordering::Relaxed);
            }
        });
        (
            sink,
            Self {
                receiver,
                overflowed,
            },
        )
    }
}

#[derive(Default)]
pub(crate) struct ProgressPolicy {
    last: Option<f64>,
    reports: usize,
    ended: bool,
}

impl ProgressPolicy {
    pub(crate) fn accept(
        &mut self,
        mut update: ProgressUpdate,
        overflowed: bool,
    ) -> Option<ProgressUpdate> {
        if self.ended
            || !update.progress.is_finite()
            || update.progress < 0.0
            || self.last.is_some_and(|last| update.progress <= last)
        {
            return None;
        }
        if update
            .total
            .is_some_and(|total| !total.is_finite() || total < update.progress)
        {
            return None;
        }
        self.last = Some(update.progress);
        self.reports += 1;
        if overflowed || self.reports == MAX_REPORTS {
            update.message = Some(TRUNCATED.into());
            self.ended = true;
        }
        update.bound_message();
        Some(update)
    }
}

#[derive(Default)]
pub(crate) struct Utf8Preview {
    pending: Vec<u8>,
}

impl Utf8Preview {
    pub(crate) fn push(&mut self, bytes: &[u8], finished: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::new();
        let mut offset = 0;
        while offset < self.pending.len() {
            match std::str::from_utf8(&self.pending[offset..]) {
                Ok(valid) => {
                    text.push_str(valid);
                    offset = self.pending.len();
                }
                Err(error) => {
                    let end = offset + error.valid_up_to();
                    text.push_str(
                        std::str::from_utf8(&self.pending[offset..end]).expect("validated prefix"),
                    );
                    offset = end;
                    match error.error_len() {
                        Some(size) => {
                            text.push('\u{fffd}');
                            offset += size;
                        }
                        None if finished => {
                            text.push('\u{fffd}');
                            offset = self.pending.len();
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..offset);
        text
    }
}
