//! End-to-end IPC contract test. Runs without a cluster: it only asserts that the
//! command surface the frontend depends on is registered and read-only.

use std::path::Path;

use kubix_lib::ipc::commands::{command_names, COMMANDS, READ_ONLY_ROSTER};
use kubix_lib::ipc::contract::contract_json;
use kubix_lib::ipc::events::EVENTS;

fn repo_root() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

#[test]
fn generated_contract_matches_committed_file() {
    let committed = std::fs::read_to_string(repo_root().join("src/lib/ipc/schema/contract.json"))
        .expect("committed contract.json must exist; run `pnpm ipc:schema`");
    assert_eq!(
        contract_json(),
        committed,
        "src/lib/ipc/schema/contract.json is stale; run `pnpm ipc:schema`"
    );
}

#[test]
fn frontend_client_references_every_command() {
    let client = std::fs::read_to_string(repo_root().join("src/lib/ipc/client.ts"))
        .expect("frontend client must exist");
    for name in command_names() {
        assert!(
            client.contains(&format!("\"{name}\"")),
            "src/lib/ipc/client.ts does not call command '{name}'"
        );
    }
}

#[test]
fn frontend_handles_every_event() {
    let events = std::fs::read_to_string(repo_root().join("src/lib/ipc/events.ts"))
        .expect("frontend events module must exist");
    for event in EVENTS {
        assert!(
            events.contains(event.name),
            "src/lib/ipc/events.ts does not declare event '{}'",
            event.name
        );
    }
}

#[test]
fn no_mutating_command_is_exposed() {
    for spec in COMMANDS {
        assert!(spec.read_only);
        assert!(READ_ONLY_ROSTER.contains(&spec.name));
    }
    let contract = contract_json();
    for verb in ["create_", "delete_", "patch_", "apply_", "exec_", "scale_"] {
        assert!(
            !contract.contains(&format!("\"{verb}")),
            "contract exposes a mutating command matching '{verb}'"
        );
    }
}

#[test]
fn tauri_capabilities_stay_minimal() {
    let capabilities =
        std::fs::read_to_string(repo_root().join("src-tauri/capabilities/default.json"))
            .expect("capabilities file must exist");
    for forbidden in ["shell:", "fs:", "http:", "process:"] {
        assert!(
            !capabilities.contains(forbidden),
            "capability file grants '{forbidden}', which this milestone does not need"
        );
    }
}

#[test]
fn kubeconfig_fixture_never_leaks_secret_material_into_dtos() {
    // ClusterContextDto is the only kubeconfig-derived type crossing the IPC boundary.
    // Parsing the dirty fixture must not surface certificate or key bytes anywhere.
    let dirty = r#"
apiVersion: v1
clusters:
- cluster:
    server: https://user:pass@example.test:6443
    certificate-authority-data: SUPERSECRETCA
  name: c
contexts:
- context: {cluster: c, user: u}
  name: ctx
current-context: ctx
users:
- name: u
  user:
    client-certificate-data: SUPERSECRETCERT
    client-key-data: SUPERSECRETKEY
"#;
    let parsed = kubix_lib::config::parse_str(dirty).expect("fixture parses");
    let dto = kubix_lib::ipc::dto::ClusterContextDto::from_descriptor(
        &parsed.contexts[0],
        kubix_lib::ipc::dto::ConnectionState::Disconnected,
    );
    let json = serde_json::to_string(&dto).unwrap();
    for secret in [
        "SUPERSECRETCA",
        "SUPERSECRETCERT",
        "SUPERSECRETKEY",
        "user:pass",
        "pass@",
    ] {
        assert!(
            !json.contains(secret),
            "context DTO leaked '{secret}': {json}"
        );
    }
}
