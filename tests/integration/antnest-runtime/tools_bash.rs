#[cfg(target_os = "linux")]
#[tokio::test]
async fn bash_home_matches_the_configured_workspace() {
    use std::sync::Arc;

    use tempfile::tempdir;
    use tokio_util::sync::CancellationToken;

    use super::ToolEngine;
    use crate::roots::NamedRoots;

    let workspace = tempdir().expect("workspace");
    let skills = tempdir().expect("skills");
    let roots = NamedRoots::open(workspace.path(), skills.path()).expect("roots");
    let engine = ToolEngine::new(Arc::new(roots));
    let result = engine
        .bash(
            bash_request("printf %s \"$HOME\"", 1_000),
            CancellationToken::new(),
        )
        .await
        .expect("bash");

    assert_eq!(result.stdout, workspace.path().to_string_lossy());
}

#[cfg(target_os = "linux")]
fn bash_request(command: &str, timeout_ms: u64) -> crate::execution::BashRequest {
    crate::execution::BashRequest::new(
        command.into(),
        crate::execution::RootPath::new(crate::execution::RootName::Workspace, ".".into()).unwrap(),
        Vec::new(),
        timeout_ms,
    )
    .unwrap()
}
