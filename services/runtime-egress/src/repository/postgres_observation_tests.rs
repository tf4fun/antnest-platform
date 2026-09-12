use std::time::Duration;

use opentelemetry::trace::{SpanKind, TracerProvider as _};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};
use tracing::{Instrument as _, instrument::WithSubscriber as _};
use tracing_subscriber::layer::SubscriberExt as _;

use super::*;

fn attribute(span: &SpanData, key: &str) -> Option<String> {
    span.attributes
        .iter()
        .find(|item| item.key.as_str() == key)
        .map(|item| item.value.to_string())
}

fn telemetry() -> (InMemorySpanExporter, SdkTracerProvider, tracing::Dispatch) {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("db-test")));
    (exporter, provider, tracing::Dispatch::new(subscriber))
}

async fn fixture_client() -> Client {
    let database_url = std::env::var("ANTNEST_EGRESS_TEST_DATABASE_URL")
        .expect("use the isolated Egress PostgreSQL fixture");
    let config: Config = database_url.parse().unwrap();
    let (client, connection) = config.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Client::new(client, &config)
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn postgres_primitives_preserve_parent_sql_errors_and_transaction_results() {
    let mut client = fixture_client().await;
    let (exporter, provider, subscriber) = telemetry();
    let parent_context = async {
        let parent = tracing::info_span!("control", otel.kind = "server");
        let context = parent.context();
        async {
            client
                .batch_execute(
                    "CREATE TEMP TABLE observation_values (
                        value text UNIQUE DEFERRABLE INITIALLY DEFERRED
                     )",
                )
                .await
                .unwrap();
            client
                .execute(
                    "INSERT INTO observation_values VALUES ($1)",
                    &[&"DB_BIND_CANARY"],
                )
                .await
                .unwrap();
            let rows = client
                .query("SELECT value FROM observation_values", &[])
                .await
                .unwrap();
            assert_eq!(rows[0].get::<_, String>(0), "DB_BIND_CANARY");
            assert!(
                client
                    .query_opt("SELECT value FROM observation_values WHERE false", &[])
                    .await
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                client
                    .query_one("SELECT 7", &[])
                    .await
                    .unwrap()
                    .get::<_, i32>(0),
                7
            );

            let transaction = client.transaction().await.unwrap();
            transaction
                .execute(
                    "INSERT INTO observation_values VALUES ($1)",
                    &[&"DB_COMMIT_CANARY"],
                )
                .await
                .unwrap();
            assert_eq!(
                transaction
                    .query("SELECT value FROM observation_values", &[])
                    .await
                    .unwrap()
                    .len(),
                2
            );
            transaction.query_one("SELECT 8", &[]).await.unwrap();
            transaction.query_opt("SELECT 9", &[]).await.unwrap();
            transaction.commit().await.unwrap();

            let transaction = client.transaction().await.unwrap();
            let error = transaction
                .query("SELECT $1::text::integer", &[&"DB_ERROR_CANARY"])
                .await
                .unwrap_err();
            assert_eq!(error.code().unwrap().code(), "22P02");
            let aborted = transaction.query_opt("SELECT 1", &[]).await.unwrap_err();
            assert_eq!(aborted.code().unwrap().code(), "25P02");
            transaction.rollback().await.unwrap();

            let transaction = client.transaction().await.unwrap();
            transaction
                .execute(
                    "INSERT INTO observation_values VALUES ($1)",
                    &[&"DB_COMMIT_CANARY"],
                )
                .await
                .unwrap();
            let error = transaction.commit().await.unwrap_err();
            assert_eq!(error.code().unwrap().code(), "23505");

            let transaction = client.transaction().await.unwrap();
            transaction
                .batch_execute("DELETE FROM observation_values")
                .await
                .unwrap();
            drop(transaction);
            assert_eq!(
                client
                    .query_one("SELECT count(*) FROM observation_values", &[])
                    .await
                    .unwrap()
                    .get::<_, i64>(0),
                2
            );
            let error = client
                .query_one("SELECT 1 WHERE false", &[])
                .await
                .unwrap_err();
            assert!(error.code().is_none());
            assert!(!error.is_closed());
            let result = client
                .query_one("SELECT reverse($1::text)", &[&"YRANAC_TLUSER_BD"])
                .await
                .unwrap();
            assert_eq!(result.get::<_, String>(0), "DB_RESULT_CANARY");
        }
        .instrument(parent)
        .await;
        context
    }
    .with_subscriber(subscriber)
    .await;
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    let clients: Vec<_> = spans
        .iter()
        .filter(|span| span.span_kind == SpanKind::Client)
        .collect();
    let operations = [
        "BATCH", "INSERT", "SELECT", "SELECT", "SELECT", "BEGIN", "INSERT", "SELECT", "SELECT",
        "SELECT", "COMMIT", "BEGIN", "SELECT", "SELECT", "ROLLBACK", "BEGIN", "INSERT", "COMMIT",
        "BEGIN", "BATCH", "ROLLBACK", "SELECT", "SELECT", "SELECT",
    ];
    assert_eq!(
        clients.len(),
        operations.len(),
        "one span per native API call"
    );
    let config: Config = std::env::var("ANTNEST_EGRESS_TEST_DATABASE_URL")
        .unwrap()
        .parse()
        .unwrap();
    for span in &spans {
        if span.span_kind != SpanKind::Client && span.name != "postgresql transaction" {
            continue;
        }
        assert_eq!(
            attribute(span, "db.namespace").as_deref(),
            config.get_dbname()
        );
        assert_eq!(
            attribute(span, "server.port"),
            Some(config.get_ports().first().unwrap().to_string())
        );
    }
    for (span, operation) in clients.iter().zip(operations) {
        assert_eq!(span.name, operation);
        assert_eq!(
            attribute(span, "db.operation.name").as_deref(),
            Some(operation)
        );
        assert_eq!(
            attribute(span, "db.system.name").as_deref(),
            Some("postgresql")
        );
        let request_id = parent_context.span().span_context().span_id();
        if span.parent_span_id != request_id {
            let transaction = spans
                .iter()
                .find(|candidate| candidate.span_context.span_id() == span.parent_span_id)
                .unwrap();
            assert_eq!(transaction.name, "postgresql transaction");
            assert_eq!(transaction.span_kind, SpanKind::Internal);
            assert_eq!(transaction.parent_span_id, request_id);
            assert!(transaction.start_time <= span.start_time);
            assert!(transaction.end_time >= span.end_time);
        }
        assert_eq!(
            span.span_context.trace_id(),
            parent_context.span().span_context().trace_id()
        );
        assert_eq!(
            attribute(span, "db.query.text").is_some(),
            !matches!(operation, "BEGIN" | "COMMIT" | "ROLLBACK")
        );
    }
    assert_eq!(
        attribute(clients[12], "db.query.text").as_deref(),
        Some("SELECT $1::text::integer")
    );
    let transactions: Vec<_> = spans
        .iter()
        .filter(|span| span.name == "postgresql transaction")
        .collect();
    assert_eq!(transactions.len(), 4);
    for (transaction, outcome) in
        transactions
            .iter()
            .zip(["committed", "rolled_back", "failed", "unconfirmed"])
    {
        assert_eq!(
            attribute(transaction, "antnest.transaction.outcome").as_deref(),
            Some(outcome)
        );
    }
    assert!(matches!(transactions[2].status, Status::Error { .. }));
    for (index, sqlstate) in [(12, "22P02"), (13, "25P02"), (17, "23505")] {
        assert!(matches!(clients[index].status, Status::Error { .. }));
        assert_eq!(
            attribute(clients[index], "db.response.status_code").as_deref(),
            Some(sqlstate)
        );
        assert!(
            clients[index]
                .events
                .iter()
                .any(|event| event.name == "exception")
        );
    }
    assert_eq!(
        attribute(clients[14], "antnest.outcome").as_deref(),
        Some("success")
    );
    assert_eq!(
        attribute(clients[20], "antnest.outcome").as_deref(),
        Some("cancelled")
    );
    assert_eq!(
        attribute(clients[20], "antnest.transaction.completion").as_deref(),
        Some("unconfirmed")
    );
    assert_eq!(
        attribute(clients[22], "error.type").as_deref(),
        Some("tokio_postgres::Error")
    );
    let failure = clients[12]
        .events
        .iter()
        .find(|e| e.name == "exception")
        .unwrap();
    assert!(
        failure
            .attributes
            .iter()
            .any(|a| a.key.as_str() == "exception.message"
                && a.value.to_string().contains("DB_ERROR_CANARY"))
    );
    let commit_error = clients[17]
        .events
        .iter()
        .find(|e| e.name == "exception")
        .unwrap();
    for (key, expected) in [
        (
            "postgresql.error.constraint",
            "observation_values_value_key",
        ),
        ("postgresql.error.table", "observation_values"),
    ] {
        assert!(
            commit_error
                .attributes
                .contains(&KeyValue::new(key, expected))
        );
    }
    assert!(
        commit_error
            .attributes
            .iter()
            .any(|a| a.key.as_str() == "postgresql.error.detail"
                && a.value.to_string().contains("DB_COMMIT_CANARY"))
    );
    let captured = format!("{spans:?}");

    for canary in ["DB_BIND_CANARY", "YRANAC_TLUSER_BD", "DB_RESULT_CANARY"] {
        assert!(!captured.contains(canary));
    }
    provider.shutdown().unwrap();
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn postgres_drop_keeps_the_parent_captured_at_begin() {
    let mut client = fixture_client().await;
    let (exporter, provider, subscriber) = telemetry();
    let parent_id = async {
        let parent = tracing::info_span!("control", otel.kind = "server");
        let parent_id = parent.context().span().span_context().span_id();
        let transaction = client.transaction().instrument(parent).await.unwrap();
        // No request span is entered at this drop site.
        drop(transaction);
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
    assert_eq!(clients.len(), 2);
    assert_eq!(clients[0].name, "BEGIN");
    assert_eq!(clients[1].name, "ROLLBACK");
    let transaction = spans
        .iter()
        .find(|span| span.name == "postgresql transaction")
        .unwrap();
    assert_eq!(transaction.parent_span_id, parent_id);
    assert_eq!(
        clients[0].parent_span_id,
        transaction.span_context.span_id()
    );
    assert_eq!(
        clients[1].parent_span_id,
        transaction.span_context.span_id()
    );
    assert_eq!(
        attribute(clients[1], "antnest.outcome").as_deref(),
        Some("cancelled")
    );
    provider.shutdown().unwrap();
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn postgres_cancellation_and_statement_timeout_are_not_success() {
    let mut client = fixture_client().await;
    let (exporter, provider, subscriber) = telemetry();
    async {
        let parent = tracing::info_span!("control", otel.kind = "server");
        async {
            client
                .batch_execute("SET statement_timeout = '20ms'")
                .await
                .unwrap();
            let error = client.query("SELECT pg_sleep(1)", &[]).await.unwrap_err();
            assert_eq!(error.code().unwrap().code(), "57014");
            client
                .batch_execute("SET statement_timeout = 0")
                .await
                .unwrap();
            let transaction = client.transaction().await.unwrap();
            assert!(
                tokio::time::timeout(
                    Duration::from_millis(20),
                    transaction.query("SELECT pg_sleep(0.1)", &[])
                )
                .await
                .is_err()
            );
            drop(transaction);
            client.query_one("SELECT 1", &[]).await.unwrap();
        }
        .instrument(parent)
        .await;
    }
    .with_subscriber(subscriber)
    .await;
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    let queries: Vec<_> = spans
        .iter()
        .filter(|span| {
            attribute(span, "db.query.text").is_some_and(|sql| sql.starts_with("SELECT pg_sleep("))
        })
        .collect();
    assert_eq!(queries.len(), 2);
    assert!(matches!(queries[0].status, Status::Error { .. }));
    assert_eq!(
        attribute(queries[0], "db.response.status_code").as_deref(),
        Some("57014")
    );
    assert_eq!(
        attribute(queries[1], "antnest.outcome").as_deref(),
        Some("cancelled")
    );
    let transaction = spans
        .iter()
        .find(|span| span.name == "postgresql transaction")
        .unwrap();
    assert_eq!(transaction.parent_span_id, queries[0].parent_span_id);
    assert_eq!(
        queries[1].parent_span_id,
        transaction.span_context.span_id()
    );
    assert_ne!(
        queries[0].parent_span_id,
        opentelemetry::trace::SpanId::INVALID
    );
    provider.shutdown().unwrap();
}
