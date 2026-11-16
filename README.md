# Kube Lab — learn Kubernetes visually

An interactive website that teaches Kubernetes from zero to advanced. Every concept has an animation you can play with, every `kubectl` and Helm command is explained flag by flag with a live lab, every manifest is explained line by line, and a playground gives you a whole simulated cluster to break.

**Live site:** https://kunalavghade.github.io/kubelab/ · **Author:** [Kunal Avghade (@kunalavghade)](https://github.com/kunalavghade)

If it helps you, please ⭐ the repo so more people can find it. New to containers? Start with [Docker Lab](https://kunalavghade.github.io/dockerlab/).

## What's inside

- **29 lessons** in three levels:
  - **Beginner:** why Kubernetes, how a cluster works, kubectl and your first cluster, Pods, YAML manifests, labels and selectors, namespaces, ReplicaSets and self-healing
  - **Intermediate:** Deployments and rolling updates, Services, DNS, Ingress and the Gateway API, ConfigMaps, Secrets, storage, probes, resources and QoS, Jobs and CronJobs, DaemonSets, StatefulSets
  - **Advanced:** scheduling, autoscaling, RBAC, network policies, pod security, cluster operations, debugging, Helm and Kustomize, CRDs and operators
- **Interactive animations** in every lesson: requests flowing through the control plane, rolling updates with surge sliders, traffic spreading over ready pods, the scheduler filtering and scoring nodes, drains blocked by a PodDisruptionBudget, an HPA reacting to load, and more. Every scene also has a small terminal that understands the real `kubectl` command.
- **Command reference with 96 commands** (`#/commands`): every common `kubectl` and `helm` command with syntax, what happens inside the cluster, every important option, examples that build on each other, common errors, and a **live lab** on its own simulated cluster.
- **Playground:** a simulated kind cluster (1 control-plane + 3 worker nodes) with 17 challenges and a live picture of nodes, pods, workloads and Services.
- **Cheat sheet:** a searchable list of the commands you'll actually use.
- **Quizzes** that mark a lesson complete. Progress is saved in your browser.

## The simulated cluster

`assets/js/sim/` is a small Kubernetes written in plain JavaScript. It runs in the browser and under Node, so the tests use it directly.

- **API server:** typed objects, defaulting, validation, admission (ResourceQuota, LimitRange, Pod Security Admission), RBAC for `--as`, CRDs.
- **Controllers:** Deployment (real `maxSurge`/`maxUnavailable` maths, revisions, rollback, progress deadline), ReplicaSet (adoption), StatefulSet (ordered, stable names, per-pod claims, partitions), DaemonSet, Job, CronJob, HPA (with stabilization), endpoints/EndpointSlices, PV provisioning (WaitForFirstConsumer), garbage collection, namespaces, PodDisruptionBudgets.
- **Scheduler:** filters (taints, node selectors, affinity, anti-affinity, topology spread, resources, volume node affinity), scoring, preemption, and the real "0/4 nodes are available: …" messages.
- **Kubelet:** image pulls, CrashLoopBackOff with back-off, OOMKilled, missing ConfigMaps/Secrets, liveness/readiness/startup probes, init and sidecar containers, graceful termination, node failure.
- **Networking:** CoreDNS search domains, headless Services and per-pod names, kube-proxy load-balancing over ready pods, NodePorts, LoadBalancer IPs, Ingress routing, NetworkPolicies (including the DNS-egress gotcha).
- **Tools:** `kubectl` (get/describe with `-o wide|yaml|json|jsonpath|custom-columns`, apply/diff/patch, rollout, logs, exec, port-forward, debug, drain, taint, wait, auth, config…), `helm` (repos, install/upgrade/rollback, release Secrets, templates), Kustomize, and a host shell with pipes, `$(…)`, redirects and `sed -i`.

Time passes 10 seconds per command (`sleep N` lets more pass). `sim node down node-2` powers a node off and `sim load web` starts a load generator.

## Run locally

It's a static site with no build step. Serve the folder with any static server (ES modules don't load over `file://`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Test

```bash
npm test
```

This checks the cluster's behaviour (rollouts, self-healing, DNS, NetworkPolicies, StatefulSets, HPA, RBAC, drains, scheduling, Helm, Kustomize) and runs every command-reference lab. CI runs it before every deploy.

## Project layout

```
index.html                 page shell, SEO and share tags
assets/css/                theme + one stylesheet per lesson level
assets/js/app.js           router, sidebar, lesson renderer
assets/js/lessons/         lesson content (beginner, intermediate-a/b, advanced) and the cheat sheet
assets/js/anim/            lesson animations; shared visuals live in animations.js
assets/js/ref/             command reference entries
assets/js/sim/             the simulated cluster (API server, controllers, scheduler, kubelet, kubectl, helm)
assets/js/commands.js      command index and command pages with live labs
assets/js/playground.js    the playground
```

## Add a command

Add an entry to one of the files in `assets/js/ref/` (the shape is documented in `assets/js/reference.js`). If the simulator doesn't know the command yet, add it in `assets/js/sim/kubectl.js` or `kubectl-ops.js`. Then run `npm test`.

## Add a lesson

1. Add an entry to the right file in `assets/js/lessons/`, using blocks such as `['p', html]`, `['cmd', {...}]`, `['file', {...}]` and `['anim', 'key']`.
2. Add its animation as `A.key = (root) => { ... }` in the matching `assets/js/anim/` file, using the `scene()` helper and the shared visuals (`podEl`, `nodeBox`, `controlPlane`, `yamlCard`).

## Author

Made by **Kunal Avghade** — [github.com/kunalavghade](https://github.com/kunalavghade).
