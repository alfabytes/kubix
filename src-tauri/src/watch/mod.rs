#![allow(dead_code)]

use std::collections::VecDeque;
use std::time::Duration;

use kube::core::DynamicObject;
use serde_json::Value;

/// A watch event as Kubix sees it, independent of the transport that produced it.
/// `Applied` boxes its payload because `DynamicObject` is large and the other variants
/// are tiny; keeping the enum small matters when events queue up.
///
/// `StartingSnapshot` marks the beginning of a watcher (re)list. Rows are only trusted
/// once the snapshot completes, so a partial snapshot can never masquerade as truth.
#[derive(Debug, Clone, PartialEq)]
pub enum WatchEvent {
    StartingSnapshot,
    Applied(Box<DynamicObject>),
    Deleted(String),
    /// The initial/relist snapshot finished; buffered rows become the authoritative set.
    SnapshotComplete,
    Error(String),
}

/// Limits that keep a desktop app from melting when a user opens many resource views.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchBudget {
    /// Maximum number of simultaneous watches across all contexts.
    pub max_watches: usize,
    /// Flush a delta batch once it reaches this many items.
    pub max_batch_size: usize,
    /// Or once this much time has passed since the last flush.
    pub flush_interval: Duration,
}

impl Default for WatchBudget {
    fn default() -> Self {
        Self {
            max_watches: 8,
            max_batch_size: 50,
            flush_interval: Duration::from_millis(100),
        }
    }
}

/// Accumulates watch events into bounded `ResourceDelta` batches, keeping a materialized
/// view of the current rows for a single `(context, gvr, namespace)` watch.
pub struct DeltaAccumulator {
    budget: WatchBudget,
    pending_upserts: Vec<DynamicObject>,
    pending_deletions: Vec<String>,
    since_flush: Duration,
    next_batch_id: u64,
    rows: VecDeque<DynamicObject>,
    /// A snapshot is in flight: applied rows are buffered, not emitted.
    snapshot_open: bool,
    /// Rows handed over by the last completed snapshot, so callers can diff if needed.
    snapshot_overflowed: bool,
}

/// One flushed batch, ready to be converted into `ResourceDeltaDto`.
#[derive(Debug, Clone, PartialEq)]
pub struct FlushedBatch {
    pub batch_id: u64,
    pub upserts: Vec<DynamicObject>,
    pub deletions: Vec<String>,
    pub truncated: bool,
    /// True when this batch is the authoritative result of a watcher snapshot. The
    /// frontend replaces its rows instead of merging when this is set.
    pub is_snapshot: bool,
}

impl DeltaAccumulator {
    pub fn new(budget: WatchBudget) -> Self {
        Self {
            budget,
            pending_upserts: Vec::new(),
            pending_deletions: Vec::new(),
            since_flush: Duration::ZERO,
            next_batch_id: 1,
            rows: VecDeque::new(),
            snapshot_open: false,
            snapshot_overflowed: false,
        }
    }

    pub fn rows(&self) -> &VecDeque<DynamicObject> {
        &self.rows
    }

    /// Feed an event. Returns a batch when the size or time budget is reached, or when a
    /// snapshot completes.
    pub fn push(&mut self, event: WatchEvent) -> Option<FlushedBatch> {
        match event {
            WatchEvent::StartingSnapshot => {
                // Discard the materialized view; the snapshot re-establishes it. Anything
                // already queued belongs to the previous generation and must not be
                // emitted alongside snapshot rows.
                self.rows.clear();
                self.pending_upserts.clear();
                self.pending_deletions.clear();
                self.since_flush = Duration::ZERO;
                self.snapshot_open = true;
                self.snapshot_overflowed = false;
                return None;
            }
            WatchEvent::Applied(obj) => {
                let obj = *obj;
                self.remove_by_uid(&uid_of(&obj));
                self.rows.push_back(obj.clone());
                self.pending_upserts.push(obj);
                if self.snapshot_open
                    && self.pending_upserts.len() + self.pending_deletions.len()
                        >= self.budget.max_batch_size
                {
                    // A snapshot larger than one batch cannot be flushed yet without
                    // dropping rows; remember it so the completed batch says so.
                    self.snapshot_overflowed = true;
                }
            }
            WatchEvent::Deleted(uid) => {
                self.remove_by_uid(&uid);
                self.pending_deletions.push(uid);
                if self.snapshot_open {
                    self.snapshot_overflowed = true;
                }
            }
            WatchEvent::SnapshotComplete => {
                self.snapshot_open = false;
                return Some(self.flush_snapshot(self.snapshot_overflowed));
            }
            WatchEvent::Error(_) => return None,
        }
        if !self.snapshot_open
            && self.pending_upserts.len() + self.pending_deletions.len()
                >= self.budget.max_batch_size
        {
            return Some(self.flush(false));
        }
        None
    }

    /// Advance the clock. Returns a batch if the flush interval elapsed with work pending.
    /// Ticks never emit while a snapshot is still being read.
    pub fn tick(&mut self, elapsed: Duration) -> Option<FlushedBatch> {
        self.since_flush += elapsed;
        if self.snapshot_open {
            return None;
        }
        if self.since_flush >= self.budget.flush_interval
            && !(self.pending_upserts.is_empty() && self.pending_deletions.is_empty())
        {
            return Some(self.flush(false));
        }
        None
    }

    /// Force a flush, marking it truncated when the accumulator was asked to shed state.
    pub fn flush(&mut self, truncated: bool) -> FlushedBatch {
        self.flush_with(truncated, false)
    }

    fn flush_snapshot(&mut self, truncated: bool) -> FlushedBatch {
        self.flush_with(truncated, true)
    }

    fn flush_with(&mut self, truncated: bool, is_snapshot: bool) -> FlushedBatch {
        let batch = FlushedBatch {
            batch_id: self.next_batch_id,
            upserts: std::mem::take(&mut self.pending_upserts),
            deletions: std::mem::take(&mut self.pending_deletions),
            truncated,
            is_snapshot,
        };
        self.next_batch_id += 1;
        self.since_flush = Duration::ZERO;
        batch
    }

    fn remove_by_uid(&mut self, uid: &str) {
        self.rows.retain(|obj| uid_of(obj) != uid);
    }
}

pub fn uid_of(obj: &DynamicObject) -> String {
    obj.metadata
        .uid
        .clone()
        .or_else(|| obj.metadata.name.clone())
        .unwrap_or_default()
}

/// Defence in depth: a namespaced view must never surface rows from another namespace,
/// even if the API server or a future `Api::all_with` call disagrees with the watch scope.
pub fn in_namespace_filter(namespace: &str, obj: &DynamicObject) -> bool {
    if namespace.is_empty() {
        return true;
    }
    obj.metadata.namespace.as_deref() == Some(namespace)
}

/// Least-recently-used registry enforcing [`WatchBudget::max_watches`].
pub struct WatchRegistry {
    capacity: usize,
    order: VecDeque<String>,
}

impl WatchRegistry {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            order: VecDeque::new(),
        }
    }

    /// Register or touch a key. Returns the key to evict, if the registry was full.
    pub fn register(&mut self, key: &str) -> Option<String> {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
            self.order.push_back(key.to_string());
            return None;
        }
        let mut evicted = None;
        if self.order.len() >= self.capacity {
            evicted = self.order.pop_front();
        }
        self.order.push_back(key.to_string());
        evicted
    }

    pub fn remove(&mut self, key: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.order.iter()
    }
}

/// Convert a `DynamicObject` into the flat summary the UI renders.
///
/// `kind` always carries the resource kind from API discovery; it is never inferred from
/// the object so a delta row can not silently lose it.
pub fn summarize(obj: &DynamicObject, kind: &str) -> Option<crate::ipc::dto::ResourceSummaryDto> {
    debug_assert!(!kind.is_empty(), "summarize requires the discovered kind");
    let uid = obj.metadata.uid.clone()?;
    let name = obj.metadata.name.clone()?;
    let labels = obj
        .metadata
        .labels
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect();

    let controlled_by = obj
        .metadata
        .owner_references
        .as_ref()
        .and_then(|owners| owners.first())
        .map(|o| format!("{}/{}", o.kind, o.name));

    let spec = obj.data.get("spec");
    let status_obj = obj.data.get("status");

    let mut status = status_obj
        .and_then(|s| s.get("phase"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut ready = None;
    let mut restarts = None;
    let mut node = None;
    let mut message = None;
    let mut taints = None;

    match kind {
        "Pod" => {
            node = spec
                .and_then(|s| s.get("nodeName"))
                .and_then(Value::as_str)
                .map(str::to_string);

            let total_spec = spec
                .and_then(|s| s.get("containers"))
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0);

            if let Some(cs) = status_obj
                .and_then(|s| s.get("containerStatuses"))
                .and_then(Value::as_array)
            {
                let total = cs.len().max(total_spec);
                let ready_count = cs
                    .iter()
                    .filter(|c| c.get("ready").and_then(Value::as_bool).unwrap_or(false))
                    .count();
                let restart_sum: u32 = cs
                    .iter()
                    .filter_map(|c| c.get("restartCount").and_then(Value::as_u64))
                    .map(|v| v as u32)
                    .sum();
                ready = Some(format!("{ready_count}/{total}"));
                restarts = Some(restart_sum);

                // Surface container waiting/terminated reason (e.g. CrashLoopBackOff)
                for c in cs {
                    if let Some(reason) = c
                        .get("state")
                        .and_then(|st| st.get("waiting"))
                        .and_then(|w| w.get("reason"))
                        .and_then(Value::as_str)
                    {
                        if !reason.is_empty() {
                            status = Some(reason.to_string());
                            break;
                        }
                    }
                }
            } else if total_spec > 0 {
                let r = if status.as_deref() == Some("Running") {
                    total_spec
                } else {
                    0
                };
                ready = Some(format!("{r}/{total_spec}"));
                restarts = Some(0);
            }

            if obj.metadata.deletion_timestamp.is_some() {
                status = Some("Terminating".to_string());
            }
        }
        "Deployment" | "StatefulSet" | "ReplicaSet" | "ReplicationController" => {
            let desired = spec
                .and_then(|s| s.get("replicas"))
                .and_then(Value::as_u64)
                .or_else(|| {
                    status_obj
                        .and_then(|s| s.get("replicas"))
                        .and_then(Value::as_u64)
                });
            let ready_rep = status_obj
                .and_then(|s| s.get("readyReplicas"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if let Some(d) = desired {
                ready = Some(format!("{ready_rep}/{d}"));
                if status.is_none() {
                    status = Some(if d == 0 {
                        "ScaledToZero".to_string()
                    } else if ready_rep >= d {
                        "Ready".to_string()
                    } else {
                        "Progressing".to_string()
                    });
                }
            }
        }
        "DaemonSet" => {
            let desired = status_obj
                .and_then(|s| s.get("desiredNumberScheduled"))
                .and_then(Value::as_u64);
            let ready_num = status_obj
                .and_then(|s| s.get("numberReady"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if let Some(d) = desired {
                ready = Some(format!("{ready_num}/{d}"));
                if status.is_none() {
                    status = Some(if ready_num >= d && d > 0 {
                        "Ready".to_string()
                    } else {
                        "Progressing".to_string()
                    });
                }
            }
        }
        "Job" => {
            let completions = spec
                .and_then(|s| s.get("completions"))
                .and_then(Value::as_u64)
                .unwrap_or(1);
            let succeeded = status_obj
                .and_then(|s| s.get("succeeded"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if status_obj.is_some() || spec.is_some() {
                ready = Some(format!("{succeeded}/{completions}"));
            }
        }
        "Node" => {
            if let Some(conds) = status_obj
                .and_then(|s| s.get("conditions"))
                .and_then(Value::as_array)
            {
                for cond in conds {
                    if cond.get("type").and_then(Value::as_str) == Some("Ready") {
                        let ok = cond.get("status").and_then(Value::as_str) == Some("True");
                        status = Some(if ok { "Ready" } else { "NotReady" }.to_string());
                    }
                }
            }
            node = status_obj
                .and_then(|s| s.get("nodeInfo"))
                .and_then(|ni| ni.get("kubeletVersion"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let taint_items = spec.and_then(|s| s.get("taints")).and_then(Value::as_array);
            taints = Some(taint_items.map(|arr| arr.len() as u32).unwrap_or(0));
            if let Some(arr) = taint_items.filter(|a| !a.is_empty()) {
                let summary: Vec<String> = arr
                    .iter()
                    .filter_map(|t| {
                        let key = t.get("key").and_then(Value::as_str)?;
                        let val = t.get("value").and_then(Value::as_str).unwrap_or("");
                        let eff = t.get("effect").and_then(Value::as_str).unwrap_or("");
                        let kv = if val.is_empty() {
                            key.to_string()
                        } else {
                            format!("{key}={val}")
                        };
                        Some(if eff.is_empty() {
                            kv
                        } else {
                            format!("{kv}:{eff}")
                        })
                    })
                    .collect();
                if !summary.is_empty() {
                    message = Some(summary.join(", "));
                }
            }
        }
        "Service" => {
            let svc_type = spec
                .and_then(|s| s.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("ClusterIP");
            let cluster_ip = spec
                .and_then(|s| s.get("clusterIP"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !cluster_ip.is_empty() {
                node = Some(format!("{svc_type} · {cluster_ip}"));
            } else if spec.is_some() {
                node = Some(svc_type.to_string());
            }
        }
        "Secret" => {
            node = obj
                .data
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        "ConfigMap" => {
            if let Some(data_map) = obj.data.get("data").and_then(Value::as_object) {
                node = Some(format!("{} keys", data_map.len()));
            }
        }
        "Event" => {
            if status.is_none() {
                status = obj
                    .data
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            if let Some(inv) = obj.data.get("involvedObject") {
                let ik = inv.get("kind").and_then(Value::as_str).unwrap_or("");
                let iname = inv.get("name").and_then(Value::as_str).unwrap_or("");
                if !ik.is_empty() && !iname.is_empty() {
                    node = Some(format!("{ik}/{iname}"));
                } else if !iname.is_empty() {
                    node = Some(iname.to_string());
                }
            }
            restarts = obj
                .data
                .get("count")
                .and_then(Value::as_u64)
                .map(|c| c as u32);
            let reason = obj.data.get("reason").and_then(Value::as_str).unwrap_or("");
            let msg = obj
                .data
                .get("message")
                .or_else(|| obj.data.get("note"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !reason.is_empty() || !msg.is_empty() {
                message = Some(if !reason.is_empty() && !msg.is_empty() {
                    format!("{reason}: {msg}")
                } else {
                    format!("{reason}{msg}")
                });
            }
        }
        _ => {}
    }

    Some(crate::ipc::dto::ResourceSummaryDto {
        uid,
        name,
        namespace: obj.metadata.namespace.clone(),
        kind: kind.to_string(),
        created_at: obj
            .metadata
            .creation_timestamp
            .as_ref()
            .map(|t| t.0.to_rfc3339())
            .unwrap_or_default(),
        labels,
        status,
        ready,
        restarts,
        controlled_by,
        node,
        message,
        taints,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

    fn pod(name: &str, uid: &str) -> DynamicObject {
        DynamicObject {
            types: None,
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                uid: Some(uid.to_string()),
                namespace: Some("dev".to_string()),
                ..Default::default()
            },
            data: Value::Object(Default::default()),
        }
    }

    fn applied(obj: DynamicObject) -> WatchEvent {
        WatchEvent::Applied(Box::new(obj))
    }

    fn accumulator() -> DeltaAccumulator {
        DeltaAccumulator::new(WatchBudget {
            max_watches: 2,
            max_batch_size: 3,
            flush_interval: Duration::from_millis(100),
        })
    }

    #[test]
    fn batches_when_size_budget_hit() {
        let mut acc = accumulator();
        assert!(acc.push(applied(pod("a", "1"))).is_none());
        assert!(acc.push(applied(pod("b", "2"))).is_none());
        let batch = acc.push(applied(pod("c", "3"))).unwrap();
        assert_eq!(batch.batch_id, 1);
        assert_eq!(batch.upserts.len(), 3);
        assert!(!batch.truncated);
    }

    #[test]
    fn batches_on_time_budget_only_with_pending_work() {
        let mut acc = accumulator();
        assert!(acc.tick(Duration::from_millis(200)).is_none());
        acc.push(applied(pod("a", "1")));
        let batch = acc.tick(Duration::from_millis(100)).unwrap();
        assert_eq!(batch.upserts.len(), 1);
        assert_eq!(batch.batch_id, 1);
        // Idle ticks do not emit.
        assert!(acc.tick(Duration::from_millis(500)).is_none());
    }

    #[test]
    fn batch_ids_are_monotonic() {
        let mut acc = accumulator();
        acc.push(applied(pod("a", "1")));
        let first = acc.flush(false);
        acc.push(applied(pod("b", "2")));
        let second = acc.flush(false);
        assert_eq!((first.batch_id, second.batch_id), (1, 2));
    }

    #[test]
    fn deletions_are_recorded_and_removed_from_rows() {
        let mut acc = accumulator();
        acc.push(applied(pod("a", "1")));
        // One applied + one deleted reaches the batch-size budget of 3 after the
        // accumulator pads with a second applied event below.
        acc.push(applied(pod("b", "2")));
        let batch = acc.push(WatchEvent::Deleted("1".to_string())).unwrap();
        assert_eq!(batch.deletions, vec!["1"]);
        assert_eq!(acc.rows().len(), 1);
    }

    #[test]
    fn forced_flush_reports_pending_deletions() {
        let mut acc = accumulator();
        acc.push(applied(pod("a", "1")));
        acc.push(WatchEvent::Deleted("1".to_string()));
        let batch = acc.flush(false);
        assert_eq!(batch.deletions, vec!["1"]);
        assert!(acc.rows().is_empty());
    }

    #[test]
    fn uid_replacement_does_not_duplicate_rows() {
        let mut acc = accumulator();
        acc.push(applied(pod("a", "1")));
        acc.push(applied(pod("a", "1")));
        assert_eq!(acc.rows().len(), 1);
    }

    #[test]
    fn restarted_clears_materialized_state() {
        let mut acc = accumulator();
        acc.push(applied(pod("a", "1")));
        acc.push(WatchEvent::StartingSnapshot);
        assert!(acc.rows().is_empty());
        let batch = acc.flush(false);
        assert!(batch.upserts.is_empty());
    }

    #[test]
    fn init_apply_events_are_accumulated_not_dropped() {
        let mut acc = accumulator();
        assert!(acc.push(WatchEvent::StartingSnapshot).is_none());
        assert!(acc.push(applied(pod("a", "1"))).is_none());
        assert!(acc.push(applied(pod("b", "2"))).is_none());
        // Two rows is below max_batch_size, so nothing is emitted mid-snapshot.
        assert_eq!(acc.rows().len(), 2);
    }

    #[test]
    fn init_done_flushes_one_batch_with_full_set() {
        let mut acc = accumulator();
        acc.push(WatchEvent::StartingSnapshot);
        acc.push(applied(pod("a", "1")));
        acc.push(applied(pod("b", "2")));
        let batch = acc.push(WatchEvent::SnapshotComplete).unwrap();
        assert!(batch.is_snapshot);
        assert!(!batch.truncated);
        assert_eq!(batch.upserts.len(), 2);
        assert_eq!(batch.batch_id, 1);
        // Nothing left pending after the snapshot flush.
        assert!(acc.tick(Duration::from_millis(500)).is_none());
    }

    #[test]
    fn second_init_snapshot_replaces_previous_rows() {
        let mut acc = accumulator();
        acc.push(applied(pod("old", "1")));
        acc.flush(false);
        acc.push(WatchEvent::StartingSnapshot);
        acc.push(applied(pod("new", "2")));
        let batch = acc.push(WatchEvent::SnapshotComplete).unwrap();
        assert!(batch.is_snapshot);
        assert_eq!(batch.upserts.len(), 1);
        assert_eq!(uid_of(&batch.upserts[0]), "2");
        assert_eq!(acc.rows().len(), 1);
    }

    #[test]
    fn oversized_snapshot_is_marked_truncated_but_keeps_all_rows() {
        let mut acc = accumulator();
        acc.push(WatchEvent::StartingSnapshot);
        for i in 0..5 {
            acc.push(applied(pod(&format!("p{i}"), &format!("{i}"))));
        }
        let batch = acc.push(WatchEvent::SnapshotComplete).unwrap();
        assert!(batch.is_snapshot);
        assert!(
            batch.truncated,
            "snapshot larger than one batch must say so"
        );
        assert_eq!(batch.upserts.len(), 5, "no snapshot row may be dropped");
    }

    #[test]
    fn ticks_do_not_emit_during_a_snapshot() {
        let mut acc = accumulator();
        acc.push(WatchEvent::StartingSnapshot);
        acc.push(applied(pod("a", "1")));
        assert!(acc.tick(Duration::from_millis(500)).is_none());
        assert!(acc.push(WatchEvent::SnapshotComplete).is_some());
    }

    #[test]
    fn normal_batches_are_not_marked_as_snapshots() {
        let mut acc = accumulator();
        acc.push(applied(pod("a", "1")));
        acc.push(applied(pod("b", "2")));
        let batch = acc.push(applied(pod("c", "3"))).unwrap();
        assert!(!batch.is_snapshot);
    }

    #[test]
    fn registry_evicts_least_recently_used() {
        let mut reg = WatchRegistry::new(2);
        assert!(reg.register("a").is_none());
        assert!(reg.register("b").is_none());
        assert_eq!(reg.register("c"), Some("a".to_string()));
        assert_eq!(reg.len(), 2);
        // Touching "b" makes "c" the next victim.
        assert!(reg.register("b").is_none());
        assert_eq!(reg.register("d"), Some("c".to_string()));
    }

    #[test]
    fn registry_remove_frees_a_slot() {
        let mut reg = WatchRegistry::new(1);
        reg.register("a");
        reg.remove("a");
        assert!(reg.is_empty());
        assert!(reg.register("b").is_none());
    }

    #[test]
    fn summarize_reads_phase_and_omits_missing_uid() {
        let mut obj = pod("a", "1");
        obj.data = serde_json::json!({"status": {"phase": "Running"}});
        let s = summarize(&obj, "Pod").unwrap();
        assert_eq!(s.status.as_deref(), Some("Running"));
        assert_eq!(s.namespace.as_deref(), Some("dev"));

        let mut no_uid = pod("b", "2");
        no_uid.metadata.uid = None;
        assert!(summarize(&no_uid, "Pod").is_none());
    }

    #[test]
    fn summarize_defaults_created_at_when_missing() {
        let obj = pod("a", "1");
        let s = summarize(&obj, "Pod").unwrap();
        assert_eq!(s.created_at, "");
    }

    #[test]
    fn summarize_uses_the_discovered_kind() {
        let obj = pod("a", "1");
        assert_eq!(summarize(&obj, "Pod").unwrap().kind, "Pod");
        assert_eq!(summarize(&obj, "CustomKind").unwrap().kind, "CustomKind");
    }

    #[test]
    fn namespace_filter_admits_everything_for_all_namespaces() {
        let obj = pod("a", "1");
        assert!(in_namespace_filter("", &obj));
    }

    #[test]
    fn namespace_filter_rejects_other_namespaces() {
        let obj = pod("a", "1");
        assert!(in_namespace_filter("dev", &obj));
        assert!(!in_namespace_filter("prod", &obj));

        let mut cluster_scoped = pod("node", "2");
        cluster_scoped.metadata.namespace = None;
        assert!(!in_namespace_filter("dev", &cluster_scoped));
        assert!(in_namespace_filter("", &cluster_scoped));
    }

    #[test]
    fn summarize_extracts_node_taints_count_and_details() {
        let mut tainted = pod("node-gpu-1", "n1");
        tainted.metadata.namespace = None;
        tainted.data = serde_json::json!({
            "spec": {
                "taints": [
                    { "key": "dedicated", "value": "gpu", "effect": "NoSchedule" },
                    { "key": "node.kubernetes.io/unschedulable", "effect": "NoSchedule" }
                ]
            },
            "status": {
                "conditions": [{ "type": "Ready", "status": "True" }],
                "nodeInfo": { "kubeletVersion": "v1.36.5-eks-9adbfea" }
            }
        });
        let s = summarize(&tainted, "Node").unwrap();
        assert_eq!(s.status.as_deref(), Some("Ready"));
        assert_eq!(s.node.as_deref(), Some("v1.36.5-eks-9adbfea"));
        assert_eq!(s.taints, Some(2));
        assert_eq!(
            s.message.as_deref(),
            Some("dedicated=gpu:NoSchedule, node.kubernetes.io/unschedulable:NoSchedule")
        );

        let mut clean = pod("node-std-1", "n2");
        clean.metadata.namespace = None;
        clean.data = serde_json::json!({
            "spec": {},
            "status": { "conditions": [{ "type": "Ready", "status": "True" }] }
        });
        let s2 = summarize(&clean, "Node").unwrap();
        assert_eq!(s2.taints, Some(0));
        assert_eq!(s2.message, None);
    }
}
