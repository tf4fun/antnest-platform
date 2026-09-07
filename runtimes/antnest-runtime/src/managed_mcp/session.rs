use futures_util::{StreamExt as _, future};
use rmcp::{
    RoleClient,
    service::{RunningService, RxJsonRpcMessage, TxJsonRpcMessage},
    transport::async_rw::JsonRpcMessageCodec,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::{
    codec::{FramedRead, FramedWrite},
    sync::CancellationToken,
};

const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

pub(crate) async fn connect(
    read: impl AsyncRead + Unpin + Send + 'static,
    write: impl AsyncWrite + Unpin + Send + 'static,
    cancel: CancellationToken,
) -> Result<RunningService<RoleClient, ()>, &'static str> {
    // Use the SDK codec and transport with an explicit frame limit. Invalid or
    // oversized child output closes the connection rather than buffering forever.
    let read = FramedRead::new(
        read,
        JsonRpcMessageCodec::<RxJsonRpcMessage<RoleClient>>::new_with_max_length(MAX_MESSAGE_BYTES),
    )
    .take_while(|message| future::ready(message.is_ok()))
    .filter_map(|message| future::ready(message.ok()));
    let write = FramedWrite::new(
        write,
        JsonRpcMessageCodec::<TxJsonRpcMessage<RoleClient>>::new_with_max_length(MAX_MESSAGE_BYTES),
    );
    rmcp::service::serve_client_with_ct((), (write, read), cancel)
        .await
        .map_err(|_| "managed MCP initialization failed")
}
