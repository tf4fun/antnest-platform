macro_rules! define_error_codes {
    ($name:ident { $($(#[$meta:meta])* $variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub(crate) enum $name {
            $($(#[$meta])* $variant),+
        }

        impl $name {
            pub(crate) const fn as_str(self) -> &'static str {
                match self {
                    $($(#[$meta])* Self::$variant => $value),+
                }
            }

            #[cfg(test)]
            pub(crate) const ALL: &'static [Self] = &[
                $($(#[$meta])* Self::$variant),+
            ];
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

define_error_codes!(BootstrapStage {
    Entry => "entry",
    RuntimeSpec => "runtime_spec",
    EnvironmentSanitized => "environment_sanitized",
    NetworkReady => "network_ready",
    Filesystem => "filesystem",
    RootsReady => "roots_ready",
    PreTokio => "pre_tokio",
    Executor => "executor",
    #[cfg(any(test, not(target_os = "linux")))]
    Platform => "platform",
});

define_error_codes!(BootstrapErrorCode {
    BootstrapEvidenceFailed => "bootstrap_evidence_failed",
    EntryFailed => "entry_failed",
    EnvironmentVerificationFailed => "environment_verification_failed",
    ExecutorInitializationFailed => "executor_initialization_failed",
    InvalidConfig => "invalid_config",
    NamedRootsFailed => "named_roots_failed",
    NetworkBootstrapFailed => "network_bootstrap_failed",
    NetworkVerificationFailed => "network_verification_failed",
    PreExecutorVerificationFailed => "pre_executor_verification_failed",
    RootVerificationFailed => "root_verification_failed",
    #[cfg(any(test, not(target_os = "linux")))]
    UnsupportedPlatform => "unsupported_platform",
    WorkspaceInitializationFailed => "workspace_initialization_failed",
    WorkspaceOwnershipFailed => "workspace_ownership_failed",
});

define_error_codes!(RuntimeErrorCode {
    ChildProcessContainmentUnproven => "child_process_containment_unproven",
    ExecutorProbeFailed => "executor_probe_failed",
    HttpBindFailed => "http_bind_failed",
    HttpServiceFailed => "http_service_failed",
    LocalNetworkFailed => "local_network_failed",
    NetworkProtocolFailed => "network_protocol_failed",
    NetworkTransportFailed => "network_transport_failed",
    ShutdownTimeout => "shutdown_timeout",
    SignalListenerFailed => "signal_listener_failed",
    TelemetryInitializationFailed => "telemetry_initialization_failed",
    UnexpectedExit => "unexpected_exit",
});
