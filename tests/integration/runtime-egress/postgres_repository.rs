use auth::{TestAttachment as _, TestRepositoryAttachment as _};
#[path = "../../support/egress-auth.rs"]
mod auth;

use std::{
    env,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

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

#[derive(Default)]
struct CountingKernel(AtomicUsize);

#[async_trait]
impl KernelCleanup for CountingKernel {
    async fn clear_agent(&self, _: std::net::Ipv4Addr) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

async fn durable_control_state(client: &tokio_postgres::Client) -> Vec<serde_json::Value> {
    let mut state = Vec::new();
    // Static, service-owned names: compare complete rows, including allocator
    // cursors, resource versions and timestamps, rather than only row counts.
    for table in [
        "address_pools",
        "agent_networks",
        "policy_revisions",
        "agent_policy_assignments",
        "runtime_attachments",
        "runtime_tunnel_keys",
    ] {
        let row = client
            .query_one(
                &format!(
                    "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)
                     FROM runtime_egress.{table} t"
                ),
                &[],
            )
            .await
            .unwrap();
        state.push(row.get(0));
    }
    state
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn control_admission_rejections_have_no_postgres_or_packet_gate_effects() {
    let database_url =
        env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").expect("ANTNEST_EGRESS_TEST_DATABASE_URL");
    let suffix = format!("{}-{}", std::process::id(), monotonic_suffix());
    let repository = Arc::new(
        PostgresRepository::connect(
            &database_url,
            DatabaseTlsMode::Disable,
            RepositoryConfig {
                pool_id: format!("admission-{suffix}"),
                tunnel_cidr: "100.64.8.0/29".parse().unwrap(),
                resolver_ipv4: "100.64.8.1".parse().unwrap(),
                quarantine: Duration::from_secs(300),
            },
        )
        .await
        .unwrap(),
    );
    let kernel = Arc::new(CountingKernel::default());
    let control = Arc::new(ControlService::new(
        repository,
        kernel.clone(),
        ControlConfig {
            advertised_udp_endpoint: "10.20.0.8:8092".parse().unwrap(),
            resolver_ipv4: "100.64.8.1".parse().unwrap(),
            max_flows: 32,
            max_agent_flows: 16,
            flow_idle: Duration::from_secs(60),
        },
        antnest_runtime_egress::tunnel::KeyBox::new([91; 32]),
    ));
    control.recover().await.unwrap();
    let agent = AgentId::parse(format!("agent-admission-{suffix}")).unwrap();
    control.ensure_agent_network(agent.clone()).await.unwrap();
    control
        .set_test_attachment(
            agent.clone(),
            AttachmentState::Open,
            1,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    let policy = format!("admission-policy-{suffix}");
    let routes = [
        (
            "GET",
            format!("/internal/agent-networks/{}", agent.as_str()),
            "",
        ),
        ("PUT", format!("/internal/agent-networks/new-{suffix}"), ""),
        (
            "PUT",
            format!("/internal/agent-network-attachments/{}", agent.as_str()),
            r#"{"state":"closed","expected_resource_version":2}"#,
        ),
        (
            "POST",
            format!("/internal/agent-networks/{}/release", agent.as_str()),
            r#"{"expected_resource_version":1}"#,
        ),
        (
            "PUT",
            format!("/internal/policies/{policy}/revisions/1"),
            r#"{"spec":{"schema_version":1,"action":"allow_all"}}"#,
        ),
        (
            "GET",
            format!("/internal/policies/{policy}/revisions/1"),
            "",
        ),
        (
            "GET",
            format!("/internal/agent-policy-assignments/{}", agent.as_str()),
            "",
        ),
        (
            "PUT",
            format!("/internal/agent-policy-assignments/{}", agent.as_str()),
            r#"{"policy_id":"builtin/allow-all","revision":1,"expected_resource_version":1}"#,
        ),
    ];
    let accepted = router(
        control.clone(),
        EgressMetrics::default(),
        auth::admission_for("agent-controller"),
    );
    let forbidden = router(
        control.clone(),
        EgressMetrics::default(),
        auth::admission_for("skill-registry"),
    );
    let (observer, connection) = tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
        .await
        .unwrap();
    let connection_task = tokio::spawn(connection);
    let before = durable_control_state(&observer).await;
    let snapshot = control.status().snapshot_revision;
    let cleanups = kernel.0.load(Ordering::SeqCst);
    for (method, path, body) in &routes {
        for (app, authenticate, expected) in [
            (&accepted, false, StatusCode::UNAUTHORIZED),
            (&forbidden, true, StatusCode::FORBIDDEN),
        ] {
            let mut request = Request::builder()
                .method(*method)
                .uri(path)
                .header("content-type", "application/json")
                .header("authorization", auth::workload_header())
                .header("x-antnest-service", "agent-controller")
                .header("antnest-caller-context", "forged-user-context");
            if authenticate {
                request = request.header("antnest-service-authorization", auth::workload_header());
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::from(*body)).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "{method} {path}");
            assert_eq!(
                response.headers().contains_key("www-authenticate"),
                expected == StatusCode::UNAUTHORIZED
            );
        }
        let response = accepted
            .clone()
            .oneshot(
                Request::builder()
                    .method(*method)
                    .uri(format!("{path}?unexpected=1"))
                    .header("antnest-service-authorization", auth::workload_header())
                    .header("content-type", "application/json")
                    .body(Body::from(*body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "{method} {path}"
        );
    }
    for (body, content_type, expected) in [
        (
            r#"{"spec":{"schema_version":1,"action":"allow_all"}}"#,
            "text/plain",
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            r#"{"spec":{"schema_version":1,"action":"allow_all","act\u0069on":"deny_all"}}"#,
            "application/json",
            StatusCode::BAD_REQUEST,
        ),
        (
            r#"{"spec":{"schema_version":1,"action":"allow_all","extra":true}}"#,
            "application/json",
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let response = accepted
            .clone()
            .oneshot(
                Request::put(format!("/internal/policies/{policy}/revisions/1"))
                    .header("antnest-service-authorization", auth::workload_header())
                    .header("content-type", content_type)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    assert_eq!(durable_control_state(&observer).await, before);
    assert_eq!(control.status().snapshot_revision, snapshot);
    assert_eq!(kernel.0.load(Ordering::SeqCst), cleanups);
    assert!(!control.dataplane().lock().unwrap().is_agent_fenced(&agent));
    drop(observer);
    connection_task.await.unwrap().unwrap();
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
        .set_test_repository_attachment(
            &agent,
            AttachmentState::Open,
            1,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(opened.resource_version, 2);
    assert_eq!(opened.runtime_endpoint, Some("10.20.0.9".parse().unwrap()));
    let recovered = repository.active_bindings().await.unwrap();
    assert!(recovered.iter().any(|binding| {
        binding.network.agent_id == agent
            && binding.attachment.runtime_endpoint == opened.runtime_endpoint
    }));
    assert_eq!(
        repository
            .set_test_repository_attachment(
                &agent,
                AttachmentState::Open,
                1,
                Some("10.20.0.9".parse().unwrap()),
            )
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
        .set_test_repository_attachment(&agent, AttachmentState::Closed, 2, None)
        .await
        .unwrap();
    let reopened = repository
        .set_test_repository_attachment(
            &agent,
            AttachmentState::Open,
            first_close.resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    repository
        .set_test_repository_attachment(
            &agent,
            AttachmentState::Closed,
            reopened.resource_version,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        repository
            .set_test_repository_attachment(&agent, AttachmentState::Closed, 2, None,)
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
            .set_test_repository_attachment(
                &agent,
                AttachmentState::Open,
                repository
                    .runtime_attachment(&agent)
                    .await
                    .unwrap()
                    .resource_version,
                Some("10.20.0.9".parse().unwrap()),
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
        antnest_runtime_egress::tunnel::KeyBox::new([91; 32]),
    ));
    let snapshot = control.status().snapshot_revision;
    let app = router(
        control.clone(),
        EgressMetrics::default(),
        auth::admission_for("agent-controller"),
    );
    for expected in [first_policy, second_policy] {
        let response = app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/internal/policies/{}/revisions/{}",
                    expected.policy_id.as_str(),
                    expected.revision
                ))
                .header("antnest-service-authorization", auth::workload_header())
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
        let provisioned = repository
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
            .set_test_repository_attachment(&agent, AttachmentState::Closed, 1, None)
            .instrument(tracing::info_span!("cas_attachment", otel.kind = "server"))
            .await
            .unwrap();
        let prepared = auth::key_box()
            .seal(
                agent.clone(),
                &auth::tunnel_registration(agent.as_str(), provisioned.tunnel_ipv4),
            )
            .unwrap();
        let key_id = prepared.key_id;
        repository
            .prepare_tunnel(prepared)
            .instrument(tracing::info_span!("prepare_tunnel", otel.kind = "server"))
            .await
            .unwrap();
        assert_eq!(
            repository
                .compare_and_swap_attachment(
                    &agent,
                    AttachmentState::Open,
                    99,
                    Some("10.20.0.9".parse().unwrap()),
                    Some(key_id),
                )
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
        (
            "prepare_tunnel",
            &[
                "BEGIN", "SELECT", "SELECT", "SELECT", "DELETE", "INSERT", "COMMIT",
            ],
        ),
        (
            "rejected",
            &["BEGIN", "SELECT", "SELECT", "SELECT", "ROLLBACK"],
        ),
        ("bindings", &["SELECT"]),
        (
            "quarantine",
            &["BEGIN", "SELECT", "SELECT", "UPDATE", "DELETE", "COMMIT"],
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

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn generation_keys_are_sealed_durable_bounded_and_retired_atomically() {
    let url = env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").unwrap();
    let suffix = monotonic_suffix();
    let repository = Arc::new(
        PostgresRepository::connect(
            &url,
            DatabaseTlsMode::Disable,
            RepositoryConfig {
                pool_id: format!("tunnel-{suffix}"),
                tunnel_cidr: "100.64.16.0/29".parse().unwrap(),
                resolver_ipv4: "100.64.16.1".parse().unwrap(),
                quarantine: Duration::from_secs(300),
            },
        )
        .await
        .unwrap(),
    );
    let agent = AgentId::parse(format!("agent-tunnel-{suffix}")).unwrap();
    let network = repository
        .ensure_agent_network(agent.clone())
        .await
        .unwrap();
    let vault = auth::key_box();
    let first = vault
        .seal(
            agent.clone(),
            &auth::tunnel_registration(agent.as_str(), network.tunnel_ipv4),
        )
        .unwrap();
    let committed = repository.prepare_tunnel(first.clone()).await.unwrap();
    let retry = repository
        .prepare_tunnel(
            vault
                .seal(
                    agent.clone(),
                    &auth::tunnel_registration(agent.as_str(), network.tunnel_ipv4),
                )
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(retry.sealed, committed.sealed);
    assert!(
        !committed
            .sealed
            .windows(32)
            .any(|window| window == [29; 32])
    );
    let peer = Some("10.243.0.2".parse().unwrap());
    let opened = repository
        .compare_and_swap_attachment(&agent, AttachmentState::Open, 1, peer, Some(first.key_id))
        .await
        .unwrap();
    let mut next = auth::tunnel_registration(agent.as_str(), network.tunnel_ipv4);
    next.key_id = auth::key_id(&format!("{}-next", agent.as_str())).to_string();
    assert!(matches!(
        repository
            .prepare_tunnel(vault.seal(agent.clone(), &next).unwrap())
            .await,
        Err(RepositoryError::AttachmentOpen)
    ));
    let closed = repository
        .compare_and_swap_attachment(
            &agent,
            AttachmentState::Closed,
            opened.resource_version,
            None,
            None,
        )
        .await
        .unwrap();
    let second = vault.seal(agent.clone(), &next).unwrap();
    repository.prepare_tunnel(second.clone()).await.unwrap();
    assert_eq!(repository.prepared_tunnels(&agent).await.unwrap().len(), 2);
    repository
        .compare_and_swap_attachment(
            &agent,
            AttachmentState::Open,
            closed.resource_version,
            peer,
            Some(second.key_id),
        )
        .await
        .unwrap();
    let rows = repository.prepared_tunnels(&agent).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].key_id, second.key_id);
    assert!(auth::key_box().open(&rows[0]).is_ok());
    assert!(
        antnest_runtime_egress::tunnel::KeyBox::new([92; 32])
            .open(&rows[0])
            .is_err()
    );
    let attachment = repository.runtime_attachment(&agent).await.unwrap();
    assert!(matches!(
        repository
            .compare_and_swap_attachment(
                &agent,
                AttachmentState::Open,
                attachment.resource_version,
                peer,
                Some(first.key_id)
            )
            .await,
        Err(RepositoryError::TunnelKeyUnavailable)
    ));
    repository
        .compare_and_swap_attachment(
            &agent,
            AttachmentState::Closed,
            attachment.resource_version,
            None,
            None,
        )
        .await
        .unwrap();
    repository
        .quarantine_agent_network(
            &agent,
            network.resource_version,
            std::time::SystemTime::now(),
        )
        .await
        .unwrap();
    assert!(
        repository
            .prepared_tunnels(&agent)
            .await
            .unwrap()
            .is_empty()
    );
}
