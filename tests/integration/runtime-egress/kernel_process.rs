use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::run;

#[tokio::test]
async fn timeout_kills_and_reaps_the_command() {
    let marker = std::env::temp_dir().join(format!(
        "antnest-egress-timeout-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let script = format!("sleep 0.2; touch {}", marker.display());

    let result = run(
        "sh",
        &["-c".to_owned(), script],
        None,
        Duration::from_millis(20),
        false,
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("timed out"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!marker.exists(), "timed-out child continued running");
}
