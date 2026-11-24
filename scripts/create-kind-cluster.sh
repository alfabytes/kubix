#!/usr/bin/env bash
# Disposable cluster for development and manual acceptance of Kubix.
#
# Kubix is read-only, so nothing here can damage a real cluster. This script also seeds
# a Secret so the masking path has something to hide.
#
# Requires a working container runtime (Docker Desktop, OrbStack, Colima, or Podman).
set -euo pipefail

CLUSTER_NAME="${KUBIX_KIND_CLUSTER:-kubix-dev}"
CONTEXT="kind-${CLUSTER_NAME}"

command -v kind >/dev/null || { echo "kind is not installed (brew install kind)" >&2; exit 1; }

if ! docker info >/dev/null 2>&1; then
  echo "No container runtime is reachable by docker. Kubix does not need one to run," >&2
  echo "but 'kind' does. Start Docker Desktop / OrbStack / Colima, or run:" >&2
  echo "  podman machine start && docker context use podman" >&2
  exit 1
fi

if kind get clusters | grep -qx "$CLUSTER_NAME"; then
  echo "Cluster '$CLUSTER_NAME' already exists."
else
  kind create cluster --name "$CLUSTER_NAME" --wait 120s
fi

kubectl --context "$CONTEXT" create namespace kubix-demo --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
kubectl --context "$CONTEXT" -n kubix-demo create secret generic kubix-demo-secret \
  --from-literal=password=super-secret-value \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
kubectl --context "$CONTEXT" -n kubix-demo create deployment web \
  --image=nginx:alpine --replicas=2 --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -

cat <<'EOF' | kubectl --context "$CONTEXT" -n kubix-demo apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: kubix-demo
  labels:
    app: api-gateway
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      initContainers:
        - name: init-config
          image: nginx:alpine
          imagePullPolicy: IfNotPresent
          command:
            - sh
            - -c
            - |
              echo "[init-config] verifying upstream endpoints..."
              echo "[init-config] bootstrap configuration complete"
      containers:
        - name: gateway
          image: nginx:alpine
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 80
        - name: metrics-sidecar
          image: nginx:alpine
          imagePullPolicy: IfNotPresent
          command:
            - sh
            - -c
            - |
              echo "[metrics-sidecar] starting telemetry collector on :9090"
              while true; do
                echo "[metrics-sidecar] scraped upstream metrics (status=200)"
                sleep 10
              done
        - name: audit-logger
          image: nginx:alpine
          imagePullPolicy: IfNotPresent
          command:
            - sh
            - -c
            - |
              echo "[audit-logger] audit trail stream connected"
              while true; do
                echo "[audit-logger] checkpoint synced"
                sleep 15
              done
EOF

kubectl --context "$CONTEXT" -n kubix-demo expose deployment api-gateway \
  --name=api-gateway --port=80 --target-port=80 --dry-run=client -o yaml | kubectl --context "$CONTEXT" -n kubix-demo apply -f -

echo
echo "Ready. Kubix will list context: $CONTEXT"
echo
echo "Run the kind acceptance suite with:"
echo "  KUBIX_KIND_CONTEXT=$CONTEXT cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --test-threads=1"
echo "Tear down with: kind delete cluster --name $CLUSTER_NAME"
