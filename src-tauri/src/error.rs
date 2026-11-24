use serde::{Deserialize, Serialize};

use crate::ipc::dto::ContextId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KubixErrorDto {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_id: Option<ContextId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    KubeconfigNotFound,
    KubeconfigParseFailed,
    UnknownContext,
    AuthRequired,
    AuthFailed,
    ClusterUnreachable,
    Forbidden,
    DiscoveryFailed,
    ResourceNotFound,
    WatchEvicted,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::KubeconfigNotFound => "kubeconfigNotFound",
            ErrorCode::KubeconfigParseFailed => "kubeconfigParseFailed",
            ErrorCode::UnknownContext => "unknownContext",
            ErrorCode::AuthRequired => "authRequired",
            ErrorCode::AuthFailed => "authFailed",
            ErrorCode::ClusterUnreachable => "clusterUnreachable",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::DiscoveryFailed => "discoveryFailed",
            ErrorCode::ResourceNotFound => "resourceNotFound",
            ErrorCode::WatchEvicted => "watchEvicted",
            ErrorCode::Internal => "internal",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum KubixError {
    #[error("{message}")]
    KubeconfigNotFound { message: String },
    #[error("{message}")]
    KubeconfigParseFailed { message: String },
    #[error("unknown context '{context_id}'")]
    UnknownContext { context_id: ContextId },
    #[error("authentication requires interaction: {message}")]
    AuthRequired { message: String },
    #[error("authentication failed: {message}")]
    AuthFailed { message: String },
    #[error("cluster unreachable: {message}")]
    ClusterUnreachable { message: String },
    #[error("forbidden: {message}")]
    Forbidden { message: String },
    #[error("discovery failed: {message}")]
    DiscoveryFailed { message: String },
    #[error("resource not found: {message}")]
    ResourceNotFound { message: String },
    #[error("watch evicted: {message}")]
    WatchEvicted { message: String },
    #[error("{message}")]
    Internal { message: String },
}

impl KubixError {
    pub fn internal(message: impl std::fmt::Display) -> Self {
        KubixError::Internal {
            message: message.to_string(),
        }
    }

    pub fn code(&self) -> ErrorCode {
        match self {
            KubixError::KubeconfigNotFound { .. } => ErrorCode::KubeconfigNotFound,
            KubixError::KubeconfigParseFailed { .. } => ErrorCode::KubeconfigParseFailed,
            KubixError::UnknownContext { .. } => ErrorCode::UnknownContext,
            KubixError::AuthRequired { .. } => ErrorCode::AuthRequired,
            KubixError::AuthFailed { .. } => ErrorCode::AuthFailed,
            KubixError::ClusterUnreachable { .. } => ErrorCode::ClusterUnreachable,
            KubixError::Forbidden { .. } => ErrorCode::Forbidden,
            KubixError::DiscoveryFailed { .. } => ErrorCode::DiscoveryFailed,
            KubixError::ResourceNotFound { .. } => ErrorCode::ResourceNotFound,
            KubixError::WatchEvicted { .. } => ErrorCode::WatchEvicted,
            KubixError::Internal { .. } => ErrorCode::Internal,
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self.code(),
            ErrorCode::ClusterUnreachable
                | ErrorCode::Internal
                | ErrorCode::WatchEvicted
                | ErrorCode::AuthRequired
        )
    }

    pub fn with_context(self, context_id: impl Into<ContextId>) -> KubixContextualError {
        KubixContextualError {
            error: self,
            context_id: context_id.into(),
        }
    }

    pub fn to_dto(&self, context_id: Option<ContextId>) -> KubixErrorDto {
        KubixErrorDto {
            code: self.code(),
            message: self.to_string(),
            retryable: self.retryable(),
            context_id,
        }
    }

    /// Map a kube-rs error onto our taxonomy. Auth failures and unreachability are
    /// distinguished so the UI can show "retry" versus "fix your credentials".
    pub fn from_kube(err: kube::Error) -> Self {
        match &err {
            kube::Error::Api(api) => match api.code {
                401 => KubixError::AuthFailed {
                    message: api.message.clone(),
                },
                403 => KubixError::Forbidden {
                    message: api.message.clone(),
                },
                404 => KubixError::ResourceNotFound {
                    message: api.message.clone(),
                },
                _ => KubixError::Internal {
                    message: format!("api error {}: {}", api.code, api.message),
                },
            },
            err if is_unreachable(err) => KubixError::ClusterUnreachable {
                message: err.to_string(),
            },
            other => KubixError::Internal {
                message: other.to_string(),
            },
        }
    }
}

pub type Result<T> = std::result::Result<T, KubixError>;

/// A [`KubixError`] paired with the context it happened in.
#[derive(Debug, thiserror::Error)]
#[error("{error}")]
pub struct KubixContextualError {
    pub error: KubixError,
    pub context_id: ContextId,
}

impl KubixContextualError {
    pub fn dto(&self) -> KubixErrorDto {
        self.error.to_dto(Some(self.context_id.clone()))
    }
}

impl From<KubixContextualError> for KubixError {
    fn from(value: KubixContextualError) -> Self {
        value.error
    }
}

fn is_unreachable(err: &kube::Error) -> bool {
    let text = match err {
        kube::Error::Service(e) => e.to_string(),
        kube::Error::HyperError(_) => "hyper".to_string(),
        kube::Error::HttpError(_) => "http".to_string(),
        other => other.to_string(),
    };
    let text = text.to_lowercase();
    text.contains("connect")
        || text.contains("dns")
        || text.contains("timed out")
        || text.contains("timeout")
        || text.contains("tls")
        || text.contains("handshake")
        || text.contains("refused")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_match_contract_strings() {
        let cases = [
            (
                KubixError::KubeconfigNotFound {
                    message: "x".into(),
                },
                "kubeconfigNotFound",
            ),
            (
                KubixError::KubeconfigParseFailed {
                    message: "x".into(),
                },
                "kubeconfigParseFailed",
            ),
            (
                KubixError::UnknownContext {
                    context_id: "c".into(),
                },
                "unknownContext",
            ),
            (
                KubixError::AuthRequired {
                    message: "x".into(),
                },
                "authRequired",
            ),
            (
                KubixError::AuthFailed {
                    message: "x".into(),
                },
                "authFailed",
            ),
            (
                KubixError::ClusterUnreachable {
                    message: "x".into(),
                },
                "clusterUnreachable",
            ),
            (
                KubixError::Forbidden {
                    message: "x".into(),
                },
                "forbidden",
            ),
            (
                KubixError::DiscoveryFailed {
                    message: "x".into(),
                },
                "discoveryFailed",
            ),
            (
                KubixError::ResourceNotFound {
                    message: "x".into(),
                },
                "resourceNotFound",
            ),
            (
                KubixError::WatchEvicted {
                    message: "x".into(),
                },
                "watchEvicted",
            ),
            (
                KubixError::Internal {
                    message: "x".into(),
                },
                "internal",
            ),
        ];
        for (err, expected) in cases {
            assert_eq!(err.code().as_str(), expected);
            let dto = err.to_dto(None);
            let json = serde_json::to_string(&dto).unwrap();
            assert!(json.contains(&format!("\"code\":\"{expected}\"")));
            assert!(json.contains(&format!("\"retryable\":{}", err.retryable())));
        }
    }

    #[test]
    fn only_retryable_codes_are_retryable() {
        assert!(KubixError::ClusterUnreachable {
            message: "x".into()
        }
        .retryable());
        assert!(KubixError::WatchEvicted {
            message: "x".into()
        }
        .retryable());
        assert!(!KubixError::AuthFailed {
            message: "x".into()
        }
        .retryable());
        assert!(!KubixError::Forbidden {
            message: "x".into()
        }
        .retryable());
        assert!(!KubixError::UnknownContext {
            context_id: "c".into()
        }
        .retryable());
    }

    #[test]
    fn dto_carries_context_id_when_present() {
        let dto = KubixError::Forbidden {
            message: "no".into(),
        }
        .to_dto(Some("ctx".into()));
        assert_eq!(dto.context_id.as_deref(), Some("ctx"));
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"contextId\":\"ctx\""));
        let dto = KubixError::Internal {
            message: "x".into(),
        }
        .to_dto(None);
        assert!(!serde_json::to_string(&dto).unwrap().contains("contextId"));
    }

    #[test]
    fn api_401_is_auth_failed_403_is_forbidden_404_is_not_found() {
        let mk = |code: u16| {
            kube::Error::Api(kube::core::ErrorResponse {
                status: "Failure".to_string(),
                message: format!("msg {code}"),
                reason: "Reason".to_string(),
                code,
            })
        };
        assert_eq!(KubixError::from_kube(mk(401)).code(), ErrorCode::AuthFailed);
        assert_eq!(KubixError::from_kube(mk(403)).code(), ErrorCode::Forbidden);
        assert_eq!(
            KubixError::from_kube(mk(404)).code(),
            ErrorCode::ResourceNotFound
        );
        assert_eq!(KubixError::from_kube(mk(500)).code(), ErrorCode::Internal);
    }
}
