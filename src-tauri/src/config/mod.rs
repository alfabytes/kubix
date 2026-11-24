use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{KubixError, Result};

/// Minimal, credential-free view of a kubeconfig auth method.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    Exec,
    ClientCert,
    Token,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigAuth {
    pub kind: AuthKind,
    /// Executable basename for `exec` auth (e.g. "aws"). Never carries args.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// What we know about a context from the kubeconfig alone. No network calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextDescriptor {
    pub id: String,
    pub name: String,
    pub cluster_name: String,
    /// Host (and port) only. No userinfo, no query string.
    pub server: String,
    pub namespace_default: String,
    pub auth: KubeconfigAuth,
    pub is_current: bool,
    /// Problems found while resolving this entry (missing cluster/user, etc).
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KubeconfigDiscovery {
    pub contexts: Vec<ContextDescriptor>,
    pub sources: Vec<PathBuf>,
    /// Paths that were considered but did not exist.
    pub missing_sources: Vec<PathBuf>,
    pub warnings: Vec<String>,
}

/// Resolve candidate kubeconfig paths, `KUBECONFIG` first, then `~/.kube/config`.
pub fn resolve_kubeconfig_paths(env_kubeconfig: Option<&str>, home: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(raw) = env_kubeconfig {
        for part in raw.split(':') {
            let part = part.trim();
            if !part.is_empty() {
                paths.push(PathBuf::from(part));
            }
        }
    }
    if paths.is_empty() {
        paths.push(home.join(".kube").join("config"));
    }
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    paths
}

pub fn discover_from_env() -> Result<KubeconfigDiscovery> {
    let home = home::home_dir().ok_or_else(|| KubixError::KubeconfigNotFound {
        message: "cannot determine home directory".to_string(),
    })?;
    let env_value = std::env::var("KUBECONFIG").ok();
    discover(env_value.as_deref(), &home)
}

pub fn discover(env_kubeconfig: Option<&str>, home: &Path) -> Result<KubeconfigDiscovery> {
    let candidates = resolve_kubeconfig_paths(env_kubeconfig, home);
    let mut discovery = KubeconfigDiscovery {
        sources: Vec::new(),
        ..Default::default()
    };

    let mut existing: Vec<PathBuf> = Vec::new();
    for path in candidates {
        if path.is_file() {
            existing.push(path);
        } else {
            discovery.missing_sources.push(path);
        }
    }

    if existing.is_empty() {
        return Err(KubixError::KubeconfigNotFound {
            message: "no readable kubeconfig found (checked KUBECONFIG and ~/.kube/config)"
                .to_string(),
        });
    }

    discovery.sources = existing.clone();
    for path in &existing {
        match parse_file(path) {
            Ok(partial) => merge(&mut discovery, partial),
            Err(err) => {
                let message = err.to_string();
                if existing.len() == 1 {
                    return Err(KubixError::KubeconfigParseFailed {
                        message: format!("{}: {message}", path.display()),
                    });
                }
                discovery
                    .warnings
                    .push(format!("{}: {message}", path.display()));
            }
        }
    }

    if discovery.contexts.is_empty() {
        discovery
            .warnings
            .push("kubeconfig parsed but contains no usable contexts".to_string());
    }
    Ok(discovery)
}

fn merge(into: &mut KubeconfigDiscovery, from: KubeconfigDiscovery) {
    for ctx in from.contexts {
        if !into.contexts.iter().any(|c| c.id == ctx.id) {
            into.contexts.push(ctx);
        }
    }
    into.warnings.extend(from.warnings);
    into.missing_sources.extend(from.missing_sources);
}

#[derive(Debug, Clone, Deserialize)]
struct RawKubeconfig {
    #[serde(default)]
    clusters: Vec<Named<RawCluster>>,
    #[serde(default)]
    contexts: Vec<Named<RawContext>>,
    #[serde(default)]
    users: Vec<Named<RawUser>>,
    #[serde(default, rename = "current-context")]
    current_context: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct Named<T> {
    name: String,
    #[serde(flatten)]
    body: T,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawCluster {
    #[serde(default)]
    cluster: RawClusterBody,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawClusterBody {
    server: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawContext {
    #[serde(default)]
    context: RawContextBody,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawContextBody {
    cluster: Option<String>,
    user: Option<String>,
    namespace: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawUser {
    #[serde(default)]
    user: RawUserBody,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawUserBody {
    #[serde(default, rename = "client-certificate-data")]
    client_certificate_data: Option<String>,
    #[serde(default, rename = "client-certificate")]
    client_certificate: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default, rename = "tokenFile")]
    token_file: Option<String>,
    #[serde(default)]
    exec: Option<RawExec>,
    #[serde(default, rename = "auth-provider")]
    auth_provider: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawExec {
    #[serde(default)]
    command: Option<String>,
}

fn parse_file(path: &Path) -> Result<KubeconfigDiscovery> {
    let raw = std::fs::read_to_string(path).map_err(|e| KubixError::KubeconfigParseFailed {
        message: e.to_string(),
    })?;
    parse_str(&raw)
}

pub fn parse_str(raw: &str) -> Result<KubeconfigDiscovery> {
    let parsed: RawKubeconfig =
        serde_yaml::from_str(raw).map_err(|e| KubixError::KubeconfigParseFailed {
            message: e.to_string(),
        })?;

    let clusters: BTreeMap<String, RawClusterBody> = parsed
        .clusters
        .into_iter()
        .map(|n| (n.name, n.body.cluster))
        .collect();
    let users: BTreeMap<String, RawUserBody> = parsed
        .users
        .into_iter()
        .map(|n| (n.name, n.body.user))
        .collect();

    let mut contexts = Vec::new();
    for entry in parsed.contexts {
        let name = entry.name;
        let body = entry.body.context;
        let mut issues = Vec::new();

        let cluster_name = body.cluster.unwrap_or_default();
        let user_name = body.user.unwrap_or_default();

        let server = match clusters.get(&cluster_name) {
            Some(cluster) => sanitize_server(cluster.server.as_deref()),
            None => {
                if cluster_name.is_empty() {
                    issues.push("context does not reference a cluster".to_string());
                } else {
                    issues.push(format!("cluster '{cluster_name}' is not defined"));
                }
                None
            }
        };

        if cluster_name.is_empty() {
            // already recorded above
        }
        let auth = match users.get(&user_name) {
            Some(user) => classify_auth(user),
            None => {
                if user_name.is_empty() {
                    issues.push("context does not reference a user".to_string());
                } else {
                    issues.push(format!("user '{user_name}' is not defined"));
                }
                KubeconfigAuth {
                    kind: AuthKind::Other,
                    hint: None,
                }
            }
        };

        contexts.push(ContextDescriptor {
            id: name.clone(),
            name,
            cluster_name,
            server: server.unwrap_or_default(),
            namespace_default: body.namespace.unwrap_or_else(|| "default".to_string()),
            auth,
            is_current: parsed.current_context.as_deref() == Some(entry_name_hint(&issues)),
            issues,
        });
    }

    let current = parsed.current_context.unwrap_or_default();
    for ctx in contexts.iter_mut() {
        ctx.is_current = ctx.id == current;
    }

    Ok(KubeconfigDiscovery {
        contexts,
        ..Default::default()
    })
}

fn entry_name_hint(_issues: &[String]) -> &str {
    ""
}

fn classify_auth(user: &RawUserBody) -> KubeconfigAuth {
    if let Some(exec) = &user.exec {
        let hint = exec
            .command
            .as_deref()
            .map(basename)
            .filter(|s| !s.is_empty());
        return KubeconfigAuth {
            kind: AuthKind::Exec,
            hint,
        };
    }
    if user.client_certificate_data.is_some() || user.client_certificate.is_some() {
        return KubeconfigAuth {
            kind: AuthKind::ClientCert,
            hint: None,
        };
    }
    if user.token.is_some() || user.token_file.is_some() {
        return KubeconfigAuth {
            kind: AuthKind::Token,
            hint: None,
        };
    }
    if user.auth_provider.is_some() {
        return KubeconfigAuth {
            kind: AuthKind::Other,
            hint: Some("auth-provider".to_string()),
        };
    }
    KubeconfigAuth {
        kind: AuthKind::Other,
        hint: None,
    }
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Reduce a server URL to host:port, dropping credentials, path and query.
pub fn sanitize_server(server: Option<&str>) -> Option<String> {
    let server = server?;
    let after_scheme = match server.split_once("://") {
        Some((_, rest)) => rest,
        None => server,
    };
    let host = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

#[allow(unused)]
fn _typecheck(_: &mut Vec<PathBuf>) {}

#[cfg(test)]
mod tests {
    use super::*;

    const DIRTY: &str = r#"
apiVersion: v1
clusters:
- cluster:
    server: https://user:pass@example.test:6443/prefix?token=abc
  name: with-creds
- cluster:
    server: https://orphan-cluster.test
  name: no-context-cluster
contexts:
- context:
    cluster: with-creds
    user: exec-user
    namespace: dev
  name: current-ctx
- context:
    cluster: missing-cluster
    user: missing-user
  name: broken-ctx
- context:
    cluster: with-creds
  name: no-user-ctx
current-context: current-ctx
users:
- name: exec-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: /usr/local/bin/aws
      args: ["eks", "get-token", "--cluster-name", "x"]
- name: cert-user
  user:
    client-certificate-data: LS0t
    client-key-data: LS0t
- name: orphan-user
  user:
    token: secret-token
"#;

    #[test]
    fn parses_current_context_and_sanitizes_server() {
        let d = parse_str(DIRTY).unwrap();
        let ctx = d.contexts.iter().find(|c| c.id == "current-ctx").unwrap();
        assert!(ctx.is_current);
        assert_eq!(ctx.server, "example.test:6443");
        assert_eq!(ctx.namespace_default, "dev");
        assert_eq!(ctx.auth.kind, AuthKind::Exec);
        assert_eq!(ctx.auth.hint.as_deref(), Some("aws"));
        assert!(ctx.issues.is_empty());
    }

    #[test]
    fn only_one_context_is_current() {
        let d = parse_str(DIRTY).unwrap();
        let current: Vec<_> = d.contexts.iter().filter(|c| c.is_current).collect();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].id, "current-ctx");
    }

    #[test]
    fn broken_context_records_issues_instead_of_failing() {
        let d = parse_str(DIRTY).unwrap();
        let ctx = d.contexts.iter().find(|c| c.id == "broken-ctx").unwrap();
        assert_eq!(ctx.server, "");
        assert_eq!(ctx.auth.kind, AuthKind::Other);
        assert!(ctx.issues.iter().any(|i| i.contains("missing-cluster")));
        assert!(ctx.issues.iter().any(|i| i.contains("missing-user")));
    }

    #[test]
    fn context_without_user_is_flagged() {
        let d = parse_str(DIRTY).unwrap();
        let ctx = d.contexts.iter().find(|c| c.id == "no-user-ctx").unwrap();
        assert!(ctx
            .issues
            .iter()
            .any(|i| i.contains("does not reference a user")));
    }

    #[test]
    fn cluster_only_entries_do_not_become_contexts() {
        let d = parse_str(DIRTY).unwrap();
        assert_eq!(d.contexts.len(), 3);
        assert!(d
            .contexts
            .iter()
            .all(|c| c.cluster_name != "no-context-cluster"));
    }

    #[test]
    fn client_cert_auth_is_classified() {
        let d = parse_str(DIRTY).unwrap();
        // cert-user is not referenced by any context, so classification is checked directly.
        let user = RawUserBody {
            client_certificate_data: Some("LS0t".into()),
            ..Default::default()
        };
        assert_eq!(classify_auth(&user).kind, AuthKind::ClientCert);
        assert!(d
            .contexts
            .iter()
            .all(|c| c.auth.kind != AuthKind::ClientCert));
    }

    #[test]
    fn resolves_kubeconfig_env_first_and_dedupes() {
        let home = Path::new("/home/tester");
        let paths = resolve_kubeconfig_paths(Some("/a/config:/b/config:/a/config"), home);
        assert_eq!(
            paths,
            vec![PathBuf::from("/a/config"), PathBuf::from("/b/config")]
        );
    }

    #[test]
    fn resolves_default_home_path_when_env_missing() {
        let home = Path::new("/home/tester");
        let paths = resolve_kubeconfig_paths(None, home);
        assert_eq!(paths, vec![PathBuf::from("/home/tester/.kube/config")]);
    }

    #[test]
    fn empty_env_value_falls_back_to_home() {
        let home = Path::new("/home/tester");
        let paths = resolve_kubeconfig_paths(Some("   "), home);
        assert_eq!(paths, vec![PathBuf::from("/home/tester/.kube/config")]);
    }

    #[test]
    fn discover_reports_missing_sources() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("config");
        std::fs::write(
            &good,
            "apiVersion: v1\ncontexts:\n- context:\n    cluster: c\n    user: u\n  name: only\nclusters:\n- cluster:\n    server: https://h.test\n  name: c\nusers:\n- name: u\n  user:\n    token: t\n",
        )
        .unwrap();
        let missing = dir.path().join("nope");
        let env = format!("{}:{}", good.display(), missing.display());
        let d = discover(Some(&env), dir.path()).unwrap();
        assert_eq!(d.sources, vec![good]);
        assert_eq!(d.missing_sources, vec![missing]);
        assert_eq!(d.contexts.len(), 1);
        assert_eq!(d.contexts[0].auth.kind, AuthKind::Token);
    }

    #[test]
    fn discover_errors_when_nothing_exists() {
        let dir = tempfile::tempdir().unwrap();
        let err = discover(None, dir.path()).unwrap_err();
        assert!(matches!(err, KubixError::KubeconfigNotFound { .. }));
    }

    #[test]
    fn discover_errors_on_single_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("config");
        std::fs::write(&bad, "clusters: [not: valid").unwrap();
        let err = discover(Some(bad.to_str().unwrap()), dir.path()).unwrap_err();
        assert!(matches!(err, KubixError::KubeconfigParseFailed { .. }));
    }

    #[test]
    fn discover_warns_on_broken_file_when_another_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("bad");
        let good = dir.path().join("good");
        std::fs::write(&bad, "clusters: [not: valid").unwrap();
        std::fs::write(
            &good,
            "apiVersion: v1\ncontexts:\n- context:\n    cluster: c\n    user: u\n  name: ok\nclusters:\n- cluster:\n    server: https://h.test\n  name: c\nusers:\n- name: u\n  user:\n    token: t\n",
        )
        .unwrap();
        let env = format!("{}:{}", bad.display(), good.display());
        let d = discover(Some(&env), dir.path()).unwrap();
        assert_eq!(d.contexts.len(), 1);
        assert_eq!(d.warnings.len(), 1);
        assert!(d.warnings[0].contains("bad"));
    }

    #[test]
    fn duplicate_contexts_across_files_keep_first() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        let body = |server: &str| {
            format!(
                "apiVersion: v1\ncontexts:\n- context:\n    cluster: c\n    user: u\n  name: dup\nclusters:\n- cluster:\n    server: {server}\n  name: c\nusers:\n- name: u\n  user:\n    token: t\n"
            )
        };
        std::fs::write(&a, body("https://first.test")).unwrap();
        std::fs::write(&b, body("https://second.test")).unwrap();
        let env = format!("{}:{}", a.display(), b.display());
        let d = discover(Some(&env), dir.path()).unwrap();
        assert_eq!(d.contexts.len(), 1);
        assert_eq!(d.contexts[0].server, "first.test");
    }
}
