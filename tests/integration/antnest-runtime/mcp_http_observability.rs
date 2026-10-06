#[cfg(target_os = "linux")]
#[tokio::test(flavor = "current_thread")]
async fn successful_mcp_result_then_client_close_before_eof_is_not_an_error() {
    // Hold the response open after its first SSE frame so EOF cannot win the
    // race against the client's close. The real SDK handler and HTTP observer
    // still own dispatch, result classification and body-drop observation.
    struct HoldAfterFirstFrame {
        body: Pin<Box<Body>>,
        sent: bool,
    }
    impl HttpBody for HoldAfterFirstFrame {
        type Data = Bytes;
        type Error = axum::Error;
        fn poll_frame(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
            if self.sent {
                return Poll::Pending;
            }
            let frame = self.body.as_mut().poll_frame(cx);
            if matches!(frame, Poll::Ready(Some(Ok(_)))) {
                self.sent = true;
            }
            frame
        }
    }
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("mcp-close-component")));
    crate::test_tracing::stabilize_callsite_registry();
    let _guard = tracing::subscriber::set_default(subscriber);
    let workspace = tempfile::tempdir().unwrap();
    let skills = tempfile::tempdir().unwrap();
    let roots = Arc::new(NamedRoots::open(workspace.path(), skills.path()).unwrap());
    let status =
        RuntimeStatus::with_execution_id(RuntimeIdentity::new("test", 1).unwrap(), "execution-1");
    let state = HttpState {
        status: status.clone(),
        metrics: RuntimeMetrics::default(),
        managed: Catalog::default(),
    };
    let tools = RuntimeToolServer::new(
        ToolBackend::InProcess(ToolEngine::new(roots)),
        status,
        state.metrics.clone(),
        state.managed.clone(),
    );
    let shutdown = CancellationToken::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let service: StreamableHttpService<ObservedRuntime, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(ObservedRuntime(tools.clone())),
            Default::default(),
            StreamableHttpServerConfig::default()
                .with_allowed_hosts([address.to_string(), format!("localhost:{}", address.port())])
                .with_legacy_session_mode(false)
                .with_stateless_protocol_metadata_required(true)
                .with_cancellation_token(shutdown.child_token()),
        );
    let router = Router::new()
        .nest_service(MCP_PATH, service)
        .layer(middleware::from_fn_with_state(state, trace_http_request))
        .layer(middleware::from_fn(
            |request: Request, next: Next| async move {
                next.run(request).await.map(|body| {
                    Body::new(HoldAfterFirstFrame {
                        body: Box::pin(body),
                        sent: false,
                    })
                })
            },
        ));
    let stopped = shutdown.clone();
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(stopped.cancelled_owned())
            .await
    });
    let client = reqwest::Client::new();
    let mut response = client.post(format!("http://{address}/mcp"))
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2026-07-28")
        .header("mcp-method", "tools/list")
        .header(EXPECTED_EXECUTION_HEADER, "execution-1")
        .json(&json!({"jsonrpc":"2.0", "id":1, "method":"tools/list", "params":{"_meta":{
            "io.modelcontextprotocol/protocolVersion":"2026-07-28", "io.modelcontextprotocol/clientCapabilities":{}}}}))
        .send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let frame = response.chunk().await.unwrap().unwrap();
    let frame = std::str::from_utf8(&frame).unwrap();
    assert!(frame.contains("\"tools\""), "{frame}");
    drop(response);
    drop(client);
    let closed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(http) = exporter
                .get_finished_spans()
                .unwrap()
                .into_iter()
                .find(|s| s.name == "HTTP POST /mcp")
            {
                break http;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    shutdown.cancel();
    task.abort();
    let _ = task.await;
    let http = closed.expect("HTTP response dropped after client close");
    assert!(http.events.iter().any(|e| e.name == "antnest.cancelled"));
    assert!(!http.events.iter().any(|e| e.name == "antnest.error"));
    assert!(!matches!(
        http.status,
        opentelemetry::trace::Status::Error { .. }
    ));
    assert!(
        http.attributes
            .iter()
            .any(|a| a.key.as_str() == "antnest.protocol.outcome" && a.value.as_str() == "success")
    );
    assert!(
        http.attributes
            .iter()
            .any(|a| a.key.as_str() == "http.transport.outcome" && a.value.as_str() == "canceled")
    );
    provider.shutdown().unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "current_thread")]
async fn real_http_health_and_mcp_keep_exact_client_parent_and_rpc_values() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::registry().with(
        tracing_opentelemetry::layer()
            .with_tracer(provider.tracer("runtime-boundary-test"))
            .with_filter(tracing_subscriber::filter::filter_fn(
                crate::telemetry::is_runtime_trace,
            )),
    );
    crate::test_tracing::stabilize_callsite_registry();
    let _guard = tracing::subscriber::set_default(subscriber);
    let workspace = tempfile::tempdir().unwrap();
    let skills = tempfile::tempdir().unwrap();
    let roots = Arc::new(NamedRoots::open(workspace.path(), skills.path()).unwrap());
    let mut server = RuntimeHttp::new_in_process(
        RuntimeStatus::with_execution_id(
            RuntimeIdentity::new("agent-test", 7).unwrap(),
            "execution-7",
        ),
        roots,
    );
    server.metrics = server.metrics.with_rpc_content(true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let shutdown = CancellationToken::new();
    let task = tokio::spawn(server.serve(listener, shutdown.clone()));
    let client = reqwest::Client::new();
    let caller = tracing::info_span!("caller", otel.kind = "client");
    let context = caller.context();
    let span_context = context.span().span_context().clone();
    let traceparent = format!(
        "00-{}-{}-01",
        span_context.trace_id(),
        span_context.span_id()
    );
    let response = client
        .get(format!("http://{address}/status?token=QUERY_CANARY"))
        .header(
            crate::service_auth::SERVICE_HEADER,
            crate::service_auth::test_header(),
        )
        .header("traceparent", &traceparent)
        .header("cookie", "COOKIE_CANARY")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["execution_id"],
        "execution-7"
    );
    let response = client.post(format!("http://{address}/mcp"))
        .header(crate::service_auth::SERVICE_HEADER, crate::service_auth::test_header())
        .header("traceparent", &traceparent)
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2026-07-28")
        .header("mcp-method", "tools/call")
        .header("mcp-name", "read")
        .header(EXPECTED_EXECUTION_HEADER, "execution-7")
        .json(&json!({"jsonrpc":"2.0", "id": 9, "method":"tools/call", "params": {
            "name":"read", "arguments":{"path": "missing-file", "offset": 1, "limit":23},
            "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28", "io.modelcontextprotocol/clientCapabilities":{}, "io.modelcontextprotocol/clientInfo":{"name":"test", "version":"1"}}
        }})).send().await.unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("isError"), "{body}");
    shutdown.cancel();
    task.await.unwrap().unwrap();
    drop(caller);
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    for name in ["HTTP GET /status", "HTTP POST /mcp"] {
        let span = spans.iter().find(|span| span.name == name).unwrap();
        assert_eq!(span.parent_span_id, span_context.span_id());
        assert_eq!(span.span_context.trace_id(), span_context.trace_id());
        assert_eq!(span.span_kind, opentelemetry::trace::SpanKind::Server);
    }
    let http = spans
        .iter()
        .find(|span| span.name == "HTTP POST /mcp")
        .unwrap();
    let operation = spans
        .iter()
        .find(|span| span.name == "runtime.mcp.operation")
        .unwrap();
    assert_eq!(operation.parent_span_id, http.span_context.span_id());
    assert!(matches!(
        operation.status,
        opentelemetry::trace::Status::Error { .. }
    ));
    assert!(matches!(
        http.status,
        opentelemetry::trace::Status::Error { .. }
    ));
    let request = operation
        .events
        .iter()
        .find(|event| event.name == "antnest.request")
        .unwrap();
    let payload = request
        .attributes
        .iter()
        .find(|attribute| attribute.key.as_str() == "antnest.payload.json")
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload.value.as_str()).unwrap();
    assert_eq!(payload["params"]["arguments"]["path"], "missing-file");
    assert_eq!(payload["params"]["arguments"]["limit"], 23);
    let response = operation
        .events
        .iter()
        .find(|event| event.name == "antnest.response")
        .unwrap();
    let payload = response
        .attributes
        .iter()
        .find(|attribute| attribute.key.as_str() == "antnest.payload.json")
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload.value.as_str()).unwrap();
    assert_eq!(payload["isError"], true);
    assert_eq!(
        spans
            .iter()
            .filter(|span| span.name == "runtime.mcp.operation")
            .count(),
        1
    );
    assert!(!format!("{spans:?}").contains("CANARY"));
    assert!(
        !format!("{spans:?}").contains(crate::service_auth::test_token()),
        "instance bearer must stay absent even when RPC content capture is enabled"
    );
    assert!(
        !http
            .events
            .iter()
            .any(|event| event.name.starts_with("antnest.request")
                || event.name.starts_with("antnest.response"))
    );
    let status = spans
        .iter()
        .find(|span| span.name == "HTTP GET /status")
        .unwrap();
    assert!(!status.events.iter().any(|event| {
        event.name == "antnest.request"
            || event.name == "antnest.response"
            || event
                .attributes
                .iter()
                .any(|attribute| attribute.key.as_str().starts_with("antnest.payload."))
    }));
    assert!(
        !status
            .attributes
            .iter()
            .any(|attribute| attribute.key.as_str().contains(".header."))
    );
    provider.shutdown().unwrap();
}
