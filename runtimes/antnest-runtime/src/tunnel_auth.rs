//! Root-only, digest-verified generation bootstrap. No private type implements Debug.
use crate::service_auth::ConfigError;
use antnest_runtime_tunnel::{KeyId, Peer};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read as _,
    os::{
        fd::{AsRawFd as _, FromRawFd as _},
        unix::fs::{MetadataExt as _, OpenOptionsExt as _},
    },
    path::Path,
};
use zeroize::{Zeroize as _, Zeroizing};

pub(crate) const KEYS_FILE: &str = "/run/antnest-auth/tunnel.json";
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Descriptor {
    pub(crate) key_id: String,
    pub(crate) keys_file: String,
    pub(crate) keys_digest: String,
}
impl Descriptor {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        if KeyId::parse(&self.key_id).is_err()
            || self.keys_file != KEYS_FILE
            || !crate::service_auth::valid_digest(&self.keys_digest)
        {
            return Err(ConfigError);
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Keys {
    key_id: String,
    runtime_private_key: String,
    egress_public_key: String,
    preshared_key: String,
}
impl Drop for Keys {
    fn drop(&mut self) {
        self.runtime_private_key.zeroize();
        self.preshared_key.zeroize();
    }
}
fn key(encoded: &str) -> Result<[u8; 32], ConfigError> {
    let bytes = Zeroizing::new(URL_SAFE_NO_PAD.decode(encoded).map_err(|_| ConfigError)?);
    if bytes.len() != 32
        || URL_SAFE_NO_PAD.encode(&*bytes) != encoded
        || bytes.iter().all(|b| *b == 0)
    {
        return Err(ConfigError);
    }
    bytes.as_slice().try_into().map_err(|_| ConfigError)
}
pub(crate) fn decode(raw: &[u8], descriptor: &Descriptor) -> Result<Peer, ConfigError> {
    descriptor.validate()?;
    if raw.len() > 8192
        || digest(raw) != descriptor.keys_digest
        || !crate::service_auth::valid_json_body(raw)
    {
        return Err(ConfigError);
    }
    let value: Keys = serde_json::from_slice(raw).map_err(|_| ConfigError)?;
    if value.key_id != descriptor.key_id {
        return Err(ConfigError);
    }
    Ok(Peer::new(
        KeyId::parse(&value.key_id).map_err(|_| ConfigError)?,
        key(&value.runtime_private_key)?,
        key(&value.egress_public_key)?,
        key(&value.preshared_key)?,
    ))
}
pub(crate) fn read_opened(
    directory: &File,
    descriptor: &Descriptor,
    uid: u32,
    gid: u32,
) -> Result<Peer, ConfigError> {
    descriptor.validate()?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c"tunnel.json".as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(ConfigError);
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let stat = file.metadata().map_err(|_| ConfigError)?;
    if !stat.is_file()
        || stat.uid() != uid
        || stat.gid() != gid
        || stat.mode() & 0o7777 != 0o600
        || !(1..=8192).contains(&stat.len())
    {
        return Err(ConfigError);
    }
    let mut raw = Zeroizing::new(Vec::new());
    file.take(8193)
        .read_to_end(&mut raw)
        .map_err(|_| ConfigError)?;
    decode(&raw, descriptor)
}
pub(crate) fn read_directory(
    path: &Path,
    descriptor: &Descriptor,
    uid: u32,
    gid: u32,
) -> Result<Peer, ConfigError> {
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| ConfigError)?;
    let stat = root.metadata().map_err(|_| ConfigError)?;
    if !stat.is_dir() || stat.uid() != uid || stat.gid() != gid || stat.mode() & 0o7777 != 0o700 {
        return Err(ConfigError);
    }
    read_opened(&root, descriptor, uid, gid)
}
pub(crate) fn load(descriptor: &Descriptor) -> Result<Peer, ConfigError> {
    read_directory(
        Path::new(crate::service_auth::CALLERS_DIRECTORY),
        descriptor,
        0,
        0,
    )
}

pub(crate) fn digest(raw: &[u8]) -> String {
    "sha256:".to_owned()
        + &Sha256::digest(raw)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
}
