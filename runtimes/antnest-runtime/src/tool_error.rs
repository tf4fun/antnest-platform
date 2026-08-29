use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

macro_rules! define_tool_error_codes {
    ($($variant:ident => $value:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub(crate) enum ToolErrorCode {
            $($variant),+
        }

        impl ToolErrorCode {
            pub(crate) const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value),+
                }
            }

            fn parse(value: &str) -> Option<Self> {
                match value {
                    $($value => Some(Self::$variant),)+
                    _ => None,
                }
            }

            #[cfg(test)]
            pub(crate) const ALL: &'static [Self] = &[$(Self::$variant),+];
        }
    };
}

define_tool_error_codes! {
    Canceled => "canceled",
    ChildProcessContainmentUnproven => "child_process_containment_unproven",
    ContentNotUtf8 => "content_not_utf8",
    EditFailed => "edit_failed",
    EditReadFailed => "edit_read_failed",
    EncodeResultFailed => "encode_result_failed",
    InvalidParams => "invalid_params",
    InvalidPath => "invalid_path",
    OldStringNotFound => "old_string_not_found",
    OldStringNotUnique => "old_string_not_unique",
    OutcomeUnknown => "outcome_unknown",
    OutputCaptureFailed => "output_capture_failed",
    ReadFailed => "read_failed",
    ResultTooLarge => "result_too_large",
    RuntimeBusy => "runtime_busy",
    RuntimeFailed => "runtime_failed",
    RuntimeUnavailable => "runtime_unavailable",
    SpawnFailed => "spawn_failed",
    Timeout => "timeout",
    WaitFailed => "wait_failed",
    WriteFailed => "write_failed",
}

impl std::fmt::Display for ToolErrorCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Serialize for ToolErrorCode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ToolErrorCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).ok_or_else(|| D::Error::custom(format!("unknown tool error: {value}")))
    }
}

#[derive(Debug)]
pub(crate) struct ToolError {
    pub(crate) code: ToolErrorCode,
    pub(crate) message: String,
}

impl ToolError {
    pub(crate) fn new(code: ToolErrorCode, message: impl std::fmt::Display) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }

    pub(crate) fn invalid_params(message: impl std::fmt::Display) -> Self {
        Self::new(ToolErrorCode::InvalidParams, message)
    }
}
