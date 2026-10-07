//! Prepared generation key storage and the reviewed transport engine.
use crate::domain::AgentId;
use antnest_runtime_tunnel::{KeyId, Peer};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit as _,
    aead::{Aead as _, Payload},
};
use rand_core::{OsRng, RngCore as _};
use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::Read as _,
    net::Ipv4Addr,
    os::unix::fs::{MetadataExt as _, OpenOptionsExt as _},
};
use subtle::ConstantTimeEq as _;
use zeroize::{Zeroize as _, Zeroizing};

#[derive(Debug, thiserror::Error)]
#[error("invalid or unavailable prepared tunnel material")]
pub struct Error;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub key_id: String,
    pub runtime_revision: String,
    pub tunnel_ipv4: Ipv4Addr,
    #[serde(skip_serializing)]
    pub egress_private_key: String,
    pub runtime_public_key: String,
    #[serde(skip_serializing)]
    pub preshared_key: String,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.egress_private_key.zeroize();
        self.preshared_key.zeroize();
    }
}
impl Registration {
    pub fn validate(&self) -> Result<(), Error> {
        KeyId::parse(&self.key_id).map_err(|_| Error)?;
        let revision = self
            .runtime_revision
            .strip_prefix("rtv_")
            .filter(|v| v.len() == 32)
            .ok_or(Error)?;
        if !revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.tunnel_ipv4.is_unspecified()
            || self.tunnel_ipv4.is_multicast()
            || self.tunnel_ipv4.is_broadcast()
        {
            return Err(Error);
        }
        self.material()?;
        Ok(())
    }
    fn material(&self) -> Result<Material, Error> {
        Ok(Material {
            egress_private: key(&self.egress_private_key)?,
            runtime_public: key(&self.runtime_public_key)?,
            preshared: key(&self.preshared_key)?,
        })
    }
}
fn key(encoded: &str) -> Result<[u8; 32], Error> {
    let bytes = Zeroizing::new(URL_SAFE_NO_PAD.decode(encoded).map_err(|_| Error)?);
    if bytes.len() != 32
        || URL_SAFE_NO_PAD.encode(&*bytes) != encoded
        || bytes.iter().all(|b| *b == 0)
    {
        return Err(Error);
    }
    bytes.as_slice().try_into().map_err(|_| Error)
}
#[derive(Clone)]
pub struct PreparedKey {
    pub agent_id: AgentId,
    pub key_id: KeyId,
    pub runtime_revision: String,
    pub tunnel_ipv4: Ipv4Addr,
    pub nonce: Vec<u8>,
    pub sealed: Vec<u8>,
}
impl std::fmt::Debug for PreparedKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedKey")
            .field("agent_id", &self.agent_id)
            .field("key_id", &self.key_id)
            .finish_non_exhaustive()
    }
}
impl PreparedKey {
    fn aad(&self) -> Vec<u8> {
        serde_json::to_vec(&(
            "antnest-egress-tunnel-v1",
            self.agent_id.as_str(),
            self.key_id.to_string(),
            &self.runtime_revision,
            self.tunnel_ipv4.to_string(),
        ))
        .expect("fixed identity tuple")
    }
    pub fn same_identity(&self, other: &Self) -> bool {
        self.agent_id == other.agent_id
            && self.key_id == other.key_id
            && self.runtime_revision == other.runtime_revision
            && self.tunnel_ipv4 == other.tunnel_ipv4
    }
}
pub struct Material {
    egress_private: [u8; 32],
    runtime_public: [u8; 32],
    preshared: [u8; 32],
}
impl Drop for Material {
    fn drop(&mut self) {
        self.egress_private.zeroize();
        self.preshared.zeroize();
    }
}
impl Material {
    pub fn matches(&self, input: &Registration) -> Result<bool, Error> {
        let other = input.material()?;
        Ok(bool::from(
            self.egress_private.ct_eq(&other.egress_private)
                & self.runtime_public.ct_eq(&other.runtime_public)
                & self.preshared.ct_eq(&other.preshared),
        ))
    }
    pub fn peer(&self, key_id: KeyId) -> Peer {
        Peer::new(
            key_id,
            self.egress_private,
            self.runtime_public,
            self.preshared,
        )
    }
}
pub struct KeyBox {
    cipher: ChaCha20Poly1305,
}
impl KeyBox {
    pub fn new(mut key: [u8; 32]) -> Self {
        let cipher = ChaCha20Poly1305::new((&key).into());
        key.zeroize();
        Self { cipher }
    }
    pub fn load(path: &str) -> Result<Self, Error> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| Error)?;
        let stat = file.metadata().map_err(|_| Error)?;
        if !stat.is_file()
            || stat.uid() != 0
            || stat.gid() != 0
            || stat.mode() & 0o7777 != 0o600
            || stat.len() != 32
        {
            return Err(Error);
        }
        let mut raw = Zeroizing::new(Vec::new());
        file.take(33).read_to_end(&mut raw).map_err(|_| Error)?;
        if raw.len() != 32 || raw.iter().all(|b| *b == 0) {
            return Err(Error);
        }
        Ok(Self::new(raw.as_slice().try_into().map_err(|_| Error)?))
    }
    pub fn seal(&self, agent_id: AgentId, input: &Registration) -> Result<PreparedKey, Error> {
        input.validate()?;
        let material = input.material()?;
        let mut raw = Zeroizing::new(Vec::with_capacity(96));
        raw.extend_from_slice(&material.egress_private);
        raw.extend_from_slice(&material.runtime_public);
        raw.extend_from_slice(&material.preshared);
        let mut nonce = vec![0; 12];
        OsRng.fill_bytes(&mut nonce);
        let mut row = PreparedKey {
            agent_id,
            key_id: KeyId::parse(&input.key_id).map_err(|_| Error)?,
            runtime_revision: input.runtime_revision.clone(),
            tunnel_ipv4: input.tunnel_ipv4,
            nonce,
            sealed: Vec::new(),
        };
        row.sealed = self
            .cipher
            .encrypt(
                row.nonce.as_slice().into(),
                Payload {
                    msg: &raw,
                    aad: &row.aad(),
                },
            )
            .map_err(|_| Error)?;
        Ok(row)
    }
    pub fn open(&self, row: &PreparedKey) -> Result<Material, Error> {
        if row.nonce.len() != 12 || row.sealed.len() != 112 {
            return Err(Error);
        }
        let raw = Zeroizing::new(
            self.cipher
                .decrypt(
                    row.nonce.as_slice().into(),
                    Payload {
                        msg: &row.sealed,
                        aad: &row.aad(),
                    },
                )
                .map_err(|_| Error)?,
        );
        if raw.len() != 96 {
            return Err(Error);
        }
        Ok(Material {
            egress_private: raw[..32].try_into().map_err(|_| Error)?,
            runtime_public: raw[32..64].try_into().map_err(|_| Error)?,
            preshared: raw[64..].try_into().map_err(|_| Error)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::AgentId;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    fn storage_key() -> [u8; 32] {
        std::array::from_fn(|_| OsRng.next_u32() as u8)
    }

    fn registration() -> Registration {
        serde_json::from_value(serde_json::json!({"key_id":"rtk_0102030405060708090a0b0c0d0e0f10","runtime_revision":"rtv_0102030405060708090a0b0c0d0e0f10","tunnel_ipv4":"100.96.0.2","egress_private_key":URL_SAFE_NO_PAD.encode([29;32]),"runtime_public_key":URL_SAFE_NO_PAD.encode(antnest_runtime_tunnel::Peer::public_key([11;32])),"preshared_key":URL_SAFE_NO_PAD.encode([53;32])})).unwrap()
    }
    #[test]
    fn generation_material_is_sealed_authenticated_and_redacted() {
        let master = storage_key();
        let vault = KeyBox::new(master);
        let input = registration();
        let agent = AgentId::parse("agent_a").unwrap();
        let row = vault.seal(agent.clone(), &input).unwrap();
        let opened = vault.open(&row).unwrap();
        assert!(opened.matches(&input).unwrap());
        let visible = serde_json::to_string(&input).unwrap();
        assert!(!visible.contains(&input.egress_private_key));
        assert!(!visible.contains(&input.preshared_key));
        assert!(!row.sealed.windows(32).any(|w| w == [29; 32]));
        let mut altered = row.clone();
        altered.agent_id = AgentId::parse("agent_b").unwrap();
        assert!(vault.open(&altered).is_err());
        let mut altered = row.clone();
        altered.runtime_revision = "rtv_00000000000000000000000000000000".into();
        assert!(vault.open(&altered).is_err());
        let restarted = KeyBox::new(master);
        assert!(restarted.open(&row).unwrap().matches(&input).unwrap());
        assert!(KeyBox::new(storage_key()).open(&row).is_err());
    }
    #[test]
    fn invalid_key_material_never_creates_a_context() {
        let vault = KeyBox::new(storage_key());
        let mut input = registration();
        input.preshared_key = URL_SAFE_NO_PAD.encode([0; 32]);
        assert!(
            vault
                .seal(AgentId::parse("agent_a").unwrap(), &input)
                .is_err()
        );
    }
}
