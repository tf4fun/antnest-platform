use super::*;
use crate::tunnel::PreparedKey;
use antnest_runtime_tunnel::KeyId;

impl PostgresRepository {
    pub(super) async fn prepare_generation_key(
        &self,
        row: PreparedKey,
    ) -> Result<PreparedKey, RepositoryError> {
        let mut client = self.pool.acquire().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
            let transaction = client.transaction().await.map_err(database_operation_error)?;
            let network = select_network_for_update(&transaction, &row.agent_id)
                .await?
                .ok_or(RepositoryError::AgentNetworkNotFound)?;
            if network.state != NetworkState::Active || network.tunnel_ipv4 != row.tunnel_ipv4 {
                return Err(RepositoryError::AgentNetworkUnavailable);
            }
            if let Some(existing) = transaction.query_opt(
                "SELECT key_id,agent_id,runtime_revision,host(tunnel_ipv4),nonce,sealed
                 FROM runtime_egress.runtime_tunnel_keys WHERE key_id=$1",
                &[&row.key_id.to_string()],
            ).await.map_err(database_operation_error)? {
                let existing = key_from_row(&existing)?;
                if !existing.same_identity(&row) {
                    return Err(RepositoryError::TunnelKeyConflict);
                }
                transaction.commit().await.map_err(database_operation_error)?;
                return Ok(existing);
            }
            let attachment = select_attachment(&transaction, &row.agent_id, true)
                .await?
                .ok_or(RepositoryError::AgentNetworkNotFound)?;
            if attachment.state != AttachmentState::Closed {
                return Err(RepositoryError::AttachmentOpen);
            }
            transaction.execute(
                "DELETE FROM runtime_egress.runtime_tunnel_keys WHERE agent_id=$1 AND role='candidate'",
                &[&row.agent_id.as_str()],
            ).await.map_err(database_operation_error)?;
            transaction.execute(
                "INSERT INTO runtime_egress.runtime_tunnel_keys
                 (key_id,agent_id,runtime_revision,tunnel_ipv4,role,nonce,sealed)
                 VALUES($1,$2,$3,$4::text::inet,'candidate',$5,$6)",
                &[&row.key_id.to_string(), &row.agent_id.as_str(), &row.runtime_revision,
                  &row.tunnel_ipv4.to_string(), &row.nonce, &row.sealed],
            ).await.map_err(|error| {
                if error.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION) {
                    RepositoryError::TunnelKeyConflict
                } else {
                    database_operation_error(error)
                }
            })?;
            transaction.commit().await.map_err(database_operation_error)?;
            Ok(row)
        }).await;
        finish_operation(&mut client, result)
    }
    pub(super) async fn load_generation_keys(
        &self,
        agent: Option<&AgentId>,
    ) -> Result<Vec<PreparedKey>, RepositoryError> {
        let mut client = self.pool.acquire().await?;
        let result = tokio::time::timeout(CLIENT_OPERATION_TIMEOUT, async {
            let fields = "SELECT key_id,agent_id,runtime_revision,host(tunnel_ipv4),nonce,sealed
                          FROM runtime_egress.runtime_tunnel_keys";
            let rows = if let Some(agent) = agent {
                client
                    .query(&format!("{fields} WHERE agent_id=$1"), &[&agent.as_str()])
                    .await
            } else {
                client.query(fields, &[]).await
            }
            .map_err(database_operation_error)?;
            rows.iter().map(key_from_row).collect()
        })
        .await;
        finish_operation(&mut client, result)
    }
}
fn key_from_row(row: &Row) -> Result<PreparedKey, RepositoryError> {
    let key_id: String = row.get(0);
    let agent: String = row.get(1);
    let ip: String = row.get(3);
    Ok(PreparedKey {
        key_id: KeyId::parse(&key_id).map_err(|_| RepositoryError::TunnelKeyUnavailable)?,
        agent_id: AgentId::parse(agent).map_err(|_| RepositoryError::TunnelKeyUnavailable)?,
        runtime_revision: row.get(2),
        tunnel_ipv4: ip
            .parse()
            .map_err(|_| RepositoryError::TunnelKeyUnavailable)?,
        nonce: row.get(4),
        sealed: row.get(5),
    })
}
