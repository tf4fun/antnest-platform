use super::spec::{ServerInput, validate_servers};
use std::os::unix::process::CommandExt as _;
use std::path::Path;

pub(crate) const CHILD_CONFIG_ENV: &str = "ANTNEST_MANAGED_MCP_CONFIG";

pub(crate) fn run() -> Result<(), &'static str> {
    crate::privilege::enter_executor_state()
        .map_err(|_| "managed MCP privilege transition failed")?;
    crate::privilege::close_untrusted_fds()
        .map_err(|_| "managed MCP descriptor isolation failed")?;
    let encoded =
        std::env::var(CHILD_CONFIG_ENV).map_err(|_| "managed MCP configuration missing")?;
    let input: ServerInput =
        serde_json::from_str(&encoded).map_err(|_| "managed MCP configuration invalid")?;
    let servers = validate_servers(vec![input]).map_err(|_| "managed MCP configuration invalid")?;
    let input = servers[0].input();
    let workspace =
        std::env::var_os("ANTNEST_RUNTIME_WORKSPACE").ok_or("managed MCP workspace missing")?;
    if !Path::new(&workspace).is_absolute() {
        return Err("managed MCP workspace must be absolute");
    }
    // Do not turn config env into root process environment. In particular,
    // loader settings are applied only to this already-unprivileged exec.
    let _error = std::process::Command::new(&input.command)
        .args(&input.args)
        .env_clear()
        .env("HOME", &workspace)
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .envs(&input.env)
        .current_dir(&workspace)
        .exec();
    Err("managed MCP executable could not be started")
}
