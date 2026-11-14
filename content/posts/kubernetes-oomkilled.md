---
title: "Kubernetes OOMKilled (Exit Code 137): Causes and How to Fix It (2026)"
date: 2026-11-14T00:10:00+05:30
draft: false
description: "Why your Kubernetes container is OOMKilled with exit code 137, how to tell a real leak from a bad limit, and how to set memory requests and limits that actually fit."
tags: ["kubernetes", "troubleshooting", "memory", "resources", "kubectl"]
author: "Ramya Kolli"
---

> **Kubernetes Pod Failures — Debugging Series**
> 1. [CrashLoopBackOff](/posts/kubernetes-crashloopbackoff-fix/)
> 2. [Pending](/posts/kubernetes-pod-stuck-pending/)
> 3. [ImagePullBackOff](/posts/kubernetes-imagepullbackoff/)
> 4. **OOMKilled** ← you are here
> 5. [CreateContainerConfigError](/posts/kubernetes-createcontainerconfigerror/)
> 6. [Evicted pods](/posts/kubernetes-evicted-pods/)

Your pod keeps restarting, and when you look closer you find this:

```
    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137
```

`OOMKilled` means the container used **more memory than its limit**, and the Linux kernel killed it. "OOM" stands for Out Of Memory. Kubernetes didn't decide to kill it — the kernel did, the moment the limit was crossed. Kubernetes just restarts it afterwards, and if it keeps happening, the pod ends up in [CrashLoopBackOff](/posts/kubernetes-crashloopbackoff-fix/).

There are only two real explanations: **the limit is too low**, or **the app is using more memory than it should**. The work is figuring out which.

---

## Why memory gets killed but CPU doesn't

This is the key difference between the two resource limits:

- **CPU limit exceeded** → the container is **slowed down** (throttled). It keeps running.
- **Memory limit exceeded** → the container is **killed**. Immediately, no warning.

Memory can't be taken back from a running process the way CPU time can, so the only option is to kill it. That's why a bad memory limit is far more disruptive than a bad CPU limit.

---

## Step 1: Confirm it's OOMKilled

```bash
kubectl describe pod <pod-name>
```

Look at `Last State` for each container:

```
  Containers:
    orders-worker:
      State:          Running
        Started:      Sat, 14 Nov 2026 09:42:10 +0530
      Last State:     Terminated
        Reason:       OOMKilled
        Exit Code:    137
        Started:      Sat, 14 Nov 2026 09:31:02 +0530
        Finished:     Sat, 14 Nov 2026 09:42:08 +0530
      Restart Count:  6
      Limits:
        memory:  512Mi
      Requests:
        memory:  256Mi
```

Check three things here:

- **`Reason: OOMKilled`** — confirms it. If you see exit code 137 with `Reason: Error` instead, it was killed with SIGKILL for another reason, usually a failed liveness probe. That's a [CrashLoopBackOff](/posts/kubernetes-crashloopbackoff-fix/) problem, not a memory one.
- **Which container** — in a pod with sidecars, make sure it's your app and not the sidecar that's being killed.
- **`Started` to `Finished`** — how long it ran before dying. This is the most useful clue (see Step 3).

---

## Step 2: See how much memory it actually uses

```bash
kubectl top pod <pod-name> --containers
```

```
POD                          NAME            CPU(cores)   MEMORY(bytes)
orders-worker-6d8f7c-9vq4z   orders-worker   120m         488Mi
```

`kubectl top` needs metrics-server installed, and it only shows the **current** value. A container that spikes and dies won't show the spike here. If you have Prometheus, the metric to look at over time is `container_memory_working_set_bytes`, compared against the limit.

---

## Step 3: Spike, leak, or bad limit?

The timing tells you which one you're dealing with.

**Killed a few seconds after start** → the limit is simply too low for the app to even start. Some apps (especially JVM-based ones) need a lot of memory at startup.

**Killed after running steadily for hours or days, memory climbing the whole time** → a **memory leak**. Raising the limit only makes it take longer to crash.

**Killed at random times, memory normal in between** → a **spike**. Something specific — a large request, a big file, a batch job, a report — briefly needs a lot of memory.

Each one has a different fix.

---

## The common causes and how to fix each one

### 1. The limit is too low

The limit was guessed, copied from another service, or set before the app grew.

**Fix it:** set the limit based on what the app actually uses, with headroom. Look at the peak usage over a normal week, then add 20–30% on top.

```yaml
resources:
  requests:
    memory: "512Mi"
  limits:
    memory: "768Mi"
```

For memory, many teams set the **request equal to the limit**. The request is what the scheduler reserves on the node. If the request is much lower than the limit, the scheduler packs more pods onto the node than it can really hold, and when they all grow at once, the node itself runs out of memory.

### 2. The runtime doesn't know about the container limit (Java, Node.js, Go)

Some runtimes size their memory use from settings or defaults that have nothing to do with the container limit. The app grows past the limit without ever realising it's in a container.

**Java:** modern JVMs (JDK 11+) read the container limit, but by default only use **25% of it for the heap**. People then set `-Xmx` by hand, often to the same value as the container limit — and forget that the JVM also needs memory **outside** the heap (metaspace, threads, buffers). The result: OOMKilled, even though the heap never fills.

Use a percentage instead of a fixed `-Xmx`, and leave room for non-heap memory:

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: "-XX:MaxRAMPercentage=75.0"
```

**Node.js:** set the heap size explicitly, below the container limit:

```yaml
command: ["node", "--max-old-space-size=384", "server.js"]   # with a 512Mi limit
```

**Go (1.19+):** set `GOMEMLIMIT` a little below the container limit so the garbage collector works harder before the limit is hit:

```yaml
env:
  - name: GOMEMLIMIT
    value: "450MiB"   # with a 512Mi limit
```

### 3. A memory leak

Memory grows steadily and never comes back down, no matter the load.

**Find it:** graph `container_memory_working_set_bytes` over a few days. A sawtooth that climbs to the limit, drops to zero (restart), and climbs again is the classic leak pattern.

**Fix it:** this is an application bug, not a Kubernetes one. Take a heap dump or memory profile from a running instance and find what's growing — common culprits are caches with no size limit, connections that are never closed, and objects held in a global list.

Raising the limit is a reasonable short-term fix to stop the restarts while you find the leak. Just don't stop there.

### 4. A spike from a specific workload

Memory is fine most of the time, then jumps for one specific operation.

**Find it:** match the OOMKill timestamp (`Finished` in `Last State`) against your app logs. You're looking for the request or job that was running just before.

**Fix it:** change how that operation uses memory — stream large files instead of loading them whole, paginate big queries, process batches in smaller chunks. If the spike is legitimate and rare, set the limit to cover it.

---

## OOMKilled vs Evicted

These two get mixed up, but they're different:

- **OOMKilled** — **your container** went over **its own limit**. Only that container is killed and restarted.
- **Evicted** — **the node** is running low on memory overall. The kubelet removes whole pods to protect the node, even pods that were within their limits. See [Evicted pods](/posts/kubernetes-evicted-pods/).

When a node is under memory pressure, Kubernetes decides which pods to remove first based on their **QoS class**:

```bash
kubectl get pod <pod-name> -o jsonpath='{.status.qosClass}'
```

| QoS class | When | Removed |
|---|---|---|
| `BestEffort` | No requests or limits set | First |
| `Burstable` | Requests lower than limits | Next |
| `Guaranteed` | Requests equal limits (CPU and memory) | Last |

This is another reason to set memory requests equal to limits for important workloads — it puts them in the safest class.

---

## Reproduce it yourself (2 minutes on kind or minikube)

Run a container that tries to use 250 MB with a 100 Mi limit:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: memory-demo
spec:
  containers:
    - name: stress
      image: polinux/stress
      resources:
        requests:
          memory: "50Mi"
        limits:
          memory: "100Mi"
      command: ["stress"]
      args: ["--vm", "1", "--vm-bytes", "250M", "--vm-hang", "1"]
EOF
```

Watch it get killed:

```bash
kubectl get pod memory-demo -w
```

You'll see `OOMKilled`, then `CrashLoopBackOff` after a few restarts. Check the details:

```bash
kubectl describe pod memory-demo | grep -A 4 "Last State"
```

Now change `--vm-bytes` to `50M`, delete the pod, apply again, and see it stay `Running`.

Clean up:

```bash
kubectl delete pod memory-demo
```

---

## Quick reference

| What you see | Likely cause | Fix |
|---|---|---|
| OOMKilled within seconds of starting | Limit too low to start | Raise the limit |
| Memory climbs steadily until killed | Memory leak | Profile the app; raise the limit only as a stopgap |
| OOMKilled at random times | Spike from a specific operation | Find the operation from logs; stream or batch it |
| Java app OOMKilled, heap not full | `-Xmx` too close to limit | Use `-XX:MaxRAMPercentage=75.0` |
| Exit 137 but `Reason: Error` | Not OOM — usually liveness probe | See [CrashLoopBackOff](/posts/kubernetes-crashloopbackoff-fix/) |
| Pod `Evicted`, not restarted | Node out of memory | Set requests properly; check QoS class |

**The one-line takeaway:** OOMKilled means the container crossed its memory limit and the kernel killed it. Check how long it ran before dying — that tells you whether you need a bigger limit, a fix for a spike, or a hunt for a leak.

---

*Next in the series: **[Evicted pods](/posts/kubernetes-evicted-pods/)** — what node pressure is, and why Kubernetes removes pods to save the node.*
