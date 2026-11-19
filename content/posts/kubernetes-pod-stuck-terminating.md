---
title: "Kubernetes Pod Stuck in Terminating: Causes and How to Fix It Safely (2026)"
date: 2026-11-20T00:00:00+05:30
draft: false
description: "Why your Kubernetes pod or namespace is stuck in Terminating, how to find what's holding it, and when force delete is safe — and when it isn't."
tags: ["kubernetes", "troubleshooting", "finalizers", "kubectl"]
author: "Ramya Kolli"
---

> Pod failing to start instead? Paste your `kubectl describe pod` output into the [Pod Error Decoder](/tools/pod-error-decoder/).

You delete a pod, and it doesn't go away:

```
NAME                         READY   STATUS        RESTARTS   AGE
inventory-db-0               1/1     Terminating   0          4d
```

Ten minutes later it's still there. The usual reflex is to force delete it — and sometimes that's fine. But sometimes it's exactly the wrong thing to do, and it can leave two copies of the same pod writing to the same data.

`Terminating` means Kubernetes has **accepted the delete request but hasn't finished it**. Something is still holding the pod: a finalizer, a node that's not responding, a volume that won't unmount, or a process that won't stop. Find which one first, then decide.

---

## First: is it actually stuck?

A pod doesn't disappear instantly. When you delete it, Kubernetes:

1. Sends `SIGTERM` to the container's main process.
2. Waits up to `terminationGracePeriodSeconds` — **30 seconds by default** — for it to exit.
3. Sends `SIGKILL` if it's still running.

So a pod sitting in `Terminating` for 30 seconds is normal. Check its grace period before assuming it's stuck:

```bash
kubectl get pod inventory-db-0 -o jsonpath='{.spec.terminationGracePeriodSeconds}'
```

Some databases and queues set this to several minutes on purpose so they can shut down cleanly. If the pod has been Terminating for **longer than its grace period**, it's stuck.

---

## Step 1: Look at what's holding it

```bash
kubectl get pod inventory-db-0 -o yaml
```

Three things to look for in the output:

```yaml
metadata:
  deletionTimestamp: "2026-11-19T18:42:11Z"
  finalizers:
  - example.com/backup-protection
spec:
  nodeName: worker-3
```

- **`deletionTimestamp`** — when the delete was requested. Confirms the delete was accepted.
- **`finalizers`** — if this list isn't empty, something has to remove those entries before the pod can go.
- **`nodeName`** — which node it's on. You'll need this next.

Then check that node:

```bash
kubectl get node worker-3
```

```
NAME       STATUS     ROLES    AGE   VERSION
worker-3   NotReady   <none>   61d   v1.33.2
```

If the node is `NotReady`, that's almost certainly your answer.

---

## The common causes and how to fix each one

### 1. The node is NotReady or gone

The most common cause by far. To finish deleting a pod, the kubelet on the node has to confirm the container has stopped. If the node is down, unreachable or already deleted from your cloud account, nobody can confirm it — so the pod waits.

This is deliberate. Kubernetes can't tell the difference between "the node is dead" and "the node is alive but cut off from the network". In the second case, the container is **still running**. If Kubernetes just removed the pod and started a new one, you'd have two copies running at once.

**Fix it (in order of preference):**

- **Bring the node back.** Once the kubelet reconnects, it stops the container and the pod finishes deleting on its own.
- **If the node is really gone** (the VM was deleted, or the node pool scaled down), delete the Node object. Kubernetes then cleans up all the pods that were on it:
  ```bash
  kubectl delete node worker-3
  ```
- **If the node was shut down but still exists**, you can tell Kubernetes it's out of service. Pods are then cleaned up and their volumes detached so they can start elsewhere:
  ```bash
  kubectl taint nodes worker-3 node.kubernetes.io/out-of-service=nodeshutdown:NoExecute
  ```
  Only do this when you're **sure** the node is powered off. Remove the taint once the node is back.

### 2. A finalizer is blocking deletion

A finalizer is a "don't delete this yet" marker. A controller adds it, does some cleanup when the object is deleted, then removes it. If that controller is broken, uninstalled or can't finish its cleanup, the finalizer stays forever.

**Find it:**

```bash
kubectl get pod inventory-db-0 -o jsonpath='{.metadata.finalizers}'
```

**Fix it:** first, find out what added it. The name usually tells you (`kubernetes.io/...`, a cloud provider, a backup tool, a service mesh). Check whether that controller is running and look at its logs — fixing the controller is the clean fix.

If the controller is gone for good and you're sure the cleanup doesn't matter, remove the finalizer by hand:

```bash
kubectl patch pod inventory-db-0 --type=merge -p '{"metadata":{"finalizers":null}}'
```

The pod is deleted immediately after. Whatever cleanup the finalizer was protecting won't happen — so don't do this blindly.

### 3. A volume won't unmount

The container stopped, but the kubelet can't unmount or detach its volume. Common with NFS mounts where the server is unreachable, and with CSI storage drivers that are crashing.

**Find it:** look at the events:

```bash
kubectl describe pod inventory-db-0 | grep -A 10 Events
```

```
Warning  FailedKillPod  2m  kubelet  error killing pod: failed to "KillPodSandbox" ...
Warning  FailedUnmount  2m  kubelet  UnmountVolume.TearDown failed for volume "data" : ... device or resource busy
```

**Fix it:** check the storage side — is the NFS server reachable from the node, are the CSI driver pods healthy?

```bash
kubectl get pods -n kube-system -o wide | grep -i csi
```

Fixing the storage usually lets the kubelet finish on its own.

### 4. A preStop hook or long grace period

The pod has a `preStop` hook that's hanging (waiting on something that never comes), or a `terminationGracePeriodSeconds` of an hour or more.

**Find it:**

```bash
kubectl get pod inventory-db-0 -o jsonpath='{.spec.terminationGracePeriodSeconds}{"\n"}{.spec.containers[*].lifecycle.preStop}'
```

**Fix it:** this isn't really stuck — it's doing what it was told. If the hook is broken, fix the hook. If you need the pod gone right now, delete with a shorter grace period:

```bash
kubectl delete pod inventory-db-0 --grace-period=10
```

### 5. The container won't die on the node

Rare, but it happens: the process is stuck in the kernel (often waiting on a hung disk or network mount) and doesn't respond even to `SIGKILL`, or the container runtime itself is in a bad state.

**Find it:** the node is `Ready`, there are no finalizers, but the pod still won't go, and events show `FailedKillPod`. On the node, the kubelet logs show repeated "error killing pod" messages.

**Fix it:** restart the container runtime and kubelet on that node (`sudo systemctl restart containerd kubelet`). If the process is stuck in uninterruptible disk sleep, only fixing the underlying disk or rebooting the node clears it.

---

## When is force delete safe?

You'll see this everywhere:

```bash
kubectl delete pod inventory-db-0 --grace-period=0 --force
```

Understand what it actually does: it removes the pod **from the Kubernetes API only**. It does **not** stop the container. If the node is alive but unreachable, the container keeps running.

That's harmless for most stateless Deployments — you briefly have one extra replica.

It's **dangerous for StatefulSets**. A StatefulSet guarantees only one pod with each name (`inventory-db-0`) runs at a time. Force delete breaks that guarantee: Kubernetes starts a new `inventory-db-0` while the old one may still be running and writing to the same volume. For databases, that can corrupt data.

**Rule of thumb:**

| Situation | Force delete? |
|---|---|
| Stateless Deployment pod, node confirmed dead | Fine |
| Any pod, node is `Ready`, cause is a finalizer | Don't — fix or remove the finalizer instead |
| StatefulSet pod, node `NotReady` | Only after you've **confirmed** the node is powered off |
| StatefulSet pod, node status unknown | No — find out first |

---

## Bonus: namespace stuck in Terminating

The other "stuck in Terminating" problem everyone hits. A namespace can't finish deleting until **everything inside it** is gone. Usually one resource with a stuck finalizer is holding the whole namespace.

**Find what's left:**

```bash
kubectl get namespace old-project -o jsonpath='{.status.conditions}' | jq
```

The conditions often name the problem directly, for example `Some resources are remaining` or `Some content in the namespace has finalizers remaining`.

List everything still in the namespace, across all resource types:

```bash
kubectl api-resources --verbs=list --namespaced -o name \
  | xargs -n 1 kubectl get --show-kind --ignore-not-found -n old-project
```

Whatever shows up is what's blocking it. Fix or remove the finalizer on that resource (same as cause 2 above), and the namespace finishes deleting on its own.

One more common cause: if the conditions mention `NamespaceDeletionDiscoveryFailure`, an API extension in the cluster is broken (often an old metrics-server), and Kubernetes can't list everything to delete it. Check:

```bash
kubectl get apiservice | grep False
```

Fix or delete the broken APIService, and the namespace deletion continues.

---

## Reproduce it yourself (2 minutes on kind or minikube)

**Why delete takes 30 seconds:**

```bash
kubectl run slow --image=busybox -- sleep 3600
kubectl delete pod slow
```

It takes about 30 seconds. `sleep` runs as the main process (PID 1) and has no handler for `SIGTERM`, so it ignores it, and Kubernetes waits the full grace period before sending `SIGKILL`. Many real apps have the same problem when started through a shell script that doesn't pass signals on.

**A pod stuck on a finalizer:**

```bash
kubectl run stuck --image=nginx
kubectl patch pod stuck --type=merge -p '{"metadata":{"finalizers":["example.com/block"]}}'
kubectl delete pod stuck --wait=false
kubectl get pod stuck
```

It shows `Terminating` and stays there. Look at why:

```bash
kubectl get pod stuck -o jsonpath='{.metadata.finalizers}'
```

Remove the finalizer, and it's gone straight away:

```bash
kubectl patch pod stuck --type=merge -p '{"metadata":{"finalizers":null}}'
kubectl get pod stuck
```

---

## Quick reference

| What you find | Cause | Fix |
|---|---|---|
| Stuck less than the grace period | Normal shutdown | Wait, or check `terminationGracePeriodSeconds` |
| Node `NotReady` | Kubelet can't confirm the container stopped | Recover the node, or `kubectl delete node` if it's gone |
| `finalizers` not empty | A controller hasn't finished cleanup | Fix the controller, or remove the finalizer if it's safe |
| `FailedUnmount` in events | Volume won't detach | Fix the NFS server or CSI driver |
| Long grace period or `preStop` hook | Configured to wait | Fix the hook, or `--grace-period=10` |
| Node `Ready`, `FailedKillPod` | Runtime or kernel stuck | Restart containerd/kubelet, or reboot the node |
| Namespace stuck | A resource inside has a finalizer | List remaining resources, fix that one |

**The one-line takeaway:** a pod stuck in Terminating is waiting for something. Check `finalizers` and the node's status before reaching for `--force` — and never force delete a StatefulSet pod until you know its node is really off.
