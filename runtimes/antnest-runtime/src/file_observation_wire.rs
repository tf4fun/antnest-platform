use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::file_observation::{FileChange, FileObservation, MAX_CHANGE_BYTES};

pub(crate) const FILE_META_KEY: &str = "io.antnest.runtime/file";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WireFileObservation {
    path: String,
    change: Option<WireFileChange>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WireFileChange {
    Text {
        before: Option<String>,
        after: String,
    },
    TooLarge,
    NonUtf8,
    Unavailable,
}

impl WireFileObservation {
    pub(crate) fn bounded(observation: FileObservation) -> Option<Self> {
        let mut wire = Self {
            path: observation.path,
            change: observation.change.map(Into::into),
        };
        if !wire.fits() && wire.change.is_some() {
            wire.change = Some(WireFileChange::TooLarge);
        }
        wire.fits().then_some(wire)
    }

    fn fits(&self) -> bool {
        // Bound both transports after JSON escaping, not merely the source text.
        serde_json::to_vec(self).is_ok_and(|data| data.len() <= MAX_CHANGE_BYTES)
            && serde_json::to_vec(&self.metadata()).is_ok_and(|data| data.len() <= MAX_CHANGE_BYTES)
    }

    pub(crate) fn metadata(&self) -> Value {
        let mut file = json!({"path": self.path});
        match &self.change {
            Some(WireFileChange::Text { before, after }) => {
                file["diff"] = json!({"oldText": before, "newText": after});
            }
            Some(WireFileChange::TooLarge) => file["diffOmitted"] = json!("too_large"),
            Some(WireFileChange::NonUtf8) => file["diffOmitted"] = json!("non_utf8"),
            Some(WireFileChange::Unavailable) => file["diffOmitted"] = json!("unavailable"),
            None => {}
        }
        json!({FILE_META_KEY: file})
    }
}

impl From<WireFileObservation> for FileObservation {
    fn from(wire: WireFileObservation) -> Self {
        Self {
            path: wire.path,
            change: wire.change.map(Into::into),
        }
    }
}

impl From<FileChange> for WireFileChange {
    fn from(change: FileChange) -> Self {
        match change {
            FileChange::Text { before, after } => Self::Text { before, after },
            FileChange::TooLarge => Self::TooLarge,
            FileChange::NonUtf8 => Self::NonUtf8,
            FileChange::Unavailable => Self::Unavailable,
        }
    }
}

impl From<WireFileChange> for FileChange {
    fn from(change: WireFileChange) -> Self {
        match change {
            WireFileChange::Text { before, after } => Self::Text { before, after },
            WireFileChange::TooLarge => Self::TooLarge,
            WireFileChange::NonUtf8 => Self::NonUtf8,
            WireFileChange::Unavailable => Self::Unavailable,
        }
    }
}
