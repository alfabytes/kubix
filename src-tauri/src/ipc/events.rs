pub struct EventSpec {
    pub name: &'static str,
    pub payload: &'static str,
}

pub const RESOURCE_DELTA: &str = "kubix://resource-delta";
pub const CONTEXT_STATE: &str = "kubix://context-state";
pub const WATCH_EVICTED: &str = "kubix://watch-evicted";
pub const SHELL_OUTPUT: &str = "kubix://shell-output";
pub const POD_LOG_LINE: &str = "kubix://pod-log-line";
pub const CLOSE_ACTIVE_TAB: &str = "kubix://close-active-tab";

pub const EVENTS: &[EventSpec] = &[
    EventSpec {
        name: RESOURCE_DELTA,
        payload: "ResourceDeltaDto",
    },
    EventSpec {
        name: CONTEXT_STATE,
        payload: "ClusterContextDto",
    },
    EventSpec {
        name: WATCH_EVICTED,
        payload: "WatchEvictedDto",
    },
    EventSpec {
        name: SHELL_OUTPUT,
        payload: "ShellOutputDto",
    },
    EventSpec {
        name: POD_LOG_LINE,
        payload: "PodLogLineDto",
    },
    EventSpec {
        name: CLOSE_ACTIVE_TAB,
        payload: "null",
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_namespaced() {
        for event in EVENTS {
            assert!(event.name.starts_with("kubix://"), "{}", event.name);
        }
    }
}
