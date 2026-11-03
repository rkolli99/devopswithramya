---
title: "Kubernetes CreateContainerConfigError: Missing ConfigMaps, Secrets and Keys Explained"
date: 2026-11-04T00:00:00+05:30
draft: false
description: "Why your pod is stuck in CreateContainerConfigError, how to find the exact cause in under a minute, and how to stop it from reaching production."
tags: ["kubernetes", "troubleshooting", "configmap", "secrets", "kubectl"]
categories: ["Kubernetes"]
---

> **Kubernetes Pod Failures — Debugging Series**
> 1. [CrashLoopBackOff](/posts/kubernetes-crashloopbackoff-fix/)
> 2. Pending *(coming soon)*
> 3. ImagePullBackOff *(coming soon)*
> 4. OOMKilled *(coming soon)*
> 5. **CreateContainerConfigError** ← you are here
> 6. Evicted pods *(coming soon)*

You deploy, run `kubectl get pods`, and see this:

```
NAME                          READY   STATUS                       RESTARTS   AGE
orders-api-7d9f8c6b5-x2kqp    0/1     CreateContainerConfigError   0          45s
```

Restarts are `0`. Logs are empty. The image pulled fine. So what's broken?

`CreateContainerConfigError` means the kubelet **could not build the container's configuration**, so the container was never created. Your application code never ran. That's why there is nothing in the logs — and why this error is almost always about **configuration your pod references but can't find**.

---

## Why `kubectl logs` won't help

The first instinct is to check logs:

```bash
kubectl logs orders-api-7d9f8c6b5-x2kqp
```

```
Error from server (BadRequest): container "orders-api" in pod "orders-api-7d9f8c6b5-x2kqp" is waiting to start: CreateContainerConfigError
```

There's no process, so there are no logs. Skip this step. The answer is in the **events**.

---

## Step 1: Get the exact reason

```bash
kubectl describe pod orders-api-7d9f8c6b5-x2kqp
```

Scroll to the `Events` section at the bottom:

```
Events:
  Type     Reason     Age                From     Message
  ----     ------     ----               ----     -------
  Normal   Scheduled  60s                default-scheduler  Successfully assigned default/orders-api-7d9f8c6b5-x2kqp to worker-1
  Normal   Pulled     12s (x6 over 58s)  kubelet  Container image "orders-api:1.4.2" already present on machine
  Warning  Failed     12s (x6 over 58s)  kubelet  Error: configmap "orders-config" not found
```

That last line is your root cause. The message tells you exactly which of the cases below you're in.

If you're dealing with many pods, this is faster:

```bash
kubectl get events -n <namespace> --field-selector reason=Failed --sort-by=.lastTimestamp
```

---

## The 4 causes (and what each error message looks like)

### 1. The ConfigMap doesn't exist

```
Error: configmap "orders-config" not found
```

Your pod spec references it through `env` or `envFrom`:

```yaml
envFrom:
  - configMapRef:
      name: orders-config
```

Check:

```bash
kubectl get configmap orders-config -n <namespace>
```

Common reasons: it was never applied, it was applied **after** the Deployment, or there's a typo in the name.

### 2. The Secret doesn't exist

```
Error: secret "db-credentials" not found
```

Same pattern, with `secretKeyRef` or `secretRef`:

```yaml
env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: db-credentials
        key: password
```

Check:

```bash
kubectl get secret db-credentials -n <namespace>
```

If your secrets come from an external tool (External Secrets Operator, Sealed Secrets, a CI step), the Secret object may not have been created yet. Check that tool's status, not just your Deployment.

### 3. The object exists, but the key doesn't

This is the sneaky one. The ConfigMap is there, so a quick `kubectl get` looks fine:

```
Error: couldn't find key DB_HOST in ConfigMap default/orders-config
```

Check the actual keys:

```bash
kubectl get configmap orders-config -n <namespace> -o jsonpath='{.data}' 
```

For a Secret, list keys without printing values:

```bash
kubectl get secret db-credentials -n <namespace> -o jsonpath='{.data}' | jq 'keys'
```

Keys are **case-sensitive**. `db_host`, `DB_HOST` and `DbHost` are three different keys.

### 4. Wrong namespace

ConfigMaps and Secrets are namespaced. A pod can only reference objects **in its own namespace**.

```bash
kubectl get configmap -A | grep orders-config
```

If it shows up in `default` but your pod runs in `orders`, that's your problem. You can't point across namespaces — the object has to exist in the pod's namespace.

---

## Bonus cause: `runAsNonRoot`

Not every `CreateContainerConfigError` is about ConfigMaps. If you see this:

```
Error: container has runAsNonRoot and image will run as root
```

Your pod's `securityContext` says `runAsNonRoot: true`, but the image's default user is root (UID 0). Fix it by setting a non-root user:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
```

Or fix the image itself with a `USER` instruction in the Dockerfile. Make sure that user can still read the files the app needs.

---

## Wait — why isn't my volume mount showing this error?

If the missing ConfigMap is mounted as a **volume** instead of used as an environment variable, you won't see `CreateContainerConfigError`. The pod stays in `ContainerCreating` instead, with an event like:

```
Warning  FailedMount  kubelet  MountVolume.SetUp failed for volume "config" : configmap "orders-config" not found
```

Same root cause, different symptom. Worth knowing so you don't go looking in the wrong place.

---

## The fix: you usually don't need to restart anything

Once you create the missing object or add the missing key, the kubelet keeps retrying and picks it up on its own:

```bash
kubectl apply -f orders-config.yaml
kubectl get pods -w
```

```
orders-api-7d9f8c6b5-x2kqp    0/1     CreateContainerConfigError   0          3m
orders-api-7d9f8c6b5-x2kqp    1/1     Running                      0          3m12s
```

No need to delete the pod or run `rollout restart`. If it doesn't recover within a minute or so, re-check the event — you may have fixed one missing key and there's another one behind it.

---

## Reproduce it yourself (2 minutes on kind or minikube)

The best way to remember this error is to cause it on purpose:

```bash
kubectl create deployment demo --image=nginx
kubectl set env deployment/demo --from=configmap/does-not-exist
kubectl get pods
```

You'll see `CreateContainerConfigError`. Now fix it:

```bash
kubectl create configmap does-not-exist --from-literal=APP_MODE=test
kubectl get pods -w
```

Watch it move to `Running` without a restart. Then try the missing-key version:

```bash
kubectl set env deployment/demo --from=configmap/does-not-exist --keys=WRONG_KEY
```

Clean up:

```bash
kubectl delete deployment demo
kubectl delete configmap does-not-exist
```

---

## Preventing it

**Apply config before workloads.** With plain manifests, apply ConfigMaps and Secrets first. With Helm, keep them in the same chart so they ship together. With Kustomize, generating ConfigMaps with `configMapGenerator` keeps the name and the reference in sync automatically.

**Use `optional: true` only when the value is genuinely optional.**

```yaml
envFrom:
  - configMapRef:
      name: feature-flags
      optional: true
```

The pod will start without it. That's useful for nice-to-have config — and dangerous for anything like a database password, where you'd rather fail loudly at startup than run with a missing value.

**Validate against the real cluster before deploying.**

```bash
kubectl apply -f deployment.yaml --dry-run=server
```

This catches schema problems, but note it does **not** check that referenced ConfigMaps or Secrets exist. That check has to be explicit — for example, a pipeline step that runs `kubectl get configmap <name> -n <namespace>` for each referenced object before the deploy step.

**Treat renamed keys as a breaking change.** Most "key not found" errors come from someone renaming a key in the ConfigMap while an older Deployment still references the old name.

---

## Quick reference

| Event message | Cause | Check |
|---|---|---|
| `configmap "X" not found` | ConfigMap missing | `kubectl get cm X -n <ns>` |
| `secret "X" not found` | Secret missing | `kubectl get secret X -n <ns>` |
| `couldn't find key K in ConfigMap/Secret` | Key missing or wrong case | `kubectl get cm X -o jsonpath='{.data}'` |
| Object exists elsewhere | Wrong namespace | `kubectl get cm -A \| grep X` |
| `has runAsNonRoot and image will run as root` | Image runs as UID 0 | Set `runAsUser` or fix the image |

**The one-line takeaway:** `CreateContainerConfigError` means your app never started — skip the logs, run `kubectl describe pod`, and read the last event.

---

*Next in the series: **Evicted pods** — what node pressure is, and why Kubernetes kills your pod to save the node.*