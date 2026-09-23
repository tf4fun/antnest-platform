use std::{env, sync::Arc, time::Duration};

use antnest_runtime_egress::{
    application::{ControlConfig, ControlService, KernelCleanup},
    control::router,
    domain::{AgentId, AttachmentState, NetworkState, PolicyId},
    policy::PolicySpec,
    repository::{
        DatabaseTlsMode, PostgresRepository, Repository, RepositoryConfig, RepositoryError,
    },
    telemetry::EgressMetrics,
};
use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use tower::ServiceExt as _;

struct ReadOnlyKernel;

#[async_trait]
impl KernelCleanup for ReadOnlyKernel {
    async fn clear_agent(&self, _: std::net::Ipv4Addr) -> Result<(), String> {
        panic!("policy inspection must not clean network state");
    }
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn postgres_enforces_attachment_fencing_and_replay_bounds() {
    let database_url =
        env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").expect("ANTNEST_EGRESS_TEST_DATABASE_URL");
    let suffix = format!("{}-{}", std::process::id(), monotonic_suffix());
    let repository = PostgresRepository::connect(
        &database_url,
        DatabaseTlsMode::Disable,
        RepositoryConfig {
            pool_id: format!("attachment-{suffix}"),
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        },
    )
    .await
    .expect("connect and migrate");
    let agent = AgentId::parse(format!("agent-attachment-{suffix}")).unwrap();
    repository
        .ensure_agent_network(agent.clone())
        .await
        .unwrap();

    let recovered = repository.active_bindings().await.unwrap();
    assert!(recovered.iter().any(|binding| {
        binding.network.agent_id == agent && binding.attachment.state == AttachmentState::Closed
    }));

    let opened = repository
        .compare_and_swap_attachment(&agent, AttachmentState::Open, 1)
        .await
        .unwrap();
    assert_eq!(opened.resource_version, 2);
    assert_eq!(
        repository
            .compare_and_swap_attachment(&agent, AttachmentState::Open, 1)
            .await
            .unwrap(),
        opened
    );
    assert_eq!(
        repository
            .quarantine_agent_network(&agent, 1, std::time::SystemTime::now())
            .await,
        Err(RepositoryError::AgentNetworkUnavailable)
    );
    let first_close = repository
        .compare_and_swap_attachment(&agent, AttachmentState::Closed, 2)
        .await
        .unwrap();
    let reopened = repository
        .compare_and_swap_attachment(&agent, AttachmentState::Open, first_close.resource_version)
        .await
        .unwrap();
    repository
        .compare_and_swap_attachment(&agent, AttachmentState::Closed, reopened.resource_version)
        .await
        .unwrap();
    assert_eq!(
        repository
            .compare_and_swap_attachment(&agent, AttachmentState::Closed, 2)
            .await,
        Err(RepositoryError::ResourceVersionConflict)
    );

    let quarantined = repository
        .quarantine_agent_network(&agent, 1, std::time::SystemTime::now())
        .await
        .unwrap();
    assert_eq!(quarantined.state, NetworkState::Quarantined);
    assert_eq!(
        repository
            .quarantine_agent_network(&agent, 1, std::time::SystemTime::now())
            .await
            .unwrap(),
        quarantined
    );
    assert_eq!(
        repository
            .compare_and_swap_attachment(
                &agent,
                AttachmentState::Open,
                repository
                    .runtime_attachment(&agent)
                    .await
                    .unwrap()
                    .resource_version,
            )
            .await,
        Err(RepositoryError::AgentNetworkUnavailable)
    );
    assert!(
        repository
            .delete_quarantined(&agent, quarantined.resource_version)
            .await
            .unwrap()
    );
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn postgres_preserves_network_and_policy_semantics() {
    let database_url =
        env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").expect("ANTNEST_EGRESS_TEST_DATABASE_URL");
    let suffix = format!("{}-{}", std::process::id(), monotonic_suffix());
    let pool_id = format!("test-{suffix}");
    let repository = PostgresRepository::connect(
        &database_url,
        DatabaseTlsMode::Disable,
        RepositoryConfig {
            pool_id: pool_id.clone(),
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        },
    )
    .await
    .expect("connect and migrate");
    let agent = AgentId::parse(format!("agent-{suffix}")).unwrap();
    let policy = PolicyId::parse(format!("allow-{suffix}")).unwrap();

    let first = repository
        .ensure_agent_network(agent.clone())
        .await
        .unwrap();
    let second = repository
        .ensure_agent_network(agent.clone())
        .await
        .unwrap();
    assert_eq!(first, second);

    let first_policy = repository
        .put_policy_revision(policy.clone(), 1, PolicySpec::allow_all())
        .await
        .unwrap();
    let assignment = repository
        .compare_and_swap_assignment(&agent, policy.clone(), 1, 1)
        .await
        .unwrap();
    assert_eq!(assignment.resource_version, 2);
    let second_policy = repository
        .put_policy_revision(policy.clone(), 2, PolicySpec::deny_all())
        .await
        .unwrap();

    drop(repository);
    let repository = PostgresRepository::connect(
        &database_url,
        DatabaseTlsMode::Disable,
        RepositoryConfig {
            pool_id,
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        },
    )
    .await
    .expect("reconnect and recover persisted state");
    assert_eq!(repository.agent_network(&agent).await.unwrap(), first);
    assert_eq!(
        repository.policy_assignment(&agent).await.unwrap(),
        assignment
    );
    let repository = Arc::new(repository);
    let control = Arc::new(ControlService::new(
        repository.clone(),
        Arc::new(ReadOnlyKernel),
        ControlConfig {
            advertised_udp_endpoint: "10.20.0.8:8092".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            max_flows: 32,
            max_agent_flows: 16,
            flow_idle: Duration::from_secs(60),
        },
    ));
    let snapshot = control.status().snapshot_revision;
    let app = router(control.clone(), EgressMetrics::default());
    for expected in [first_policy, second_policy] {
        let response = app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/internal/policies/{}/revisions/{}",
                    expected.policy_id.as_str(),
                    expected.revision
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let document: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            document,
            serde_json::json!({
                "policy_id": expected.policy_id.as_str(), "revision": expected.revision,
                "spec": expected.spec, "digest": expected.digest,
            })
        );
    }
    assert_eq!(
        repository.policy_assignment(&agent).await.unwrap(),
        assignment
    );
    assert_eq!(
        repository.runtime_attachment(&agent).await.unwrap().state,
        AttachmentState::Closed
    );
    assert_eq!(control.status().snapshot_revision, snapshot);

    let released = repository
        .quarantine_agent_network(&agent, 1, std::time::SystemTime::now())
        .await
        .unwrap();
    assert_eq!(released.state, NetworkState::Quarantined);
    assert!(released.quarantine_until.is_some());
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn postgres_reconnects_after_warm_transport_loss() {
    let database_url =
        env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").expect("ANTNEST_EGRESS_TEST_DATABASE_URL");
    let suffix = format!("{}-{}", std::process::id(), monotonic_suffix());
    let application_name = format!("egress-reconnect-{suffix}");
    let repository_url = format!("{database_url}?application_name={application_name}");
    let repository = PostgresRepository::connect(
        &repository_url,
        DatabaseTlsMode::Disable,
        RepositoryConfig {
            pool_id: format!("reconnect-{suffix}"),
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        },
    )
    .await
    .expect("connect and migrate");
    let mut health = repository.health();
    assert!(*health.borrow());
    let agent = AgentId::parse(format!("agent-reconnect-{suffix}")).unwrap();
    let expected = repository
        .ensure_agent_network(agent.clone())
        .await
        .unwrap();

    let (admin, connection) = tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let rows = admin
        .query(
            "SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
             WHERE application_name = $1 AND pid <> pg_backend_pid()",
            &[&application_name],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].get::<_, bool>(0));
    tokio::time::timeout(Duration::from_secs(2), health.wait_for(|ready| !*ready))
        .await
        .expect("transport loss is observed promptly")
        .expect("health sender remains open");

    assert_eq!(repository.agent_network(&agent).await.unwrap(), expected);
    tokio::time::timeout(Duration::from_secs(2), health.wait_for(|ready| *ready))
        .await
        .expect("successful reconnect restores health")
        .expect("health sender remains open");
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn postgres_rejects_a_foreign_schema_before_writing_it() {
    let database_url =
        env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").expect("ANTNEST_EGRESS_TEST_DATABASE_URL");
    let admin_database_url = env::var("ANTNEST_EGRESS_TEST_ADMIN_DATABASE_URL")
        .expect("ANTNEST_EGRESS_TEST_ADMIN_DATABASE_URL");
    let role = format!(
        "foreign_owner_{}_{}",
        std::process::id(),
        monotonic_suffix()
    );
    let (admin, connection) = tokio_postgres::connect(&admin_database_url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    admin
        .batch_execute(&format!(
            "DROP SCHEMA IF EXISTS runtime_egress CASCADE;
             CREATE ROLE {role};
             CREATE SCHEMA runtime_egress AUTHORIZATION {role}"
        ))
        .await
        .unwrap();

    let result = PostgresRepository::connect(
        &database_url,
        DatabaseTlsMode::Disable,
        RepositoryConfig {
            pool_id: format!("foreign-schema-{role}"),
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        },
    )
    .await;
    let migration_table_exists: bool = admin
        .query_one(
            "SELECT to_regclass('runtime_egress.schema_migrations') IS NOT NULL",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    admin
        .batch_execute(&format!(
            "DROP SCHEMA runtime_egress CASCADE; DROP ROLE {role}"
        ))
        .await
        .unwrap();
    assert!(result.is_err());
    assert!(
        !migration_table_exists,
        "ownership rejection must precede migration writes"
    );
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn one_agents_row_lock_does_not_block_an_unrelated_agent() {
    let database_url =
        env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").expect("ANTNEST_EGRESS_TEST_DATABASE_URL");
    let suffix = format!("{}-{}", std::process::id(), monotonic_suffix());
    let application_name = format!("egress-concurrency-{suffix}");
    let repository_url = format!("{database_url}?application_name={application_name}");
    let repository = Arc::new(
        PostgresRepository::connect(
            &repository_url,
            DatabaseTlsMode::Disable,
            RepositoryConfig {
                pool_id: format!("concurrency-{suffix}"),
                tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
                resolver_ipv4: "100.64.0.1".parse().unwrap(),
                quarantine: Duration::from_secs(300),
            },
        )
        .await
        .expect("connect and migrate"),
    );
    let blocked_agent = AgentId::parse(format!("agent-blocked-{suffix}")).unwrap();
    let independent_agent = AgentId::parse(format!("agent-independent-{suffix}")).unwrap();
    repository
        .ensure_agent_network(blocked_agent.clone())
        .await
        .unwrap();
    let expected = repository
        .ensure_agent_network(independent_agent.clone())
        .await
        .unwrap();

    let (mut locker, locker_connection) =
        tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
            .await
            .unwrap();
    tokio::spawn(async move {
        let _ = locker_connection.await;
    });
    let lock = locker.transaction().await.unwrap();
    lock.query_one(
        "SELECT agent_id FROM runtime_egress.agent_networks
         WHERE agent_id = $1 FOR UPDATE",
        &[&blocked_agent.as_str()],
    )
    .await
    .unwrap();

    let blocked_repository = repository.clone();
    let blocked_agent_for_task = blocked_agent.clone();
    let blocked = tokio::spawn(async move {
        blocked_repository
            .quarantine_agent_network(&blocked_agent_for_task, 1, std::time::SystemTime::now())
            .await
    });

    let (observer, observer_connection) =
        tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
            .await
            .unwrap();
    tokio::spawn(async move {
        let _ = observer_connection.await;
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let waiting: bool = observer
                .query_one(
                    "SELECT EXISTS (
                       SELECT 1 FROM pg_stat_activity
                       WHERE application_name = $1 AND wait_event_type = 'Lock'
                     )",
                    &[&application_name],
                )
                .await
                .unwrap()
                .get(0);
            if waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the first Agent operation waits on its row lock");

    let observed = tokio::time::timeout(
        Duration::from_secs(1),
        repository.agent_network(&independent_agent),
    )
    .await
    .expect("an unrelated Agent is not serialized behind the row lock")
    .unwrap();
    assert_eq!(observed, expected);

    lock.rollback().await.unwrap();
    blocked.await.unwrap().unwrap();
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn one_agents_lock_timeout_is_scoped_and_bounded() {
    let database_url =
        env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").expect("ANTNEST_EGRESS_TEST_DATABASE_URL");
    let suffix = format!("{}-{}", std::process::id(), monotonic_suffix());
    let repository = PostgresRepository::connect(
        &database_url,
        DatabaseTlsMode::Disable,
        RepositoryConfig {
            pool_id: format!("timeout-{suffix}"),
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        },
    )
    .await
    .expect("connect and migrate");
    let health = repository.health();
    let agent = AgentId::parse(format!("agent-timeout-{suffix}")).unwrap();
    repository
        .ensure_agent_network(agent.clone())
        .await
        .unwrap();

    let (mut locker, locker_connection) =
        tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
            .await
            .unwrap();
    tokio::spawn(async move {
        let _ = locker_connection.await;
    });
    let lock = locker.transaction().await.unwrap();
    lock.query_one(
        "SELECT agent_id FROM runtime_egress.agent_networks
         WHERE agent_id = $1 FOR UPDATE",
        &[&agent.as_str()],
    )
    .await
    .unwrap();

    let started = tokio::time::Instant::now();
    let result = repository
        .quarantine_agent_network(&agent, 1, std::time::SystemTime::now())
        .await;
    let error = result.unwrap_err();
    assert!(matches!(&error, RepositoryError::DatabaseOperation(_)));
    let driver = std::error::Error::source(&error)
        .and_then(std::error::Error::source)
        .and_then(|source| source.downcast_ref::<tokio_postgres::Error>())
        .expect("lock/statement timeout retains its PostgreSQL source");
    assert!(matches!(
        driver.code().map(|code| code.code()),
        Some("55P03" | "57014")
    ));
    assert!(started.elapsed() < Duration::from_secs(6));
    assert!(
        *health.borrow(),
        "one lock timeout must not degrade the pool"
    );

    lock.rollback().await.unwrap();
    repository.agent_network(&agent).await.unwrap();
}

fn monotonic_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn production_repository_automatically_observes_each_database_primitive_once() {
    use opentelemetry::trace::{SpanKind, TracerProvider as _};
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
    use tracing::{Instrument as _, instrument::WithSubscriber as _};
    use tracing_subscriber::layer::SubscriberExt as _;

    let database_url =
        env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").expect("ANTNEST_EGRESS_TEST_DATABASE_URL");
    let suffix = format!("{}-{}", std::process::id(), monotonic_suffix());
    let repository = PostgresRepository::connect(
        &database_url,
        DatabaseTlsMode::Disable,
        RepositoryConfig {
            pool_id: format!("observation-{suffix}"),
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::ZERO,
        },
    )
    .await
    .unwrap();
    let agent = AgentId::parse(format!("DB_AGENT_CANARY-{suffix}")).unwrap();
    let policy = PolicyId::parse(format!("DB_POLICY_CANARY-{suffix}")).unwrap();
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("repository-test")));
    async {
        repository
            .ensure_agent_network(agent.clone())
            .instrument(tracing::info_span!("ensure", otel.kind = "server"))
            .await
            .unwrap();
        repository
            .ensure_agent_network(agent.clone())
            .instrument(tracing::info_span!("ensure_existing", otel.kind = "server"))
            .await
            .unwrap();
        repository
            .agent_network(&agent)
            .instrument(tracing::info_span!("network", otel.kind = "server"))
            .await
            .unwrap();
        repository
            .put_policy_revision(policy.clone(), 1, PolicySpec::allow_all())
            .instrument(tracing::info_span!("put_policy", otel.kind = "server"))
            .await
            .unwrap();
        repository
            .policy_revision(&policy, 1)
            .instrument(tracing::info_span!("policy", otel.kind = "server"))
            .await
            .unwrap();
        repository
            .policy_assignment(&agent)
            .instrument(tracing::info_span!("assignment", otel.kind = "server"))
            .await
            .unwrap();
        repository
            .runtime_attachment(&agent)
            .instrument(tracing::info_span!("attachment", otel.kind = "server"))
            .await
            .unwrap();
        repository
            .compare_and_swap_assignment(&agent, policy.clone(), 1, 1)
            .instrument(tracing::info_span!("cas_assignment", otel.kind = "server"))
            .await
            .unwrap();
        repository
            .compare_and_swap_attachment(&agent, AttachmentState::Closed, 1)
            .instrument(tracing::info_span!("cas_attachment", otel.kind = "server"))
            .await
            .unwrap();
        assert_eq!(
            repository
                .compare_and_swap_attachment(&agent, AttachmentState::Open, 99)
                .instrument(tracing::info_span!("rejected", otel.kind = "server"))
                .await,
            Err(RepositoryError::ResourceVersionConflict)
        );
        repository
            .active_bindings()
            .instrument(tracing::info_span!("bindings", otel.kind = "server"))
            .await
            .unwrap();
        let now = std::time::SystemTime::now();
        let quarantined = repository
            .quarantine_agent_network(&agent, 1, now)
            .instrument(tracing::info_span!("quarantine", otel.kind = "server"))
            .await
            .unwrap();
        repository
            .expired_quarantines(now + Duration::from_secs(1))
            .instrument(tracing::info_span!("expired", otel.kind = "server"))
            .await
            .unwrap();
        assert!(
            repository
                .delete_quarantined(&agent, quarantined.resource_version)
                .instrument(tracing::info_span!("delete", otel.kind = "server"))
                .await
                .unwrap()
        );
    }
    .with_subscriber(subscriber)
    .await;
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    let expected: &[(&str, &[&str])] = &[
        (
            "ensure",
            &[
                "BEGIN", "SELECT", "SELECT", "SELECT", "SELECT", "UPDATE", "INSERT", "INSERT",
                "INSERT", "COMMIT",
            ],
        ),
        ("ensure_existing", &["BEGIN", "SELECT", "ROLLBACK"]),
        ("network", &["SELECT"]),
        ("put_policy", &["INSERT", "SELECT"]),
        ("policy", &["SELECT"]),
        ("assignment", &["SELECT"]),
        ("attachment", &["SELECT"]),
        (
            "cas_assignment",
            &["BEGIN", "SELECT", "SELECT", "SELECT", "UPDATE", "COMMIT"],
        ),
        ("cas_attachment", &["BEGIN", "SELECT", "SELECT", "COMMIT"]),
        ("rejected", &["BEGIN", "SELECT", "SELECT", "ROLLBACK"]),
        ("bindings", &["SELECT"]),
        (
            "quarantine",
            &["BEGIN", "SELECT", "SELECT", "UPDATE", "COMMIT"],
        ),
        ("expired", &["SELECT"]),
        ("delete", &["DELETE"]),
    ];
    assert_eq!(
        spans
            .iter()
            .filter(|span| span.span_kind == SpanKind::Server)
            .count(),
        expected.len()
    );
    assert_eq!(
        spans
            .iter()
            .filter(|span| span.span_kind == SpanKind::Client)
            .count(),
        expected
            .iter()
            .map(|(_, operations)| operations.len())
            .sum::<usize>()
    );
    for (name, operations) in expected {
        let parent = spans.iter().find(|span| span.name == *name).unwrap();
        let owner = spans
            .iter()
            .find(|span| {
                span.name == "postgresql transaction"
                    && span.parent_span_id == parent.span_context.span_id()
            })
            .unwrap_or(parent);
        if owner.name == "postgresql transaction" {
            assert_eq!(owner.span_kind, SpanKind::Internal);
        }
        let children: Vec<_> = spans
            .iter()
            .filter(|span| span.parent_span_id == owner.span_context.span_id())
            .collect();
        assert_eq!(children.len(), operations.len(), "{name}");
        for (span, operation) in children.iter().zip(*operations) {
            assert_eq!(span.name, *operation, "{name}");
            assert!(span.attributes.iter().any(
                |a| a.key.as_str() == "db.operation.name" && a.value.to_string() == *operation
            ));
            assert_eq!(span.span_kind, SpanKind::Client);
            assert_eq!(span.span_context.trace_id(), parent.span_context.trace_id());
            assert!(
                span.attributes
                    .iter()
                    .any(|item| item.key.as_str() == "db.system.name"
                        && item.value.to_string() == "postgresql")
            );
            assert_eq!(
                span.attributes
                    .iter()
                    .any(|item| item.key.as_str() == "db.query.text"),
                !matches!(*operation, "BEGIN" | "COMMIT" | "ROLLBACK")
            );
            assert!(
                !span.attributes.iter().any(|item| item
                    .key
                    .as_str()
                    .starts_with("db.query.parameter")
                    || item.key.as_str().contains("rows"))
            );
        }
    }
    let captured = format!("{spans:?}");
    assert!(!captured.contains("DB_AGENT_CANARY"));
    assert!(!captured.contains("DB_POLICY_CANARY"));
    provider.shutdown().unwrap();
}
