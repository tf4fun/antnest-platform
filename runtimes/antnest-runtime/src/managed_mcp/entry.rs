use super::spec::{ServerInput, validate_servers};
use std::os::unix::process::CommandExt as _;
use std::path::Path;

pub(crate) const CHILD_CONFIG_ENV: &str = "ANTNEST_MANAGED_MCP_CONFIG";

pub(crate) fn run() -> Result<(), &'static str> {
    if !nix::unistd::geteuid().is_root() {
        return Err("managed MCP entry requires trusted root parent");
    }
    let encoded =
        std::env::var(CHILD_CONFIG_ENV).map_err(|_| "managed MCP configuration missing")?;
    let input: ServerInput =
        serde_json::from_str(&encoded).map_err(|_| "managed MCP configuration invalid")?;
    let servers = validate_servers(vec![input]).map_err(|_| "managed MCP configuration invalid")?;
    let input = servers[0].input();
    let uid: u32 = std::env::var("ANTNEST_MANAGED_MCP_UID")
        .map_err(|_| "managed MCP identity missing")?
        .parse()
        .map_err(|_| "managed MCP identity invalid")?;
    let secrets = super::secrets::load(input)?;
    let workspace =
        std::env::var_os("ANTNEST_RUNTIME_WORKSPACE").ok_or("managed MCP workspace missing")?;
    if !Path::new(&workspace).is_absolute() {
        return Err("managed MCP workspace must be absolute");
    }
    let cache_environment = super::private_home::prepare(uid)?;
    crate::privilege::enter_managed_state(uid)
        .map_err(|_| "managed MCP privilege transition failed")?;
    crate::privilege::close_untrusted_fds()
        .map_err(|_| "managed MCP descriptor isolation failed")?;
    // Do not turn config env into root process environment. In particular,
    // loader settings are applied only to this already-unprivileged exec.
    let _error = std::process::Command::new(&input.command)
        .args(&input.args)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .envs(&input.env)
        .envs(&secrets)
        .envs(cache_environment)
        .current_dir(&workspace)
        .exec();
    Err("managed MCP executable could not be started")
}
