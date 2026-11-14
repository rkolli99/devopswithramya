(function () {
  "use strict";

  var ARTICLES = {
    crash: "/posts/kubernetes-crashloopbackoff-fix/",
    pending: "/posts/kubernetes-pod-stuck-pending/",
    image: "/posts/kubernetes-imagepullbackoff/",
    oom: "/posts/kubernetes-oomkilled/",
    config: "/posts/kubernetes-createcontainerconfigerror/",
    evicted: "/posts/kubernetes-evicted-pods/"
  };

  var SAMPLES = {
    "CrashLoopBackOff": [
      "Name:             payments-api-6c8d9f-7xk2p",
      "Namespace:        shop",
      "Status:           Running",
      "Containers:",
      "  payments-api:",
      "    Image:          myregistry.azurecr.io/payments-api:3.2.0",
      "    State:          Waiting",
      "      Reason:       CrashLoopBackOff",
      "    Last State:     Terminated",
      "      Reason:       Error",
      "      Exit Code:    1",
      "      Started:      Sat, 14 Nov 2026 10:12:03 +0530",
      "      Finished:     Sat, 14 Nov 2026 10:12:05 +0530",
      "    Ready:          False",
      "    Restart Count:  5",
      "Events:",
      "  Type     Reason   Age                From     Message",
      "  ----     ------   ----               ----     -------",
      "  Warning  BackOff  30s (x12 over 3m)  kubelet  Back-off restarting failed container payments-api in pod payments-api-6c8d9f-7xk2p_shop"
    ].join("\n"),
    "Pending": [
      "Name:             reports-api-5f7c9d-k8m2x",
      "Namespace:        analytics",
      "Node:             <none>",
      "Status:           Pending",
      "Containers:",
      "  reports-api:",
      "    Image:      reports-api:1.8.0",
      "    Requests:",
      "      cpu:     2",
      "      memory:  1Gi",
      "Events:",
      "  Type     Reason            Age               From               Message",
      "  ----     ------            ----              ----               -------",
      "  Warning  FailedScheduling  2m (x4 over 6m)   default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 Insufficient cpu. preemption: 0/3 nodes are available: 1 Preemption is not helpful for scheduling, 2 No preemption victims found for incoming pod."
    ].join("\n"),
    "ImagePullBackOff": [
      "Name:             checkout-api-7b9c4d-p2xq8",
      "Namespace:        shop",
      "Node:             worker-1/10.0.1.14",
      "Status:           Pending",
      "Containers:",
      "  checkout-api:",
      "    Image:          myregistry.azurecr.io/checkout-api:2.4.1",
      "    State:          Waiting",
      "      Reason:       ImagePullBackOff",
      "Events:",
      "  Type     Reason     Age                From     Message",
      "  ----     ------     ----               ----     -------",
      "  Normal   Pulling    90s (x4 over 3m)   kubelet  Pulling image \"myregistry.azurecr.io/checkout-api:2.4.1\"",
      "  Warning  Failed     90s (x4 over 3m)   kubelet  Failed to pull image \"myregistry.azurecr.io/checkout-api:2.4.1\": failed to authorize: failed to fetch oauth token: unexpected status: 401 Unauthorized",
      "  Warning  Failed     90s (x4 over 3m)   kubelet  Error: ErrImagePull",
      "  Normal   BackOff    20s (x6 over 3m)   kubelet  Back-off pulling image \"myregistry.azurecr.io/checkout-api:2.4.1\""
    ].join("\n"),
    "OOMKilled": [
      "Name:             orders-worker-6d8f7c-9vq4z",
      "Namespace:        orders",
      "Status:           Running",
      "Containers:",
      "  orders-worker:",
      "    State:          Running",
      "      Started:      Sat, 14 Nov 2026 09:42:10 +0530",
      "    Last State:     Terminated",
      "      Reason:       OOMKilled",
      "      Exit Code:    137",
      "      Started:      Sat, 14 Nov 2026 09:31:02 +0530",
      "      Finished:     Sat, 14 Nov 2026 09:42:08 +0530",
      "    Ready:          True",
      "    Restart Count:  6",
      "    Limits:",
      "      memory:  512Mi",
      "    Requests:",
      "      memory:  256Mi"
    ].join("\n"),
    "CreateContainerConfigError": [
      "Name:             orders-api-7d9f8c6b5-x2kqp",
      "Namespace:        default",
      "Status:           Pending",
      "Containers:",
      "  orders-api:",
      "    State:          Waiting",
      "      Reason:       CreateContainerConfigError",
      "Events:",
      "  Type     Reason     Age                From     Message",
      "  ----     ------     ----               ----     -------",
      "  Normal   Pulled     12s (x6 over 58s)  kubelet  Container image \"orders-api:1.4.2\" already present on machine",
      "  Warning  Failed     12s (x6 over 58s)  kubelet  Error: couldn't find key DB_HOST in ConfigMap default/orders-config"
    ].join("\n"),
    "Evicted": [
      "Name:             orders-worker-6d8f7c-2kx7p",
      "Namespace:        orders",
      "Node:             worker-2/10.0.1.22",
      "Status:           Failed",
      "Reason:           Evicted",
      "Message:          The node was low on resource: memory. Threshold quantity: 100Mi, available: 87304Ki. Container orders-worker was using 1532448Ki, request is 256Mi, has larger consumption of memory."
    ].join("\n")
  };

  // ---------- helpers ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function lineOf(text, re) {
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return lines[i].trim();
    }
    return null;
  }

  function m(text, re, group) {
    var r = text.match(re);
    return r ? r[group || 1] : null;
  }

  function ctx(text) {
    var pod = m(text, /^Name:\s+(\S+)/m);
    var ns = m(text, /^Namespace:\s+(\S+)/m);
    var node = m(text, /^Node:\s+([^\s\/]+)/m);
    var container = m(text, /^Containers:\s*\n\s+([\w.-]+):/m);
    if (node === "<none>") node = null;
    return {
      pod: pod || "<pod-name>",
      ns: ns || "<namespace>",
      node: node || "<node-name>",
      container: container || "<container-name>"
    };
  }

  function fix(text, cmd) {
    return { text: text, cmd: cmd || null };
  }

  // ---------- detectors ----------

  function evicted(t, c) {
    if (!/Reason:\s*Evicted|low on resource:|\bEvicted\b/.test(t)) return null;
    var res = m(t, /low on resource:\s*([\w-]+)/) || "";
    var usage = t.match(/Container ([\w.-]+) was using (\S+), request is (\S+)/);
    var d = {
      status: "Evicted",
      key: "evicted",
      title: "The node ran low on " + (res || "resources") + " and removed this pod",
      what: "Eviction means the node itself was in trouble, not necessarily this pod. The kubelet removes pods to protect the node. If the pod belongs to a Deployment, a replacement was already created on another node \u2014 this entry is just a leftover.",
      evidence: [lineOf(t, /low on resource|Reason:\s*Evicted|\bEvicted\b/)],
      fixes: []
    };
    if (usage) {
      d.evidence.push("Container " + usage[1] + " was using " + usage[2] + ", request is " + usage[3]);
      d.what += " This pod was picked because it was using more than it requested.";
    }
    if (res === "memory") {
      d.fixes.push(fix("Set memory requests close to what the pod really uses. Pods using more than their request are evicted first.", "kubectl top pods -n " + c.ns + " --sort-by=memory"));
      d.fixes.push(fix("Check how much memory is actually requested on the node versus what it holds.", "kubectl describe node " + c.node + " | grep -A 8 \"Allocated resources\""));
      d.fixes.push(fix("For important workloads, set the memory request equal to the limit (Guaranteed QoS) so they're the last to be evicted."));
    } else if (res === "ephemeral-storage") {
      d.fixes.push(fix("Find what's filling the node's disk.", "kubectl debug node/" + c.node + " -it --image=busybox\n# then inside: df -h /host"));
      d.fixes.push(fix("Write logs to stdout instead of files inside the container, and set ephemeral-storage limits so one pod can't fill the node."));
      d.fixes.push(fix("Add a sizeLimit to emptyDir volumes."));
    } else if (res === "pids") {
      d.fixes.push(fix("A process on the node is creating too many processes or threads. Find which pod and fix the app, or set a pod PID limit on the kubelet."));
    } else {
      d.fixes.push(fix("Check the node's conditions to see whether it's memory or disk pressure.", "kubectl describe node " + c.node + " | grep -A 6 Conditions"));
    }
    d.fixes.push(fix("Clean up the leftover Evicted pods once the cause is fixed.", "kubectl delete pods --field-selector=status.phase=Failed -n " + c.ns));
    return d;
  }

  function imagePull(t, c) {
    var invalid = /InvalidImageName/.test(t);
    var never = /ErrImageNeverPull/.test(t);
    if (!invalid && !never && !/ImagePullBackOff|ErrImagePull|Failed to pull image|Back-off pulling image/.test(t)) return null;
    var image = m(t, /(?:Failed to pull image|Back-off pulling image|Pulling image) "([^"]+)"/) || m(t, /^\s*Image:\s+(\S+)/m) || "<image>";
    var d = {
      status: "ImagePullBackOff",
      key: "image",
      title: "The node couldn't download the container image",
      what: "The pod was scheduled, but the image pull failed, so the container never started. There are no app logs \u2014 the cause is in the pull error.",
      evidence: [],
      fixes: []
    };
    var errLine = lineOf(t, /Failed to pull image|InvalidImageName|ErrImageNeverPull/);
    if (errLine) d.evidence.push(errLine);
    d.evidence.push("Image: " + image);

    var acr = /azurecr\.io/.test(image), ecr = /\.dkr\.ecr\./.test(image), gcp = /gcr\.io|pkg\.dev/.test(image);

    if (invalid) {
      d.status = "InvalidImageName";
      d.title = "The image name isn't valid";
      d.what = "Kubernetes couldn't parse the image reference, so it never tried to pull it.";
      d.fixes.push(fix("Check the image field for uppercase letters in the repository name, spaces, or a leading https://."));
    } else if (never) {
      d.status = "ErrImageNeverPull";
      d.title = "imagePullPolicy is Never and the image isn't on the node";
      d.fixes.push(fix("Change imagePullPolicy to IfNotPresent, or load the image onto the node first (for kind: kind load docker-image " + image + ")."));
    } else if (/no match for platform|no matching manifest/.test(t)) {
      d.title = "The image wasn't built for this node's CPU architecture";
      d.fixes.push(fix("Check the node architectures.", "kubectl get nodes -L kubernetes.io/arch"));
      d.fixes.push(fix("Build a multi-architecture image.", "docker buildx build --platform linux/amd64,linux/arm64 -t " + image + " --push ."));
    } else if (/toomanyrequests|429 Too Many Requests|pull rate limit/.test(t)) {
      d.title = "Docker Hub rate limit reached";
      d.fixes.push(fix("Authenticate to Docker Hub with an image pull secret \u2014 authenticated pulls get a higher limit."));
      d.fixes.push(fix("Better: mirror the images you use into your own registry and pull from there."));
      d.fixes.push(fix("Use a specific tag with imagePullPolicy: IfNotPresent so nodes reuse cached images."));
    } else if (/no such host|i\/o timeout|dial tcp|TLS handshake timeout|x509:|connection refused/.test(t)) {
      d.title = "The node can't reach the registry";
      d.fixes.push(fix("Check the registry hostname in the image name for typos."));
      d.fixes.push(fix("Try the pull from the node itself to separate a network problem from an image problem.", "sudo crictl pull " + image));
      d.fixes.push(fix("For private registries, check DNS, firewall rules and private endpoints between the nodes and the registry. An x509 error means the nodes don't trust the registry's certificate."));
    } else if (/unauthorized|401|403 Forbidden|pull access denied|authorization failed|insufficient_scope|denied:/i.test(t)) {
      d.title = "The node isn't allowed to pull this image";
      d.what += " \"pull access denied, repository does not exist or may require authorization\" almost always means credentials for a private image.";
      if (acr) {
        d.fixes.push(fix("On AKS, attach the registry to the cluster so the nodes can pull without a secret.", "az aks update --name <cluster> --resource-group <rg> --attach-acr " + image.split(".")[0]));
      } else if (ecr) {
        d.fixes.push(fix("On EKS, give the node IAM role the AmazonEC2ContainerRegistryReadOnly policy."));
      } else if (gcp) {
        d.fixes.push(fix("On GKE, give the node service account the Artifact Registry Reader role."));
      }
      d.fixes.push(fix("Or create an image pull secret in the pod's namespace.", "kubectl create secret docker-registry regcred \\\n  --docker-server=" + image.split("/")[0] + " \\\n  --docker-username=<username> \\\n  --docker-password=<password-or-token> \\\n  -n " + c.ns));
      d.fixes.push(fix("Reference it in the pod spec (imagePullSecrets: - name: regcred), or attach it to the service account.", "kubectl patch serviceaccount default -n " + c.ns + " -p '{\"imagePullSecrets\":[{\"name\":\"regcred\"}]}'"));
      d.fixes.push(fix("If a secret already exists, check it's in the same namespace and the token hasn't expired."));
    } else if (/not found|manifest unknown/.test(t)) {
      d.title = "The image tag doesn't exist in the registry";
      d.fixes.push(fix("Check the tag exists without pulling it.", "docker manifest inspect " + image));
      if (acr) d.fixes.push(fix("List the tags in Azure Container Registry.", "az acr repository show-tags --name " + image.split(".")[0] + " --repository " + (image.split("/").slice(1).join("/").split(":")[0] || "<repo>") + " --output table"));
      d.fixes.push(fix("Push the missing tag, or fix the tag in your Deployment. If your pipeline builds and deploys separately, check the build step really pushed."));
    } else {
      d.fixes.push(fix("The exact reason is at the end of the \"Failed to pull image\" event line. Paste the full kubectl describe pod output, including Events, for a specific answer.", "kubectl describe pod " + c.pod + " -n " + c.ns));
    }
    return d;
  }

  function config(t, c) {
    var mount = t.match(/MountVolume\.SetUp failed for volume "([^"]+)" : (configmap|secret) "([^"]+)" not found/i);
    if (mount) {
      return {
        status: "ContainerCreating",
        key: "config",
        title: "A volume needs a " + mount[2].toLowerCase() + " that doesn't exist",
        what: "The pod mounts \"" + mount[3] + "\" as a volume, and it's missing in this namespace. With volumes, the pod stays in ContainerCreating instead of showing CreateContainerConfigError \u2014 same root cause.",
        evidence: [lineOf(t, /MountVolume\.SetUp failed/)],
        fixes: [
          fix("Check whether it exists in the pod's namespace.", "kubectl get " + mount[2].toLowerCase() + " " + mount[3] + " -n " + c.ns),
          fix("Create it (or fix the name in the pod spec). The kubelet retries on its own \u2014 no restart needed.")
        ]
      };
    }
    if (!/CreateContainerConfigError|couldn't find key|(?:configmap|secret) "[^"]+" not found|runAsNonRoot/i.test(t)) return null;
    var d = {
      status: "CreateContainerConfigError",
      key: "config",
      title: "Kubernetes couldn't build the container's configuration",
      what: "The container was never created, so there are no logs. The pod references configuration it can't find.",
      evidence: [],
      fixes: []
    };
    var key = t.match(/couldn't find key (\S+) in (ConfigMap|Secret) ([\w.-]+)\/([\w.-]+)/);
    var cm = m(t, /configmap "([^"]+)" not found/i);
    var sec = m(t, /secret "([^"]+)" not found/i);
    if (key) {
      d.title = "The " + key[2] + " exists, but key \"" + key[1] + "\" doesn't";
      d.evidence.push(lineOf(t, /couldn't find key/));
      d.fixes.push(fix("List the keys it actually has. Keys are case-sensitive.", key[2] === "Secret"
        ? "kubectl get secret " + key[4] + " -n " + key[3] + " -o jsonpath='{.data}' | jq 'keys'"
        : "kubectl get configmap " + key[4] + " -n " + key[3] + " -o jsonpath='{.data}'"));
      d.fixes.push(fix("Add the missing key, or fix the key name in the pod spec. A renamed key is the most common cause."));
    } else if (cm) {
      d.title = "ConfigMap \"" + cm + "\" doesn't exist";
      d.evidence.push(lineOf(t, /configmap "[^"]+" not found/i));
      d.fixes.push(fix("Check it exists in the pod's namespace.", "kubectl get configmap " + cm + " -n " + c.ns));
      d.fixes.push(fix("Look for it in other namespaces \u2014 ConfigMaps can't be referenced across namespaces.", "kubectl get configmap -A | grep " + cm));
      d.fixes.push(fix("Create or apply it. The kubelet retries on its own \u2014 no restart needed."));
    } else if (sec) {
      d.title = "Secret \"" + sec + "\" doesn't exist";
      d.evidence.push(lineOf(t, /secret "[^"]+" not found/i));
      d.fixes.push(fix("Check it exists in the pod's namespace.", "kubectl get secret " + sec + " -n " + c.ns));
      d.fixes.push(fix("If it comes from External Secrets, Sealed Secrets or a CI step, check that tool's status \u2014 the Secret may not have been created yet."));
    } else if (/runAsNonRoot/.test(t)) {
      d.title = "runAsNonRoot is set, but the image runs as root";
      d.evidence.push(lineOf(t, /runAsNonRoot/));
      d.fixes.push(fix("Set a non-root user in the pod's securityContext (runAsUser: 1000), or add a USER instruction to the Dockerfile."));
    } else {
      d.fixes.push(fix("The exact reason is in the Events at the bottom of kubectl describe pod. Paste the full output for a specific answer.", "kubectl describe pod " + c.pod + " -n " + c.ns));
    }
    return d;
  }

  function pending(t, c) {
    var sched = /FailedScheduling|nodes are available/.test(t);
    var noNode = /^Node:\s+<none>/m.test(t) || !/^Node:/m.test(t);
    var pendingStatus = /^Status:\s+Pending/m.test(t) || /\bPending\b/.test(t);
    if (!sched && !(noNode && pendingStatus)) return null;
    var d = {
      status: "Pending",
      key: "pending",
      title: "The scheduler can't find a node for this pod",
      what: "The pod hasn't been placed on any node yet, so nothing has started. The scheduling message lists why each node was rejected.",
      evidence: [],
      fixes: []
    };
    var line = lineOf(t, /nodes are available/);
    if (line) d.evidence.push(line.replace(/^.*?(\d+\/\d+ nodes are available)/, "$1"));
    var msg = line || "";

    var insuf = {}, r, re = /Insufficient ([\w.\/-]+)/g;
    while ((r = re.exec(msg))) insuf[r[1]] = true;
    var kinds = Object.keys(insuf);
    if (kinds.length) {
      d.fixes.push(fix("Not enough " + kinds.join(" and ") + " left to request on any node. The scheduler counts what pods have requested, not what they use \u2014 a node at 20% usage can still be full. Check what's already reserved:", "kubectl describe node <node-name> | grep -A 8 \"Allocated resources\""));
      d.fixes.push(fix("Lower the pod's requests if they were copied or guessed, or add capacity (more nodes / cluster autoscaler)."));
    }
    var taint = msg.match(/taint \{([^}]*)\}/);
    if (taint) {
      d.fixes.push(fix("A node has taint {" + taint[1] + "} that the pod doesn't tolerate. If the pod should run there, add a matching toleration. If not, the taint is working as intended \u2014 look at the other reasons.", "kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints"));
    }
    if (/didn't match Pod's node affinity\/selector|didn't match node selector/.test(msg)) {
      d.fixes.push(fix("No node has the label the pod's nodeSelector or affinity asks for. Check the labels (a typo like disk-type vs disktype is common).", "kubectl get nodes --show-labels"));
    }
    if (/unbound immediate PersistentVolumeClaims|persistentvolumeclaim "[^"]+" not found/.test(msg)) {
      d.fixes.push(fix("The pod's PersistentVolumeClaim isn't bound. Check why \u2014 usually a wrong or missing StorageClass.", "kubectl get pvc -n " + c.ns + "\nkubectl describe pvc <pvc-name> -n " + c.ns));
    }
    if (/volume node affinity conflict/.test(msg)) {
      d.fixes.push(fix("The pod's volume is in a different zone from the available nodes. Add capacity in that zone, or use a StorageClass with volumeBindingMode: WaitForFirstConsumer."));
    }
    if (/were unschedulable/.test(msg)) {
      d.fixes.push(fix("A node is cordoned (SchedulingDisabled). Uncordon it once maintenance is done.", "kubectl get nodes\nkubectl uncordon <node-name>"));
    }
    if (/didn't have free ports/.test(msg)) {
      d.fixes.push(fix("The pod uses a hostPort that's already taken on every node. Use a Service instead, or run no more replicas than nodes."));
    }
    if (/pod anti-affinity|pod affinity rules|topology spread/.test(msg)) {
      d.fixes.push(fix("Pod affinity, anti-affinity or topology spread rules can't be satisfied with the current nodes. Relax the rule (preferred instead of required) or add nodes."));
    }
    if (/0\/0 nodes are available/.test(msg)) {
      d.fixes.push(fix("The cluster has no schedulable nodes at all. Check the node pool.", "kubectl get nodes"));
    }
    if (!d.fixes.length) {
      if (!sched) {
        d.fixes.push(fix("No FailedScheduling event was found. If the pod has been Pending a while with no event, check the scheduler is running and the pod's schedulerName is correct.", "kubectl get pods -n kube-system | grep scheduler"));
      } else {
        d.fixes.push(fix("Read the full FailedScheduling message \u2014 each reason maps to a cause in the Pending guide.", "kubectl describe pod " + c.pod + " -n " + c.ns));
      }
    }
    return d;
  }

  function parseTime(s) {
    if (!s) return NaN;
    return Date.parse(s.trim().replace(/^\w{3},\s*/, ""));
  }

  function oom(t, c) {
    if (!/OOMKilled/.test(t)) return null;
    var limit = m(t, /Limits:\s*\n(?:\s+cpu:.*\n)?\s+memory:\s+(\S+)/);
    var req = m(t, /Requests:\s*\n(?:\s+cpu:.*\n)?\s+memory:\s+(\S+)/);
    var ls = t.match(/Last State:\s+Terminated[\s\S]*?Started:\s+(.+)\n\s+Finished:\s+(.+)/);
    var restarts = m(t, /Restart Count:\s+(\d+)/);
    var d = {
      status: "OOMKilled",
      key: "oom",
      title: "The container went over its memory limit and was killed",
      what: "The kernel killed the container the moment it crossed its memory limit (exit code 137). Kubernetes restarted it" + (restarts ? " \u2014 " + restarts + " times so far" : "") + ". Either the limit is too low, or the app uses more memory than it should.",
      evidence: [lineOf(t, /OOMKilled/)],
      fixes: []
    };
    if (limit) d.evidence.push("Memory limit: " + limit + (req ? ", request: " + req : ""));
    var secs = ls ? (parseTime(ls[2]) - parseTime(ls[1])) / 1000 : NaN;
    if (!isNaN(secs) && secs >= 0) {
      var human = secs < 120 ? Math.round(secs) + " seconds" : secs < 7200 ? Math.round(secs / 60) + " minutes" : Math.round(secs / 3600) + " hours";
      d.evidence.push("Ran for " + human + " before being killed");
      if (secs < 60) {
        d.fixes.push(fix("It died within a minute of starting, so the limit is too low for the app to even start up. Raise the memory limit" + (limit ? " (currently " + limit + ")" : "") + "."));
      } else {
        d.fixes.push(fix("It ran for " + human + " first. If memory climbs steadily until it dies, it's a leak \u2014 profile the app; a bigger limit only delays the crash. If it jumps suddenly, match the time against your app logs to find the operation that spikes."));
      }
    } else {
      d.fixes.push(fix("Check how long it ran before dying (Started vs Finished under Last State): seconds means the limit is too low; hours means a leak or a spike."));
    }
    d.fixes.push(fix("See current usage per container (needs metrics-server).", "kubectl top pod " + c.pod + " -n " + c.ns + " --containers"));
    d.fixes.push(fix("Java: use -XX:MaxRAMPercentage=75.0 instead of a fixed -Xmx. Node.js: set --max-old-space-size below the limit. Go: set GOMEMLIMIT a little below the limit."));
    return d;
  }

  function crash(t, c) {
    var hasCrash = /CrashLoopBackOff|Back-off restarting failed container/.test(t);
    var codeStr = m(t, /Last State:\s+Terminated\s*\n\s+Reason:\s+\w+\s*\n\s+Exit Code:\s+(\d+)/) || m(t, /Exit Code:\s+(\d+)/);
    if (!hasCrash && codeStr === null) return null;
    var code = codeStr === null ? null : parseInt(codeStr, 10);
    var reason = m(t, /Last State:\s+Terminated\s*\n\s+Reason:\s+(\w+)/);
    var liveness = /Liveness probe failed|failed liveness probe/.test(t);
    var notFound = /executable file not found|no such file or directory/.test(t);
    var permission = /permission denied/.test(t);

    var before = t.split(/^Containers:/m)[0];
    var initCrash = /Init:CrashLoopBackOff/.test(t) || (/Init Containers:/.test(before) && /CrashLoopBackOff|Exit Code:\s+[1-9]/.test(before));
    var initName = m(t, /^Init Containers:\s*\n\s+([\w.-]+):/m);

    var d = {
      status: initCrash ? "Init:CrashLoopBackOff" : "CrashLoopBackOff",
      key: "crash",
      title: "The container keeps crashing and Kubernetes keeps restarting it",
      what: "CrashLoopBackOff isn't the error itself \u2014 the real error is inside the container. The exit code tells you what kind of failure it is.",
      evidence: [],
      fixes: []
    };
    if (reason || code !== null) d.evidence.push("Last State: Terminated" + (reason ? ", Reason: " + reason : "") + (code !== null ? ", Exit Code: " + code : ""));
    var probeLine = lineOf(t, /Liveness probe failed/);
    if (probeLine) d.evidence.push(probeLine);
    var cn = initCrash && initName ? initName : c.container;
    var logs = "kubectl logs " + c.pod + " -n " + c.ns + " -c " + cn + " --previous";

    if (initCrash) {
      d.title = "An init container keeps failing, so the app never starts";
      d.what = "The main container waits until every init container succeeds. The failing one is " + (initName ? "\"" + initName + "\"" : "an init container") + ".";
      d.fixes.push(fix("Read the init container's logs from the failed run.", logs));
      d.fixes.push(fix("Usually a failing script or a dependency it's waiting for (database, another service)."));
      return d;
    }
    if (liveness) {
      d.title = "The liveness probe is killing the container";
      d.what = "Kubernetes is restarting a container that may actually be fine \u2014 just slow to start, or the probe is pointing at the wrong path or port.";
      d.fixes.push(fix("Add a startupProbe so liveness checks wait until the app has started (e.g. failureThreshold: 30, periodSeconds: 5 allows 150s)."));
      d.fixes.push(fix("Check the probe's path and port match what the app really serves."));
      d.fixes.push(fix("Check the app logs around the time the probe failed.", logs));
      return d;
    }
    if (code === 0 || reason === "Completed") {
      d.title = "Nothing crashed \u2014 the process finished and exited";
      d.what = "Exit code 0 means the command completed successfully. A Deployment expects it to keep running, so Kubernetes restarts it.";
      d.fixes.push(fix("If it's meant to run once, use a Job instead of a Deployment."));
      d.fixes.push(fix("If it's meant to keep running, make sure the main process stays in the foreground (e.g. nginx needs daemon off;)."));
      return d;
    }
    if (code === 127 || code === 126 || code === 128 || notFound || permission || reason === "StartError" || reason === "ContainerCannotRun") {
      d.title = (code === 126 || permission) ? "The start command isn't executable" : "The start command doesn't exist in the image";
      var l = lineOf(t, /executable file not found|no such file or directory|permission denied/);
      if (l) d.evidence.push(l);
      d.fixes.push(fix("Compare command and args in your YAML with what actually exists in the image. A typo is the usual cause."));
      d.fixes.push(fix("For scripts, make sure the Dockerfile makes them executable (RUN chmod +x start.sh)."));
      d.fixes.push(fix("Start a copy of the pod with a shell to look around.", "kubectl debug " + c.pod + " -n " + c.ns + " -it --copy-to=" + c.pod + "-debug --container=" + c.container + " -- sh"));
      return d;
    }
    if (code === 137) {
      d.title = "The container was killed with SIGKILL";
      d.what = "Exit code 137 without OOMKilled usually means something killed it from outside \u2014 most often a failed liveness probe, or a node under memory pressure.";
      d.fixes.push(fix("Check the events for probe failures and the node for memory pressure.", "kubectl describe pod " + c.pod + " -n " + c.ns + " | grep -A 20 Events"));
      return d;
    }
    if (code === 139) {
      d.title = "The app crashed with a segmentation fault";
      d.fixes.push(fix("This is a bug in the app or a native library \u2014 often a base image or architecture mismatch. Check the logs from the crashed run.", logs));
      return d;
    }
    if (code === 143) {
      d.title = "The container received SIGTERM and shut down";
      d.fixes.push(fix("Something asked it to stop \u2014 a probe failure, a rollout, or the app exiting on a signal. Check the events.", "kubectl describe pod " + c.pod + " -n " + c.ns + " | grep -A 20 Events"));
      return d;
    }
    d.title = code !== null ? "The application exited with an error (exit code " + code + ")" : d.title;
    d.fixes.push(fix("Read the logs from the run that crashed. --previous is the important part \u2014 without it you get the new, often empty, attempt.", logs));
    d.fixes.push(fix("Common causes: a missing environment variable, a bad config value, or a database or service that isn't reachable on startup."));
    d.fixes.push(fix("If it dies too fast to inspect, start a copy with a shell.", "kubectl debug " + c.pod + " -n " + c.ns + " -it --copy-to=" + c.pod + "-debug --container=" + c.container + " -- sh"));
    return d;
  }

  function other(t, c) {
    if (/FailedCreatePodSandBox/.test(t)) {
      return {
        status: "ContainerCreating",
        key: null,
        title: "The node couldn't set up the pod's network sandbox",
        what: "This is a node-level problem, usually the CNI network plugin or the node running out of IP addresses.",
        evidence: [lineOf(t, /FailedCreatePodSandBox/)],
        fixes: [fix("Check the network plugin pods on that node.", "kubectl get pods -n kube-system -o wide | grep " + c.node)]
      };
    }
    if (/FailedMount|FailedAttachVolume/.test(t)) {
      return {
        status: "ContainerCreating",
        key: null,
        title: "A volume couldn't be attached or mounted",
        what: "The pod is scheduled but waiting for its volume.",
        evidence: [lineOf(t, /FailedMount|FailedAttachVolume/)],
        fixes: [fix("Check the PVC and its events.", "kubectl describe pvc <pvc-name> -n " + c.ns)]
      };
    }
    if (/State:\s+Running/.test(t) && !/Warning/.test(t)) {
      return {
        status: "Running",
        key: null,
        healthy: true,
        title: "No errors found",
        what: "The container is running and there are no warnings in the output. If something's still wrong, it's likely inside the application \u2014 check its logs.",
        evidence: [],
        fixes: [fix("Read the app logs.", "kubectl logs " + c.pod + " -n " + c.ns)]
      };
    }
    return null;
  }

  function decode(text) {
    var c = ctx(text);
    var order = [evicted, imagePull, config, pending, oom, crash, other];
    for (var i = 0; i < order.length; i++) {
      var d = order[i](text, c);
      if (d) {
        d.evidence = d.evidence.filter(Boolean);
        d.thin = !/^Name:/m.test(text) || !/Events:|Last State:|Message:/.test(text);
        return d;
      }
    }
    return null;
  }

  // ---------- rendering ----------

  function render(d) {
    if (!d) {
      return '<div class="pd-card pd-unknown"><div class="pd-head"><span class="pd-badge">Not recognised</span></div>' +
        '<p class="pd-what">Couldn\'t match a known pod error in that text. Paste the <strong>full</strong> output of <code>kubectl describe pod &lt;pod-name&gt; -n &lt;namespace&gt;</code>, including the Events section at the bottom.</p></div>';
    }
    var h = '<div class="pd-card' + (d.healthy ? " pd-ok" : "") + '">';
    h += '<div class="pd-head"><span class="pd-badge">' + esc(d.status) + '</span><span class="pd-title">' + esc(d.title) + "</span></div>";
    h += '<p class="pd-what">' + esc(d.what) + "</p>";
    if (d.evidence.length) {
      h += '<div class="pd-label">Found in your output</div><pre class="pd-evidence">' + d.evidence.map(esc).join("\n") + "</pre>";
    }
    if (d.fixes.length) {
      h += '<div class="pd-label">What to do</div><ol class="pd-fixes">';
      d.fixes.forEach(function (f) {
        h += "<li><span>" + esc(f.text) + "</span>";
        if (f.cmd) h += '<div class="pd-cmd"><pre>' + esc(f.cmd) + '</pre><button type="button" class="pd-copy">Copy</button></div>';
        h += "</li>";
      });
      h += "</ol>";
    }
    if (d.thin) {
      h += '<p class="pd-note">For a more exact answer, paste the full <code>kubectl describe pod</code> output, including Events.</p>';
    }
    if (d.key && ARTICLES[d.key]) {
      h += '<a class="pd-more" href="' + ARTICLES[d.key] + '">Read the full ' + esc(d.status.replace(/^Init:/, "")) + " guide &rarr;</a>";
    }
    return h + "</div>";
  }

  function init() {
    var root = document.getElementById("pod-decoder");
    if (!root) return;
    var input = root.querySelector("#pd-input");
    var out = root.querySelector("#pd-result");
    var samples = root.querySelector(".pd-samples");

    Object.keys(SAMPLES).forEach(function (k) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pd-sample";
      b.textContent = k;
      b.addEventListener("click", function () {
        input.value = SAMPLES[k];
        run();
      });
      samples.appendChild(b);
    });

    function run() {
      var text = input.value.trim();
      if (!text) {
        out.innerHTML = "";
        return;
      }
      out.innerHTML = render(decode(text));
      out.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    root.querySelector("#pd-run").addEventListener("click", run);
    root.querySelector("#pd-clear").addEventListener("click", function () {
      input.value = "";
      out.innerHTML = "";
      input.focus();
    });
    out.addEventListener("click", function (e) {
      if (!e.target.classList.contains("pd-copy")) return;
      var pre = e.target.previousElementSibling;
      try {
        navigator.clipboard.writeText(pre.textContent).then(function () {
          e.target.textContent = "Copied";
          setTimeout(function () { e.target.textContent = "Copy"; }, 1500);
        });
      } catch (err) {}
    });
  }

  window.PodDecoder = { decode: decode };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
