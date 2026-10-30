use std::time::Duration;

pub(crate) const DRAIN_TIMEOUT: Duration = Duration::from_secs(8);
pub(crate) const CLEANUP_TIMEOUT: Duration = Duration::from_secs(3);
pub(crate) const CLEANUP_EXECUTION_TIMEOUT: Duration = Duration::from_secs(1);
pub(crate) const TELEMETRY_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(20);

#[cfg(test)]
mod tests {
    use super::{
        CLEANUP_EXECUTION_TIMEOUT, CLEANUP_TIMEOUT, DRAIN_TIMEOUT, STOP_GRACE, TELEMETRY_TIMEOUT,
    };

    fn contract_shutdown() -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../contracts/runtime/container-security.json"
        ))
        .expect("container security contract must decode")["shutdown"]
            .clone()
    }

    #[test]
    fn constants_match_the_container_security_contract() {
        let shutdown = contract_shutdown();
        assert_eq!(
            DRAIN_TIMEOUT.as_secs(),
            shutdown["drain_seconds"].as_u64().unwrap()
        );
        assert_eq!(
            CLEANUP_TIMEOUT.as_secs(),
            shutdown["cleanup_seconds"].as_u64().unwrap()
        );
        assert_eq!(
            TELEMETRY_TIMEOUT.as_secs(),
            shutdown["telemetry_seconds"].as_u64().unwrap()
        );
        assert_eq!(
            STOP_GRACE.as_secs(),
            shutdown["stop_grace_seconds"].as_u64().unwrap()
        );
    }

    #[test]
    fn phase_budgets_sum_below_the_engine_stop_grace() {
        let shutdown = contract_shutdown();
        let total = DRAIN_TIMEOUT + CLEANUP_TIMEOUT + TELEMETRY_TIMEOUT;
        assert_eq!(total.as_secs(), shutdown["total_seconds"].as_u64().unwrap());
        assert!(total < STOP_GRACE);
        assert!(CLEANUP_EXECUTION_TIMEOUT < CLEANUP_TIMEOUT);
        assert_eq!(
            shutdown["managed_shutdown"]["budget_seconds"]
                .as_u64()
                .unwrap(),
            DRAIN_TIMEOUT.as_secs()
        );
        assert_eq!(
            shutdown["managed_shutdown"]["parallel_with_drain"],
            serde_json::json!(true)
        );
    }
}
