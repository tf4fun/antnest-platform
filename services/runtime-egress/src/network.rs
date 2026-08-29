use std::{
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use thiserror::Error;
use tokio::{net::UdpSocket, sync::Mutex as AsyncMutex, time::timeout};
use tokio_util::sync::CancellationToken;

use crate::dataplane::{DataPlaneAction, DataPlaneEngine};

#[derive(Debug, Error)]
pub enum NetworkError {
    #[error("UDP transport failed: {0}")]
    Udp(io::Error),
    #[error("TUN transport failed: {0}")]
    Tun(io::Error),
    #[error("packet output timed out")]
    OutputTimeout,
    #[error("data-plane state is poisoned")]
    Poisoned,
    #[error("TUN device reached end of file")]
    TunClosed,
}

#[async_trait]
pub trait PacketDevice: Send + 'static {
    async fn read_packet(&mut self, buffer: &mut [u8]) -> io::Result<usize>;
    async fn write_packet(&mut self, packet: &[u8]) -> io::Result<()>;
}

pub async fn run_packet_loop<T>(
    udp: UdpSocket,
    mut tun: T,
    engine: Arc<Mutex<DataPlaneEngine>>,
    output_barrier: Arc<AsyncMutex<()>>,
    inner_mtu: usize,
    output_timeout: Duration,
    cancellation: CancellationToken,
) -> Result<(), NetworkError>
where
    T: PacketDevice,
{
    let mut udp_buffer = vec![0_u8; inner_mtu + 1];
    let mut tun_buffer = vec![0_u8; inner_mtu + 1];

    loop {
        tokio::select! {
            () = cancellation.cancelled() => return Ok(()),
            received = udp.recv_from(&mut udp_buffer) => {
                let (length, peer) = received.map_err(NetworkError::Udp)?;
                let packet = &udp_buffer[..length];
                let _output = output_barrier.lock().await;
                let action = engine
                    .lock()
                    .map_err(|_| NetworkError::Poisoned)?
                    .handle_uplink(packet, peer, Instant::now());
                execute(action, &udp, &mut tun, output_timeout).await?;
            }
            read = tun.read_packet(&mut tun_buffer) => {
                let length = read.map_err(NetworkError::Tun)?;
                if length == 0 {
                    return Err(NetworkError::TunClosed);
                }
                let packet = &tun_buffer[..length];
                let _output = output_barrier.lock().await;
                let action = engine
                    .lock()
                    .map_err(|_| NetworkError::Poisoned)?
                    .handle_downlink(packet, Instant::now());
                execute(action, &udp, &mut tun, output_timeout).await?;
            }
        }
    }
}

async fn execute<W>(
    action: DataPlaneAction,
    udp: &UdpSocket,
    tun_writer: &mut W,
    deadline: Duration,
) -> Result<(), NetworkError>
where
    W: PacketDevice,
{
    match action {
        DataPlaneAction::WriteTun(packet) => timeout(deadline, tun_writer.write_packet(&packet))
            .await
            .map_err(|_| NetworkError::OutputTimeout)?
            .map_err(NetworkError::Tun),
        DataPlaneAction::SendUdp { peer, packet } => timeout(deadline, udp.send_to(&packet, peer))
            .await
            .map_err(|_| NetworkError::OutputTimeout)?
            .map(|_| ())
            .map_err(NetworkError::Udp),
        DataPlaneAction::Drop(_) => Ok(()),
    }
}
