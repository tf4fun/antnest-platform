use std::sync::OnceLock;

use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing::span::{Attributes, Id, Record};
use tracing::subscriber::Interest;
use tracing::{Dispatch, Event, Metadata, Subscriber};

/// Call before a test installs a thread-scoped subscriber.
///
/// Parallel tests share tracing-core's process-wide callsite registry. While
/// exactly one dispatcher is registered, tracing-core 0.1.36 computes a new
/// callsite's interest from the registering thread's default alone, so a test
/// without a subscriber can cache `never` for a span another test is capturing
/// (tokio-rs/tracing#3611). A second dispatcher that is never installed and
/// lives for the whole process keeps every registration on the path that
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

#[cfg(test)]
mod tests {
    use super::stabilize_callsite_registry;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tracing::span::{Attributes, Id};
    use tracing_subscriber::layer::{Context, Layer};
    use tracing_subscriber::prelude::*;

    struct CountSpans(Arc<AtomicUsize>);

    impl<S: tracing::Subscriber> Layer<S> for CountSpans {
        fn on_new_span(&self, _: &Attributes<'_>, _: &Id, _: Context<'_, S>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn probe() -> tracing::Span {
        tracing::info_span!("callsite-registry-probe")
    }

    #[test]
    fn a_thread_without_a_subscriber_cannot_disable_a_scoped_capture() {
        stabilize_callsite_registry();
        let spans = Arc::new(AtomicUsize::new(0));
        let _guard = tracing::subscriber::set_default(
            tracing_subscriber::registry().with(CountSpans(spans.clone())),
        );
        std::thread::spawn(|| drop(probe())).join().unwrap();
        drop(probe());
        assert_eq!(spans.load(Ordering::SeqCst), 1);
    }
}
