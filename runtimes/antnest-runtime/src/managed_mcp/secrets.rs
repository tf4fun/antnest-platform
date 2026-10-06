use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::path::Path;

use super::spec::ServerInput;

pub(crate) const DIRECTORY: &str = "/run/antnest-mcp";
const FILE: &str = "/run/antnest-mcp/secrets.json";
const MAX_BYTES: u64 = 64 * 1024;

pub(crate) fn load(input: &ServerInput) -> Result<BTreeMap<String, String>, &'static str> {
    if input.secret_env.is_empty() {
        return Ok(BTreeMap::new());
    }
    load_file(input, Path::new(DIRECTORY), Path::new(FILE))
}

fn load_file(
    input: &ServerInput,
    directory: &Path,
    path: &Path,
) -> Result<BTreeMap<String, String>, &'static str> {
    let dir = std::fs::symlink_metadata(directory)
        .map_err(|_| "private MCP bootstrap directory missing")?;
    if !dir.is_dir() || dir.uid() != 0 || dir.gid() != 0 || dir.mode() & 0o7777 != 0o700 {
        return Err("private MCP bootstrap directory invalid");
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| "private MCP bootstrap unreadable")?;
    let metadata = file
        .metadata()
        .map_err(|_| "private MCP bootstrap invalid")?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.gid() != 0
        || metadata.mode() & 0o7777 != 0o400
        || metadata.nlink() != 1
        || metadata.len() > MAX_BYTES
    {
        return Err("private MCP bootstrap metadata invalid");
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "private MCP bootstrap read failed")?;
    if bytes.len() > MAX_BYTES as usize {
        return Err("private MCP bootstrap oversized");
    }
    let parsed = serde_json::from_slice::<BTreeMap<String, BTreeMap<String, String>>>(&bytes)
        .map_err(|_| "private MCP bootstrap invalid")?;
    let values = parsed
        .get(&input.id)
        .ok_or("private MCP bootstrap server missing")?;
    verify(input, values)?;
    Ok(values.clone())
}

fn secret_fingerprint(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!(
        "sha256:{}",
        digest
            .iter()
            .take(4)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn verify(input: &ServerInput, values: &BTreeMap<String, String>) -> Result<(), &'static str> {
    if values.len() != input.secret_env.len() {
        return Err("private MCP bootstrap names differ");
    }
    for (name, descriptor) in &input.secret_env {
        let value = values
            .get(name)
            .ok_or("private MCP bootstrap name missing")?;
        if value.len() > 8192 || value.contains('\0') {
            return Err("private MCP bootstrap value invalid");
        }
        let fingerprint = secret_fingerprint(value);
        if fingerprint != descriptor.fingerprint {
            return Err("private MCP bootstrap fingerprint differs");
        }
    }
    // Apply the existing resolved limits, including JSON escaping overhead.
    let mut resolved = input.clone();
    resolved.secret_env.clear();
    resolved.env.extend(values.clone());
    super::spec::validate_servers(vec![resolved])
        .map_err(|_| "private MCP resolved configuration invalid")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_bootstrap_requires_exact_names_and_content() {
        let value = "synthetic-secret-canary";
        let fingerprint = secret_fingerprint(value);
        let input:ServerInput=serde_json::from_value(serde_json::json!({"id":"docs","command":"node","secret_env":{"API_KEY":{"set":true,"fingerprint":&fingerprint[..15]}}})).unwrap();
        let mut values = BTreeMap::from([("API_KEY".into(), value.into())]);
        assert!(verify(&input, &values).is_ok());
        values.insert("OTHER".into(), value.into());
        assert!(verify(&input, &values).is_err());
        values.remove("OTHER");
        values.insert("API_KEY".into(), "changed".into());
        assert!(verify(&input, &values).is_err());
    }
}
