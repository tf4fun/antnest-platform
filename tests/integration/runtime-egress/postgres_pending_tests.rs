use super::*;
use sha2::{Digest as _, Sha256};

#[tokio::test]
#[ignore = "requires isolated ANTNEST_EGRESS_TEST_DATABASE_URL and --test-threads=1"]
async fn aaa_revision_three_upgrade_preserves_rows_and_adds_pending_constraint() {
    let url = env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").unwrap();
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    let driver = tokio::spawn(connection);
    client
        .batch_execute("DROP SCHEMA IF EXISTS runtime_egress CASCADE")
        .await
        .unwrap();
    for (version, name, sql) in [
        (
            0_i64,
            "bootstrap",
            include_str!("../../../services/runtime-egress/migrations/0000_bootstrap.sql"),
        ),
        (
            1,
            "initial",
            include_str!("../../../services/runtime-egress/migrations/0001_initial.sql"),
        ),
        (
            2,
            "runtime_peer",
            include_str!("../../../services/runtime-egress/migrations/0002_runtime_peer.sql"),
        ),
        (
            3,
            "authenticated_tunnel",
            include_str!(
                "../../../services/runtime-egress/migrations/0003_authenticated_tunnel.sql"
            ),
        ),
    ] {
        client.batch_execute(sql).await.unwrap();
        let checksum = "sha256:".to_owned()
            + &Sha256::digest(sql.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
        client.execute("INSERT INTO runtime_egress.schema_migrations(version,name,checksum) VALUES($1,$2,$3)", &[&version,&name,&checksum]).await.unwrap();
    }
    client.batch_execute("INSERT INTO runtime_egress.address_pools VALUES ('upgrade','100.64.24.0/29','100.64.24.1',4,300,1);
        INSERT INTO runtime_egress.agent_networks(agent_id,pool_id,tunnel_ipv4,state,resource_version) VALUES
        ('upgrade-closed','upgrade','100.64.24.2','active',1),('upgrade-open','upgrade','100.64.24.3','active',1);
        INSERT INTO runtime_egress.runtime_attachments(agent_id,state,resource_version,runtime_endpoint,tunnel_key_id) VALUES
        ('upgrade-closed','closed',1,NULL,NULL),('upgrade-open','open',7,'10.20.0.9','rtk_0123456789abcdef0123456789abcdef');").await.unwrap();
    let before = durable_control_state(&client).await;
    let repository = PostgresRepository::connect(
        &url,
        DatabaseTlsMode::Disable,
        RepositoryConfig {
            pool_id: "upgrade".to_owned(),
            tunnel_cidr: "100.64.24.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.24.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        },
    )
    .await
    .unwrap();
    // Connection seeds built-in policies, but existing network/attachment rows stay byte-for-byte identical.
    let after = durable_control_state(&client).await;
    assert_eq!(before[1], after[1]);
    assert_eq!(before[4], after[4]);
    let versions: Vec<i64> = client
        .query(
            "SELECT version FROM runtime_egress.schema_migrations ORDER BY version",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(versions, [0, 1, 2, 3, 4]);
    let agent = AgentId::parse("upgrade-closed").unwrap();
    let waiting = repository
        .compare_and_swap_attachment(&agent, AttachmentState::Pending, 1, None, None)
        .await
        .unwrap();
    assert_eq!(waiting.resource_version, 2);
    for (field, value) in [
        ("runtime_endpoint", "'10.20.0.9'::inet"),
        ("tunnel_key_id", "'rtk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"),
    ] {
        let error = client.execute(&format!("UPDATE runtime_egress.runtime_attachments SET {field}={value} WHERE agent_id='upgrade-closed'"),&[]).await.unwrap_err();
        assert_eq!(
            error.code(),
            Some(&tokio_postgres::error::SqlState::CHECK_VIOLATION)
        );
    }
    drop(repository);
    drop(client);
    driver.await.unwrap().unwrap();
}

#[tokio::test]
#[ignore = "requires ANTNEST_EGRESS_TEST_DATABASE_URL"]
async fn pending_attachment_survives_reconnect_and_closing_invalidates_old_open() {
    let url = env::var("ANTNEST_EGRESS_TEST_DATABASE_URL").unwrap();
    let suffix = monotonic_suffix();
    let config = || RepositoryConfig {
        pool_id: format!("pending-{suffix}"),
        tunnel_cidr: "100.64.28.0/29".parse().unwrap(),
        resolver_ipv4: "100.64.28.1".parse().unwrap(),
        quarantine: Duration::from_secs(300),
    };
    let repository = PostgresRepository::connect(&url, DatabaseTlsMode::Disable, config())
        .await
        .unwrap();
    let agent = AgentId::parse(format!("pending-{suffix}")).unwrap();
    let network = repository
        .ensure_agent_network(agent.clone())
        .await
        .unwrap();
    let prepared = auth::key_box()
        .seal(
            agent.clone(),
            &auth::tunnel_registration(agent.as_str(), network.tunnel_ipv4),
        )
        .unwrap();
    repository.prepare_tunnel(prepared.clone()).await.unwrap();
    let waiting = repository
        .compare_and_swap_attachment(&agent, AttachmentState::Pending, 1, None, None)
        .await
        .unwrap();
    assert_eq!(waiting.resource_version, 2);
    drop(repository);
    let repository = PostgresRepository::connect(&url, DatabaseTlsMode::Disable, config())
        .await
        .unwrap();
    assert_eq!(
        repository.runtime_attachment(&agent).await.unwrap(),
        waiting
    );
    assert!(
        repository
            .active_bindings()
            .await
            .unwrap()
            .iter()
            .any(|r| r.network.agent_id == agent && r.attachment == waiting)
    );
    let replay = repository.prepare_tunnel(prepared.clone()).await.unwrap();
    assert!(replay.same_identity(&prepared));
    assert_eq!(replay.sealed, prepared.sealed);
    assert_eq!(replay.nonce, prepared.nonce);
    let mut other = auth::tunnel_registration(agent.as_str(), network.tunnel_ipv4);
    other.key_id = auth::key_id(&format!("{}-next", agent.as_str())).to_string();
    assert!(matches!(
        repository
            .prepare_tunnel(auth::key_box().seal(agent.clone(), &other).unwrap())
            .await,
        Err(RepositoryError::AttachmentOpen)
    ));
    let retained = repository.prepared_tunnels(&agent).await.unwrap();
    assert_eq!(retained.len(), 1);
    assert!(retained[0].same_identity(&prepared));
    assert_eq!(retained[0].sealed, prepared.sealed);
    assert_eq!(retained[0].nonce, prepared.nonce);
    assert_eq!(
        repository
            .quarantine_agent_network(&agent, 1, std::time::SystemTime::now())
            .await,
        Err(RepositoryError::AgentNetworkUnavailable)
    );
    let closed = repository
        .compare_and_swap_attachment(&agent, AttachmentState::Closed, 2, None, None)
        .await
        .unwrap();
    assert_eq!(closed.resource_version, 3);
    assert_eq!(
        repository
            .compare_and_swap_attachment(
                &agent,
                AttachmentState::Open,
                2,
                Some("10.20.0.9".parse().unwrap()),
                Some(prepared.key_id)
            )
            .await,
        Err(RepositoryError::ResourceVersionConflict)
    );
    let next = repository
        .compare_and_swap_attachment(&agent, AttachmentState::Pending, 3, None, None)
        .await
        .unwrap();
    assert_eq!(next.resource_version, 4);
    assert_eq!(
        repository
            .compare_and_swap_attachment(&agent, AttachmentState::Pending, 1, None, None)
            .await,
        Err(RepositoryError::ResourceVersionConflict)
    );
    let opened = repository
        .compare_and_swap_attachment(
            &agent,
            AttachmentState::Open,
            4,
            Some("10.20.0.9".parse().unwrap()),
            Some(prepared.key_id),
        )
        .await
        .unwrap();
    assert_eq!(opened.resource_version, 5);
    assert_eq!(
        repository
            .compare_and_swap_attachment(
                &agent,
                AttachmentState::Open,
                4,
                Some("10.20.0.9".parse().unwrap()),
                Some(prepared.key_id)
            )
            .await
            .unwrap(),
        opened
    );
}
