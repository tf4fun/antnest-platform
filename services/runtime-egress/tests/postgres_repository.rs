use std::{env, sync::Arc, time::Duration};

use antnest_runtime_egress::{
    domain::{AgentId, NetworkState, PolicyId},
    policy::PolicySpec,
    repository::{
        DatabaseTlsMode, PostgresRepository, Repository, RepositoryConfig, RepositoryError,
    },
};

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

    repository
        .put_policy_revision(policy.clone(), 1, PolicySpec::allow_all())
        .await
        .unwrap();
    let assignment = repository
        .compare_and_swap_assignment(&agent, policy, 1, 1)
        .await
        .unwrap();
    assert_eq!(assignment.resource_version, 2);

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

    let released = repository
        .quarantine_agent_network(&agent, std::time::SystemTime::now())
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
    let role = format!(
        "foreign_owner_{}_{}",
        std::process::id(),
        monotonic_suffix()
    );
    let (admin, connection) = tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
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
            .quarantine_agent_network(&blocked_agent_for_task, std::time::SystemTime::now())
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
        .quarantine_agent_network(&agent, std::time::SystemTime::now())
        .await;
    assert!(matches!(result, Err(RepositoryError::OperationFailed(_))));
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
