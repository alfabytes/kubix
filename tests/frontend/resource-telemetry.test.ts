import { describe, expect, it } from "vitest";

import type { DiscoveredResourceDto } from "@/lib/ipc/types";
import { parseManifestSummary, resolveGvrForKind } from "@/lib/resource-telemetry";

describe("manifest reference extraction & GVR resolver", () => {
  it("extracts ownerReferences, mounted/env ConfigMaps, and Secrets from Pod YAML", () => {
    const yaml = `apiVersion: v1
kind: Pod
metadata:
  name: api-gateway-6f7d8b9c4-xyz12
  namespace: kubix-demo
  ownerReferences:
  - apiVersion: apps/v1
    blockOwnerDeletion: true
    controller: true
    kind: ReplicaSet
    name: api-gateway-6f7d8b9c4
    uid: rs-uid-1
spec:
  serviceAccountName: gateway-sa
  nodeName: worker-node-1
  containers:
  - name: gateway
    image: nginx:1.27
    envFrom:
    - configMapRef:
        name: env-config
    - secretRef:
        name: env-secret
    env:
    - name: DB_PASS
      valueFrom:
        secretKeyRef:
          name: db-creds
          key: password
    - name: LOG_LEVEL
      valueFrom:
        configMapKeyRef:
          name: runtime-flags
          key: logLevel
  volumes:
  - name: cfg
    configMap:
      name: app-config
  - name: tls
    secret:
      secretName: tls-cert
  - name: dup
    configMap:
      name: app-config
`;

    const parsed = parseManifestSummary(yaml, {
      gvr: "/v1/pods",
      name: "api-gateway-6f7d8b9c4-xyz12",
      namespace: "kubix-demo",
    });

    expect(parsed.ownerReferences).toEqual([
      {
        kind: "ReplicaSet",
        name: "api-gateway-6f7d8b9c4",
        apiVersion: "apps/v1",
      },
    ]);
    expect(parsed.configMapRefs).toEqual(["app-config", "env-config", "runtime-flags"]);
    expect(parsed.secretRefs).toEqual(["db-creds", "env-secret", "tls-cert"]);
    expect(parsed.nodeName).toBe("worker-node-1");
    expect(parsed.serviceAccount).toBe("gateway-sa");
  });

  it("extracts ConfigMap and Secret refs when serde_yaml sorts keys alphabetically (defaultMode/key before name)", () => {
    const yaml = `apiVersion: v1
kind: Pod
metadata:
  name: sorted-keys-pod
  namespace: kubix-demo
spec:
  containers:
  - env:
    - name: DB_PASS
      valueFrom:
        secretKeyRef:
          key: password
          name: db-creds
    - name: LOG_LEVEL
      valueFrom:
        configMapKeyRef:
          key: logLevel
          name: runtime-flags
    envFrom:
    - configMapRef:
        name: env-config
        optional: true
    - secretRef:
        name: env-secret
        optional: false
    image: nginx:1.27
    name: gateway
  volumes:
  - configMap:
      defaultMode: 420
      items:
      - key: app.conf
        path: app.conf
      name: app-config
    name: cfg
  - name: tls
    secret:
      defaultMode: 420
      secretName: tls-cert
`;

    const parsed = parseManifestSummary(yaml, {
      gvr: "/v1/pods",
      name: "sorted-keys-pod",
      namespace: "kubix-demo",
    });

    expect(parsed.configMapRefs).toEqual(["app-config", "env-config", "runtime-flags"]);
    expect(parsed.secretRefs).toEqual(["db-creds", "env-secret", "tls-cert"]);
  });

  it("resolves cluster-scoped vs namespaced GVRs and prefers discovered resources (including CRDs)", () => {
    expect(resolveGvrForKind("Node")).toEqual({ gvr: "/v1/nodes", namespaced: false });
    expect(resolveGvrForKind("Namespace")).toEqual({ gvr: "/v1/namespaces", namespaced: false });
    expect(resolveGvrForKind("ServiceAccount")).toEqual({
      gvr: "/v1/serviceaccounts",
      namespaced: true,
    });
    expect(resolveGvrForKind("ReplicaSet")).toEqual({
      gvr: "apps/v1/replicasets",
      namespaced: true,
    });
    expect(resolveGvrForKind("ConfigMap")).toEqual({
      gvr: "/v1/configmaps",
      namespaced: true,
    });
    expect(resolveGvrForKind("Secret")).toEqual({ gvr: "/v1/secrets", namespaced: true });

    const discovered: DiscoveredResourceDto[] = [
      {
        gvr: "cert-manager.io/v1/certificates",
        kind: "Certificate",
        group: "cert-manager.io",
        version: "v1",
        plural: "certificates",
        namespaced: true,
        shortNames: ["cert"],
        verbs: ["get", "list", "watch"],
        curated: false,
      },
    ];

    expect(resolveGvrForKind("Certificate", discovered)).toEqual({
      gvr: "cert-manager.io/v1/certificates",
      namespaced: true,
    });
    expect(resolveGvrForKind("Certificate", [])).toBeNull();
    expect(resolveGvrForKind("UnknownCustomThing", discovered)).toBeNull();
  });
});
