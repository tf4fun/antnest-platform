use std::{collections::HashSet, net::Ipv4Addr};

use antnest_runtime_egress::allocator::{AddressPool, AllocationError};

fn tiny_pool(next_slot: u32) -> AddressPool {
    AddressPool::new(
        "tiny",
        "100.64.0.0/29".parse().expect("CIDR"),
        "100.64.0.1".parse().expect("resolver"),
        next_slot,
    )
    .expect("pool")
}

#[test]
fn allocator_skips_gateway_active_and_quarantined_slots() {
    let pool = tiny_pool(1);
    let unavailable = HashSet::from([
        "100.64.0.2".parse::<Ipv4Addr>().unwrap(),
        "100.64.0.3".parse::<Ipv4Addr>().unwrap(),
    ]);

    let selected = pool.select(&unavailable).expect("available address");

    assert_eq!(selected.address, "100.64.0.4".parse::<Ipv4Addr>().unwrap());
    assert_eq!(selected.next_slot, 5);
}

#[test]
fn allocator_wraps_like_a_pid_allocator() {
    let pool = tiny_pool(6);
    let unavailable = HashSet::from(["100.64.0.6".parse::<Ipv4Addr>().unwrap()]);

    let selected = pool.select(&unavailable).expect("wrapped address");

    assert_eq!(selected.address, "100.64.0.2".parse::<Ipv4Addr>().unwrap());
    assert_eq!(selected.next_slot, 3);
}

#[test]
fn allocator_reports_exhaustion_without_returning_reserved_addresses() {
    let pool = tiny_pool(2);
    let unavailable = (2..=6)
        .map(|last| Ipv4Addr::new(100, 64, 0, last))
        .collect();

    assert_eq!(pool.select(&unavailable), Err(AllocationError::Exhausted));
}
