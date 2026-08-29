use std::{env, time::Duration};

use antnest_runtime_egress::{
    domain::{AgentId, NetworkState, PolicyId},
    policy::PolicySpec,
    repository::{DatabaseTlsMode, PostgresRepository, Repository, RepositoryConfig},
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

fn monotonic_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}
