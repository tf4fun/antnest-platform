use std::{future::Future, sync::Arc};

use opentelemetry::{
    Context, KeyValue,
    trace::{Status, TraceContextExt as _},
};
use tokio_postgres::{Config, Error, Row, config::Host, types::ToSql};
use tracing_opentelemetry::OpenTelemetrySpanExt as _;

// Native handles stay private here; repository helpers can only call observed APIs.
pub(super) struct Client {
    inner: tokio_postgres::Client,
    attributes: Arc<[KeyValue]>,
}

pub(super) struct Transaction<'a> {
    inner: Option<tokio_postgres::Transaction<'a>>,
    observation: DatabaseObservation,
    attributes: Arc<[KeyValue]>,
}

impl Client {
    pub(super) fn new(inner: tokio_postgres::Client, config: &Config) -> Self {
        Self {
            inner,
            attributes: connection_attributes(config).into(),
        }
    }

    pub(super) fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    pub(super) async fn query(
        &self,
        query: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, Error> {
        DatabaseObservation::run(
            Operation::Statement,
            Some(query),
            &self.attributes,
            self.inner.query(query, params),
        )
        .await
    }

    pub(super) async fn query_one(
        &self,
        query: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Row, Error> {
        DatabaseObservation::run(
            Operation::Statement,
            Some(query),
            &self.attributes,
            self.inner.query_one(query, params),
        )
        .await
    }

    pub(super) async fn query_opt(
        &self,
        query: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, Error> {
        DatabaseObservation::run(
            Operation::Statement,
            Some(query),
            &self.attributes,
            self.inner.query_opt(query, params),
        )
        .await
    }

    pub(super) async fn execute(
        &self,
        query: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, Error> {
        DatabaseObservation::run(
            Operation::Statement,
            Some(query),
            &self.attributes,
            self.inner.execute(query, params),
        )
        .await
    }

    pub(super) async fn batch_execute(&self, query: &str) -> Result<(), Error> {
        DatabaseObservation::run(
            Operation::BatchExecute,
            Some(query),
            &self.attributes,
            self.inner.batch_execute(query),
        )
        .await
    }

    pub(super) async fn transaction(&mut self) -> Result<Transaction<'_>, Error> {
        let mut observation = DatabaseObservation::transaction(&self.attributes);
        let result = DatabaseObservation::run_with_parent(
            Operation::Begin,
            None,
            &self.attributes,
            observation.context(),
            self.inner.transaction(),
        )
        .await;
        match result {
            Ok(inner) => Ok(Transaction {
                inner: Some(inner),
                observation,
                attributes: self.attributes.clone(),
            }),
            Err(error) => {
                observation.finish_transaction("failed", Some(&error));
                Err(error)
            }
        }
    }
}

impl Transaction<'_> {
    fn inner(&self) -> &tokio_postgres::Transaction<'_> {
        self.inner
            .as_ref()
            .expect("an open transaction owns its native handle")
    }

    pub(super) async fn query(
        &self,
        query: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, Error> {
        DatabaseObservation::run_with_parent(
            Operation::Statement,
            Some(query),
            &self.attributes,
            self.observation.context(),
            self.inner().query(query, params),
        )
        .await
    }

    pub(super) async fn query_one(
        &self,
        query: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Row, Error> {
        DatabaseObservation::run_with_parent(
            Operation::Statement,
            Some(query),
            &self.attributes,
            self.observation.context(),
            self.inner().query_one(query, params),
        )
        .await
    }

    pub(super) async fn query_opt(
        &self,
        query: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, Error> {
        DatabaseObservation::run_with_parent(
            Operation::Statement,
            Some(query),
            &self.attributes,
            self.observation.context(),
            self.inner().query_opt(query, params),
        )
        .await
    }

    pub(super) async fn execute(
        &self,
        query: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, Error> {
        DatabaseObservation::run_with_parent(
            Operation::Statement,
            Some(query),
            &self.attributes,
            self.observation.context(),
            self.inner().execute(query, params),
        )
        .await
    }

    pub(super) async fn batch_execute(&self, query: &str) -> Result<(), Error> {
        DatabaseObservation::run_with_parent(
            Operation::BatchExecute,
            Some(query),
            &self.attributes,
            self.observation.context(),
            self.inner().batch_execute(query),
        )
        .await
    }

    pub(super) async fn commit(mut self) -> Result<(), Error> {
        let inner = self
            .inner
            .take()
            .expect("an open transaction owns its native handle");
        let result = DatabaseObservation::run_with_parent(
            Operation::Commit,
            None,
            &self.attributes,
            self.observation.context(),
            inner.commit(),
        )
        .await;
        self.observation
            .finish_transaction("committed", result.as_ref().err());
        result
    }

    // Production currently relies on native Drop rollback, not awaited rollback.
    #[cfg(test)]
    async fn rollback(mut self) -> Result<(), Error> {
        let inner = self
            .inner
            .take()
            .expect("an open transaction owns its native handle");
        let result = DatabaseObservation::run_with_parent(
            Operation::Rollback,
            None,
            &self.attributes,
            self.observation.context(),
            inner.rollback(),
        )
        .await;
        self.observation
            .finish_transaction("rolled_back", result.as_ref().err());
        result
    }
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        let Some(inner) = self.inner.take() else {
            return;
        };
        let observation = DatabaseObservation::with_parent(
            Operation::Rollback,
            None,
            &self.attributes,
            self.observation.context(),
        );
        if let Some(span) = &observation.span {
            span.set_attribute("antnest.transaction.completion", "unconfirmed");
        }
        // The driver only queues rollback on Drop. Do not wait, spawn, or claim success.
        drop(inner);
        drop(observation);
    }
}

#[derive(Clone, Copy)]
enum Operation {
    Statement,
    BatchExecute,
    Begin,
    Commit,
    Rollback,
}

impl Operation {
    fn name(self, query: Option<&str>) -> String {
        match self {
            // Match otelpgx's default first-word naming, not SQL grammar or table parsing.
            Self::Statement => query
                .unwrap_or_default()
                .split_whitespace()
                .next()
                .unwrap_or("UNKNOWN")
                .to_uppercase(),
            Self::BatchExecute => "BATCH".to_owned(),
            Self::Begin => "BEGIN".to_owned(),
            Self::Commit => "COMMIT".to_owned(),
            Self::Rollback => "ROLLBACK".to_owned(),
        }
    }
}

fn connection_attributes(config: &Config) -> Vec<KeyValue> {
    let mut attributes = Vec::new();
    if let Some(database) = config.get_dbname().or(config.get_user()) {
        attributes.push(KeyValue::new("db.namespace", database.to_owned()));
    }
    if let Some(user) = config.get_user() {
        attributes.push(KeyValue::new("user.name", user.to_owned()));
    }
    // Config may list failover targets. Never label the first as the selected peer.
    if config.get_hosts().len() <= 1 && config.get_hostaddrs().len() <= 1 {
        let address = match config.get_hosts().first() {
            Some(Host::Tcp(host)) => Some(host.clone()),
            #[cfg(unix)]
            Some(Host::Unix(path)) => Some(path.display().to_string()),
            None => config.get_hostaddrs().first().map(ToString::to_string),
        };
        if let Some(address) = address {
            attributes.push(KeyValue::new("server.address", address));
            attributes.push(KeyValue::new(
                "server.port",
                i64::from(config.get_ports().first().copied().unwrap_or(5432)),
            ));
        }
    }
    attributes
}

struct DatabaseObservation {
    span: Option<tracing::Span>,
    transaction: bool,
}

impl DatabaseObservation {
    fn transaction(attributes: &[KeyValue]) -> Self {
        let span = tracing::info_span!(
            "egress.database.transaction",
            otel.name = "postgresql transaction",
            otel.kind = "internal",
            db.system.name = "postgresql",
        );
        for attribute in attributes {
            span.set_attribute(attribute.key.clone(), attribute.value.clone());
        }
        Self {
            span: Some(span),
            transaction: true,
        }
    }

    fn context(&self) -> Context {
        self.span
            .as_ref()
            .map(|span| span.context())
            .unwrap_or_default()
    }

    fn finish_transaction(&mut self, outcome: &'static str, error: Option<&Error>) {
        if let Some(span) = &self.span {
            span.set_attribute(
                "antnest.transaction.outcome",
                if error.is_some() { "failed" } else { outcome },
            );
        }
        self.finish(error);
    }

    #[cfg(test)]
    fn new(operation: Operation, query: Option<&str>) -> Self {
        Self::with_parent(operation, query, &[], tracing::Span::current().context())
    }

    fn with_parent(
        operation: Operation,
        query: Option<&str>,
        attributes: &[KeyValue],
        parent: Context,
    ) -> Self {
        let operation = operation.name(query);
        let span = tracing::info_span!(
            "egress.database",
            otel.name = operation.as_str(),
            otel.kind = "client",
            db.system.name = "postgresql",
            db.operation.name = operation.as_str(),
        );
        if span.set_parent(parent).is_err() {
            tracing::debug!("database trace parent was not attached");
        }
        for attribute in attributes {
            span.set_attribute(attribute.key.clone(), attribute.value.clone());
        }
        if let Some(query) = query {
            span.set_attribute("db.query.text", query.to_owned());
        }
        Self {
            span: Some(span),
            transaction: false,
        }
    }

    async fn run<T>(
        operation: Operation,
        query: Option<&str>,
        attributes: &[KeyValue],
        future: impl Future<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        Self::run_with_parent(
            operation,
            query,
            attributes,
            tracing::Span::current().context(),
            future,
        )
        .await
    }

    async fn run_with_parent<T>(
        operation: Operation,
        query: Option<&str>,
        attributes: &[KeyValue],
        parent: Context,
        future: impl Future<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        let mut observation = Self::with_parent(operation, query, attributes, parent);
        let result = future.await;
        observation.finish(result.as_ref().err());
        result
    }

    fn finish(&mut self, error: Option<&Error>) {
        let Some(span) = self.span.take() else {
            return;
        };
        let Some(error) = error else {
            span.set_attribute("antnest.outcome", "success");
            return;
        };
        record_driver_error(&span, error);
    }
}

impl Drop for DatabaseObservation {
    fn drop(&mut self) {
        if let Some(span) = self.span.take() {
            if self.transaction {
                span.set_attribute("antnest.transaction.outcome", "unconfirmed");
            }
            span.set_attribute(
                "antnest.outcome",
                if std::thread::panicking() {
                    "error"
                } else {
                    "cancelled"
                },
            );
            if std::thread::panicking() {
                span.set_attribute("error.type", "database_boundary_panic");
                span.set_status(Status::error("database_boundary_panic"));
            }
        }
    }
}

fn record_driver_error(span: &tracing::Span, error: &Error) {
    use std::error::Error as _;

    let database = error.as_db_error();
    let sqlstate = error.code().map(|code| code.code());
    let kind = sqlstate.unwrap_or("tokio_postgres::Error");
    let message = database.map_or_else(|| error.to_string(), |db| db.message().to_owned());
    span.set_attribute("antnest.outcome", "error");
    span.set_attribute("error.type", kind.to_owned());
    span.set_status(Status::error(message.clone()));
    if let Some(sqlstate) = sqlstate {
        span.set_attribute("db.response.status_code", sqlstate.to_owned());
    }
    let mut attributes = vec![
        KeyValue::new("exception.type", kind.to_owned()),
        KeyValue::new("exception.message", message.clone()),
    ];
    // Typed PostgreSQL fields are already parsed by the driver.
    if let Some(db) = database {
        for (key, value) in [
            ("postgresql.error.severity", Some(db.severity())),
            ("postgresql.error.detail", db.detail()),
            ("postgresql.error.hint", db.hint()),
            ("postgresql.error.schema", db.schema()),
            ("postgresql.error.table", db.table()),
            ("postgresql.error.column", db.column()),
            ("postgresql.error.constraint", db.constraint()),
        ] {
            if let Some(value) = value {
                attributes.push(KeyValue::new(key, value.to_owned()));
            }
        }
    }
    let causes = std::iter::successors(error.source(), |cause| (*cause).source())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if !causes.is_empty() {
        attributes.push(KeyValue::new(
            "exception.causes",
            opentelemetry::Value::Array(opentelemetry::Array::String(
                causes.into_iter().map(Into::into).collect(),
            )),
        ));
    }
    span.add_event("exception", attributes);
    let context = span.context();
    let active = context.span();
    tracing::warn!(target: "antnest_runtime_egress::repository::completion",
        trace_id = %active.span_context().trace_id(), span_id = %active.span_context().span_id(),
        error.type = kind, failure.message = %message, db.response.status_code = sqlstate,
        "Runtime Egress database operation failed");
}

#[cfg(test)]
#[path = "observation_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "postgres_observation_tests.rs"]
mod postgres_tests;
