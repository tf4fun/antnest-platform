use std::{collections::HashSet, net::Ipv4Addr};

use ipnet::Ipv4Net;
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AddressPool {
    id: String,
    network: Ipv4Net,
    resolver: Ipv4Addr,
    next_slot: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Selection {
    pub address: Ipv4Addr,
    pub next_slot: u32,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum AllocationError {
    #[error("address pool identifier must not be empty")]
    EmptyPoolId,
    #[error("address pool must contain at least two usable addresses")]
    PoolTooSmall,
    #[error("resolver must be a usable address inside the pool")]
    InvalidResolver,
    #[error("address pool is exhausted")]
    Exhausted,
}

impl AddressPool {
    pub fn new(
        id: impl Into<String>,
        network: Ipv4Net,
        resolver: Ipv4Addr,
        next_slot: u32,
    ) -> Result<Self, AllocationError> {
        let id = id.into();
        if id.is_empty() {
            return Err(AllocationError::EmptyPoolId);
        }
        let last_slot = u32::from(network.broadcast()) - u32::from(network.network());
        if last_slot < 3 {
            return Err(AllocationError::PoolTooSmall);
        }
        let resolver_slot = u32::from(resolver).wrapping_sub(u32::from(network.network()));
        if resolver_slot == 0 || resolver_slot >= last_slot || !network.contains(&resolver) {
            return Err(AllocationError::InvalidResolver);
        }
        let next_slot = normalize_slot(next_slot, last_slot);
        Ok(Self {
            id,
            network,
            resolver,
            next_slot,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn network(&self) -> Ipv4Net {
        self.network
    }

    pub fn resolver(&self) -> Ipv4Addr {
        self.resolver
    }

    pub fn next_slot(&self) -> u32 {
        self.next_slot
    }

    pub fn select(&self, unavailable: &HashSet<Ipv4Addr>) -> Result<Selection, AllocationError> {
        let network = u32::from(self.network.network());
        let last_slot = u32::from(self.network.broadcast()) - network;
        let candidates = last_slot - 1;

        for offset in 0..candidates {
            let slot = 1 + ((self.next_slot - 1 + offset) % candidates);
            let address = Ipv4Addr::from(network + slot);
            if address == self.resolver || unavailable.contains(&address) {
                continue;
            }
            return Ok(Selection {
                address,
                next_slot: normalize_slot(slot + 1, last_slot),
            });
        }
        Err(AllocationError::Exhausted)
    }
}

fn normalize_slot(slot: u32, last_slot: u32) -> u32 {
    if slot == 0 || slot >= last_slot {
        1
    } else {
        slot
    }
}
