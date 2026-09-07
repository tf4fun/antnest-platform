use crate::{
    ServiceFailure,
    managed_mcp::manager::{ManagedError, ManagedMcp},
    network_session::NetworkSessionError,
    processes::ChildRegistry,
    spec::RuntimeSpec,
};
use std::{future::Future, pin::Pin, time::Duration};
use tokio_util::sync::CancellationToken;

enum StartupExit {
    Initialized(Result<(), ManagedError>),
    Network(Result<(), NetworkSessionError>),
    Shutdown,
}

pub(crate) async fn initialize_managed<NF>(
    spec: &RuntimeSpec,
    children: &ChildRegistry,
    network: &mut Pin<Box<NF>>,
    shutdown: &CancellationToken,
) -> Result<Option<ManagedMcp>, ServiceFailure>
where
    NF: Future<Output = Result<(), NetworkSessionError>>,
{
    let mut managed = ManagedMcp::default();
    // Stdio programs may need network access before they can answer initialize
    // or tools/list. Drive forwarding now, while HTTP admission remains closed.
    let exit = tokio::select! {
        result = managed.initialize(spec.mcp_servers(), children, spec.filesystem().workspace()) => StartupExit::Initialized(result),
        result = network.as_mut() => StartupExit::Network(result),
        _ = shutdown.cancelled() => StartupExit::Shutdown,
    };
    let (primary, wait_network) = match exit {
        StartupExit::Initialized(Ok(())) => return Ok(Some(managed)),
        StartupExit::Initialized(Err(error)) => (Some(managed_failure(error)), true),
        StartupExit::Network(result) => (Some(crate::network_exit_failure(result)), false),
        StartupExit::Shutdown => (None, true),
    };
    shutdown.cancel();
    let timeout = Duration::from_secs(8);
    let (managed_stop, network_stop) = tokio::join!(
        managed.shutdown(),
        crate::wait_for_service(
            wait_network,
            "network",
            network,
            |error| error.code(),
            tokio::time::Instant::now() + timeout,
            timeout
        ),
    );
    let failures = [managed_stop.err().map(managed_failure), network_stop]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if let Some(primary) = primary {
        crate::log_secondary_failures(spec.identity(), &primary, failures);
        return Err(primary);
    }
    let mut failures = failures.into_iter();
    match failures.next() {
        Some(error) => {
            crate::log_secondary_failures(spec.identity(), &error, failures.collect());
            Err(error)
        }
        None => Ok(None),
    }
}

pub(crate) fn managed_failure(error: ManagedError) -> ServiceFailure {
    ServiceFailure {
        component: "managed_mcp",
        error_type: error.code,
        message: error.to_string(),
    }
}
