---
title: "Kubernetes Pod Stuck in Pending: Causes and How to Fix It (2026)"
date: 2026-11-11T12:00:00+05:30
draft: false
description: "Why your Kubernetes pod is stuck in Pending, how to read the FailedScheduling message, and how to fix insufficient CPU, taints, node selectors and unbound PVCs."
tags: ["kubernetes", "troubleshooting", "scheduling", "kubectl"]
author: "Ramya Kolli"
---

> **Kubernetes Pod Failures — Debugging Series**
> 1. [CrashLoopBackOff](/posts/kubernetes-crashloopbackoff-fix/)
> 2. **Pending** ← you are here
> 3. [ImagePullBackOff](/posts/kubernetes-imagepullbackoff/)
> 4. [OOMKilled](/posts/kubernetes-oomkilled/)
> 5. [CreateContainerConfigError](/posts/kubernetes-createcontainerconfigerror/)
> 6. [Evicted pods](/posts/kubernetes-evicted-pods/)
>
> Not sure which one you have? Paste your `kubectl describe pod` output into the [Pod Error Decoder](/tools/pod-error-decoder/).

You deploy, and the pod just sits there:

```
NAME                       READY   STATUS    RESTARTS   AGE
reports-api-5f7c9d-k8m2x   0/1     Pending   0          6m
```

No restarts, no logs, no crash. Nothing is happening at all.

A pod stuck in `Pending` almost always means **the scheduler can't find a node to put it on**. The container hasn't been created, so there's nothing to debug inside it. The answer is in why the scheduler said no — and Kubernetes tells you exactly that.

---

## Step 1: Confirm it's a scheduling problem

```bash
kubectl get pod reports-api-5f7c9d-k8m2x -o wide
```

```
NAME                       READY   STATUS    RESTARTS   AGE   IP       NODE
reports-api-5f7c9d-k8m2x   0/1     Pending   0          6m    <none>   <none>
```

`NODE` is `<none>`. The pod was never assigned to a node, so this is a scheduling problem.

If a node **is** assigned and the status shows `ContainerCreating`, that's a different problem — usually an image pull or a volume mount. Check the events for that instead.

---

## Step 2: Read the FailedScheduling event

```bash
kubectl describe pod reports-api-5f7c9d-k8m2x
```

At the bottom:

```
Events:
  Type     Reason            Age                From               Message
  ----     ------            ----               ----               -------
  Warning  FailedScheduling  2m (x4 over 6m)    default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 Insufficient cpu. preemption: 0/3 nodes are available: 1 Preemption is not helpful for scheduling, 2 No preemption victims found for incoming pod.
```

This one line is the whole diagnosis. Read it like this:

- `0/3 nodes are available` — the cluster has 3 nodes, and none of them fit.
- Then it lists **why each node was rejected**: 1 node had a taint, 2 nodes didn't have enough CPU.
- The `preemption:` part tells you Kubernetes also couldn't make room by evicting lower-priority pods. You can usually ignore it.

Every reason in that message maps to one of the causes below.

---

## The common causes and how to fix each one

### 1. Not enough CPU or memory (`Insufficient cpu` / `Insufficient memory`)

The most common one, and the most misunderstood.

The scheduler doesn't look at how much CPU your nodes are **using**. It looks at how much has been **requested** by the pods already on them. A node can be at 20% actual usage and still be "full" if the pods on it requested all of its CPU.

That's why this is confusing:

```bash
kubectl top nodes
```

```
NAME       CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%
worker-1   410m         20%    2100Mi          27%
```

Looks mostly empty. But check what's actually reserved:

```bash
kubectl describe node worker-1
```

```
Allocated resources:
  Resource           Requests      Limits
  --------           --------      ------
  cpu                1850m (92%)   3 (150%)
  memory             5Gi (66%)     8Gi (106%)
```

92% of the CPU is already requested. If your pod asks for `500m`, it doesn't fit.

**Fix it:**
- Check the pod's requests. A request copied from somewhere else (`cpu: 2`) is often far more than the app needs. Lower it to something realistic.
- Look for other pods with inflated requests that are hogging the node.
- If the requests are genuinely right, you need more capacity — add a node, or let the cluster autoscaler do it.

```yaml
resources:
  requests:
    cpu: "250m"
    memory: "256Mi"
```

### 2. The node has a taint the pod doesn't tolerate (`untolerated taint`)

Taints keep pods off certain nodes. Control plane nodes are tainted by default, and teams often taint GPU nodes or dedicated node pools.

```
1 node(s) had untolerated taint {dedicated: batch}
```

**Find it:**

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
```

**Fix it:** if the pod is supposed to run on that node, add a matching toleration:

```yaml
tolerations:
  - key: "dedicated"
    operator: "Equal"
    value: "batch"
    effect: "NoSchedule"
```

If the pod is **not** supposed to run there, the taint is doing its job — the real problem is that your other nodes are full or don't match (see causes 1 and 3).

### 3. No node matches the nodeSelector or affinity (`didn't match Pod's node affinity/selector`)

The pod asks for a node with a specific label, and no node has it.

```yaml
nodeSelector:
  disktype: ssd
```

```
3 node(s) didn't match Pod's node affinity/selector
```

**Find it:**

```bash
kubectl get nodes --show-labels | grep disktype
```

If nothing comes back, no node has that label.

**Fix it:** either correct the label in the pod spec (a typo like `disk-type` vs `disktype` is common), or label the node if it should qualify:

```bash
kubectl label node worker-2 disktype=ssd
```

This also happens after a node pool is replaced — the new nodes come up without the custom labels the old ones had.

### 4. The PersistentVolumeClaim isn't bound (`unbound immediate PersistentVolumeClaims`)

The pod needs a volume, and the volume doesn't exist yet.

```
0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims.
```

**Find it:**

```bash
kubectl get pvc
```

```
NAME          STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
reports-data  Pending                                      fast-ssd       6m
```

Then see why:

```bash
kubectl describe pvc reports-data
```

Common messages:
- `storageclass.storage.k8s.io "fast-ssd" not found` — the StorageClass name is wrong or doesn't exist in this cluster. Check with `kubectl get storageclass`.
- `no persistent volumes available for this claim and no storage class is set` — there's no default StorageClass, and no PV was created manually.

**Fix it:** point the PVC at a StorageClass that actually exists, or set one as the default.

One thing that looks like a problem but isn't: with `volumeBindingMode: WaitForFirstConsumer`, the PVC stays `Pending` **until a pod using it is scheduled**. You'll see `waiting for first consumer to be created before binding`. That's normal — if the pod is also Pending, the cause is one of the other reasons in the pod's event.

### 5. The node is cordoned (`node(s) were unschedulable`)

Someone ran `kubectl cordon` (or `kubectl drain`) for maintenance and never undid it.

**Find it:**

```bash
kubectl get nodes
```

```
NAME       STATUS                     ROLES    AGE   VERSION
worker-1   Ready,SchedulingDisabled   <none>   40d   v1.33.2
```

**Fix it:** once the maintenance is done:

```bash
kubectl uncordon worker-1
```

### 6. A hostPort is already taken (`didn't have free ports`)

If the pod uses `hostPort`, only one pod per node can use that port. With 3 nodes and 4 replicas, the fourth stays Pending.

```
3 node(s) didn't have free ports for the requested pod ports
```

**Fix it:** avoid `hostPort` unless you really need it. Use a Service instead. If you do need it, you can't run more replicas than you have nodes.

---

## What if there's no event at all?

If `kubectl describe pod` shows no `FailedScheduling` event and the pod has been Pending for a while, check whether the scheduler is running:

```bash
kubectl get pods -n kube-system | grep scheduler
```

On managed clusters (EKS, AKS, GKE) you can't see the scheduler pod, but this is rare there. On a self-managed cluster, a crashed scheduler means **every** new pod stays Pending, not just yours.

Also check `schedulerName` in the pod spec. If it points to a custom scheduler that doesn't exist, nothing will ever schedule the pod.

---

## Not actually Pending

- **The pod doesn't exist at all.** If a Deployment shows `0/3` ready but `kubectl get pods` shows nothing, the pods were never created. Check the ReplicaSet: `kubectl describe rs <name>`. A common cause is a ResourceQuota — you'll see `exceeded quota` in the events.
- **The status is `ContainerCreating`.** The pod was scheduled, but something is failing on the node — usually an image pull or a volume mount. See [CreateContainerConfigError](/posts/kubernetes-createcontainerconfigerror/) for the volume mount case.

---

## Reproduce it yourself (2 minutes on kind or minikube)

**Insufficient CPU** — ask for more CPU than any node has:

```bash
kubectl create deployment big --image=nginx
kubectl set resources deployment big --requests=cpu=100
kubectl get pods
kubectl describe pod -l app=big | grep -A 3 Events
```

You'll see `Insufficient cpu`. The old pod keeps running because the rollout can't complete — a good example of how a bad request blocks a deploy without taking anything down.

**Node selector with no matching node:**

```bash
kubectl run picky --image=nginx --overrides='{"spec":{"nodeSelector":{"disktype":"ssd"}}}'
kubectl describe pod picky | grep FailedScheduling
```

Now fix it by labelling the node, and watch the pod schedule straight away:

```bash
kubectl label node $(kubectl get nodes -o name | head -1 | cut -d/ -f2) disktype=ssd
kubectl get pod picky -w
```

Clean up:

```bash
kubectl delete deployment big
kubectl delete pod picky
kubectl label node $(kubectl get nodes -o name | head -1 | cut -d/ -f2) disktype-
```

---

## Quick reference

| FailedScheduling message | Cause | Check |
|---|---|---|
| `Insufficient cpu` / `Insufficient memory` | Node requests are full | `kubectl describe node` → Allocated resources |
| `had untolerated taint` | Node is tainted | `kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints` |
| `didn't match Pod's node affinity/selector` | No node has the label | `kubectl get nodes --show-labels` |
| `unbound immediate PersistentVolumeClaims` | PVC not bound | `kubectl describe pvc <name>` |
| `node(s) were unschedulable` | Node cordoned | `kubectl get nodes`, then `kubectl uncordon` |
| `didn't have free ports` | hostPort conflict | Remove `hostPort` or reduce replicas |
| No event at all | Scheduler down or wrong `schedulerName` | `kubectl get pods -n kube-system` |

**The one-line takeaway:** a Pending pod hasn't failed — it's waiting for a node. Run `kubectl describe pod`, read the `FailedScheduling` line, and it tells you exactly which rule ruled out each node.

---

*Next in the series: **[ImagePullBackOff](/posts/kubernetes-imagepullbackoff/)** — wrong tags, private registries and rate limits.*
