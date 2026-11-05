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
    ($($variant:ident => $value:path),+ $(,)?) => {
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
    AtomicSkillReplaceUnsupported => crate::api_errors_gen::ATOMIC_SKILL_REPLACE_UNSUPPORTED,
    Canceled => crate::api_errors_gen::CANCELED,
    ChildProcessContainmentUnproven => crate::api_errors_gen::CHILD_PROCESS_CONTAINMENT_UNPROVEN,
    ContentNotUtf8 => crate::api_errors_gen::CONTENT_NOT_UTF8,
    EditFailed => crate::api_errors_gen::EDIT_FAILED,
    EditReadFailed => crate::api_errors_gen::EDIT_READ_FAILED,
    EncodeResultFailed => crate::api_errors_gen::ENCODE_RESULT_FAILED,
    InvalidParams => crate::api_errors_gen::INVALID_PARAMS,
    InvalidPath => crate::api_errors_gen::INVALID_PATH,
    OldStringNotFound => crate::api_errors_gen::OLD_STRING_NOT_FOUND,
    OldStringNotUnique => crate::api_errors_gen::OLD_STRING_NOT_UNIQUE,
    OutcomeUnknown => crate::api_errors_gen::OUTCOME_UNKNOWN,
    OutputCaptureFailed => crate::api_errors_gen::OUTPUT_CAPTURE_FAILED,
    ReadFailed => crate::api_errors_gen::READ_FAILED,
    ResultTooLarge => crate::api_errors_gen::RESULT_TOO_LARGE,
    RuntimeBusy => crate::api_errors_gen::RUNTIME_BUSY,
    RuntimeFailed => crate::api_errors_gen::RUNTIME_FAILED,
    RuntimeUnavailable => crate::api_errors_gen::RUNTIME_UNAVAILABLE,
    SkillBackgroundTaskRunning => crate::api_errors_gen::SKILL_BACKGROUND_TASK_RUNNING,
    SkillManagedCallInFlight => crate::api_errors_gen::SKILL_MANAGED_CALL_IN_FLIGHT,
    SkillStorageFull => crate::api_errors_gen::SKILL_STORAGE_FULL,
    SkillWritersUnknown => crate::api_errors_gen::SKILL_WRITERS_UNKNOWN,
    SpawnFailed => crate::api_errors_gen::SPAWN_FAILED,
    Timeout => crate::api_errors_gen::TIMEOUT,
    TemporaryRunClosed => crate::api_errors_gen::TEMPORARY_RUN_CLOSED,
    TemporaryScopeBusy => crate::api_errors_gen::TEMPORARY_SCOPE_BUSY,
    TemporaryBackgroundNotSupported => crate::api_errors_gen::TEMPORARY_BACKGROUND_NOT_SUPPORTED,
    WaitFailed => crate::api_errors_gen::WAIT_FAILED,
    WriteFailed => crate::api_errors_gen::WRITE_FAILED,
}

impl ToolErrorCode {
    #[cfg(test)]
    pub(crate) const fn is_model_facing(self) -> bool {
        !matches!(
            self,
            Self::AtomicSkillReplaceUnsupported
                | Self::SkillBackgroundTaskRunning
                | Self::SkillManagedCallInFlight
                | Self::SkillStorageFull
                | Self::SkillWritersUnknown
                | Self::TemporaryRunClosed
                | Self::TemporaryScopeBusy
        )
    }
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
    pub(crate) blocked_subject_id: Option<String>,
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
    pub(crate) fn settled(code: ToolErrorCode, message: impl std::fmt::Display) -> Self {
        Self::with_effect(code, message, ToolEffectState::Settled)
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
            blocked_subject_id: None,
            source: None,
        }
    }

    pub(crate) fn with_blocked_subject(mut self, subject_id: impl Into<String>) -> Self {
        self.blocked_subject_id = Some(subject_id.into());
        self
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
