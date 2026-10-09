//! Shared routing prefix and WireGuard engine. Lifecycle, storage and policy
//! remain owned by callers. No private material implements Debug/serialization.
use boringtun::{
    noise::{Tunn, TunnResult, errors::WireGuardError},
    x25519,
};
use rand_core::{OsRng, RngCore};
use std::{fmt, net::IpAddr};
use zeroize::Zeroize;

pub const REVISION: u32 = 2;
pub const INNER_MTU: usize = 1400;
pub const PREFIX_BYTES: usize = 20;
pub const MAX_DATAGRAM: usize = INNER_MTU + 67;
pub const TIMER_MILLIS: u64 = 250;
const MAGIC: &[u8; 4] = b"ANT2";
const MAX_DRAIN: usize = 257;

#[derive(Clone, Copy, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct KeyId([u8; 16]);

impl KeyId {
    pub fn parse(value: &str) -> Result<Self, Error> {
        if value.len() != 36 || !value.starts_with("rtk_") {
            return Err(Error::Invalid);
        }
        let mut bytes = [0; 16];
        for (i, pair) in value.as_bytes()[4..].as_chunks::<2>().0.iter().enumerate() {
            let digit = |b| match b {
                b'0'..=b'9' => Ok(b - b'0'),
                b'a'..=b'f' => Ok(b - b'a' + 10),
                _ => Err(Error::Invalid),
            };
            bytes[i] = (digit(pair[0])? << 4) | digit(pair[1])?;
        }
        Ok(Self(bytes))
    }
    pub fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }
    pub fn bytes(self) -> [u8; 16] {
        self.0
    }
}
impl fmt::Display for KeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("rtk_")?;
        for b in self.0 {
            write!(f, "{b:02x}")?;
        }
        Ok(())
    }
}
impl fmt::Debug for KeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Error {
    Invalid,
    WrongContext,
    Authentication,
    Replay,
    Expired,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "invalid_tunnel_packet",
            Self::WrongContext => "tunnel_context_mismatch",
            Self::Authentication => "tunnel_authentication_failed",
            Self::Replay => "tunnel_replay_rejected",
            Self::Expired => "tunnel_session_expired",
        })
    }
}
impl std::error::Error for Error {}

pub enum Event {
    Network(Vec<u8>),
    Ipv4(Vec<u8>),
}

pub fn datagram_key_id(packet: &[u8]) -> Result<KeyId, Error> {
    if packet.len() < PREFIX_BYTES + 4 || packet.len() > MAX_DATAGRAM || &packet[..4] != MAGIC {
        return Err(Error::Invalid);
    }
    Ok(KeyId(
        packet[4..PREFIX_BYTES]
            .try_into()
            .map_err(|_| Error::Invalid)?,
    ))
}

pub struct Peer {
    key_id: KeyId,
    engine: Tunn,
}

impl Peer {
    pub fn public_key(mut private: [u8; 32]) -> [u8; 32] {
        let secret = x25519::StaticSecret::from(private);
        private.zeroize();
        x25519::PublicKey::from(&secret).to_bytes()
    }
    pub fn new(key_id: KeyId, mut private: [u8; 32], public: [u8; 32], mut psk: [u8; 32]) -> Self {
        let engine = Tunn::new(
            x25519::StaticSecret::from(private),
            x25519::PublicKey::from(public),
            Some(psk),
            Some(10),
            OsRng.next_u32() & 0x00ff_ffff,
            None,
        );
        private.zeroize();
        psk.zeroize();
        Self { key_id, engine }
    }
    pub fn key_id(&self) -> KeyId {
        self.key_id
    }
    fn output(key_id: KeyId, result: TunnResult<'_>) -> Result<Option<Event>, Error> {
        match result {
            TunnResult::Done => Ok(None),
            TunnResult::Err(e) => Err(classify(e)),
            TunnResult::WriteToNetwork(bytes) => {
                if bytes.len() + PREFIX_BYTES > MAX_DATAGRAM {
                    return Err(Error::Invalid);
                }
                let mut out = Vec::with_capacity(PREFIX_BYTES + bytes.len());
                out.extend_from_slice(MAGIC);
                out.extend_from_slice(&key_id.0);
                out.extend_from_slice(bytes);
                Ok(Some(Event::Network(out)))
            }
            TunnResult::WriteToTunnelV4(bytes, _) => {
                if bytes.len() > INNER_MTU {
                    return Err(Error::Invalid);
                }
                Ok(Some(Event::Ipv4(bytes.to_vec())))
            }
            TunnResult::WriteToTunnelV6(_, _) => Err(Error::Invalid),
        }
    }
    pub fn send(&mut self, inner: &[u8]) -> Result<Vec<Event>, Error> {
        if inner.is_empty() || inner.len() > INNER_MTU || inner[0] >> 4 != 4 {
            return Err(Error::Invalid);
        }
        let mut buf = [0; MAX_DATAGRAM];
        Ok(
            Self::output(self.key_id, self.engine.encapsulate(inner, &mut buf))?
                .into_iter()
                .collect(),
        )
    }
    pub fn receive(&mut self, packet: &[u8], source: IpAddr) -> Result<Vec<Event>, Error> {
        if datagram_key_id(packet)? != self.key_id {
            return Err(Error::WrongContext);
        }
        let mut buf = [0; MAX_DATAGRAM];
        let mut output = Vec::new();
        if let Some(event) = Self::output(
            self.key_id,
            self.engine
                .decapsulate(Some(source), &packet[PREFIX_BYTES..], &mut buf),
        )? {
            output.push(event);
        } else {
            return Ok(output);
        }
        // BoringTun requires draining its bounded packet queue after network output.
        // Empty input does not verify or consume another received packet.
        for _ in 0..MAX_DRAIN {
            match Self::output(self.key_id, self.engine.decapsulate(None, &[], &mut buf))? {
                Some(event) => output.push(event),
                None => return Ok(output),
            }
        }
        Err(Error::Invalid)
    }
    pub fn tick(&mut self) -> Result<Vec<Event>, Error> {
        let mut buf = [0; MAX_DATAGRAM];
        Ok(
            Self::output(self.key_id, self.engine.update_timers(&mut buf))?
                .into_iter()
                .collect(),
        )
    }
}

fn classify(error: WireGuardError) -> Error {
    match error {
        WireGuardError::DuplicateCounter | WireGuardError::InvalidCounter => Error::Replay,
        WireGuardError::InvalidPacket
        | WireGuardError::WrongPacketType
        | WireGuardError::UnexpectedPacket => Error::Invalid,
        WireGuardError::ConnectionExpired => Error::Expired,
        _ => Error::Authentication,
    }
}
