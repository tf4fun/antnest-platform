pub(crate) const MAX_CHANGE_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileObservation {
    pub(crate) path: String,
    pub(crate) change: Option<FileChange>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FileChange {
    Text {
        before: Option<String>,
        after: String,
    },
    TooLarge,
    NonUtf8,
    Unavailable,
}

impl FileChange {
    pub(crate) fn text(before: Option<&[u8]>, after: &[u8]) -> Self {
        if before.map_or(0, <[u8]>::len).saturating_add(after.len()) > MAX_CHANGE_BYTES {
            return Self::TooLarge;
        }
        let Ok(before) = before.map(std::str::from_utf8).transpose() else {
            return Self::NonUtf8;
        };
        let Ok(after) = std::str::from_utf8(after) else {
            return Self::NonUtf8;
        };
        Self::Text {
            before: before.map(str::to_owned),
            after: after.to_owned(),
        }
    }
}
