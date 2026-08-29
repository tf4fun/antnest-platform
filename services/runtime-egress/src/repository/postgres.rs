use std::{
    collections::HashSet,
    future::Future,
    net::Ipv4Addr,
    time::{Duration, SystemTime},
};

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, watch};
use tokio_postgres::{Client, NoTls, Row, config::SslMode};
use tokio_postgres_rustls::MakeRustlsConnect;

use super::{
    BUILTIN_ALLOW_ALL, BUILTIN_DENY_ALL, BUILTIN_REVISION, DatabaseTlsMode, Repository,
    RepositoryConfig, RepositoryError, policy_revision,
};
use crate::{
    allocator::{AddressPool, AllocationError},
    domain::{
        ActiveBinding, AgentId, AgentNetwork, NetworkState, PolicyAssignment, PolicyId,
        PolicyRevision,
    },
    policy::PolicySpec,
};

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 0,
        name: "bootstrap",
        sql: include_str!("../../migrations/0000_bootstrap.sql"),
    },
    Migration {
        version: 1,
        name: "initial",
        sql: include_str!("../../migrations/0001_initial.sql"),
    },
];

#[derive(Clone, Debug, Eq, PartialEq)]
struct AppliedMigration {
    version: i64,
    name: String,
    checksum: String,
}

pub struct PostgresRepository {
    database_url: String,
    tls_mode: DatabaseTlsMode,
    client: Mutex<Option<Client>>,
    config: RepositoryConfig,
    health: watch::Sender<bool>,
}

impl PostgresRepository {
    pub async fn connect_with_retry(
        database_url: &str,
        tls_mode: DatabaseTlsMode,
        config: RepositoryConfig,
        startup_timeout: Duration,
        retry_delay: Duration,
    ) -> Result<Self, RepositoryError> {
        retry_connection(startup_timeout, retry_delay, || {
            Self::connect(database_url, tls_mode, config.clone())
        })
        .await
    }

    pub async fn connect(
        database_url: &str,
        tls_mode: DatabaseTlsMode,
        config: RepositoryConfig,
    ) -> Result<Self, RepositoryError> {
        AddressPool::new(
            config.pool_id.clone(),
            config.tunnel_cidr,
            config.resolver_ipv4,
            1,
        )
        .map_err(RepositoryError::InvalidPool)?;
        let (health, _) = watch::channel(false);
        let mut client = connect_client(database_url, tls_mode, health.clone()).await?;
        migrate_client(&mut client, &config).await?;
        health.send_replace(true);
        Ok(Self {
            database_url: database_url.to_owned(),
            tls_mode,
            client: Mutex::new(Some(client)),
            config,
            health,
        })
    }

    pub fn health(&self) -> watch::Receiver<bool> {
        self.health.subscribe()
    }

    async fn acquire_client(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<Client>>, RepositoryError> {
        let mut client = self.client.lock().await;
        let reconnect = client.as_ref().is_none_or(Client::is_closed);
        if reconnect {
            self.health.send_replace(false);
            let mut replacement =
                connect_client(&self.database_url, self.tls_mode, self.health.clone()).await?;
            migrate_client(&mut replacement, &self.config).await?;
            *client = Some(replacement);
            self.health.send_replace(true);
        }
        Ok(client)
    }
}

fn connected_client(client: &mut Option<Client>) -> &mut Client {
    client
        .as_mut()
        .expect("PostgreSQL client is established before use")
}

async fn connect_client(
    database_url: &str,
    tls_mode: DatabaseTlsMode,
    health: watch::Sender<bool>,
) -> Result<Client, RepositoryError> {
    match tls_mode {
        DatabaseTlsMode::Disable => connect_without_tls(database_url, health).await,
        DatabaseTlsMode::Require => connect_with_tls(database_url, health).await,
    }
}

async fn connect_without_tls(
    database_url: &str,
    health: watch::Sender<bool>,
) -> Result<Client, RepositoryError> {
    let config = database_config(database_url, DatabaseTlsMode::Disable)?;
    let (client, connection) = config
        .connect(NoTls)
        .await
        .map_err(connection_unavailable)?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            tracing::error!(error = %error, "PostgreSQL connection terminated");
        }
        health.send_replace(false);
    });
    Ok(client)
}

async fn connect_with_tls(
    database_url: &str,
    health: watch::Sender<bool>,
) -> Result<Client, RepositoryError> {
    let certificates = rustls_native_certs::load_native_certs();
    for error in certificates.errors {
        tracing::warn!(%error, "one native certificate root could not be loaded");
    }
    let mut roots = rustls::RootCertStore::empty();
    for certificate in certificates.certs {
        roots
            .add(certificate)
            .map_err(|error| connection_unavailable(format!("add native certificate: {error}")))?;
    }
    if roots.is_empty() {
        return Err(connection_unavailable(
            "no usable native certificate roots were loaded",
        ));
    }
    let client_config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = MakeRustlsConnect::new(client_config);
    let postgres_config = database_config(database_url, DatabaseTlsMode::Require)?;
    let (client, connection) = postgres_config
        .connect(connector)
        .await
        .map_err(connection_unavailable)?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            tracing::error!(error = %error, "PostgreSQL TLS connection terminated");
        }
        health.send_replace(false);
    });
    Ok(client)
}

fn database_config(
    database_url: &str,
    tls_mode: DatabaseTlsMode,
) -> Result<tokio_postgres::Config, RepositoryError> {
    let mut config = database_url
        .parse::<tokio_postgres::Config>()
        .map_err(connection_unavailable)?;
    config.ssl_mode(match tls_mode {
        DatabaseTlsMode::Require => SslMode::Require,
        DatabaseTlsMode::Disable => SslMode::Disable,
    });
    Ok(config)
}

async fn migrate_client(
    client: &mut Client,
    config: &RepositoryConfig,
) -> Result<(), RepositoryError> {
    initialize_migration_catalog(client).await?;
    verify_schema_owner(client).await?;
    let applied = client
        .query(
            "SELECT version, name, checksum
             FROM runtime_egress.schema_migrations ORDER BY version",
            &[],
        )
        .await
        .map_err(unavailable)?
        .into_iter()
        .map(|row| AppliedMigration {
            version: row.get(0),
            name: row.get(1),
            checksum: row.get(2),
        })
        .collect::<Vec<_>>();
    let next = validate_migration_history(&applied)?;
    for migration in &MIGRATIONS[next..] {
        let transaction = client.transaction().await.map_err(unavailable)?;
        transaction
            .batch_execute(migration.sql)
            .await
            .map_err(unavailable)?;
        transaction
            .execute(
                "INSERT INTO runtime_egress.schema_migrations(version, name, checksum)
                 VALUES ($1, $2, $3)",
                &[
                    &migration.version,
                    &migration.name,
                    &migration_checksum(migration),
                ],
            )
            .await
            .map_err(unavailable)?;
        transaction.commit().await.map_err(unavailable)?;
    }
    seed_repository(client, config).await
}

async fn initialize_migration_catalog(client: &mut Client) -> Result<(), RepositoryError> {
    let bootstrap = &MIGRATIONS[0];
    let transaction = client.transaction().await.map_err(unavailable)?;
    transaction
        .batch_execute(bootstrap.sql)
        .await
        .map_err(unavailable)?;
    transaction
        .execute(
            "INSERT INTO runtime_egress.schema_migrations(version, name, checksum)
             VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING",
            &[
                &bootstrap.version,
                &bootstrap.name,
                &migration_checksum(bootstrap),
            ],
        )
        .await
        .map_err(unavailable)?;
    transaction.commit().await.map_err(unavailable)
}

async fn verify_schema_owner(client: &Client) -> Result<(), RepositoryError> {
    let owned: bool = client
        .query_one(
            "SELECT pg_get_userbyid(nspowner) = current_user
             FROM pg_namespace WHERE nspname = 'runtime_egress'",
            &[],
        )
        .await
        .map_err(unavailable)?
        .get(0);
    if owned {
        Ok(())
    } else {
        Err(RepositoryError::Unavailable(
            "runtime_egress schema is not owned by the configured database role".to_owned(),
        ))
    }
}

fn validate_migration_history(applied: &[AppliedMigration]) -> Result<usize, RepositoryError> {
    if MIGRATIONS
        .windows(2)
        .any(|pair| pair[0].version >= pair[1].version)
    {
        return Err(RepositoryError::Unavailable(
            "embedded migration catalog is not strictly ordered".to_owned(),
        ));
    }
    for (index, actual) in applied.iter().enumerate() {
        let expected = MIGRATIONS.get(index).ok_or_else(|| {
            RepositoryError::Unavailable(format!(
                "database contains unknown migration version {}",
                actual.version
            ))
        })?;
        if actual.version != expected.version
            || actual.name != expected.name
            || actual.checksum != migration_checksum(expected)
        {
            return Err(RepositoryError::Unavailable(format!(
                "migration history diverges at version {}",
                actual.version
            )));
        }
    }
    Ok(applied.len())
}

fn migration_checksum(migration: &Migration) -> String {
    format!("sha256:{:x}", Sha256::digest(migration.sql.as_bytes()))
}

async fn seed_repository(
    client: &mut Client,
    config: &RepositoryConfig,
) -> Result<(), RepositoryError> {
    let transaction = client.transaction().await.map_err(unavailable)?;
    transaction
        .execute(
            "INSERT INTO runtime_egress.address_pools
             (pool_id, cidr, resolver_ipv4, next_slot, quarantine_seconds, resource_version)
             VALUES ($1, $2::text::cidr, $3::text::inet, 1, $4, 1)
             ON CONFLICT (pool_id) DO NOTHING",
            &[
                &config.pool_id,
                &config.tunnel_cidr.to_string(),
                &config.resolver_ipv4.to_string(),
                &duration_seconds_i64(config.quarantine)?,
            ],
        )
        .await
        .map_err(unavailable)?;
    verify_pool(&transaction, config).await?;
    for (policy_id, spec) in [
        (BUILTIN_ALLOW_ALL, PolicySpec::allow_all()),
        (BUILTIN_DENY_ALL, PolicySpec::deny_all()),
    ] {
        let revision = policy_revision(
            PolicyId::parse(policy_id).expect("built-in policy ID"),
            BUILTIN_REVISION,
            spec,
        );
        transaction
            .execute(
                "INSERT INTO runtime_egress.policy_revisions
                 (policy_id, revision, schema_version, canonical_spec, digest)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (policy_id, revision) DO NOTHING",
                &[
                    &revision.policy_id.as_str(),
                    &u64_to_i64(revision.revision)?,
                    &i64::from(revision.spec.schema_version()),
                    &serde_json::to_value(revision.spec).map_err(unavailable)?,
                    &revision.digest,
                ],
            )
            .await
            .map_err(unavailable)?;
        let row = transaction
            .query_one(
                "SELECT canonical_spec, digest
                 FROM runtime_egress.policy_revisions
                 WHERE policy_id = $1 AND revision = $2",
                &[
                    &revision.policy_id.as_str(),
                    &u64_to_i64(revision.revision)?,
                ],
            )
            .await
            .map_err(unavailable)?;
        let persisted =
            policy_revision_from_row(revision.policy_id.clone(), revision.revision, &row)?;
        if persisted.digest != revision.digest || persisted.spec != revision.spec {
            return Err(RepositoryError::Unavailable(format!(
                "built-in policy {} differs from the embedded revision",
                revision.policy_id
            )));
        }
    }
    transaction.commit().await.map_err(unavailable)
}

async fn verify_pool(
    transaction: &tokio_postgres::Transaction<'_>,
    config: &RepositoryConfig,
) -> Result<(), RepositoryError> {
    let row = transaction
        .query_one(
            "SELECT cidr::text, host(resolver_ipv4), quarantine_seconds
             FROM runtime_egress.address_pools WHERE pool_id = $1",
            &[&config.pool_id],
        )
        .await
        .map_err(unavailable)?;
    let cidr: String = row.get(0);
    let resolver: String = row.get(1);
    let quarantine: i64 = row.get(2);
    if cidr != config.tunnel_cidr.to_string()
        || resolver != config.resolver_ipv4.to_string()
        || quarantine != duration_seconds_i64(config.quarantine)?
    {
        return Err(RepositoryError::Unavailable(
            "configured address pool differs from persisted pool".to_owned(),
        ));
    }
    Ok(())
}

#[async_trait]
impl Repository for PostgresRepository {
    async fn ensure_agent_network(
        &self,
        agent_id: AgentId,
    ) -> Result<AgentNetwork, RepositoryError> {
        let pool_id = self.config.pool_id.as_str();
        let mut client_guard = self.acquire_client().await?;
        let client = connected_client(&mut client_guard);
        let transaction = client.transaction().await.map_err(unavailable)?;
        if let Some(existing) = select_network(&transaction, &agent_id).await? {
            return existing_for_ensure(existing);
        }

        let pool_row = transaction
            .query_opt(
                "SELECT cidr::text, host(resolver_ipv4), next_slot
                 FROM runtime_egress.address_pools
                 WHERE pool_id = $1 FOR UPDATE",
                &[&pool_id],
            )
            .await
            .map_err(unavailable)?
            .ok_or_else(|| {
                RepositoryError::Unavailable("configured address pool is missing".to_owned())
            })?;
        if let Some(existing) = select_network(&transaction, &agent_id).await? {
            return existing_for_ensure(existing);
        }

        let network = parse_ipv4_net(pool_row.get::<_, String>(0))?;
        let resolver = parse_ipv4(pool_row.get::<_, String>(1))?;
        let next_slot = i64_to_u32(pool_row.get(2))?;
        let unavailable_rows = transaction
            .query(
                "SELECT host(tunnel_ipv4) FROM runtime_egress.agent_networks",
                &[],
            )
            .await
            .map_err(unavailable)?;
        let unavailable_addresses = unavailable_rows
            .into_iter()
            .map(|row| parse_ipv4(row.get::<_, String>(0)))
            .collect::<Result<HashSet<_>, _>>()?;
        let selection = AddressPool::new(pool_id, network, resolver, next_slot)
            .map_err(RepositoryError::InvalidPool)?
            .select(&unavailable_addresses)
            .map_err(map_allocation_error)?;

        transaction
            .execute(
                "UPDATE runtime_egress.address_pools
                 SET next_slot = $2, resource_version = resource_version + 1
                 WHERE pool_id = $1",
                &[&pool_id, &i64::from(selection.next_slot)],
            )
            .await
            .map_err(unavailable)?;
        transaction
            .execute(
                "INSERT INTO runtime_egress.agent_networks
                 (agent_id, pool_id, tunnel_ipv4, state, resource_version)
                 VALUES ($1, $2, $3::text::inet, 'active', 1)",
                &[&agent_id.as_str(), &pool_id, &selection.address.to_string()],
            )
            .await
            .map_err(unavailable)?;
        transaction
            .execute(
                "INSERT INTO runtime_egress.agent_policy_assignments
                 (agent_id, policy_id, revision, resource_version)
                 VALUES ($1, $2, $3, 1)",
                &[
                    &agent_id.as_str(),
                    &BUILTIN_DENY_ALL,
                    &u64_to_i64(BUILTIN_REVISION)?,
                ],
            )
            .await
            .map_err(unavailable)?;
        transaction.commit().await.map_err(unavailable)?;
        Ok(AgentNetwork {
            agent_id,
            pool_id: pool_id.to_owned(),
            tunnel_ipv4: selection.address,
            state: NetworkState::Active,
            resource_version: 1,
            quarantine_until: None,
        })
    }

    async fn agent_network(&self, agent_id: &AgentId) -> Result<AgentNetwork, RepositoryError> {
        let mut client_guard = self.acquire_client().await?;
        let client = connected_client(&mut client_guard);
        select_network_client(client, agent_id)
            .await?
            .ok_or(RepositoryError::AgentNetworkNotFound)
    }

    async fn put_policy_revision(
        &self,
        policy_id: PolicyId,
        revision: u64,
        spec: PolicySpec,
    ) -> Result<PolicyRevision, RepositoryError> {
        if revision == 0 {
            return Err(RepositoryError::PolicyRevisionConflict);
        }
        let candidate = policy_revision(policy_id, revision, spec);
        let mut client_guard = self.acquire_client().await?;
        let client = connected_client(&mut client_guard);
        client
            .execute(
                "INSERT INTO runtime_egress.policy_revisions
                 (policy_id, revision, schema_version, canonical_spec, digest)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (policy_id, revision) DO NOTHING",
                &[
                    &candidate.policy_id.as_str(),
                    &u64_to_i64(candidate.revision)?,
                    &i64::from(candidate.spec.schema_version()),
                    &serde_json::to_value(candidate.spec).map_err(unavailable)?,
                    &candidate.digest,
                ],
            )
            .await
            .map_err(unavailable)?;
        let persisted = select_policy_revision(client, &candidate.policy_id, revision).await?;
        if persisted.digest != candidate.digest {
            return Err(RepositoryError::PolicyRevisionConflict);
        }
        Ok(persisted)
    }

    async fn policy_revision(
        &self,
        policy_id: &PolicyId,
        revision: u64,
    ) -> Result<PolicyRevision, RepositoryError> {
        let mut client_guard = self.acquire_client().await?;
        let client = connected_client(&mut client_guard);
        select_policy_revision(client, policy_id, revision).await
    }

    async fn policy_assignment(
        &self,
        agent_id: &AgentId,
    ) -> Result<PolicyAssignment, RepositoryError> {
        let mut client_guard = self.acquire_client().await?;
        let client = connected_client(&mut client_guard);
        select_assignment_client(client, agent_id)
            .await?
            .ok_or(RepositoryError::AgentNetworkNotFound)
    }

    async fn compare_and_swap_assignment(
        &self,
        agent_id: &AgentId,
        policy_id: PolicyId,
        revision: u64,
        expected_resource_version: u64,
    ) -> Result<PolicyAssignment, RepositoryError> {
        let mut client_guard = self.acquire_client().await?;
        let client = connected_client(&mut client_guard);
        let transaction = client.transaction().await.map_err(unavailable)?;
        if transaction
            .query_opt(
                "SELECT 1 FROM runtime_egress.policy_revisions
                 WHERE policy_id = $1 AND revision = $2",
                &[&policy_id.as_str(), &u64_to_i64(revision)?],
            )
            .await
            .map_err(unavailable)?
            .is_none()
        {
            return Err(RepositoryError::PolicyRevisionNotFound);
        }
        let current = select_assignment(&transaction, agent_id, true)
            .await?
            .ok_or(RepositoryError::AgentNetworkNotFound)?;
        if current.policy_id == policy_id && current.revision == revision {
            transaction.commit().await.map_err(unavailable)?;
            return Ok(current);
        }
        if current.resource_version != expected_resource_version {
            return Err(RepositoryError::ResourceVersionConflict);
        }
        let assignment = PolicyAssignment {
            agent_id: agent_id.clone(),
            policy_id,
            revision,
            resource_version: current.resource_version + 1,
        };
        transaction
            .execute(
                "UPDATE runtime_egress.agent_policy_assignments
                 SET policy_id = $2, revision = $3, resource_version = $4,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE agent_id = $1",
                &[
                    &agent_id.as_str(),
                    &assignment.policy_id.as_str(),
                    &u64_to_i64(assignment.revision)?,
                    &u64_to_i64(assignment.resource_version)?,
                ],
            )
            .await
            .map_err(unavailable)?;
        transaction.commit().await.map_err(unavailable)?;
        Ok(assignment)
    }

    async fn quarantine_agent_network(
        &self,
        agent_id: &AgentId,
        now: SystemTime,
    ) -> Result<AgentNetwork, RepositoryError> {
        let mut client_guard = self.acquire_client().await?;
        let client = connected_client(&mut client_guard);
        let transaction = client.transaction().await.map_err(unavailable)?;
        let current = select_network_for_update(&transaction, agent_id)
            .await?
            .ok_or(RepositoryError::AgentNetworkNotFound)?;
        if current.state == NetworkState::Quarantined {
            transaction.commit().await.map_err(unavailable)?;
            return Ok(current);
        }
        let quarantine_until = now + self.config.quarantine;
        let row = transaction
            .query_one(
                "UPDATE runtime_egress.agent_networks
                 SET state = 'quarantined', quarantine_until = $2,
                     resource_version = resource_version + 1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE agent_id = $1
                 RETURNING agent_id, pool_id, host(tunnel_ipv4), state,
                           resource_version, quarantine_until",
                &[&agent_id.as_str(), &quarantine_until],
            )
            .await
            .map_err(unavailable)?;
        let network = network_from_row(&row)?;
        transaction.commit().await.map_err(unavailable)?;
        Ok(network)
    }

    async fn active_bindings(&self) -> Result<Vec<ActiveBinding>, RepositoryError> {
        let mut client_guard = self.acquire_client().await?;
        let client = connected_client(&mut client_guard);
        let rows = client
            .query(
                "SELECT n.agent_id, n.pool_id, host(n.tunnel_ipv4), n.state,
                        n.resource_version, n.quarantine_until,
                        a.policy_id, a.revision, a.resource_version,
                        p.canonical_spec, p.digest
                 FROM runtime_egress.agent_networks n
                 JOIN runtime_egress.agent_policy_assignments a USING (agent_id)
                 JOIN runtime_egress.policy_revisions p
                   ON p.policy_id = a.policy_id AND p.revision = a.revision
                 WHERE n.state = 'active'",
                &[],
            )
            .await
            .map_err(unavailable)?;
        rows.into_iter().map(binding_from_row).collect()
    }

    async fn expired_quarantines(
        &self,
        now: SystemTime,
    ) -> Result<Vec<AgentNetwork>, RepositoryError> {
        let mut client_guard = self.acquire_client().await?;
        let client = connected_client(&mut client_guard);
        client
            .query(
                "SELECT agent_id, pool_id, host(tunnel_ipv4), state,
                        resource_version, quarantine_until
                 FROM runtime_egress.agent_networks
                 WHERE state = 'quarantined' AND quarantine_until <= $1",
                &[&now],
            )
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(|row| network_from_row(&row))
            .collect()
    }

    async fn delete_quarantined(
        &self,
        agent_id: &AgentId,
        expected_resource_version: u64,
    ) -> Result<bool, RepositoryError> {
        let mut client_guard = self.acquire_client().await?;
        let client = connected_client(&mut client_guard);
        let deleted = client
            .execute(
                "DELETE FROM runtime_egress.agent_networks
                 WHERE agent_id = $1 AND state = 'quarantined'
                   AND resource_version = $2",
                &[&agent_id.as_str(), &u64_to_i64(expected_resource_version)?],
            )
            .await
            .map_err(unavailable)?;
        Ok(deleted == 1)
    }
}

fn binding_from_row(row: Row) -> Result<ActiveBinding, RepositoryError> {
    let network = network_from_row(&row)?;
    let policy_id = PolicyId::parse(row.get::<_, String>(6)).map_err(unavailable)?;
    let revision_number = i64_to_u64(row.get(7))?;
    let assignment = PolicyAssignment {
        agent_id: network.agent_id.clone(),
        policy_id: policy_id.clone(),
        revision: revision_number,
        resource_version: i64_to_u64(row.get(8))?,
    };
    let spec = serde_json::from_value(row.get(9)).map_err(unavailable)?;
    let revision = PolicyRevision {
        policy_id,
        revision: revision_number,
        spec,
        digest: row.get(10),
    };
    Ok(ActiveBinding {
        network,
        assignment,
        revision,
    })
}

async fn select_network(
    transaction: &tokio_postgres::Transaction<'_>,
    agent_id: &AgentId,
) -> Result<Option<AgentNetwork>, RepositoryError> {
    transaction
        .query_opt(
            "SELECT agent_id, pool_id, host(tunnel_ipv4), state,
                    resource_version, quarantine_until
             FROM runtime_egress.agent_networks WHERE agent_id = $1",
            &[&agent_id.as_str()],
        )
        .await
        .map_err(unavailable)?
        .map(|row| network_from_row(&row))
        .transpose()
}

async fn select_network_for_update(
    transaction: &tokio_postgres::Transaction<'_>,
    agent_id: &AgentId,
) -> Result<Option<AgentNetwork>, RepositoryError> {
    transaction
        .query_opt(
            "SELECT agent_id, pool_id, host(tunnel_ipv4), state,
                    resource_version, quarantine_until
             FROM runtime_egress.agent_networks WHERE agent_id = $1 FOR UPDATE",
            &[&agent_id.as_str()],
        )
        .await
        .map_err(unavailable)?
        .map(|row| network_from_row(&row))
        .transpose()
}

async fn select_network_client(
    client: &Client,
    agent_id: &AgentId,
) -> Result<Option<AgentNetwork>, RepositoryError> {
    client
        .query_opt(
            "SELECT agent_id, pool_id, host(tunnel_ipv4), state,
                    resource_version, quarantine_until
             FROM runtime_egress.agent_networks WHERE agent_id = $1",
            &[&agent_id.as_str()],
        )
        .await
        .map_err(unavailable)?
        .map(|row| network_from_row(&row))
        .transpose()
}

fn network_from_row(row: &Row) -> Result<AgentNetwork, RepositoryError> {
    let state: String = row.get(3);
    Ok(AgentNetwork {
        agent_id: AgentId::parse(row.get::<_, String>(0)).map_err(unavailable)?,
        pool_id: row.get(1),
        tunnel_ipv4: parse_ipv4(row.get(2))?,
        state: match state.as_str() {
            "active" => NetworkState::Active,
            "quarantined" => NetworkState::Quarantined,
            _ => {
                return Err(RepositoryError::Unavailable(
                    "invalid network state".to_owned(),
                ));
            }
        },
        resource_version: i64_to_u64(row.get(4))?,
        quarantine_until: row.get(5),
    })
}

fn existing_for_ensure(existing: AgentNetwork) -> Result<AgentNetwork, RepositoryError> {
    if existing.state != NetworkState::Active {
        return Err(RepositoryError::AgentNetworkUnavailable);
    }
    Ok(existing)
}

async fn select_policy_revision(
    client: &Client,
    policy_id: &PolicyId,
    revision: u64,
) -> Result<PolicyRevision, RepositoryError> {
    let row = client
        .query_opt(
            "SELECT canonical_spec, digest FROM runtime_egress.policy_revisions
             WHERE policy_id = $1 AND revision = $2",
            &[&policy_id.as_str(), &u64_to_i64(revision)?],
        )
        .await
        .map_err(unavailable)?
        .ok_or(RepositoryError::PolicyRevisionNotFound)?;
    policy_revision_from_row(policy_id.clone(), revision, &row)
}

fn policy_revision_from_row(
    policy_id: PolicyId,
    revision: u64,
    row: &Row,
) -> Result<PolicyRevision, RepositoryError> {
    let spec = serde_json::from_value(row.get(0)).map_err(unavailable)?;
    Ok(PolicyRevision {
        policy_id,
        revision,
        spec,
        digest: row.get(1),
    })
}

async fn select_assignment_client(
    client: &Client,
    agent_id: &AgentId,
) -> Result<Option<PolicyAssignment>, RepositoryError> {
    client
        .query_opt(
            "SELECT policy_id, revision, resource_version
             FROM runtime_egress.agent_policy_assignments WHERE agent_id = $1",
            &[&agent_id.as_str()],
        )
        .await
        .map_err(unavailable)?
        .map(|row| assignment_from_row(agent_id.clone(), &row))
        .transpose()
}

async fn select_assignment(
    transaction: &tokio_postgres::Transaction<'_>,
    agent_id: &AgentId,
    for_update: bool,
) -> Result<Option<PolicyAssignment>, RepositoryError> {
    let suffix = if for_update { " FOR UPDATE" } else { "" };
    let query = format!(
        "SELECT policy_id, revision, resource_version
         FROM runtime_egress.agent_policy_assignments WHERE agent_id = $1{suffix}"
    );
    transaction
        .query_opt(&query, &[&agent_id.as_str()])
        .await
        .map_err(unavailable)?
        .map(|row| assignment_from_row(agent_id.clone(), &row))
        .transpose()
}

fn assignment_from_row(agent_id: AgentId, row: &Row) -> Result<PolicyAssignment, RepositoryError> {
    Ok(PolicyAssignment {
        agent_id,
        policy_id: PolicyId::parse(row.get::<_, String>(0)).map_err(unavailable)?,
        revision: i64_to_u64(row.get(1))?,
        resource_version: i64_to_u64(row.get(2))?,
    })
}

fn map_allocation_error(error: AllocationError) -> RepositoryError {
    match error {
        AllocationError::Exhausted => RepositoryError::AddressPoolExhausted,
        other => RepositoryError::InvalidPool(other),
    }
}

fn parse_ipv4(value: String) -> Result<Ipv4Addr, RepositoryError> {
    value.parse().map_err(unavailable)
}

fn parse_ipv4_net(value: String) -> Result<ipnet::Ipv4Net, RepositoryError> {
    value.parse().map_err(unavailable)
}

fn i64_to_u64(value: i64) -> Result<u64, RepositoryError> {
    value
        .try_into()
        .map_err(|_| RepositoryError::Unavailable("negative database value".to_owned()))
}

fn i64_to_u32(value: i64) -> Result<u32, RepositoryError> {
    value
        .try_into()
        .map_err(|_| RepositoryError::Unavailable("invalid allocator cursor".to_owned()))
}

fn u64_to_i64(value: u64) -> Result<i64, RepositoryError> {
    value
        .try_into()
        .map_err(|_| RepositoryError::Unavailable("value exceeds PostgreSQL bigint".to_owned()))
}

fn duration_seconds_i64(value: std::time::Duration) -> Result<i64, RepositoryError> {
    u64_to_i64(value.as_secs())
}

fn unavailable(error: impl std::fmt::Display) -> RepositoryError {
    RepositoryError::Unavailable(error.to_string())
}

fn connection_unavailable(error: impl std::fmt::Display) -> RepositoryError {
    RepositoryError::ConnectionUnavailable(error.to_string())
}

async fn retry_connection<T, F, Fut>(
    startup_timeout: Duration,
    retry_delay: Duration,
    mut connect: F,
) -> Result<T, RepositoryError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, RepositoryError>>,
{
    let attempts = async {
        loop {
            match connect().await {
                Err(RepositoryError::ConnectionUnavailable(error)) => {
                    tracing::warn!(%error, "PostgreSQL is not reachable; retrying startup");
                    tokio::time::sleep(retry_delay).await;
                }
                result => return result,
            }
        }
    };
    tokio::time::timeout(startup_timeout, attempts)
        .await
        .unwrap_or_else(|_| {
            Err(RepositoryError::ConnectionUnavailable(format!(
                "PostgreSQL did not become reachable within {} ms",
                startup_timeout.as_millis()
            )))
        })
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn migration_history_must_be_an_exact_catalog_prefix() {
        assert_eq!(validate_migration_history(&[]).unwrap(), 0);

        let first = &MIGRATIONS[0];
        let applied = vec![AppliedMigration {
            version: first.version,
            name: first.name.to_owned(),
            checksum: migration_checksum(first),
        }];
        assert_eq!(validate_migration_history(&applied).unwrap(), 1);

        let mut changed = applied.clone();
        changed[0].checksum = "sha256:changed".to_owned();
        assert!(validate_migration_history(&changed).is_err());

        let unknown = vec![AppliedMigration {
            version: 999,
            name: "future".to_owned(),
            checksum: "sha256:future".to_owned(),
        }];
        assert!(validate_migration_history(&unknown).is_err());
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use super::{database_config, retry_connection};
    use crate::repository::{DatabaseTlsMode, RepositoryError};

    #[test]
    fn configured_tls_mode_overrides_connection_string_preferences() {
        let required = database_config(
            "postgres://localhost/egress?sslmode=disable",
            DatabaseTlsMode::Require,
        )
        .unwrap();
        assert_eq!(
            required.get_ssl_mode(),
            tokio_postgres::config::SslMode::Require
        );

        let disabled = database_config(
            "postgres://localhost/egress?sslmode=require",
            DatabaseTlsMode::Disable,
        )
        .unwrap();
        assert_eq!(
            disabled.get_ssl_mode(),
            tokio_postgres::config::SslMode::Disable
        );
    }

    #[tokio::test]
    async fn startup_retries_only_connection_failures() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let observed = attempts.clone();
        let result = retry_connection(
            Duration::from_secs(1),
            Duration::from_millis(1),
            move || {
                let observed = observed.clone();
                async move {
                    if observed.fetch_add(1, Ordering::SeqCst) < 2 {
                        Err(RepositoryError::ConnectionUnavailable(
                            "starting".to_owned(),
                        ))
                    } else {
                        Ok(42)
                    }
                }
            },
        )
        .await;

        assert_eq!(result.unwrap(), 42);
        assert_eq!(attempts.load(Ordering::SeqCst), 3);

        let attempts = Arc::new(AtomicUsize::new(0));
        let observed = attempts.clone();
        let result: Result<(), _> = retry_connection(
            Duration::from_secs(1),
            Duration::from_millis(1),
            move || {
                observed.fetch_add(1, Ordering::SeqCst);
                async { Err(RepositoryError::Unavailable("invalid schema".to_owned())) }
            },
        )
        .await;

        assert_eq!(
            result,
            Err(RepositoryError::Unavailable("invalid schema".to_owned()))
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }
}
