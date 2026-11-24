use std::collections::BTreeMap;

use kube::core::{ApiResource, GroupVersionKind};
use serde::Serialize;

use crate::ipc::dto::{gvr_string, DiscoveredResourceDto, GroupVersionResource};

/// The resources Kubix surfaces in the sidebar by default. Discovery returns everything
/// the API server serves; this catalog only marks what is "curated" so the UI can order
/// the list. Adding a kind here requires no backend change beyond this table.
pub const CURATED: &[(&str, &str, &str, &str)] = &[
    ("", "v1", "namespaces", "Namespace"),
    ("", "v1", "pods", "Pod"),
    ("", "v1", "services", "Service"),
    ("", "v1", "configmaps", "ConfigMap"),
    ("", "v1", "secrets", "Secret"),
    ("", "v1", "nodes", "Node"),
    ("apps", "v1", "deployments", "Deployment"),
    ("apps", "v1", "statefulsets", "StatefulSet"),
    ("apps", "v1", "daemonsets", "DaemonSet"),
    ("batch", "v1", "jobs", "Job"),
    ("batch", "v1", "cronjobs", "CronJob"),
    ("networking.k8s.io", "v1", "ingresses", "Ingress"),
];

pub fn curated_set() -> std::collections::BTreeSet<GroupVersionResource> {
    CURATED
        .iter()
        .map(|(g, v, p, _)| gvr_string(g, v, p))
        .collect()
}

/// One entry from the API discovery document, reduced to what we need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiResourceEntry {
    pub group: String,
    pub version: String,
    pub plural: String,
    pub kind: String,
    pub namespaced: bool,
    pub short_names: Vec<String>,
    pub verbs: Vec<String>,
}

impl ApiResourceEntry {
    pub fn gvr(&self) -> GroupVersionResource {
        gvr_string(&self.group, &self.version, &self.plural)
    }

    /// Only look at list-capable resources: if we cannot list it we cannot show it.
    pub fn is_listable(&self) -> bool {
        self.verbs.iter().any(|v| v == "list")
    }

    /// Subresources (`pods/log`, `deployments/scale`) contain a slash in the plural.
    pub fn is_subresource(&self) -> bool {
        self.plural.contains('/')
    }

    pub fn to_dto(
        &self,
        curated: &std::collections::BTreeSet<GroupVersionResource>,
    ) -> DiscoveredResourceDto {
        let gvr = self.gvr();
        DiscoveredResourceDto {
            curated: curated.contains(&gvr),
            gvr,
            kind: self.kind.clone(),
            group: self.group.clone(),
            version: self.version.clone(),
            plural: self.plural.clone(),
            namespaced: self.namespaced,
            short_names: self.short_names.clone(),
            verbs: self.verbs.clone(),
        }
    }

    /// Build the kube dynamic `ApiResource` needed to construct an `Api<DynamicObject>`.
    pub fn api_resource(&self) -> ApiResource {
        ApiResource {
            group: self.group.clone(),
            version: self.version.clone(),
            api_version: if self.group.is_empty() {
                self.version.clone()
            } else {
                format!("{}/{}", self.group, self.version)
            },
            kind: self.kind.clone(),
            plural: self.plural.clone(),
        }
    }

    pub fn gvk(&self) -> GroupVersionKind {
        GroupVersionKind::gvk(&self.group, &self.version, &self.kind)
    }
}

/// Normalize discovery output: dedupe by GVR, drop subresources, drop non-listable
/// entries, sort curated-first then alphabetically for stable UI ordering.
pub fn normalize(entries: Vec<ApiResourceEntry>) -> Vec<DiscoveredResourceDto> {
    let curated = curated_set();
    let mut by_gvr: BTreeMap<GroupVersionResource, ApiResourceEntry> = BTreeMap::new();
    for entry in entries {
        if entry.is_subresource() || !entry.is_listable() {
            continue;
        }
        by_gvr.entry(entry.gvr()).or_insert(entry);
    }

    let mut dtos: Vec<DiscoveredResourceDto> =
        by_gvr.values().map(|e| e.to_dto(&curated)).collect();

    let curated_order: BTreeMap<GroupVersionResource, usize> = CURATED
        .iter()
        .enumerate()
        .map(|(i, (g, v, p, _))| (gvr_string(g, v, p), i))
        .collect();

    dtos.sort_by(|a, b| {
        let ai = curated_order.get(&a.gvr);
        let bi = curated_order.get(&b.gvr);
        match (ai, bi) {
            (Some(x), Some(y)) => x.cmp(y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.gvr.cmp(&b.gvr),
        }
    });
    dtos
}

/// Find a discovered entry by GVR string.
pub fn find_gvr(entries: &[ApiResourceEntry], gvr: &str) -> Option<ApiResourceEntry> {
    entries.iter().find(|e| e.gvr() == gvr).cloned()
}

/// Parse kube's `ApiResourceList` JSON (one per group/version).
#[derive(Debug, Serialize, serde::Deserialize)]
struct RawApiResourceList {
    #[serde(rename = "groupVersion")]
    group_version: String,
    resources: Vec<RawApiResource>,
}

#[derive(Debug, Serialize, serde::Deserialize)]
struct RawApiResource {
    name: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    namespaced: bool,
    #[serde(default, rename = "shortNames")]
    short_names: Vec<String>,
    #[serde(default)]
    verbs: Vec<String>,
}

/// Convert a kube `ApiResourceList` into our entry shape.
pub fn entries_from_api_resource_list(
    list_json: &str,
) -> Result<Vec<ApiResourceEntry>, serde_json::Error> {
    let raw: RawApiResourceList = serde_json::from_str(list_json)?;
    let (group, version) = match raw.group_version.split_once('/') {
        Some((g, v)) => (g.to_string(), v.to_string()),
        None => (String::new(), raw.group_version.clone()),
    };
    Ok(raw
        .resources
        .into_iter()
        .map(|r| ApiResourceEntry {
            group: group.clone(),
            version: version.clone(),
            plural: r.name,
            kind: r.kind,
            namespaced: r.namespaced,
            short_names: r.short_names,
            verbs: r.verbs,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(plural: &str, verbs: &[&str]) -> ApiResourceEntry {
        ApiResourceEntry {
            group: "".into(),
            version: "v1".into(),
            plural: plural.into(),
            kind: "Kind".into(),
            namespaced: true,
            short_names: vec![],
            verbs: verbs.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn catalog_has_twelve_curated_kinds() {
        assert_eq!(CURATED.len(), 12);
        let set = curated_set();
        assert!(set.contains("/v1/pods"));
        assert!(set.contains("networking.k8s.io/v1/ingresses"));
    }

    #[test]
    fn drops_subresources_and_non_listable() {
        let out = normalize(vec![
            entry("pods", &["get", "list"]),
            entry("pods/log", &["get"]),
            entry("bindings", &["create"]),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].plural, "pods");
    }

    #[test]
    fn curated_resources_sort_first_in_catalog_order() {
        let out = normalize(vec![
            entry("zebras", &["list"]),
            entry("secrets", &["list"]),
            entry("pods", &["list"]),
        ]);
        assert_eq!(
            out.iter().map(|r| r.plural.as_str()).collect::<Vec<_>>(),
            vec!["pods", "secrets", "zebras"]
        );
        assert!(out[0].curated);
        assert!(!out[2].curated);
    }

    #[test]
    fn duplicates_collapse() {
        let out = normalize(vec![entry("pods", &["list"]), entry("pods", &["list"])]);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn api_resource_for_core_group_has_bare_version() {
        let e = entry("pods", &["list"]);
        let ar = e.api_resource();
        assert_eq!(ar.api_version, "v1");
        assert_eq!(ar.group, "");
        assert_eq!(ar.plural, "pods");
    }

    #[test]
    fn api_resource_for_named_group_has_qualified_version() {
        let mut e = entry("deployments", &["list"]);
        e.group = "apps".into();
        let ar = e.api_resource();
        assert_eq!(ar.api_version, "apps/v1");
        assert_eq!(ar.kind, "Kind");
    }

    #[test]
    fn parses_kube_api_resource_list() {
        let json = r#"{
            "kind": "APIResourceList",
            "groupVersion": "apps/v1",
            "resources": [
                {"name": "deployments", "kind": "Deployment", "namespaced": true,
                 "shortNames": ["deploy"], "verbs": ["get","list","watch"]},
                {"name": "deployments/scale", "kind": "Scale", "namespaced": true, "verbs": ["get","patch"]}
            ]
        }"#;
        let entries = entries_from_api_resource_list(json).unwrap();
        assert_eq!(entries.len(), 2);
        let deploy = find_gvr(&entries, "apps/v1/deployments").unwrap();
        assert_eq!(deploy.kind, "Deployment");
        assert_eq!(deploy.short_names, vec!["deploy"]);
        assert!(deploy.namespaced);
        assert!(deploy.is_listable());
        let scale = find_gvr(&entries, "apps/v1/deployments/scale").unwrap();
        assert!(scale.is_subresource());
        assert!(!scale.is_listable());
    }

    #[test]
    fn parses_core_group_version_without_slash() {
        let json = r#"{"groupVersion":"v1","resources":[{"name":"pods","kind":"Pod","namespaced":true,"verbs":["list"]}]}"#;
        let entries = entries_from_api_resource_list(json).unwrap();
        assert_eq!(entries[0].group, "");
        assert_eq!(entries[0].version, "v1");
        assert_eq!(entries[0].gvr(), "/v1/pods");
    }
}
