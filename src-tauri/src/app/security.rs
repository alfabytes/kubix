//! Read-only cluster security posture audit.

use kube::Api;
use tauri::State;

use super::telemetry::{parse_cpu_millicores, parse_memory_mib};
use super::{map_err, AppState, CommandResult};
use crate::error::KubixError;
use crate::ipc::dto::{ClusterSecurityAuditDto, ContextArgs, SecurityFindingDto};

fn image_uses_mutable_latest(image: &str) -> bool {
    let trimmed = image.trim();
    if trimmed.is_empty() || trimmed.contains("@sha256:") {
        return false;
    }
    let last_segment = trimmed.rsplit('/').next().unwrap_or(trimmed);
    match last_segment.split_once(':') {
        Some((_, tag)) => tag == "latest" || tag.is_empty(),
        None => true,
    }
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "critical" => 0,
        "high" => 1,
        "medium" => 2,
        _ => 3,
    }
}

pub(super) fn audit_pods(
    context_id: &str,
    pods: &[k8s_openapi::api::core::v1::Pod],
) -> ClusterSecurityAuditDto {
    let mut findings: Vec<SecurityFindingDto> = Vec::new();
    let mut scanned_pods = 0u32;
    let mut scanned_containers = 0u32;

    for pod in pods {
        if matches!(
            pod.status.as_ref().and_then(|s| s.phase.as_deref()),
            Some("Succeeded" | "Failed")
        ) {
            continue;
        }
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        if pod_name.is_empty() {
            continue;
        }
        let namespace = pod
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let Some(spec) = pod.spec.as_ref() else {
            continue;
        };
        scanned_pods += 1;

        let pod_sc = spec.security_context.as_ref();
        let pod_run_as_non_root = pod_sc.and_then(|sc| sc.run_as_non_root);
        let pod_run_as_user = pod_sc.and_then(|sc| sc.run_as_user);

        // Pod-level host namespace checks
        let mut host_flags = Vec::new();
        if spec.host_network == Some(true) {
            host_flags.push("hostNetwork");
        }
        if spec.host_pid == Some(true) {
            host_flags.push("hostPID");
        }
        if spec.host_ipc == Some(true) {
            host_flags.push("hostIPC");
        }
        if !host_flags.is_empty() {
            let joined = host_flags.join(", ");
            findings.push(SecurityFindingDto {
                id: format!("{namespace}/{pod_name}/host-ns"),
                severity: "high".to_string(),
                category: "Host Isolation".to_string(),
                check_name: format!("Host namespace enabled ({joined})"),
                namespace: namespace.clone(),
                pod_name: pod_name.clone(),
                container_name: None,
                message: format!("Pod shares host namespace(s): {joined}."),
            });
        }

        // Default ServiceAccount with auto-mounted token
        let sa = spec
            .service_account_name
            .as_deref()
            .or(spec.service_account.as_deref())
            .unwrap_or("default");
        if (sa.is_empty() || sa == "default") && spec.automount_service_account_token != Some(false)
        {
            findings.push(SecurityFindingDto {
                id: format!("{namespace}/{pod_name}/default-sa"),
                severity: "low".to_string(),
                category: "RBAC & Identity".to_string(),
                check_name: "Default ServiceAccount token auto-mounted".to_string(),
                namespace: namespace.clone(),
                pod_name: pod_name.clone(),
                container_name: None,
                message:
                    "Uses the default ServiceAccount without automountServiceAccountToken: false."
                        .to_string(),
            });
        }

        let all_pod_containers: Vec<(String, &k8s_openapi::api::core::v1::Container)> = spec
            .init_containers
            .iter()
            .flatten()
            .map(|c| (format!("init:{}", c.name), c))
            .chain(spec.containers.iter().map(|c| (c.name.clone(), c)))
            .collect();

        for (cname, container) in all_pod_containers {
            scanned_containers += 1;
            let c_sc = container.security_context.as_ref();

            if c_sc.and_then(|sc| sc.privileged) == Some(true) {
                findings.push(SecurityFindingDto {
                    id: format!("{namespace}/{pod_name}/{cname}/privileged"),
                    severity: "critical".to_string(),
                    category: "Privilege Escalation".to_string(),
                    check_name: "Privileged container".to_string(),
                    namespace: namespace.clone(),
                    pod_name: pod_name.clone(),
                    container_name: Some(cname.clone()),
                    message: format!(
                        "Container '{cname}' runs with securityContext.privileged: true."
                    ),
                });
            }

            let effective_run_as_user = c_sc.and_then(|sc| sc.run_as_user).or(pod_run_as_user);
            let effective_non_root = c_sc
                .and_then(|sc| sc.run_as_non_root)
                .or(pod_run_as_non_root);
            if effective_run_as_user == Some(0) {
                findings.push(SecurityFindingDto {
                    id: format!("{namespace}/{pod_name}/{cname}/run-as-root"),
                    severity: "high".to_string(),
                    category: "Root Execution".to_string(),
                    check_name: "Runs explicitly as UID 0 (root)".to_string(),
                    namespace: namespace.clone(),
                    pod_name: pod_name.clone(),
                    container_name: Some(cname.clone()),
                    message: format!("Container '{cname}' sets runAsUser: 0."),
                });
            } else if effective_non_root != Some(true) {
                findings.push(SecurityFindingDto {
                    id: format!("{namespace}/{pod_name}/{cname}/non-root-unset"),
                    severity: "medium".to_string(),
                    category: "Root Execution".to_string(),
                    check_name: "runAsNonRoot not enforced".to_string(),
                    namespace: namespace.clone(),
                    pod_name: pod_name.clone(),
                    container_name: Some(cname.clone()),
                    message: format!(
                        "Container '{cname}' does not set securityContext.runAsNonRoot: true."
                    ),
                });
            }

            let limits = container.resources.as_ref().and_then(|r| r.limits.as_ref());
            let has_cpu_lim = limits
                .and_then(|m| m.get("cpu"))
                .is_some_and(|q| parse_cpu_millicores(&q.0) > 0.0);
            let has_mem_lim = limits
                .and_then(|m| m.get("memory"))
                .is_some_and(|q| parse_memory_mib(&q.0) > 0.0);
            if !has_cpu_lim || !has_mem_lim {
                let missing = match (has_cpu_lim, has_mem_lim) {
                    (false, false) => "CPU and memory limits",
                    (false, true) => "CPU limit",
                    (true, false) => "memory limit",
                    _ => "",
                };
                findings.push(SecurityFindingDto {
                    id: format!("{namespace}/{pod_name}/{cname}/missing-limits"),
                    severity: "medium".to_string(),
                    category: "Resource Governance".to_string(),
                    check_name: format!("Missing {missing}"),
                    namespace: namespace.clone(),
                    pod_name: pod_name.clone(),
                    container_name: Some(cname.clone()),
                    message: format!("Container '{cname}' has no {missing} configured."),
                });
            }

            if let Some(image) = container.image.as_deref() {
                if image_uses_mutable_latest(image) {
                    findings.push(SecurityFindingDto {
                        id: format!("{namespace}/{pod_name}/{cname}/latest-image"),
                        severity: "low".to_string(),
                        category: "Supply Chain".to_string(),
                        check_name: "Mutable :latest or untagged image".to_string(),
                        namespace: namespace.clone(),
                        pod_name: pod_name.clone(),
                        container_name: Some(cname.clone()),
                        message: format!("Container '{cname}' uses unpinned image '{image}'."),
                    });
                }
            }
        }
    }

    findings.sort_by(|a, b| {
        severity_rank(&a.severity)
            .cmp(&severity_rank(&b.severity))
            .then_with(|| a.namespace.cmp(&b.namespace))
            .then_with(|| a.pod_name.cmp(&b.pod_name))
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut critical_count = 0u32;
    let mut high_count = 0u32;
    let mut medium_count = 0u32;
    let mut low_count = 0u32;
    for f in &findings {
        match f.severity.as_str() {
            "critical" => critical_count += 1,
            "high" => high_count += 1,
            "medium" => medium_count += 1,
            _ => low_count += 1,
        }
    }

    ClusterSecurityAuditDto {
        context_id: context_id.to_string(),
        scanned_pods,
        scanned_containers,
        critical_count,
        high_count,
        medium_count,
        low_count,
        findings,
    }
}

#[tauri::command]
pub(super) async fn get_cluster_security_audit(
    state: State<'_, AppState>,
    args: ContextArgs,
) -> CommandResult<ClusterSecurityAuditDto> {
    use k8s_openapi::api::core::v1::Pod;
    use kube::api::ListParams;

    let client = state
        .manager
        .client(&args.context_id)
        .await
        .ok_or_else(|| {
            map_err(
                KubixError::AuthRequired {
                    message: "context is not connected".to_string(),
                },
                Some(args.context_id.clone()),
            )
        })?;

    let pod_api: Api<Pod> = Api::all(client);
    let list = pod_api
        .list(&ListParams::default())
        .await
        .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?;

    Ok(audit_pods(&args.context_id, &list.items))
}
