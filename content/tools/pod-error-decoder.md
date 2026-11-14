---
title: "Kubernetes Pod Error Decoder"
date: 2026-11-14T23:00:00+05:30
draft: false
description: "Paste your kubectl describe pod output and get the cause and fix for CrashLoopBackOff, Pending, ImagePullBackOff, OOMKilled, CreateContainerConfigError and Evicted pods."
showDate: false
showReadingTime: false
showAuthor: false
showTableOfContents: false
sharingLinks: false
---

Paste the output of `kubectl describe pod` below. The decoder reads the status, exit code and events, tells you what's actually wrong, and gives you the commands to fix it.

{{< pod-decoder >}}

## How to use it

1. Run this for the pod that won't start:
   ```bash
   kubectl describe pod <pod-name> -n <namespace>
   ```
2. Copy the **whole** output, including the `Events` section at the bottom. That's where most of the clues are.
3. Paste it into the box and click **Decode**.

Only have a line from `kubectl get pods`? Paste that too. You'll get the general cause, and a note to paste the full output for a more exact answer.

## What it detects

| Status | What it finds | Full guide |
|---|---|---|
| `CrashLoopBackOff` | Exit codes 0, 1, 126, 127, 137, 139, 143, liveness probe kills, init container failures | [CrashLoopBackOff](/posts/kubernetes-crashloopbackoff-fix/) |
| `Pending` | Insufficient CPU/memory, taints, node selectors, unbound PVCs, cordoned nodes, hostPort conflicts | [Pending](/posts/kubernetes-pod-stuck-pending/) |
| `ImagePullBackOff` / `ErrImagePull` | Missing tags, registry auth (with AKS, EKS and GKE fixes), rate limits, network, CPU architecture | [ImagePullBackOff](/posts/kubernetes-imagepullbackoff/) |
| `OOMKilled` | Memory limit, how long it ran before dying, and whether that points to a bad limit, a spike or a leak | [OOMKilled](/posts/kubernetes-oomkilled/) |
| `CreateContainerConfigError` | Missing ConfigMaps, Secrets and keys, `runAsNonRoot` conflicts, missing volume sources | [CreateContainerConfigError](/posts/kubernetes-createcontainerconfigerror/) |
| `Evicted` | Memory and disk pressure, and why this pod was the one chosen | [Evicted pods](/posts/kubernetes-evicted-pods/) |

## Is my output safe to paste?

Yes. The decoder runs entirely in your browser. Nothing you paste is uploaded, stored or sent anywhere — you can check by disconnecting from the internet after the page loads; it still works.

That said, `kubectl describe pod` can include environment variable values. If yours contain secrets, remove those lines before pasting anything anywhere, here included.

## Didn't recognise your error?

The decoder covers the six most common pod failures. If yours isn't one of them, the answer is almost always in the last `Warning` line under `Events`. Read that line first — it usually names the exact problem.
