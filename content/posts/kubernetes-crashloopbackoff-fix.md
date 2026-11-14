---
title: 'Kubernetes CrashLoopBackOff: What It Means, Causes and How to Fix It (2026)'
date: 2026-05-25T21:48:00+05:30
lastmod: 2026-11-04T01:00:00+05:30
draft: false
description: "CrashLoopBackOff means your container keeps crashing and Kubernetes keeps restarting it. Here's how to find the real cause with exit codes, logs and events, and fix it step by step."
tags: ["kubernetes", "devops", "troubleshooting", "kubectl"]
author: "Ramya Kolli"
---

> **Kubernetes Pod Failures — Debugging Series**
> 1. **CrashLoopBackOff** ← you are here
> 2. [Pending](/posts/kubernetes-pod-stuck-pending/)
> 3. [ImagePullBackOff](/posts/kubernetes-imagepullbackoff/)
> 4. [OOMKilled](/posts/kubernetes-oomkilled/)
> 5. [CreateContainerConfigError](/posts/kubernetes-createcontainerconfigerror/)
> 6. [Evicted pods](/posts/kubernetes-evicted-pods/)
>
> Not sure which one you have? Paste your `kubectl describe pod` output into the [Pod Error Decoder](/tools/pod-error-decoder/).

## What does CrashLoopBackOff mean?

CrashLoopBackOff means your container **starts, crashes, and Kubernetes keeps restarting it** — waiting a little longer before each restart.

```
NAME                        READY   STATUS             RESTARTS      AGE
payments-api-6c8d9f-7xk2p   0/1     CrashLoopBackOff   5 (40s ago)   4m
```

It is not an error by itself. It's Kubernetes telling you: *"I started your container, it died, and I'm backing off before I try again."* The real error is inside the container, and your job is to find it.

The "back-off" part is the waiting time between restarts. It starts at 10 seconds and doubles each time (10s, 20s, 40s…) up to a maximum of 5 minutes. If the container then runs for 10 minutes without crashing, the timer resets. That's why a pod can look fine for a while and then go back into CrashLoopBackOff.

In `kubectl describe pod` you'll see the same thing as an event:

```
Warning  BackOff  kubelet  Back-off restarting failed container payments-api in pod payments-api-6c8d9f-7xk2p
```

---

## Step 1: Read the exit code first

Before reading logs, check **how** the container died. This one command narrows it down more than anything else:

```bash
kubectl describe pod <pod-name>
```

Look at the `Last State` block under your container:

```
    State:          Waiting
      Reason:       CrashLoopBackOff
    Last State:     Terminated
      Reason:       Error
      Exit Code:    1
      Started:      Tue, 04 Nov 2026 10:12:03 +0530
      Finished:     Tue, 04 Nov 2026 10:12:05 +0530
```

What the exit code tells you:

| Exit code | Reason shown | What it usually means |
|---|---|---|
| `0` | Completed | The app finished and exited. Nothing crashed — it just isn't a long-running process |
| `1` | Error | The application threw an error. Check the logs |
| `126` | Error | Command found but not executable (permissions) |
| `127` | Error | Command not found — typo in `command`/`args` or missing binary |
| `137` | OOMKilled | Killed for using more memory than its limit |
| `137` | Error | Killed with SIGKILL — often after a failed liveness probe |
| `139` | Error | Segmentation fault inside the app |
| `143` | Error | Received SIGTERM and shut down |

Also check `Started` and `Finished`. If the container dies within a second or two, it's failing at startup (config, command, missing file). If it runs for a minute and then dies, look at memory or probes.

---

## Step 2: Read the logs from the crashed container

```bash
kubectl logs <pod-name> --previous
```

`--previous` is the important part. Without it, you get the logs of the **current** attempt, which is often empty because the container just restarted. `--previous` shows the logs of the run that crashed.

If the pod has more than one container:

```bash
kubectl logs <pod-name> -c <container-name> --previous
```

---

## Step 3: Check the events

At the bottom of `kubectl describe pod`, the `Events` section shows what Kubernetes itself saw:

```
Events:
  Type     Reason     Age                 From     Message
  ----     ------     ----                ----     -------
  Warning  Unhealthy  2m (x9 over 4m)     kubelet  Liveness probe failed: HTTP probe failed with statuscode: 500
  Normal   Killing    2m (x3 over 4m)     kubelet  Container payments-api failed liveness probe, will be restarted
  Warning  BackOff    30s (x12 over 3m)   kubelet  Back-off restarting failed container payments-api
```

If you see `Liveness probe failed`, Kubernetes is killing a container that might actually be fine — just slow. That's a different fix from an app crash.

---

## The common causes and how to fix each one

### 1. The application crashes on startup (exit code 1)

The most common case. A bad config value, a missing environment variable, a failed database connection, an unhandled exception.

**Find it:** `kubectl logs <pod-name> --previous` — the last few lines almost always show the error.

**Fix it:** fix the actual error in the app or its configuration. Check what environment variables the container really received:

```bash
kubectl exec <pod-name> -- env
```

If the container dies too fast to `exec` into, see the debugging trick further down.

### 2. The container runs out of memory (exit code 137, OOMKilled)

The app uses more memory than its `resources.limits.memory`, and the kernel kills it.

**Find it:** `Last State` shows `Reason: OOMKilled`. For the full breakdown, see [OOMKilled](/posts/kubernetes-oomkilled/).

**Fix it:** either raise the limit or find out why the app needs that much memory. Raising the limit is fine if the original value was a guess. If memory keeps growing over time, it's a leak, and a bigger limit only delays the crash.

```yaml
resources:
  requests:
    memory: "256Mi"
  limits:
    memory: "512Mi"
```

For Java apps, check the heap settings too. A JVM with `-Xmx` set higher than the container limit will be OOMKilled every time.

### 3. The liveness probe kills a healthy but slow app

The app takes 60 seconds to start, but the liveness probe starts checking after 10 seconds. The probe fails, Kubernetes kills the container, and it never gets the chance to finish starting.

**Find it:** events show `Liveness probe failed` followed by `will be restarted`.

**Fix it:** add a `startupProbe`. Liveness checks don't begin until the startup probe passes:

```yaml
startupProbe:
  httpGet:
    path: /health
    port: 8080
  failureThreshold: 30
  periodSeconds: 5      # allows up to 150s to start
livenessProbe:
  httpGet:
    path: /health
    port: 8080
  periodSeconds: 10
```

Also check that the probe path and port are correct. A probe pointing at the wrong port fails forever.

### 4. The container exits successfully (exit code 0)

This one confuses people because nothing is actually broken. The container ran its command, finished, and exited cleanly. Since a Deployment expects it to keep running, Kubernetes restarts it, and you get CrashLoopBackOff with `Reason: Completed`.

Common examples: running a script that does its job and ends, or a `busybox` image with no long-running command.

**Fix it:** if it's meant to run once, use a `Job` instead of a Deployment. If it's meant to keep running, make sure the main process stays in the foreground (for example, nginx needs `daemon off;`).

### 5. Wrong command or arguments (exit code 127 or 126)

A typo in `command` or `args`, a script that isn't executable, or an entrypoint that doesn't exist in the image.

**Find it:** logs show something like `exec: "startt.sh": executable file not found in $PATH` or `permission denied`.

**Fix it:** check the `command` and `args` in your YAML against what actually exists in the image. For scripts, make sure the Dockerfile sets execute permission (`RUN chmod +x start.sh`).

### 6. A dependency isn't ready

The app tries to connect to a database or another service on startup, fails, and exits instead of retrying.

**Find it:** logs show `connection refused` or a timeout to another host.

**Fix it:** the best fix is in the app — retry the connection instead of exiting. Otherwise, an init container can wait for the dependency before the main container starts.

---

## What about Init:CrashLoopBackOff?

If the status shows `Init:CrashLoopBackOff`, the crashing container is an **init container**, not your main app. The main container never starts until every init container succeeds.

Get the init container's name from `kubectl describe pod`, then read its logs:

```bash
kubectl logs <pod-name> -c <init-container-name> --previous
```

The causes are the same as above — usually a failing script or a dependency it's waiting on.

---

## Debugging trick: when the container dies too fast to inspect

If the container crashes within a second, you can't `exec` into it. Start a copy of the pod with the command replaced, so it stays alive and you can look around:

```bash
kubectl debug <pod-name> -it --copy-to=<pod-name>-debug --container=<container-name> -- sh
```

Inside, check that the config files exist, the environment variables are set, and then run the app's start command by hand to see the error directly. Delete the debug pod when you're done:

```bash
kubectl delete pod <pod-name>-debug
```

---

## Not actually CrashLoopBackOff

Two problems often get mixed up with CrashLoopBackOff, but they show a different status and need a different fix:

- **Missing ConfigMap or Secret** referenced in `env` or `envFrom` — the container never starts, so the status is `CreateContainerConfigError`. See [CreateContainerConfigError explained](/posts/kubernetes-createcontainerconfigerror/).
- **Wrong image name or tag** — the image can't be pulled, so the status is `ImagePullBackOff` or `ErrImagePull`. See [ImagePullBackOff](/posts/kubernetes-imagepullbackoff/).

If your status isn't literally `CrashLoopBackOff`, you're probably looking at one of these.

---

## Reproduce it yourself (2 minutes on kind or minikube)

Cause a crash on purpose and walk through the steps above:

```bash
kubectl run crash-demo --image=busybox -- sh -c "echo starting; sleep 3; echo something failed; exit 1"
kubectl get pods -w
```

After a few restarts you'll see `CrashLoopBackOff`. Now run:

```bash
kubectl describe pod crash-demo      # Exit Code: 1
kubectl logs crash-demo --previous   # "something failed"
```

Then try the exit code 0 case:

```bash
kubectl run done-demo --image=busybox -- sh -c "echo finished"
kubectl describe pod done-demo       # Reason: Completed, Exit Code: 0
```

Clean up:

```bash
kubectl delete pod crash-demo done-demo
```

---

## Quick reference

| What you see | Likely cause | Fix |
|---|---|---|
| Exit code 1 | App error on startup | `kubectl logs --previous`, fix the error |
| `OOMKilled`, exit 137 | Over memory limit | Raise limit or fix memory usage |
| `Liveness probe failed` in events | Probe too early or wrong path/port | Add `startupProbe`, check probe config |
| Exit code 0, `Completed` | Process finished | Use a Job, or keep process in foreground |
| Exit code 127 / 126 | Wrong command or not executable | Fix `command`/`args`, `chmod +x` |
| `connection refused` in logs | Dependency not ready | Retry in app, or init container |
| `Init:CrashLoopBackOff` | Init container failing | `kubectl logs <pod> -c <init> --previous` |

**The one-line takeaway:** don't restart the pod and hope. Check the exit code with `kubectl describe pod`, read `kubectl logs --previous`, and the cause is almost always right there.

---

*Next in the series: **[Pod stuck in Pending](/posts/kubernetes-pod-stuck-pending/)** — why the scheduler can't place your pod, and how to read what it's telling you.*
