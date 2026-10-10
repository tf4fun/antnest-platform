#[path = "../src/test_tracing.rs"]
mod test_tracing;

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use tracing::{Event, Subscriber, span::Attributes, span::Id};
use tracing_subscriber::{layer::Context, prelude::*};

#[derive(Clone, Default)]
struct Capture {
    events: Arc<AtomicUsize>,
    spans: Arc<AtomicUsize>,
}

impl<S: Subscriber> tracing_subscriber::Layer<S> for Capture {
    fn on_event(&self, _: &Event<'_>, _: Context<'_, S>) {
        self.events.fetch_add(1, Ordering::SeqCst);
    }

    fn on_new_span(&self, _: &Attributes<'_>, _: &Id, _: Context<'_, S>) {
        self.spans.fetch_add(1, Ordering::SeqCst);
    }
}

fn probe() {
    tracing::info!("egress callsite event probe");
    drop(tracing::info_span!("egress callsite span probe"));
}

// Keep this as the only test in its binary: another live subscriber could hide
// tracing-core's single-dispatcher registration path. The other Egress binaries
// continue to use the default parallel test runner.
#[test]
fn a_thread_without_a_subscriber_cannot_disable_scoped_events_or_spans() {
    test_tracing::stabilize_callsite_registry();
    let capture = Capture::default();
    let subscriber = tracing_subscriber::registry().with(capture.clone());
    tracing::subscriber::with_default(subscriber, || {
        // A joined thread fixes the registration order without a timing sleep.
        // It has no default subscriber and must not produce captured records.
        std::thread::spawn(probe).join().unwrap();
        assert_eq!(capture.events.load(Ordering::SeqCst), 0);
        assert_eq!(capture.spans.load(Ordering::SeqCst), 0);
        probe();
    });
    assert_eq!(capture.events.load(Ordering::SeqCst), 1);
    assert_eq!(capture.spans.load(Ordering::SeqCst), 1);

    // The anchor must still defer to each scoped subscriber's own filter.
    let filtered = Capture::default();
    let subscriber = tracing_subscriber::registry()
        .with(filtered.clone())
        .with(tracing_subscriber::filter::LevelFilter::ERROR);
    tracing::subscriber::with_default(subscriber, probe);
    assert_eq!(filtered.events.load(Ordering::SeqCst), 0);
    assert_eq!(filtered.spans.load(Ordering::SeqCst), 0);
}
