---
title: "Kubernetes Evicted Pods: Why They Happen and How to Fix Them (2026)"
date: 2026-11-14T23:30:00+05:30
draft: false
description: "Why Kubernetes evicts your pods, how to read the eviction message, and how to fix memory and disk pressure on nodes — plus how to clean up the Evicted pods left behind."
tags: ["kubernetes", "troubleshooting", "eviction", "resources", "kubectl"]
author: "Ramya Kolli"
---

> **Kubernetes Pod Failures — Debugging Series**
> 1. [CrashLoopBackOff](/posts/kubernetes-crashloopbackoff-fix/)
> 2. [Pending](/posts/kubernetes-pod-stuck-pending/)
> 3. [ImagePullBackOff](/posts/kubernetes-imagepullbackoff/)
> 4. [OOMKilled](/posts/kubernetes-oomkilled/)
> 5. [CreateContainerConfigError](/posts/kubernetes-createcontainerconfigerror/)
> 6. **Evicted pods** ← you are here

You run `kubectl get pods` and find a list like this:

```
NAME                             READY   STATUS    RESTARTS   AGE
orders-worker-6d8f7c-9vq4z       1/1     Running   0          12m
orders-worker-6d8f7c-2kx7p       0/1     Evicted   0          3h
orders-worker-6d8f7c-h8m4t       0/1     Evicted   0          3h
orders-worker-6d8f7c-qz5wd       0/1     Evicted   0          2h
```

`Evicted` means **the node ran low on memory or disk, and the kubelet removed the pod to protect the node**. Unlike [OOMKilled](/posts/kubernetes-oomkilled/), the pod didn't necessarily do anything wrong — it may have been well within its own limits. The node as a whole was in trouble, and this pod was chosen to go.

The good news: if the pod belongs to a Deployment, a replacement was already created on another node. The Evicted entries are just leftovers. The real question is **why the node ran out**, because it will happen again.

---

## Step 1: Read the eviction message

```bash
kubectl describe pod orders-worker-6d8f7c-2kx7p
```

Near the top:

```
Status:       Failed
Reason:       Evicted
Message:      The node was low on resource: memory. Threshold quantity: 100Mi, available: 87304Ki. Container orders-worker was using 1532448Ki, request is 256Mi, has larger consumption of memory.
```

This one message tells you almost everything:

- **Which resource ran low** — `memory`, `ephemeral-storage` (disk), or occasionally `pids`.
- **The threshold** — the kubelet starts evicting when free memory drops below 100Mi, or free disk below 10–15%, by default.
- **Why this pod was picked** — here, the container was using about 1.5Gi but had only requested 256Mi. That makes it the first candidate.

Also note the node it was on:

```bash
kubectl get pod orders-worker-6d8f7c-2kx7p -o wide
```

If all the Evicted pods came from the same node, the problem is that node. If they're spread across nodes, the problem is your workloads.

---

## Step 2: Check the node's condition

```bash
kubectl describe node worker-2
```

Look at `Conditions`:

```
Conditions:
  Type             Status  Reason                       Message
  ----             ------  ------                       -------
  MemoryPressure   True    KubeletHasInsufficientMemory kubelet has insufficient memory available
  DiskPressure     False   KubeletHasNoDiskPressure     kubelet has no disk pressure
  PIDPressure      False   KubeletHasSufficientPID      kubelet has sufficient PID available
  Ready            True    KubeletReady                 kubelet is posting ready status
```

And the node's events:

```
Events:
  Type     Reason                 Age   From     Message
  ----     ------                 ----  ----     -------
  Warning  EvictionThresholdMet   14m   kubelet  Attempting to reclaim memory
```

While a node is under pressure, Kubernetes also taints it (`node.kubernetes.io/memory-pressure` or `disk-pressure`) so no new pods get scheduled there. That's why you might see new pods go [Pending](/posts/kubernetes-pod-stuck-pending/) at the same time.

---

## How the kubelet decides which pod to evict

This explains why it's often **your** pod and not the noisy one next to it. The kubelet ranks pods in this order:

1. **Is the pod using more than it requested?** Pods over their request go first.
2. **Pod priority.** Lower `priorityClassName` goes before higher.
3. **How far over its request it is.** The bigger the gap, the sooner it goes.

So a pod with **no requests at all** (`BestEffort`) is always over its request and almost always goes first. A pod whose requests equal its limits (`Guaranteed`) and stays within them is the last to be evicted.

That's the main lesson of this whole article: **accurate requests protect your pods.**

---

## The common causes and how to fix each one

### 1. Memory pressure from requests that are too low

The most common cause. Pods request 256Mi but actually use 1Gi. The scheduler trusts the requests, packs many of these pods onto one node, and when they all grow at the same time, the node runs out of real memory.

**Find it:** compare requests with actual usage across the node:

```bash
kubectl top pods -A --sort-by=memory
kubectl describe node worker-2 | grep -A 8 "Allocated resources"
```

If actual usage is well above what's requested, the node is overcommitted.

**Fix it:** set memory requests close to real usage. For important workloads, set the request equal to the limit — the scheduler then only places what the node can really hold, and the pod moves to the safest QoS class.

```yaml
resources:
  requests:
    memory: "1Gi"
  limits:
    memory: "1Gi"
```

### 2. Disk pressure from logs or temporary files (`ephemeral-storage`)

```
The node was low on resource: ephemeral-storage. Threshold quantity: 10%, available: 4123456Ki. Container report-generator was using 8Gi, request is 0, has larger consumption of ephemeral-storage.
```

Containers write to the node's disk more than people expect: log files written inside the container, temporary files, downloads, caches, and `emptyDir` volumes. One pod writing large files can fill the disk and get everything on the node evicted.

**Find it:** check the node's disk directly. A debug pod mounts the node's filesystem at `/host`:

```bash
kubectl debug node/worker-2 -it --image=busybox
df -h /host
du -sh /host/var/lib/kubelet/pods/* | sort -h | tail
```

Exit the debug pod when you're done, then delete it — `kubectl debug node/` leaves a pod named `node-debugger-...` behind.

**Fix it:**
- Write logs to stdout, not to files inside the container. Kubernetes rotates stdout logs; it doesn't rotate your files.
- Set ephemeral storage requests and limits, so one pod can't fill the node:
  ```yaml
  resources:
    requests:
      ephemeral-storage: "1Gi"
    limits:
      ephemeral-storage: "2Gi"
  ```
- Put a `sizeLimit` on `emptyDir` volumes:
  ```yaml
  volumes:
    - name: scratch
      emptyDir:
        sizeLimit: 1Gi
  ```

With a limit set, a pod that goes over is evicted on its own, before it can affect anything else on the node.

### 3. Disk pressure from container images

The node's image storage fills up — common on nodes that run many different images, or CI build agents running on Kubernetes. The kubelet tries to clean up unused images first, but if most images are in use, it starts evicting pods.

**Find it:** `DiskPressure` is `True`, and the eviction message mentions `imagefs` or `nodefs`. On the node, `crictl images` shows how many images are stored.

**Fix it:** use smaller images (multi-stage builds, slim or distroless base images), and give nodes bigger disks if they run many images. On managed clusters, the node's OS disk size is set in the node pool configuration.

### 4. A memory-hungry pod without a limit

One pod with no memory limit grows and grows. It doesn't get OOMKilled because it has no limit, so instead the whole node runs low, and the kubelet starts evicting pods — often other, well-behaved ones first, if the hungry pod has high priority or a large request.

**Fix it:** every container should have a memory limit. To enforce that in a namespace, add a `LimitRange` with default values:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
spec:
  limits:
    - type: Container
      default:
        memory: "512Mi"
      defaultRequest:
        memory: "256Mi"
```

Containers created without their own values then get these.

---

## Cleaning up Evicted pods

Evicted pods stay in the list until someone deletes them. Kubernetes does eventually garbage-collect them, but the default threshold is very high, so in practice they pile up.

They don't use any CPU or memory — they're just records. To clear them in a namespace:

```bash
kubectl delete pods --field-selector=status.phase=Failed -n <namespace>
```

This deletes **all** Failed pods in the namespace, not just Evicted ones. That's usually what you want, but check the list first:

```bash
kubectl get pods --field-selector=status.phase=Failed -n <namespace>
```

Cleaning up only hides the symptom. If pods keep getting evicted, fix the cause above.

---

## Not this kind of eviction

"Eviction" is used for a few different things in Kubernetes. These don't leave pods in `Evicted` status:

- **`kubectl drain`** — evicts pods on purpose for node maintenance. The pods are deleted and recreated elsewhere; no `Evicted` pods remain.
- **Preemption** — a higher-priority pod needs room, so the scheduler removes a lower-priority one. You'll see a `Preempted` event.
- **Node NotReady** — if a node stops responding for about 5 minutes, its pods are deleted and recreated on healthy nodes.

If your pod just disappeared and a new one with a different name appeared, it's probably one of these, not node pressure.

---

## Reproduce it yourself (2 minutes on kind or minikube)

The easiest eviction to reproduce safely is a pod going over its own ephemeral storage limit:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: disk-hog
spec:
  containers:
    - name: hog
      image: busybox
      command: ["sh", "-c", "dd if=/dev/zero of=/tmp/fill bs=1M count=200; sleep 3600"]
      resources:
        limits:
          ephemeral-storage: "50Mi"
EOF
```

The container writes 200 MB with a 50 Mi limit. The kubelet checks disk usage periodically, so give it a minute:

```bash
kubectl get pod disk-hog -w
```

You'll see the status change to `Evicted`. Read why:

```bash
kubectl describe pod disk-hog | grep -A 2 Reason
```

Notice the pod is **not** restarted — unlike OOMKilled, eviction removes the whole pod. A bare pod like this one is simply gone; a Deployment would have created a new one.

Clean up:

```bash
kubectl delete pod disk-hog
```

---

## Quick reference

| What you see | Likely cause | Fix |
|---|---|---|
| `low on resource: memory` | Node overcommitted — requests too low | Set requests close to real usage |
| `low on resource: ephemeral-storage` | Logs or temp files filling the disk | Log to stdout; set ephemeral-storage limits |
| `DiskPressure` + many images | Image storage full | Smaller images; bigger node disks |
| Your pod evicted, not the noisy one | Your pod is over its request | Accurate requests; `Guaranteed` QoS for critical pods |
| Many `Evicted` pods listed | Leftover records | `kubectl delete pods --field-selector=status.phase=Failed` |
| Pod gone, no `Evicted` status | Drain, preemption or node NotReady | Check node events and pod priority |

**The one-line takeaway:** an Evicted pod means the node ran short, not necessarily that your pod misbehaved. Read the eviction message, check the node's conditions, and fix the requests — accurate requests are what keep pods from being chosen.

---

*That's the end of the Kubernetes Pod Failures series. Between these six articles, you can work out the cause of almost any pod that won't run — start with `kubectl describe pod` and follow the status.*
