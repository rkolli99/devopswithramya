---
title: "Azure DevOps: \"Pipeline Does Not Have Permissions to Use the Referenced Service Connection\" — Causes and Fixes (2026)"
date: 2026-11-21T17:00:00+05:30
draft: false
description: "How to fix Azure DevOps pipeline permission errors for service connections, agent pools, variable groups and environments — including why a correctly named resource still 'could not be found'."
tags: ["azure-devops", "azure", "ci-cd", "pipelines", "troubleshooting"]
author: "Ramya Kolli"
---

> **Azure DevOps Pipeline Errors — Series**
> 1. **Pipeline does not have permissions** ← you are here
> 2. No agent found in pool *(coming soon)*
> 3. No hosted parallelism has been purchased or granted *(coming soon)*
> 4. Job ran longer than the maximum time *(coming soon)*
> 5. TF401019: Git repository does not exist *(coming soon)*
> 6. Template and YAML errors *(coming soon)*

You add a new service connection to your YAML pipeline, run it, and it fails before a single step runs:

```
There was a resource authorization issue: "The pipeline is not valid. Job Deploy: Step input
azureSubscription references service connection sc-azure-prod which could not be found.
The service connection does not exist, has been disabled or has not been authorized for use.
For authorization details, refer to https://aka.ms/yamlauthz."
```

Or one of its close relatives:

```
##[error]Pipeline does not have permissions to use the referenced pool(s) build-pool-linux.
```

```
Variable group was not found or is not authorized for use.
For authorization details, refer to https://aka.ms/yamlauthz.
```

The connection exists. You can see it in Project Settings. The name is right. So why "could not be found"?

Because in Azure DevOps, **a resource existing and a pipeline being allowed to use it are two separate things**. The same message is used for "doesn't exist", "disabled" and "not authorized", which is why it's so confusing. This article walks through how to tell which one you have, and how to fix each.

---

## Which resources need permission

Azure DevOps calls these **protected resources**. A YAML pipeline must be explicitly allowed to use each one:

| Resource | Where it's managed |
|---|---|
| Service connections | Project Settings → Service connections |
| Agent pools | Project Settings → Agent pools |
| Variable groups | Pipelines → Library |
| Secure files | Pipelines → Library → Secure files |
| Environments | Pipelines → Environments |
| Repositories (other than the pipeline's own) | Project Settings → Repositories |

Every one of them has its own **Pipeline permissions** list. If your pipeline isn't on it — and the resource isn't open to all pipelines — the run is blocked.

---

## Step 1: Check the run page for a Permit button

Often the fix is one click. Open the failed or waiting run. If authorization is the only problem, you'll see a banner at the top:

```
This pipeline needs permission to access a resource before this run can continue to Deploy
```

Click **View**, then **Permit** next to each resource listed.

Two catches:

- You can only permit a resource if you have the **User** or **Administrator** role on it. Otherwise the button is greyed out, and you need to ask whoever owns the resource.
- The banner only appears when Azure DevOps can work out **which** resource you meant. If the name is wrong, or built from a runtime variable (see cause 3), there's nothing to permit — you just get the "could not be found" error.

---

## Step 2: Work out which case you're in

### 1. The pipeline isn't authorized (most common)

The resource exists and is enabled, but your pipeline isn't on its permissions list. This happens every time you:

- Reference a resource in a pipeline for the first time.
- Create a new pipeline from a YAML file that already references resources.
- Create a new resource that "Grant access permission to all pipelines" was left unticked on.

**Fix it:** open the resource and add the pipeline.

For a service connection:

1. **Project Settings → Service connections** → open the connection.
2. Click **⋮** (top right) → **Security**.
3. Under **Pipeline permissions**, click **+** and add your pipeline.

The path is the same idea for the others: open the pool, variable group, secure file or environment, find **Security** or **Pipeline permissions**, and add the pipeline.

There's also an **Open access** option, which lets every pipeline in the project use the resource. It's convenient, but think before using it on a production service connection — any pipeline, including one somebody creates tomorrow, can then deploy to that subscription.

### 2. The name doesn't match

The pipeline references `sc-azure-prod`, the connection is called `sc-Azure-Prod` or `sc-azure-production`. Azure DevOps looks for the exact name, so this reads as "not found".

**Fix it:** copy the name directly from the Service connections page into your YAML. Watch for trailing spaces, and for connections that were renamed after the pipeline was written.

Also check the connection is in **the same project** as the pipeline. A connection in another project isn't visible unless it has been explicitly shared with this one (**Security → Project permissions** on the connection).

### 3. The name comes from a runtime variable

This one catches people who build reusable templates. It looks perfectly reasonable:

```yaml
variables:
  - name: serviceConnection
    value: sc-azure-prod

steps:
  - task: AzureCLI@2
    inputs:
      azureSubscription: $(serviceConnection)   # doesn't work
```

But it fails with "could not be found". Resource authorization happens **before the run starts**, when the YAML is compiled. At that point, `$(serviceConnection)` is still just the text `$(serviceConnection)` — runtime macros haven't been expanded yet. Azure DevOps looks for a connection literally named `$(serviceConnection)`.

The same applies to variable groups:

```yaml
variables:
  - group: $(vgName)   # doesn't work either
```

**Fix it:** use a template expression or a parameter, which is resolved at compile time:

```yaml
parameters:
  - name: serviceConnection
    type: string
    default: sc-azure-prod

steps:
  - task: AzureCLI@2
    inputs:
      azureSubscription: ${{ parameters.serviceConnection }}   # works
```

Variables defined directly in the YAML can also be used with `${{ variables.serviceConnection }}`, as long as they aren't set at runtime or from a variable group.

### 4. The resource is disabled or was deleted

Someone disabled the service connection, or deleted and recreated it. A recreated connection is a **new** resource with a new ID — it doesn't inherit the old one's pipeline permissions, even with the same name.

**Fix it:** check the connection isn't disabled (**⋮ → Disable/Enable**). If it was recreated, re-add your pipelines under its Security page.

### 5. Environment approvals and checks are waiting

Not an error, but it looks like one: the stage sits in **Waiting** with a message about checks. Environments, service connections and pools can have **Approvals and checks** — manual approvals, business hours, required templates.

**Fix it:** open the run, click the waiting stage, and see which check is pending. Either approve it, or ask the approver listed there.

---

## Doing it for many pipelines at once

Clicking Permit is fine for one pipeline. If you've just added a resource that 20 pipelines need, use the REST API instead. This authorizes a single pipeline (ID `42`) to use a single resource:

```bash
curl -s -X PATCH \
  -u ":$AZURE_DEVOPS_PAT" \
  -H "Content-Type: application/json" \
  -d '{"pipelines":[{"id":42,"authorized":true}]}' \
  "https://dev.azure.com/<org>/<project>/_apis/pipelines/pipelinepermissions/endpoint/<service-connection-id>?api-version=7.1-preview.1"
```

The resource type in the URL changes depending on what you're authorizing:

| Resource | Type in URL |
|---|---|
| Service connection | `endpoint` |
| Agent pool (queue) | `queue` |
| Variable group | `variablegroup` |
| Secure file | `securefile` |
| Environment | `environment` |
| Repository | `repository` |

Use a PAT scoped as narrowly as possible, and keep it in a secret variable or Key Vault — never in the script itself.

---

## Try it yourself (5 minutes in a free Azure DevOps org)

1. **Pipelines → Library → + Variable group.** Name it `demo-vars`, add one variable, and **untick** "Allow access to all pipelines". Save.
2. Create a new pipeline with this YAML:
   ```yaml
   trigger: none
   pool:
     vmImage: ubuntu-latest
   variables:
     - group: demo-vars
   steps:
     - script: echo "It worked"
   ```
3. Run it. You'll see the **"This pipeline needs permission"** banner. Click **View → Permit**, and the run continues.
4. Now change the group line to `- group: $(groupName)` and run again. You get "Variable group was not found or is not authorized" — and this time there's no Permit button, because Azure DevOps can't tell which group you meant.

---

## Quick reference

| What you see | Likely cause | Fix |
|---|---|---|
| "needs permission to access a resource" banner | First use of the resource | Click **View → Permit** |
| "could not be found" + resource exists | Pipeline not on its permissions list | Resource → Security → add pipeline |
| "could not be found" + name looks right | Case, typo, rename, or different project | Copy the exact name; check project sharing |
| Name set with `$(variable)` | Runtime macro not resolved at compile time | Use `${{ parameters.x }}` or `${{ variables.x }}` |
| Was working, now "not found" | Connection disabled or recreated | Re-enable, or re-authorize pipelines on the new one |
| Stage stuck in "Waiting" | Approvals and checks | Open the stage and approve or chase the approver |
| Permit button greyed out | You lack the User role on the resource | Ask the resource owner |

**The one-line takeaway:** "could not be found" in Azure DevOps usually means "not authorized for this pipeline". Check the resource's **Pipeline permissions**, and make sure the name is fixed at compile time, not built from a runtime variable.

---

*Next in the series: **No agent found in pool** — why your job sits in "Waiting for an available agent", and how to find out which agent capability is missing.*
