use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use kube::config::KubeConfigOptions;
use kube::{Client, Config};
use tokio::sync::{Mutex, RwLock};
use tokio::time::timeout;
use tracing::{debug, warn};

use crate::config::{AuthKind, ContextDescriptor};
use crate::error::{KubixContextualError, KubixError, Result};
use crate::ipc::dto::{ClusterContextDto, ConnectionState};

/// Exec auth plugins are spawned by kube-rs when a client is first used. A hung
/// `aws eks get-token` must never freeze the UI, so every connect is bounded.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// A connected context: an authenticated client plus its health record.
pub struct ContextHandle {
    pub client: Client,
    pub state: ConnectionState,
    pub last_error: Option<crate::error::KubixErrorDto>,
}

#[derive(Default)]
struct Inner {
    config: Option<kube::config::Kubeconfig>,
    descriptors: BTreeMap<String, ContextDescriptor>,
}

/// Owns the kubeconfig and the client pool. Connecting is always explicit and lazy:
/// nothing here is called during `list_contexts`.
pub struct ClusterManager {
    inner: RwLock<Inner>,
    handles: Mutex<HashMap<String, Arc<ContextHandle>>>,
    connect_timeout: Duration,
}

impl ClusterManager {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner::default()),
            handles: Mutex::new(HashMap::new()),
            connect_timeout: CONNECT_TIMEOUT,
        }
    }

    #[cfg(test)]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    /// Replace the parsed kubeconfig. Existing connections are dropped because their
    /// credentials may have changed.
    pub async fn load(
        &self,
        descriptors: Vec<ContextDescriptor>,
        config: kube::config::Kubeconfig,
    ) {
        let map: BTreeMap<String, ContextDescriptor> =
            descriptors.into_iter().map(|d| (d.id.clone(), d)).collect();
        {
            let mut inner = self.inner.write().await;
            inner.config = Some(config);
            inner.descriptors = map;
        }
        let mut handles = self.handles.lock().await;
        handles.clear();
    }

    pub async fn store_descriptors(&self, descriptors: Vec<ContextDescriptor>) {
        let map: BTreeMap<String, ContextDescriptor> =
            descriptors.into_iter().map(|d| (d.id.clone(), d)).collect();
        let mut inner = self.inner.write().await;
        inner.descriptors = map;
    }

    pub async fn descriptions(&self) -> Vec<ContextDescriptor> {
        self.inner
            .read()
            .await
            .descriptors
            .values()
            .cloned()
            .collect()
    }

    pub async fn has_config(&self) -> bool {
        self.inner.read().await.config.is_some()
    }

    pub async fn connect(
        &self,
        context_id: &str,
    ) -> std::result::Result<ClusterContextDto, KubixContextualError> {
        let config = {
            let inner = self.inner.read().await;
            inner.config.clone().ok_or_else(|| {
                KubixError::KubeconfigNotFound {
                    message: "kubeconfig has not been loaded yet".to_string(),
                }
                .with_context(context_id.to_string())
            })?
        };

        let options = KubeConfigOptions {
            context: Some(context_id.to_string()),
            cluster: None,
            user: None,
        };

        let kube_config = Config::from_custom_kubeconfig(config, &options)
            .await
            .map_err(|e| {
                // kube's error here is a config error, most often "context not found".
                if e.to_string().to_lowercase().contains("context") {
                    KubixError::UnknownContext {
                        context_id: context_id.to_string(),
                    }
                    .with_context(context_id.to_string())
                } else {
                    KubixError::KubeconfigParseFailed {
                        message: e.to_string(),
                    }
                    .with_context(context_id.to_string())
                }
            })?;

        let client = Client::try_from(kube_config).map_err(|e| {
            KubixError::KubeconfigParseFailed {
                message: e.to_string(),
            }
            .with_context(context_id.to_string())
        })?;

        // First real network/auth attempt: one cheap discovery read with a hard timeout
        // so an interactive `exec` plugin can never block the UI thread.
        let probe = probe_api(&client);
        let outcome = timeout(self.connect_timeout, probe).await;

        let (state, last_error) = match outcome {
            Err(_) => {
                let err = KubixError::ClusterUnreachable {
                    message: format!(
                        "connection attempt exceeded {}s (auth plugin may require interaction)",
                        self.connect_timeout.as_secs()
                    ),
                };
                (
                    ConnectionState::Unreachable,
                    Some(err.to_dto(Some(context_id.to_string()))),
                )
            }
            Ok(Err(e)) => {
                let err = classify_auth(e, context_id);
                warn!(context = %context_id, error = %err, "connect failed");
                (
                    state_for_error(&err),
                    Some(err.to_dto(Some(context_id.to_string()))),
                )
            }
            Ok(Ok(_)) => {
                debug!(context = %context_id, "connected");
                (ConnectionState::Ready, None)
            }
        };

        let handle = Arc::new(ContextHandle {
            client,
            state,
            last_error: last_error.clone(),
        });
        self.handles
            .lock()
            .await
            .insert(context_id.to_string(), handle);

        let descriptor = self.descriptor_for(context_id).await;
        Ok(build_dto(
            descriptor.as_ref(),
            context_id,
            state,
            last_error,
        ))
    }

    pub async fn disconnect(&self, context_id: &str) -> Option<ClusterContextDto> {
        let removed = self.handles.lock().await.remove(context_id);
        let descriptor = self.descriptor_for(context_id).await;
        if removed.is_none() && descriptor.is_none() {
            return None;
        }
        Some(build_dto(
            descriptor.as_ref(),
            context_id,
            ConnectionState::Disconnected,
            None,
        ))
    }

    pub async fn handle(&self, context_id: &str) -> Option<Arc<ContextHandle>> {
        self.handles.lock().await.get(context_id).cloned()
    }

    pub async fn client(&self, context_id: &str) -> Option<Client> {
        self.handle(context_id).await.map(|h| h.client.clone())
    }

    pub async fn state(&self, context_id: &str) -> Option<ConnectionState> {
        self.handle(context_id).await.map(|h| h.state)
    }

    pub async fn connected_ids(&self) -> Vec<String> {
        self.handles.lock().await.keys().cloned().collect()
    }

    async fn descriptor_for(&self, context_id: &str) -> Option<ContextDescriptor> {
        self.inner.read().await.descriptors.get(context_id).cloned()
    }
}

impl Default for ClusterManager {
    fn default() -> Self {
        Self::new()
    }
}

/// A minimal read that proves the client can authenticate and reach the API server.
/// `raw("/version")` is cheaper than building a typed `Api` and needs no GVK.
async fn probe_api(client: &Client) -> std::result::Result<(), kube::Error> {
    client.apiserver_version().await?;
    Ok(())
}

fn build_dto(
    descriptor: Option<&ContextDescriptor>,
    context_id: &str,
    state: ConnectionState,
    last_error: Option<crate::error::KubixErrorDto>,
) -> ClusterContextDto {
    match descriptor {
        Some(d) => {
            let mut dto = ClusterContextDto::from_descriptor(d, state);
            dto.last_error = last_error;
            dto
        }
        None => ClusterContextDto {
            id: context_id.to_string(),
            name: context_id.to_string(),
            cluster_name: String::new(),
            server: String::new(),
            namespace_default: "default".to_string(),
            auth_kind: AuthKind::Other,
            auth_hint: None,
            is_current: false,
            state,
            last_error,
            issues: vec!["context is not in the current kubeconfig".to_string()],
        },
    }
}

fn classify_auth(err: kube::Error, context_id: &str) -> KubixError {
    let mapped = KubixError::from_kube(err);
    match mapped {
        KubixError::Internal { message } => {
            let lower = message.to_lowercase();
            if lower.contains("exec") || lower.contains("token") {
                KubixError::AuthFailed {
                    message: format!("authentication plugin failed: {message}"),
                }
            } else {
                KubixError::Internal { message }
            }
        }
        other => other,
    }
    .with_context(context_id.to_string())
    .error
}

fn state_for_error(err: &KubixError) -> ConnectionState {
    match err.code() {
        crate::error::ErrorCode::AuthFailed | crate::error::ErrorCode::AuthRequired => {
            ConnectionState::AuthFailed
        }
        crate::error::ErrorCode::Forbidden => ConnectionState::Forbidden,
        crate::error::ErrorCode::ClusterUnreachable => ConnectionState::Unreachable,
        _ => ConnectionState::Degraded,
    }
}

pub type ConnectOutcome = Result<ClusterContextDto>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_mapping_is_explicit() {
        assert_eq!(
            state_for_error(&KubixError::AuthFailed {
                message: "x".into()
            }),
            ConnectionState::AuthFailed
        );
        assert_eq!(
            state_for_error(&KubixError::AuthRequired {
                message: "x".into()
            }),
            ConnectionState::AuthFailed
        );
        assert_eq!(
            state_for_error(&KubixError::Forbidden {
                message: "x".into()
            }),
            ConnectionState::Forbidden
        );
        assert_eq!(
            state_for_error(&KubixError::ClusterUnreachable {
                message: "x".into()
            }),
            ConnectionState::Unreachable
        );
        assert_eq!(
            state_for_error(&KubixError::Internal {
                message: "x".into()
            }),
            ConnectionState::Degraded
        );
    }

    #[test]
    fn dto_falls_back_when_descriptor_missing() {
        let dto = build_dto(None, "ghost", ConnectionState::Disconnected, None);
        assert_eq!(dto.id, "ghost");
        assert_eq!(dto.state, ConnectionState::Disconnected);
        assert!(!dto.is_current);
        assert_eq!(dto.namespace_default, "default");
        assert_eq!(dto.issues.len(), 1);
    }

    #[tokio::test]
    async fn connect_without_config_is_contextual_error() {
        let manager = ClusterManager::new().with_timeout(Duration::from_millis(10));
        let err = manager.connect("anything").await.unwrap_err();
        assert!(matches!(err.error, KubixError::KubeconfigNotFound { .. }));
        assert_eq!(err.context_id, "anything");
    }

    #[tokio::test]
    async fn disconnect_is_idempotent_and_returns_dto_for_described_context() {
        let manager = ClusterManager::new();
        assert!(manager.disconnect("nope").await.is_none());

        let descriptor = ContextDescriptor {
            id: "ctx".into(),
            name: "ctx".into(),
            cluster_name: "c".into(),
            server: "h.test:6443".into(),
            namespace_default: "dev".into(),
            auth: crate::config::KubeconfigAuth {
                kind: AuthKind::Token,
                hint: None,
            },
            is_current: false,
            issues: vec![],
        };
        manager.store_descriptors(vec![descriptor]).await;
        let dto = manager.disconnect("ctx").await.unwrap();
        assert_eq!(dto.id, "ctx");
        assert_eq!(dto.state, ConnectionState::Disconnected);
        assert_eq!(dto.cluster_name, "c");

        // Second disconnect still returns a dto (descriptor still known).
        assert!(manager.disconnect("ctx").await.is_some());
    }
}
