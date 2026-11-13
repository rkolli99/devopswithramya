---
title: "Kubernetes ImagePullBackOff and ErrImagePull: Causes and How to Fix Them (2026)"
date: 2026-11-14T00:00:00+05:30
draft: false
description: "Why your pod is stuck in ImagePullBackOff or ErrImagePull, how to read the exact pull error, and how to fix wrong tags, private registry auth, rate limits and architecture mismatches."
tags: ["kubernetes", "troubleshooting", "docker", "registry", "kubectl"]
author: "Ramya Kolli"
---

> **Kubernetes Pod Failures — Debugging Series**
> 1. [CrashLoopBackOff](/posts/kubernetes-crashloopbackoff-fix/)
> 2. [Pending](/posts/kubernetes-pod-stuck-pending/)
> 3. **ImagePullBackOff** ← you are here
> 4. [OOMKilled](/posts/kubernetes-oomkilled/)
> 5. [CreateContainerConfigError](/posts/kubernetes-createcontainerconfigerror/)
> 6. Evicted pods *(coming soon)*

You deploy a new version and the pod never starts:

```
NAME                         READY   STATUS             RESTARTS   AGE
checkout-api-7b9c4d-p2xq8    0/1     ImagePullBackOff   0          3m
```

The pod was scheduled to a node, but the node **couldn't download the container image**. Your app never ran, so there are no logs. The reason is in the pull error, and it's usually one of a handful of things.

---

## ErrImagePull vs ImagePullBackOff

You'll often see both, one after the other:

```
checkout-api-7b9c4d-p2xq8    0/1     ErrImagePull       0          10s
checkout-api-7b9c4d-p2xq8    0/1     ImagePullBackOff   0          25s
```

- **`ErrImagePull`** — the pull just failed.
- **`ImagePullBackOff`** — Kubernetes is waiting before trying again. Like CrashLoopBackOff, the wait grows with each failure, up to 5 minutes.

Same problem, different moment. Fixing the cause fixes both.

---

## Step 1: Read the pull error

```bash
kubectl describe pod checkout-api-7b9c4d-p2xq8
```

At the bottom:

```
Events:
  Type     Reason     Age                From     Message
  ----     ------     ----               ----     -------
  Normal   Scheduled  3m                 default-scheduler  Successfully assigned default/checkout-api-7b9c4d-p2xq8 to worker-1
  Normal   Pulling    90s (x4 over 3m)   kubelet  Pulling image "myregistry.azurecr.io/checkout-api:2.4.1"
  Warning  Failed     90s (x4 over 3m)   kubelet  Failed to pull image "myregistry.azurecr.io/checkout-api:2.4.1": rpc error: code = NotFound desc = failed to pull and unpack image "myregistry.azurecr.io/checkout-api:2.4.1": failed to resolve reference "myregistry.azurecr.io/checkout-api:2.4.1": myregistry.azurecr.io/checkout-api:2.4.1: not found
  Warning  Failed     90s (x4 over 3m)   kubelet  Error: ErrImagePull
  Normal   BackOff    20s (x6 over 3m)   kubelet  Back-off pulling image "myregistry.azurecr.io/checkout-api:2.4.1"
```

The `Failed to pull image` line is long, but the useful part is at the end. In this case: `not found`.

Also read the image name in that line carefully. Many of these turn out to be a typo you only notice when you see the full name spelled out.

---

## The common causes and how to fix each one

### 1. The tag or image doesn't exist (`not found`)

The most common one. The tag was never pushed, the CI build that should have pushed it failed, or there's a typo in the image name or tag.

```
failed to resolve reference "myregistry.azurecr.io/checkout-api:2.4.1": ... not found
```

**Find it:** check the tag actually exists in the registry, without pulling it:

```bash
docker manifest inspect myregistry.azurecr.io/checkout-api:2.4.1
```

Or list the tags in the registry UI or CLI. For Azure Container Registry:

```bash
az acr repository show-tags --name myregistry --repository checkout-api --output table
```

**Fix it:** push the missing tag, or correct the tag in your Deployment. If your pipeline builds and deploys in separate stages, check that the build stage really pushed — a deploy that runs after a failed push is a classic way to end up here.

### 2. Private registry, no credentials (`unauthorized` / `pull access denied`)

The image exists, but the node isn't allowed to pull it.

```
failed to authorize: failed to fetch oauth token: unexpected status: 401 Unauthorized
```

or

```
pull access denied, repository does not exist or may require authorization
```

The second message is misleading — it says "does not exist **or** may require authorization". For a private image, it almost always means authorization.

**Fix it (any registry):** create an image pull secret **in the same namespace as the pod**:

```bash
kubectl create secret docker-registry regcred \
  --docker-server=myregistry.example.com \
  --docker-username=<username> \
  --docker-password=<password-or-token> \
  -n <namespace>
```

Then reference it in the pod spec:

```yaml
spec:
  imagePullSecrets:
    - name: regcred
  containers:
    - name: checkout-api
      image: myregistry.example.com/checkout-api:2.4.1
```

If every pod in the namespace needs it, attach it to the service account instead so you don't have to add it to each Deployment:

```bash
kubectl patch serviceaccount default -n <namespace> \
  -p '{"imagePullSecrets":[{"name":"regcred"}]}'
```

**On managed Kubernetes, you usually don't need a secret at all.** The node's identity pulls the image, so the fix is a permission, not a password:

- **AKS + ACR:** attach the registry to the cluster:
  ```bash
  az aks update --name <cluster> --resource-group <rg> --attach-acr <acr-name>
  ```
- **EKS + ECR:** the node IAM role needs the `AmazonEC2ContainerRegistryReadOnly` policy.
- **GKE + Artifact Registry:** the node service account needs the Artifact Registry Reader role.

Two things that catch people out:
- The secret exists, but in a **different namespace**. Pull secrets are namespaced, just like ConfigMaps.
- The secret was created with a token that has since **expired**. Pulls worked last month and suddenly don't. Recreate the secret with a fresh token.

### 3. Docker Hub rate limit (`toomanyrequests`)

```
429 Too Many Requests - Server message: toomanyrequests: You have reached your pull rate limit.
```

Docker Hub limits anonymous and free-account pulls. Clusters hit this easily because all nodes often share one outbound IP, so every node's pulls count against the same limit.

**Fix it:**
- Authenticate to Docker Hub with a pull secret (as above) — authenticated users get a higher limit.
- Better: mirror the images you use into your own registry (ACR, ECR, Artifact Registry) and pull from there.
- Use a specific tag with `imagePullPolicy: IfNotPresent` so nodes reuse the image they already have instead of pulling again on every restart.

### 4. The node can't reach the registry (`no such host` / `i/o timeout`)

```
dial tcp: lookup myregistry.example.com: no such host
```

```
dial tcp 10.0.4.12:443: i/o timeout
```

The node has a DNS or network problem reaching the registry — a typo in the registry hostname, a private registry the nodes can't route to, a firewall rule, or a proxy that isn't configured on the nodes.

**Fix it:** check the registry hostname first. If it's correct, test from the node itself (see the debugging tip below). For private registries, check that the cluster's network can actually reach it — private endpoints and firewall rules are the usual cause.

### 5. Wrong CPU architecture (`no match for platform in manifest`)

```
no match for platform in manifest: not found
```

The image was built only for `amd64`, and the node is `arm64` (or the other way round). This shows up more now that ARM nodes (Graviton, Ampere) are common, and when images are built on an Apple Silicon laptop and pushed straight to a registry.

**Find it:**

```bash
kubectl get nodes -L kubernetes.io/arch
docker manifest inspect myregistry.example.com/checkout-api:2.4.1 | grep architecture
```

**Fix it:** build a multi-architecture image:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t myregistry.example.com/checkout-api:2.4.1 --push .
```

Or keep the pod on matching nodes with a `nodeSelector` on `kubernetes.io/arch`.

---

## Debugging tip: pull from the node directly

If the event message isn't clear, try the pull yourself from the node that failed. That tells you whether the problem is the image, the credentials, or the node's network.

On a node you can SSH into (containerd runtime):

```bash
sudo crictl pull myregistry.example.com/checkout-api:2.4.1
```

On a local kind cluster, the node is a Docker container:

```bash
docker exec -it kind-control-plane crictl pull nginx:1.27
```

If the pull works from your laptop but fails from the node, the image is fine — look at node credentials or network.

---

## A note on imagePullPolicy

`imagePullPolicy` controls when the node pulls:

- **`IfNotPresent`** — pull only if the node doesn't already have it. The default for specific tags.
- **`Always`** — check the registry every time the container starts. The default for `:latest` or no tag.
- **`Never`** — never pull. If the image isn't already on the node, you get `ErrImageNeverPull`.

This explains a confusing situation: a pod works on one node and fails with ImagePullBackOff on another. The first node already had the image cached, so it never needed to pull — and never hit the auth or network problem. Avoid `:latest` in Deployments; a specific tag makes it clear exactly what's running.

---

## Not actually ImagePullBackOff

- **`InvalidImageName`** — the image reference isn't valid, so Kubernetes doesn't even try to pull. Common causes are uppercase letters in the repository name (`MyApp:1.0` isn't allowed) or a stray space or `https://` in the image field.
- **`Pending`** with no node assigned — the pod was never scheduled, so no pull has been attempted. See [Pod stuck in Pending](/posts/kubernetes-pod-stuck-pending/).
- **`CreateContainerConfigError`** — the image pulled fine, but a ConfigMap or Secret is missing. See [CreateContainerConfigError](/posts/kubernetes-createcontainerconfigerror/).

---

## Reproduce it yourself (2 minutes on kind or minikube)

**Tag that doesn't exist:**

```bash
kubectl run badtag --image=nginx:1.99.99
kubectl get pod badtag -w
```

You'll see `ErrImagePull`, then `ImagePullBackOff`. Read the error:

```bash
kubectl describe pod badtag | grep Failed
```

Fix it in place — a pod's image can be changed without recreating it:

```bash
kubectl set image pod/badtag badtag=nginx:1.27
kubectl get pod badtag -w
```

**Private image with no credentials:**

```bash
kubectl run private --image=ghcr.io/example-private-org/app:1.0
kubectl describe pod private | grep Failed
```

Notice the error doesn't tell you whether the image doesn't exist or you're just not allowed to see it.

Clean up:

```bash
kubectl delete pod badtag private
```

---

## Quick reference

| Error in the event | Cause | Fix |
|---|---|---|
| `not found` | Tag or image doesn't exist | Push the tag or fix the name — check with `docker manifest inspect` |
| `401 Unauthorized` / `pull access denied` | No credentials for a private registry | `imagePullSecrets`, or grant the node identity pull access |
| `toomanyrequests` | Docker Hub rate limit | Authenticate, or mirror images to your own registry |
| `no such host` / `i/o timeout` | Node can't reach the registry | Check hostname, DNS, firewall, private endpoint |
| `no match for platform in manifest` | Wrong CPU architecture | Build multi-arch with `docker buildx` |
| `ErrImageNeverPull` | `imagePullPolicy: Never` and image not on node | Change the policy or preload the image |
| `InvalidImageName` | Malformed image reference | Fix uppercase letters, spaces or `https://` in the name |

**The one-line takeaway:** ImagePullBackOff means the node couldn't download the image. Run `kubectl describe pod`, read the end of the `Failed to pull image` line, and it tells you whether it's the tag, the credentials, or the network.

---

*Next in the series: **[OOMKilled](/posts/kubernetes-oomkilled/)** — why your container gets killed for memory, and how to set limits that actually fit.*
