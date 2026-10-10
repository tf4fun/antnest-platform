use std::sync::OnceLock;

use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing::span::{Attributes, Id, Record};
use tracing::subscriber::Interest;
use tracing::{Dispatch, Event, Metadata, Subscriber};

/// Call before a test creates a thread- or future-scoped dispatcher.
///
/// Parallel tests share tracing-core's process-wide callsite registry. While
/// exactly one dispatcher is registered, tracing-core 0.1.36 computes a new
/// callsite's interest from the registering thread's default alone, so a test
/// without a subscriber can cache `never` for an event or span another test is
/// capturing (tokio-rs/tracing#3611). A second dispatcher that is never installed
/// and lives for the whole process keeps every registration on the path that
/// consults all live dispatchers.
///
/// On that path, another test's subscriber may be dropped for the last time
/// while the registry lock is held. When that drop releases an OpenTelemetry
/// tracer provider, the provider's first internal log registers a callsite,
/// re-enters the lock, and deadlocks the test process. Registering that
/// callsite here, outside the lock, keeps later provider drops lock-free.
pub(crate) fn stabilize_callsite_registry() {
    static ANCHOR: OnceLock<Dispatch> = OnceLock::new();
    ANCHOR.get_or_init(|| {
        let anchor = Dispatch::new(Anchor);
        let provider = SdkTracerProvider::builder().build();
        let _ = provider.shutdown();
        drop(provider);
        anchor
    });
}

/// Defers every enablement decision to the thread's own default subscriber
/// and leaves the global max level unrestricted.
struct Anchor;

impl Subscriber for Anchor {
    fn register_callsite(&self, _: &'static Metadata<'static>) -> Interest {
        Interest::sometimes()
    }

    fn enabled(&self, _: &Metadata<'_>) -> bool {
        false
    }

    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }

    fn record(&self, _: &Id, _: &Record<'_>) {}

    fn record_follows_from(&self, _: &Id, _: &Id) {}

    fn event(&self, _: &Event<'_>) {}

    fn enter(&self, _: &Id) {}

    fn exit(&self, _: &Id) {}
}
