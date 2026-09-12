use schemars::JsonSchema;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Copy, Debug, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolEffectState {
    None,
    Settled,
    Unknown,
}

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

            pub(crate) fn parse(value: &str) -> Option<Self> {
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
    pub(crate) effect_state: ToolEffectState,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl ToolError {
    pub(crate) fn new(code: ToolErrorCode, message: impl std::fmt::Display) -> Self {
        let effect_state = if code == ToolErrorCode::OutcomeUnknown {
            ToolEffectState::Unknown
        } else {
            ToolEffectState::None
        };
        Self::with_effect(code, message, effect_state)
    }

    pub(crate) fn unknown(code: ToolErrorCode, message: impl std::fmt::Display) -> Self {
        Self::with_effect(code, message, ToolEffectState::Unknown)
    }

    pub(crate) fn outcome_unknown(message: impl std::fmt::Display) -> Self {
        Self::unknown(ToolErrorCode::OutcomeUnknown, message)
    }

    fn with_effect(
        code: ToolErrorCode,
        message: impl std::fmt::Display,
        effect_state: ToolEffectState,
    ) -> Self {
        Self {
            code,
            message: message.to_string(),
            effect_state,
            source: None,
        }
    }

    pub(crate) fn invalid_params(message: impl std::fmt::Display) -> Self {
        Self::new(ToolErrorCode::InvalidParams, message)
    }

    pub(crate) fn with_source(
        mut self,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        self.source = Some(Box::new(source));
        self
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ToolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn std::error::Error + 'static))
    }
}
