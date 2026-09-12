use opentelemetry::trace::{SpanKind, TracerProvider as _};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use tracing::{Instrument as _, instrument::WithSubscriber as _};
use tracing_subscriber::layer::SubscriberExt as _;

use super::*;

#[tokio::test]
async fn database_primitives_keep_parent_sql_driver_errors_and_cancellation() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("db-test")));
    let parent_id = async {
        let parent = tracing::info_span!("control", otel.kind = "server");
        let parent_id = parent.context().span().span_context().span_id();
        async {
            DatabaseObservation::run(Operation::Statement, Some("SELECT $1"), &[], async {
                Ok::<_, Error>("DB_RESULT_CANARY")
            })
            .await
            .unwrap();
            let error = "password='DB_ERROR_CANARY"
                .parse::<tokio_postgres::Config>()
                .unwrap_err();
            assert!(
                DatabaseObservation::run(Operation::Statement, Some("SELECT $1"), &[], async {
                    Err::<(), _>(error)
                })
                .await
                .is_err()
            );
            assert!(
                tokio::time::timeout(
                    std::time::Duration::from_millis(1),
                    DatabaseObservation::run(
                        Operation::Statement,
                        Some("SELECT 1"),
                        &[],
                        std::future::pending::<Result<(), Error>>()
                    ),
                )
                .await
                .is_err()
            );
            drop(DatabaseObservation::new(Operation::Rollback, None));
            drop(DatabaseObservation::run(
                Operation::Statement,
                Some("SELECT 2"),
                &[],
                async { Ok::<_, Error>(()) },
            ));
        }
        .instrument(parent)
        .await;
        parent_id
    }
    .with_subscriber(subscriber)
    .await;
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    let clients: Vec<_> = spans
        .iter()
        .filter(|span| span.span_kind == SpanKind::Client)
        .collect();
    assert_eq!(clients.len(), 4);
    assert_eq!(clients[0].name, "SELECT");
    assert_eq!(clients[1].name, "SELECT");
    assert_eq!(clients[3].name, "ROLLBACK");
    for span in &clients {
        assert_eq!(span.parent_span_id, parent_id);
        assert!(
            span.attributes
                .iter()
                .any(|attribute| attribute.key.as_str() == "db.system.name"
                    && attribute.value.to_string() == "postgresql")
        );
        assert!(!span.attributes.iter().any(|attribute| {
            attribute.key.as_str().starts_with("db.query.parameter")
                || attribute.key.as_str().contains("rows")
        }));
    }
    assert!(
        clients[1]
            .events
            .iter()
            .any(|event| event.name == "exception")
    );
    assert!(
        clients[1]
            .attributes
            .iter()
            .any(|attribute| attribute.key.as_str() == "error.type"
                && attribute.value.to_string() == "tokio_postgres::Error")
    );
    assert!(
        clients[2]
            .attributes
            .iter()
            .any(|attribute| attribute.key.as_str() == "antnest.outcome"
                && attribute.value.to_string() == "cancelled")
    );
    assert!(!format!("{spans:?}").contains("DB_RESULT_CANARY"));

    provider.shutdown().unwrap();
}

#[test]
fn database_unwind_does_not_finish_as_success() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("db-unwind-test")));
    tracing::subscriber::with_default(subscriber, || {
        assert!(
            std::panic::catch_unwind(|| {
                let _observation = DatabaseObservation::new(Operation::Commit, None);
                panic!("database boundary unwind test");
            })
            .is_err()
        );
    });
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 1);
    assert!(matches!(spans[0].status, Status::Error { .. }));
    assert!(spans[0].attributes.iter().any(|attribute| {
        attribute.key.as_str() == "error.type"
            && attribute.value.to_string() == "database_boundary_panic"
    }));
    provider.shutdown().unwrap();
}

#[test]
fn postgres_driver_error_is_retained_as_a_typed_source_not_just_a_string() {
    use std::error::Error as _;
    let driver = "password='DRIVER_CANARY"
        .parse::<tokio_postgres::Config>()
        .unwrap_err();
    let error = crate::repository::RepositoryError::DatabaseConnection(
        crate::repository::DriverError::new(driver),
    );
    let source = error.source().unwrap();
    assert!(
        source
            .source()
            .unwrap()
            .downcast_ref::<tokio_postgres::Error>()
            .is_some()
    );
    assert!(!error.to_string().contains("DRIVER_CANARY"));
}

#[test]
fn statement_names_follow_sql_not_the_rust_query_api() {
    for (sql, expected) in [
        ("  select $1", "SELECT"),
        ("\nINSERT INTO test VALUES ($1) RETURNING value", "INSERT"),
        ("UPDATE test SET value = $1", "UPDATE"),
        ("DELETE FROM test", "DELETE"),
        ("WITH items AS (SELECT 1) SELECT * FROM items", "WITH"),
        ("", "UNKNOWN"),
        ("  \t\n", "UNKNOWN"),
    ] {
        assert_eq!(Operation::Statement.name(Some(sql)), expected);
    }
    assert_eq!(
        Operation::BatchExecute.name(Some("SELECT 1; DELETE FROM test")),
        "BATCH"
    );
    assert_eq!(Operation::Begin.name(None), "BEGIN");
    assert_eq!(Operation::Commit.name(None), "COMMIT");
    assert_eq!(Operation::Rollback.name(None), "ROLLBACK");
}

#[test]
fn database_attributes_come_from_config_without_connection_secrets() {
    let config: Config = "host=db.example port=6432 user=egress_user dbname=custom_database password=PASSWORD_CANARY options=OPTIONS_CANARY".parse().unwrap();
    let attributes = connection_attributes(&config);
    for (key, expected) in [
        ("db.namespace", "custom_database"),
        ("user.name", "egress_user"),
        ("server.address", "db.example"),
        ("server.port", "6432"),
    ] {
        assert_eq!(
            attributes
                .iter()
                .find(|a| a.key.as_str() == key)
                .unwrap()
                .value
                .to_string(),
            expected
        );
    }
    let captured = format!("{attributes:?}");
    assert!(!captured.contains("PASSWORD_CANARY"));
    assert!(!captured.contains("OPTIONS_CANARY"));
    assert!(!captured.contains("runtime_egress"));
    let config: Config = "host=db.example user=default_database".parse().unwrap();
    let attributes = connection_attributes(&config);
    assert!(attributes.contains(&KeyValue::new("db.namespace", "default_database")));
    assert!(attributes.contains(&KeyValue::new("server.port", 5432_i64)));
    for dsn in [
        "host=first,second port=5432,6432 user=egress",
        "hostaddr=127.0.0.1,127.0.0.2 user=egress",
    ] {
        let config: Config = dsn.parse().unwrap();
        assert!(
            !connection_attributes(&config)
                .iter()
                .any(|a| a.key.as_str().starts_with("server."))
        );
    }
}

#[tokio::test]
async fn driver_error_uses_native_message_and_source() {
    use std::error::Error as _;

    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("native-error")));
    let error = "port=not-a-number".parse::<Config>().unwrap_err();
    let message = error.to_string();
    let source = error.source().unwrap().to_string();
    let returned = DatabaseObservation::run(Operation::Statement, Some("SELECT 1"), &[], async {
        Err::<(), _>(error)
    })
    .with_subscriber(subscriber)
    .await
    .unwrap_err();
    assert_eq!(returned.to_string(), message);
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].name, "SELECT");
    let event = spans[0]
        .events
        .iter()
        .find(|e| e.name == "exception")
        .unwrap();
    assert!(
        event
            .attributes
            .contains(&KeyValue::new("exception.message", message))
    );
    assert!(
        event
            .attributes
            .iter()
            .any(|a| a.key.as_str() == "exception.causes" && a.value.to_string().contains(&source))
    );
    provider.shutdown().unwrap();
}
