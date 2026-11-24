//! Kind-backed integration checks for the real command layer.
//!
//! These tests are `#[ignore]` by default. They run the same building blocks the Tauri
//! commands use — kubeconfig discovery, the client pool, API discovery, dynamic lists,
//! Secret masking and the watch accumulator — against a disposable cluster.
//!
//! Gate: `KUBIX_KIND_CONTEXT` names the context to use (default `kind-kubix-dev`).
//! When the variable is set the tests **fail** rather than skip if the cluster is
//! unreachable: a green run must mean the cluster was actually exercised.
//!
//!   ./scripts/create-kind-cluster.sh
//!   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored

use std::collections::BTreeSet;
use std::time::Duration;

use kubix_lib::cluster::ClusterManager;
use kubix_lib::config;
use kubix_lib::discovery::{self, ApiResourceEntry};
use kubix_lib::ipc::dto::{gvr_string, ClusterContextDto, ConnectionState};
use kubix_lib::watch::{DeltaAccumulator, WatchBudget, WatchEvent};

const DEFAULT_CONTEXT: &str = "kind-kubix-dev";
const DEMO_NAMESPACE: &str = "kubix-demo";

fn context_name() -> String {
    std::env::var("KUBIX_KIND_CONTEXT").unwrap_or_else(|_| DEFAULT_CONTEXT.to_string())
}

/// Build a manager pointed at the kind context, or fail with an actionable message.
async fn manager_for_kind() -> (ClusterManager, String) {
    let context = context_name();
    let discovery =
        config::discover_from_env().expect("kubeconfig must be readable to run the kind suite");

    let descriptor = discovery
        .contexts
        .iter()
        .find(|c| c.id == context)
        .unwrap_or_else(|| {
            panic!(
                "KUBIX_KIND_CONTEXT={context} is not in the kubeconfig ({}). \
                 Run ./scripts/create-kind-cluster.sh first.",
                discovery
                    .sources
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .clone();
    assert!(
        !descriptor.server.is_empty(),
        "kind context '{context}' has no API server; the cluster is probably gone"
    );

    let mut merged = kube::config::Kubeconfig::default();
    for path in &discovery.sources {
        let loaded = kube::config::Kubeconfig::read_from(path).expect("kubeconfig parses");
        merged.clusters.extend(loaded.clusters);
        merged.contexts.extend(loaded.contexts);
        merged.auth_infos.extend(loaded.auth_infos);
        merged.current_context = merged.current_context.or(loaded.current_context);
    }

    let manager = ClusterManager::new();
    manager.load(discovery.contexts, merged).await;
    (manager, context)
}

async fn connected() -> (ClusterManager, String, kube::Client) {
    let (manager, context) = manager_for_kind().await;
    let dto = manager
        .connect(&context)
        .await
        .unwrap_or_else(|e| panic!("kind context '{context}' must connect: {e}"));
    assert_eq!(
        dto.state,
        ConnectionState::Ready,
        "kind context '{context}' is not ready: {:?}",
        dto.last_error
    );
    let client = manager.client(&context).await.expect("connected client");
    (manager, context, client)
}

async fn discover_entries(client: kube::Client) -> Vec<ApiResourceEntry> {
    let lists = kube::discovery::Discovery::new(client)
        .run()
        .await
        .expect("API discovery must succeed against kind");

    let mut entries = Vec::new();
    for group in lists.groups() {
        for version in group.versions() {
            for (resource, caps) in group.versioned_resources(version) {
                entries.push(ApiResourceEntry {
                    group: resource.group.clone(),
                    version: resource.version.clone(),
                    plural: resource.plural.clone(),
                    kind: resource.kind.clone(),
                    namespaced: caps.scope == kube::discovery::Scope::Namespaced,
                    short_names: Vec::new(),
                    verbs: caps.operations.clone(),
                });
            }
        }
    }
    entries
}

// ---- tests -------------------------------------------------------------------

/// Listing contexts must never touch the network or spawn an auth plugin.
#[tokio::test]
#[ignore = "requires a kind cluster"]
async fn contexts_are_listed_without_network() {
    let context = context_name();
    let discovery = config::discover_from_env().expect("kubeconfig readable");
    let descriptor = discovery
        .contexts
        .iter()
        .find(|c| c.id == context)
        .expect("kind context present in kubeconfig");

    let dto = ClusterContextDto::from_descriptor(descriptor, ConnectionState::Disconnected);
    assert_eq!(dto.state, ConnectionState::Disconnected);
    assert!(
        !dto.server.is_empty() && !dto.server.contains('@'),
        "server must be host:port without userinfo, got '{}'",
        dto.server
    );
    assert!(
        !serde_json::to_string(&dto).unwrap().contains("LS0t"),
        "context DTO must not carry certificate material"
    );
    // The kind context is client-cert based; if this fails the fixture changed.
    assert_eq!(dto.auth_kind, config::AuthKind::ClientCert);
}

#[tokio::test]
#[ignore = "requires a kind cluster"]
async fn connect_reaches_ready() {
    let (manager, context, _client) = connected().await;
    assert_eq!(manager.state(&context).await, Some(ConnectionState::Ready));
}

#[tokio::test]
#[ignore = "requires a kind cluster"]
async fn discovery_includes_curated_kinds() {
    let (_manager, _context, client) = connected().await;
    let entries = discover_entries(client).await;
    let normalized = discovery::normalize(entries);

    let served: BTreeSet<_> = normalized.iter().map(|r| r.gvr.clone()).collect();
    for expected in [
        gvr_string("", "v1", "pods"),
        gvr_string("", "v1", "services"),
        gvr_string("", "v1", "secrets"),
        gvr_string("apps", "v1", "deployments"),
    ] {
        assert!(
            served.contains(&expected),
            "{expected} missing from discovery"
        );
    }
    assert!(
        normalized.iter().filter(|r| r.curated).count() >= 8,
        "most curated kinds should exist on a fresh kind cluster"
    );
    assert!(
        normalized.iter().all(|r| !r.kind.is_empty()),
        "every discovered resource needs a kind"
    );
}

#[tokio::test]
#[ignore = "requires a kind cluster"]
async fn listing_pods_in_namespace_returns_seeded_rows() {
    let (_manager, _context, client) = connected().await;
    let entries = discover_entries(client.clone()).await;
    let pods = discovery::find_gvr(&entries, &gvr_string("", "v1", "pods")).expect("pods served");

    let api: kube::Api<kube::core::DynamicObject> =
        kube::Api::namespaced_with(client, DEMO_NAMESPACE, &pods.api_resource());
    let list = api
        .list(&Default::default())
        .await
        .expect("listing pods works");

    let rows: Vec<_> = list
        .items
        .iter()
        .filter_map(|obj| kubix_lib::watch::summarize(obj, &pods.kind))
        .collect();

    assert!(!rows.is_empty(), "the kind seed should create pods");
    assert!(
        rows.iter()
            .all(|r| r.namespace.as_deref() == Some(DEMO_NAMESPACE)),
        "namespace-scoped list must not leak other namespaces"
    );
    assert!(rows.iter().all(|r| r.kind == "Pod"));
}

#[tokio::test]
#[ignore = "requires a kind cluster"]
async fn secret_get_returns_masked_payload() {
    let (_manager, _context, client) = connected().await;
    let entries = discover_entries(client.clone()).await;
    let secrets =
        discovery::find_gvr(&entries, &gvr_string("", "v1", "secrets")).expect("secrets served");

    let api: kube::Api<kube::core::DynamicObject> =
        kube::Api::namespaced_with(client, DEMO_NAMESPACE, &secrets.api_resource());
    let obj = api
        .get("kubix-demo-secret")
        .await
        .expect("seeded secret exists");

    // Prefer the actual command-layer function so this test cannot drift from production.
    let masked = kubix_lib::app::mask_secrets(&gvr_string("", "v1", "secrets"), obj.data.clone());

    let before = serde_json::to_string(&obj.data).unwrap();
    assert!(
        before.contains("super-secret-value") || before.contains("c3VwZXItc2VjcmV0LXZhbHVl"),
        "fixture must contain the seeded secret value for this test to mean anything"
    );

    let (masked_doc, masked_paths) = masked;
    let after = serde_json::to_string(&masked_doc).unwrap();
    assert!(!masked_paths.is_empty(), "masking must report what it hid");
    assert!(
        !after.contains("super-secret-value") && !after.contains("c3VwZXItc2VjcmV0LXZhbHVl"),
        "raw secret material must not survive masking: {after}"
    );
    assert!(
        after.contains(kubix_lib::app::SECRET_MASK),
        "masked values should be replaced by the documented placeholder"
    );
}

#[tokio::test]
#[ignore = "requires a kind cluster"]
async fn watch_snapshot_then_restart_yields_full_set() {
    let (_manager, _context, client) = connected().await;
    let entries = discover_entries(client.clone()).await;
    let pods = discovery::find_gvr(&entries, &gvr_string("", "v1", "pods")).expect("pods served");

    let api: kube::Api<kube::core::DynamicObject> =
        kube::Api::namespaced_with(client.clone(), DEMO_NAMESPACE, &pods.api_resource());

    // A snapshot larger than one event: read the list and feed it through the same
    // accumulator the watcher uses, then confirm one snapshot batch carries all rows.
    let list = api.list(&Default::default()).await.expect("list pods");
    let budget = WatchBudget {
        max_watches: 1,
        max_batch_size: 50,
        flush_interval: Duration::from_millis(100),
    };
    let mut accumulator = DeltaAccumulator::new(budget);
    assert!(accumulator.push(WatchEvent::StartingSnapshot).is_none());
    for obj in list.items {
        assert!(accumulator
            .push(WatchEvent::Applied(Box::new(obj)))
            .is_none());
    }
    let batch = accumulator
        .push(WatchEvent::SnapshotComplete)
        .expect("InitDone must flush a snapshot batch");

    assert!(batch.is_snapshot);
    assert!(!batch.upserts.is_empty());
    assert!(
        !batch.truncated,
        "small namespace should not overflow a batch"
    );
    assert_eq!(batch.upserts.len(), accumulator.rows().len());
}

#[tokio::test]
#[ignore = "requires a kind cluster"]
async fn pod_exec_streams_shell_output() {
    use futures::SinkExt;
    use k8s_openapi::api::core::v1::Pod;
    use kube::api::{AttachParams, TerminalSize};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (_manager, _context, client) = connected().await;
    let pod_api: kube::Api<Pod> = kube::Api::namespaced(client, DEMO_NAMESPACE);
    let pods = pod_api.list(&Default::default()).await.expect("list pods");
    let pod = pods.items.first().expect("demo pod exists");
    let pod_name = pod.metadata.name.as_deref().unwrap();
    let container = pod
        .spec
        .as_ref()
        .and_then(|s| s.containers.first())
        .map(|c| c.name.clone())
        .unwrap();

    let cmd = vec![
        "sh".to_string(),
        "-c".to_string(),
        "command -v bash >/dev/null 2>&1 && exec bash || exec sh".to_string(),
    ];
    let ap = AttachParams::interactive_tty().container(container);
    let mut attached = pod_api.exec(pod_name, cmd, &ap).await.expect("exec start");
    let mut stdin_writer = attached.stdin().expect("stdin");
    let mut stdout_reader = attached.stdout().expect("stdout");
    if let Some(mut ts) = attached.terminal_size() {
        let _ = ts
            .send(TerminalSize {
                width: 100,
                height: 22,
            })
            .await;
    }

    stdin_writer
        .write_all(b"echo KUBIX_EXEC_OK\n")
        .await
        .expect("write");
    stdin_writer.flush().await.expect("flush");

    let mut collected = String::new();
    let mut buf = [0u8; 4096];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stdout_reader.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                collected.push_str(&String::from_utf8_lossy(&buf[..n]));
                if collected.contains("KUBIX_EXEC_OK") {
                    break;
                }
            }
            Ok(Err(e)) => panic!("read error: {e}"),
            Err(_) => continue,
        }
    }

    assert!(
        collected.contains("KUBIX_EXEC_OK"),
        "expected shell output, got: {collected:?}"
    );
    let _ = stdin_writer.write_all(b"exit\n").await;
    let _ = stdin_writer.flush().await;
    let _ = attached.join().await;
}

#[tokio::test]
#[ignore = "requires a kind cluster"]
async fn pod_portforward_proxies_http_traffic() {
    use k8s_openapi::api::core::v1::Pod;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (_manager, _context, client) = connected().await;
    let pod_api: kube::Api<Pod> = kube::Api::namespaced(client, DEMO_NAMESPACE);
    let pods = pod_api.list(&Default::default()).await.expect("list pods");
    let pod = pods
        .items
        .iter()
        .find(|p| p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running"))
        .expect("running demo pod exists");
    let pod_name = pod.metadata.name.clone().expect("pod name");

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind local listener");
    let local_port = listener.local_addr().unwrap().port();

    let api_for_task = pod_api.clone();
    let handle = tokio::spawn(async move {
        if let Ok((mut local_stream, _)) = listener.accept().await {
            let mut pf = api_for_task
                .portforward(&pod_name, &[80])
                .await
                .expect("portforward start");
            let mut upstream = pf.take_stream(80).expect("take port 80 stream");
            let _ = tokio::io::copy_bidirectional(&mut local_stream, &mut upstream).await;
            pf.abort();
        }
    });

    let mut client_stream = tokio::net::TcpStream::connect(("127.0.0.1", local_port))
        .await
        .expect("connect local forwarded port");
    client_stream
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await
        .expect("write HTTP GET");
    client_stream.flush().await.expect("flush HTTP GET");

    let mut collected = String::new();
    let mut buf = [0u8; 4096];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), client_stream.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                collected.push_str(&String::from_utf8_lossy(&buf[..n]));
                if collected.contains("200 OK") || collected.contains("Welcome to nginx") {
                    break;
                }
            }
            Ok(Err(e)) => panic!("read error: {e}"),
            Err(_) => continue,
        }
    }
    drop(client_stream);
    assert!(
        collected.contains("200 OK") || collected.contains("Welcome to nginx"),
        "expected HTTP 200 from forwarded nginx pod, got: {collected:?}"
    );
    let _ = handle.await;
}
