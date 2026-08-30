use std::{
    collections::HashSet,
    future::Future,
    net::Ipv4Addr,
    ops::{Deref, DerefMut},
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, SystemTime},
};

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
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

const MAX_POOL_SIZE: usize = 8;
const CLIENT_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Eq, PartialEq)]
struct AppliedMigration {
    version: i64,
    name: String,
    checksum: String,
}

pub struct PostgresRepository {
    pool: ClientPool,
    config: RepositoryConfig,
    health: watch::Sender<bool>,
}

struct ClientPool {
    database_url: String,
    tls_mode: DatabaseTlsMode,
    config: RepositoryConfig,
    idle: Arc<StdMutex<Vec<Client>>>,
    permits: Arc<Semaphore>,
    health: Arc<ConnectionHealth>,
}

struct ClientLease {
    client: Option<Client>,
    idle: Arc<StdMutex<Vec<Client>>>,
    _permit: OwnedSemaphorePermit,
}

struct ConnectionHealth {
    live_connections: StdMutex<usize>,
    sender: watch::Sender<bool>,
}

struct ConnectionRegistration {
    state: StdMutex<ConnectionState>,
    health: Arc<ConnectionHealth>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConnectionState {
    Pending,
    Ready,
    Closed,
}

struct UnvalidatedClient {
    client: Client,
    registration: Arc<ConnectionRegistration>,
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
        let pool = ClientPool::new(database_url, tls_mode, config.clone(), health.clone());
        drop(pool.acquire().await?);
        Ok(Self {
            pool,
            config,
            health,
        })
    }

    pub fn health(&self) -> watch::Receiver<bool> {
        self.health.subscribe()
    }

    async fn acquire_client(&self) -> Result<ClientLease, RepositoryError> {
        self.pool.acquire().await
    }
}

impl ClientPool {
    fn new(
        database_url: &str,
        tls_mode: DatabaseTlsMode,
        config: RepositoryConfig,
        health: watch::Sender<bool>,
    ) -> Self {
        Self {
            database_url: database_url.to_owned(),
            tls_mode,
            config,
            idle: Arc::new(StdMutex::new(Vec::with_capacity(MAX_POOL_SIZE))),
            permits: Arc::new(Semaphore::new(MAX_POOL_SIZE)),
            health: Arc::new(ConnectionHealth {
                live_connections: StdMutex::new(0),
                sender: health,
            }),
        }
    }

    async fn acquire(&self) -> Result<ClientLease, RepositoryError> {
        let permit = tokio::time::timeout(
            CLIENT_ACQUIRE_TIMEOUT,
            Arc::clone(&self.permits).acquire_owned(),
        )
        .await
        .map_err(|_| connection_unavailable("PostgreSQL connection pool is saturated"))?
        .map_err(|_| connection_unavailable("PostgreSQL connection pool is closed"))?;

        let client = match self.take_idle_client()? {
            Some(client) => client,
            None => self.open_validated_client().await?,
        };
        Ok(ClientLease {
            client: Some(client),
            idle: Arc::clone(&self.idle),
            _permit: permit,
        })
    }

    fn take_idle_client(&self) -> Result<Option<Client>, RepositoryError> {
        let mut idle = self
            .idle
            .lock()
            .map_err(|_| connection_unavailable("PostgreSQL connection pool lock is poisoned"))?;
        while let Some(client) = idle.pop() {
            if !client.is_closed() {
                return Ok(Some(client));
            }
        }
        Ok(None)
    }

    async fn open_validated_client(&self) -> Result<Client, RepositoryError> {
        let mut candidate =
            connect_client(&self.database_url, self.tls_mode, Arc::clone(&self.health)).await?;
        tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
            configure_operation_client(&candidate.client).await?;
            migrate_client(&mut candidate.client, &self.config).await
        })
        .await
        .map_err(|_| operation_failed("PostgreSQL connection validation timed out"))??;
        if !candidate.registration.activate() {
            return Err(connection_unavailable(
                "PostgreSQL connection closed during validation",
            ));
        }
        Ok(candidate.client)
    }
}

impl ClientLease {
    fn discard(&mut self) {
        self.client.take();
    }
}

impl Deref for ClientLease {
    type Target = Client;

    fn deref(&self) -> &Self::Target {
        self.client
            .as_ref()
            .expect("a checked-out PostgreSQL lease owns a client")
    }
}

impl DerefMut for ClientLease {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.client
            .as_mut()
            .expect("a checked-out PostgreSQL lease owns a client")
    }
}

impl Drop for ClientLease {
    fn drop(&mut self) {
        let Some(client) = self.client.take() else {
            return;
        };
        if client.is_closed() {
            return;
        }
        match self.idle.lock() {
            Ok(mut idle) => idle.push(client),
            Err(_) => tracing::error!("PostgreSQL connection pool lock is poisoned"),
        }
    }
}

impl ConnectionHealth {
    fn connection_ready(&self) {
        let mut live = self
            .live_connections
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *live += 1;
        if *live == 1 {
            self.sender.send_replace(true);
        }
    }

    fn connection_closed(&self) {
        let mut live = self
            .live_connections
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        debug_assert!(*live > 0, "connection close must follow readiness");
        *live = live.saturating_sub(1);
        if *live == 0 {
            self.sender.send_replace(false);
        }
    }
}

impl ConnectionRegistration {
    fn new(health: Arc<ConnectionHealth>) -> Self {
        Self {
            state: StdMutex::new(ConnectionState::Pending),
            health,
        }
    }

    fn activate(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match *state {
            ConnectionState::Pending => {
                self.health.connection_ready();
                *state = ConnectionState::Ready;
                true
            }
            ConnectionState::Ready | ConnectionState::Closed => false,
        }
    }

    fn close(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *state == ConnectionState::Ready {
            self.health.connection_closed();
        }
        *state = ConnectionState::Closed;
    }
}

async fn connect_client(
    database_url: &str,
    tls_mode: DatabaseTlsMode,
    health: Arc<ConnectionHealth>,
) -> Result<UnvalidatedClient, RepositoryError> {
    match tls_mode {
        DatabaseTlsMode::Disable => connect_without_tls(database_url, health).await,
        DatabaseTlsMode::Require => connect_with_tls(database_url, health).await,
    }
}

async fn connect_without_tls(
    database_url: &str,
    health: Arc<ConnectionHealth>,
) -> Result<UnvalidatedClient, RepositoryError> {
    let config = database_config(database_url, DatabaseTlsMode::Disable)?;
    let (client, connection) = config
        .connect(NoTls)
        .await
        .map_err(connection_unavailable)?;
    let registration = Arc::new(ConnectionRegistration::new(health));
    let driver_registration = Arc::clone(&registration);
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            tracing::error!(error = %error, "PostgreSQL connection terminated");
        }
        driver_registration.close();
    });
    Ok(UnvalidatedClient {
        client,
        registration,
    })
}

async fn connect_with_tls(
    database_url: &str,
    health: Arc<ConnectionHealth>,
) -> Result<UnvalidatedClient, RepositoryError> {
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
    let registration = Arc::new(ConnectionRegistration::new(health));
    let driver_registration = Arc::clone(&registration);
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            tracing::error!(error = %error, "PostgreSQL TLS connection terminated");
        }
        driver_registration.close();
    });
    Ok(UnvalidatedClient {
        client,
        registration,
    })
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
    config.connect_timeout(CLIENT_CONNECT_TIMEOUT);
    Ok(config)
}

async fn configure_operation_client(client: &Client) -> Result<(), RepositoryError> {
    tokio::time::timeout(
        CLIENT_OPERATION_TIMEOUT,
        client.batch_execute(
            "SET statement_timeout = '4s';
             SET lock_timeout = '4s'",
        ),
    )
    .await
    .map_err(|_| connection_unavailable("PostgreSQL session configuration timed out"))?
    .map_err(unavailable)
}

async fn migrate_client(
    client: &mut Client,
    config: &RepositoryConfig,
) -> Result<(), RepositoryError> {
    reject_foreign_schema(client).await?;
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

async fn reject_foreign_schema(client: &Client) -> Result<(), RepositoryError> {
    let owned = client
        .query_opt(
            "SELECT pg_get_userbyid(nspowner) = current_user
             FROM pg_namespace WHERE nspname = 'runtime_egress'",
            &[],
        )
        .await
        .map_err(unavailable)?
        .map(|row| row.get::<_, bool>(0));
    match owned {
        Some(false) => Err(RepositoryError::Unavailable(
            "runtime_egress schema is not owned by the configured database role".to_owned(),
        )),
        Some(true) | None => Ok(()),
    }
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
        let mut client = self.acquire_client().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
            let transaction = client
                .transaction()
                .await
                .map_err(database_operation_error)?;
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
                .map_err(database_operation_error)?
                .ok_or_else(|| operation_failed("configured address pool is missing"))?;
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
                .map_err(database_operation_error)?;
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
                .map_err(database_operation_error)?;
            transaction
                .execute(
                    "INSERT INTO runtime_egress.agent_networks
                     (agent_id, pool_id, tunnel_ipv4, state, resource_version)
                     VALUES ($1, $2, $3::text::inet, 'active', 1)",
                    &[&agent_id.as_str(), &pool_id, &selection.address.to_string()],
                )
                .await
                .map_err(database_operation_error)?;
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
                .map_err(database_operation_error)?;
            transaction
                .commit()
                .await
                .map_err(database_operation_error)?;
            Ok(AgentNetwork {
                agent_id,
                pool_id: pool_id.to_owned(),
                tunnel_ipv4: selection.address,
                state: NetworkState::Active,
                resource_version: 1,
                quarantine_until: None,
            })
        })
        .await;
        finish_operation(&mut client, result)
    }

    async fn agent_network(&self, agent_id: &AgentId) -> Result<AgentNetwork, RepositoryError> {
        let mut client = self.acquire_client().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
            select_network_client(&client, agent_id)
                .await?
                .ok_or(RepositoryError::AgentNetworkNotFound)
        })
        .await;
        finish_operation(&mut client, result)
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
        let mut client = self.acquire_client().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
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
                        &serde_json::to_value(candidate.spec).map_err(operation_failed)?,
                        &candidate.digest,
                    ],
                )
                .await
                .map_err(database_operation_error)?;
            let persisted = select_policy_revision(&client, &candidate.policy_id, revision).await?;
            if persisted.digest != candidate.digest {
                return Err(RepositoryError::PolicyRevisionConflict);
            }
            Ok(persisted)
        })
        .await;
        finish_operation(&mut client, result)
    }

    async fn policy_revision(
        &self,
        policy_id: &PolicyId,
        revision: u64,
    ) -> Result<PolicyRevision, RepositoryError> {
        let mut client = self.acquire_client().await?;
        let result = tokio::time::timeout(
            CLIENT_OPERATION_TIMEOUT,
            select_policy_revision(&client, policy_id, revision),
        )
        .await;
        finish_operation(&mut client, result)
    }

    async fn policy_assignment(
        &self,
        agent_id: &AgentId,
    ) -> Result<PolicyAssignment, RepositoryError> {
        let mut client = self.acquire_client().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
            select_assignment_client(&client, agent_id)
                .await?
                .ok_or(RepositoryError::AgentNetworkNotFound)
        })
        .await;
        finish_operation(&mut client, result)
    }

    async fn compare_and_swap_assignment(
        &self,
        agent_id: &AgentId,
        policy_id: PolicyId,
        revision: u64,
        expected_resource_version: u64,
    ) -> Result<PolicyAssignment, RepositoryError> {
        let mut client = self.acquire_client().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
            let transaction = client
                .transaction()
                .await
                .map_err(database_operation_error)?;
            if transaction
                .query_opt(
                    "SELECT 1 FROM runtime_egress.policy_revisions
                     WHERE policy_id = $1 AND revision = $2",
                    &[&policy_id.as_str(), &u64_to_i64(revision)?],
                )
                .await
                .map_err(database_operation_error)?
                .is_none()
            {
                return Err(RepositoryError::PolicyRevisionNotFound);
            }
            let current = select_assignment(&transaction, agent_id, true)
                .await?
                .ok_or(RepositoryError::AgentNetworkNotFound)?;
            if current.policy_id == policy_id && current.revision == revision {
                transaction
                    .commit()
                    .await
                    .map_err(database_operation_error)?;
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
                .map_err(database_operation_error)?;
            transaction
                .commit()
                .await
                .map_err(database_operation_error)?;
            Ok(assignment)
        })
        .await;
        finish_operation(&mut client, result)
    }

    async fn quarantine_agent_network(
        &self,
        agent_id: &AgentId,
        now: SystemTime,
    ) -> Result<AgentNetwork, RepositoryError> {
        let mut client = self.acquire_client().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
            let transaction = client
                .transaction()
                .await
                .map_err(database_operation_error)?;
            let current = select_network_for_update(&transaction, agent_id)
                .await?
                .ok_or(RepositoryError::AgentNetworkNotFound)?;
            if current.state == NetworkState::Quarantined {
                transaction
                    .commit()
                    .await
                    .map_err(database_operation_error)?;
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
                .map_err(database_operation_error)?;
            let network = network_from_row(&row)?;
            transaction
                .commit()
                .await
                .map_err(database_operation_error)?;
            Ok(network)
        })
        .await;
        finish_operation(&mut client, result)
    }

    async fn active_bindings(&self) -> Result<Vec<ActiveBinding>, RepositoryError> {
        let mut client = self.acquire_client().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
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
                .map_err(database_operation_error)?;
            rows.into_iter().map(binding_from_row).collect()
        })
        .await;
        finish_operation(&mut client, result)
    }

    async fn expired_quarantines(
        &self,
        now: SystemTime,
    ) -> Result<Vec<AgentNetwork>, RepositoryError> {
        let mut client = self.acquire_client().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
            client
                .query(
                    "SELECT agent_id, pool_id, host(tunnel_ipv4), state,
                            resource_version, quarantine_until
                     FROM runtime_egress.agent_networks
                     WHERE state = 'quarantined' AND quarantine_until <= $1",
                    &[&now],
                )
                .await
                .map_err(database_operation_error)?
                .into_iter()
                .map(|row| network_from_row(&row))
                .collect()
        })
        .await;
        finish_operation(&mut client, result)
    }

    async fn delete_quarantined(
        &self,
        agent_id: &AgentId,
        expected_resource_version: u64,
    ) -> Result<bool, RepositoryError> {
        let mut client = self.acquire_client().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
            let deleted = client
                .execute(
                    "DELETE FROM runtime_egress.agent_networks
                     WHERE agent_id = $1 AND state = 'quarantined'
                       AND resource_version = $2",
                    &[&agent_id.as_str(), &u64_to_i64(expected_resource_version)?],
                )
                .await
                .map_err(database_operation_error)?;
            Ok(deleted == 1)
        })
        .await;
        finish_operation(&mut client, result)
    }
}

fn binding_from_row(row: Row) -> Result<ActiveBinding, RepositoryError> {
    let network = network_from_row(&row)?;
    let policy_id = PolicyId::parse(row.get::<_, String>(6)).map_err(operation_failed)?;
    let revision_number = i64_to_u64(row.get(7))?;
    let assignment = PolicyAssignment {
        agent_id: network.agent_id.clone(),
        policy_id: policy_id.clone(),
        revision: revision_number,
        resource_version: i64_to_u64(row.get(8))?,
    };
    let spec = serde_json::from_value(row.get(9)).map_err(operation_failed)?;
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
        .map_err(database_operation_error)?
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
        .map_err(database_operation_error)?
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
        .map_err(database_operation_error)?
        .map(|row| network_from_row(&row))
        .transpose()
}

fn network_from_row(row: &Row) -> Result<AgentNetwork, RepositoryError> {
    let state: String = row.get(3);
    Ok(AgentNetwork {
        agent_id: AgentId::parse(row.get::<_, String>(0)).map_err(operation_failed)?,
        pool_id: row.get(1),
        tunnel_ipv4: parse_ipv4(row.get(2))?,
        state: match state.as_str() {
            "active" => NetworkState::Active,
            "quarantined" => NetworkState::Quarantined,
            _ => {
                return Err(operation_failed("invalid network state"));
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
        .map_err(database_operation_error)?
        .ok_or(RepositoryError::PolicyRevisionNotFound)?;
    policy_revision_from_row(policy_id.clone(), revision, &row)
}

fn policy_revision_from_row(
    policy_id: PolicyId,
    revision: u64,
    row: &Row,
) -> Result<PolicyRevision, RepositoryError> {
    let spec = serde_json::from_value(row.get(0)).map_err(operation_failed)?;
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
        .map_err(database_operation_error)?
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
        .map_err(database_operation_error)?
        .map(|row| assignment_from_row(agent_id.clone(), &row))
        .transpose()
}

fn assignment_from_row(agent_id: AgentId, row: &Row) -> Result<PolicyAssignment, RepositoryError> {
    Ok(PolicyAssignment {
        agent_id,
        policy_id: PolicyId::parse(row.get::<_, String>(0)).map_err(operation_failed)?,
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
    value.parse().map_err(operation_failed)
}

fn parse_ipv4_net(value: String) -> Result<ipnet::Ipv4Net, RepositoryError> {
    value.parse().map_err(operation_failed)
}

fn i64_to_u64(value: i64) -> Result<u64, RepositoryError> {
    value
        .try_into()
        .map_err(|_| operation_failed("negative database value"))
}

fn i64_to_u32(value: i64) -> Result<u32, RepositoryError> {
    value
        .try_into()
        .map_err(|_| operation_failed("invalid allocator cursor"))
}

fn u64_to_i64(value: u64) -> Result<i64, RepositoryError> {
    value
        .try_into()
        .map_err(|_| operation_failed("value exceeds PostgreSQL bigint"))
}

fn duration_seconds_i64(value: std::time::Duration) -> Result<i64, RepositoryError> {
    u64_to_i64(value.as_secs())
}

fn finish_operation<T>(
    client: &mut ClientLease,
    result: Result<Result<T, RepositoryError>, tokio::time::error::Elapsed>,
) -> Result<T, RepositoryError> {
    match result {
        Ok(Err(RepositoryError::ConnectionUnavailable(error))) => {
            client.discard();
            Err(RepositoryError::ConnectionUnavailable(error))
        }
        Ok(result) => result,
        Err(_) => {
            client.discard();
            Err(operation_failed("PostgreSQL operation timed out"))
        }
    }
}

fn database_operation_error(error: tokio_postgres::Error) -> RepositoryError {
    if error.as_db_error().is_some() {
        operation_failed(error)
    } else {
        connection_unavailable(error)
    }
}

fn operation_failed(error: impl std::fmt::Display) -> RepositoryError {
    RepositoryError::OperationFailed(error.to_string())
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

    use super::{ConnectionHealth, ConnectionRegistration, database_config, retry_connection};
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

    #[test]
    fn repository_health_tracks_the_last_validated_connection() {
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let health = Arc::new(ConnectionHealth {
            live_connections: std::sync::Mutex::new(0),
            sender,
        });
        let first = ConnectionRegistration::new(health.clone());
        let second = ConnectionRegistration::new(health.clone());

        assert!(first.activate());
        assert!(second.activate());
        assert!(*receiver.borrow());

        first.close();
        assert!(*receiver.borrow());
        second.close();
        assert!(!*receiver.borrow());

        let closed_before_validation = ConnectionRegistration::new(health);
        closed_before_validation.close();
        assert!(!closed_before_validation.activate());
        assert!(!*receiver.borrow());
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
