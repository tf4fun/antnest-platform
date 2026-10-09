//! Runtime Egress domain and adapters.
//!
//! This crate is an implementation boundary for the service binary and its
//! black-box integration tests, not a client SDK. The only cross-service APIs
//! are the language-neutral control and packet contracts under `contracts/`;
//! another service must not add a Rust path dependency on these modules.

pub mod allocator;
pub mod application;
pub mod config;
pub mod control;
pub mod dataplane;
pub mod dns;
pub mod domain;
pub mod flow;
pub mod kernel;
pub mod network;
pub mod packet;
pub mod policy;
pub mod privilege;
pub mod repository;
pub mod service_auth;
pub mod telemetry;
pub mod transport;
pub mod tunnel;
