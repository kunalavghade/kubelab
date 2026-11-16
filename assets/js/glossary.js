// The glossary: every Kubernetes word in plain English. `simple` is one sentence anyone can
// follow; `more` adds the detail; `lesson` is where it is taught; `aka` are other spellings
// used to spot the term in lesson text.
const t = (term, simple, more, lesson, aka = []) => ({ term, simple, more, lesson, aka });

export const GLOSSARY = [
  // ---------- containers and the big picture ----------
  t('Container', 'A running app packed with everything it needs, isolated from other apps on the same machine.', 'It is a normal process that the Linux kernel fences off (namespaces) and limits (cgroups). Many containers share one machine.', 'containers-primer', ['containers']),
  t('Image', 'A read-only package (app + libraries + settings) that containers are started from.', 'Built from layers; identified by a name and tag such as nginx:1.27. One image can start any number of containers.', 'containers-primer', ['images', 'container image']),
  t('Registry', 'An online library of images that machines download from.', 'Docker Hub, GitHub Container Registry and cloud registries are examples. The kubelet pulls images from a registry before starting containers.', 'containers-primer', ['registries']),
  t('Tag', 'The version label after the colon in an image name, like 1.27 in nginx:1.27.', 'Tags can be moved; pin a digest (sha256:…) when you need exactly the same bytes every time.', 'containers-primer', ['image tag']),
  t('Kubernetes', 'Software that runs your containers on many machines and keeps them the way you described.', 'You declare the desired state (for example "3 copies of web"); its controllers keep fixing reality until it matches. Often written K8s.', 'why-kubernetes', ['k8s']),
  t('Desired state', 'What you asked for, written down — for example "3 replicas of nginx:1.27".', 'Stored in spec. Kubernetes compares it with the actual state (status) and changes the cluster until they match.', 'why-kubernetes', ['declarative']),
  t('Reconciliation loop', 'A loop that keeps comparing what you want with what exists and fixes the difference.', 'Every controller runs one: observe → compare → act. This is why deleted pods come back.', 'replicasets', ['control loop', 'reconcile']),
  t('Cluster', 'A group of machines that Kubernetes manages as one big computer.', 'It has a control plane (the brain) and worker nodes (where your apps run).', 'architecture', ['clusters']),
  t('Node', 'One machine (real or virtual) in the cluster.', 'Worker nodes run your pods through the kubelet and a container runtime; control-plane nodes run the cluster\'s brain.', 'architecture', ['nodes', 'worker node']),
  t('Control plane', 'The brain of the cluster that decides what should run where.', 'API server, etcd, scheduler and controller manager. It never runs your app containers itself (on most clusters).', 'architecture'),
  t('API server', 'The front door of the cluster: every request from you or any component goes through it.', 'kube-apiserver checks who you are (authentication), what you may do (RBAC), runs admission, then saves objects in etcd.', 'architecture', ['kube-apiserver']),
  t('etcd', 'The cluster\'s database where every object is stored.', 'A replicated key-value store. Back it up — losing etcd means losing the cluster\'s state.', 'architecture'),
  t('Scheduler', 'The part that picks which node each new pod runs on.', 'kube-scheduler filters out nodes that cannot run the pod, scores the rest, and binds the pod to the best one.', 'scheduling', ['kube-scheduler']),
  t('Controller manager', 'A program full of robots (controllers) that keep fixing the cluster to match what you asked for.', 'kube-controller-manager runs the Deployment, ReplicaSet, Job, node, endpoint and many other controllers.', 'architecture', ['kube-controller-manager']),
  t('Controller', 'A small program that watches objects and makes changes until reality matches the spec.', 'Deployment controller, ReplicaSet controller, your own operators — all follow the same reconcile pattern.', 'replicasets', ['controllers']),
  t('kubelet', 'The agent on every node that actually starts and watches the containers.', 'It reads the pods assigned to its node, asks the container runtime to run them, runs probes and reports status.', 'architecture'),
  t('Container runtime', 'The software on a node that really runs containers, such as containerd.', 'The kubelet talks to it through the Container Runtime Interface (CRI).', 'architecture', ['containerd', 'CRI']),
  t('kube-proxy', 'A node component that makes Service IPs work by forwarding traffic to pods.', 'It programs iptables, IPVS or nftables rules from the Service\'s endpoints. Some CNIs (like Cilium) replace it.', 'services'),
  t('CNI', 'The plugin that gives every pod an IP address and connects pods across nodes.', 'Container Network Interface. Calico, Cilium and Flannel are popular. NetworkPolicies only work if the CNI enforces them.', 'pod-networking', ['CNI plugin']),
  t('CoreDNS', 'The cluster\'s phone book: it turns Service names into IP addresses.', 'Runs as pods in kube-system behind the kube-dns Service at 10.96.0.10 (on most clusters).', 'dns', ['kube-dns']),

  // ---------- working with kubectl ----------
  t('kubectl', 'The command-line tool you use to talk to a cluster.', 'It turns commands into HTTPS requests to the API server, using the cluster and credentials in your kubeconfig.', 'kubectl-basics'),
  t('kubeconfig', 'The file (~/.kube/config) that tells kubectl which clusters exist and how to log in.', 'Holds clusters, users and contexts. KUBECONFIG can point at several files.', 'kubectl-basics'),
  t('Context', 'A saved combination of cluster + user + default namespace in your kubeconfig.', 'kubectl config use-context switches between them — check it before running commands against production.', 'kubectl-basics', ['contexts']),
  t('Manifest', 'A YAML (or JSON) file that describes an object you want in the cluster.', 'Every manifest has apiVersion, kind, metadata and usually spec. kubectl apply -f sends it to the API server.', 'manifests', ['manifests', 'YAML file']),
  t('Object', 'Anything stored in the cluster: a pod, a Service, a Secret, a node…', 'Each has a kind, a name, metadata, a spec you write and a status the system writes.', 'manifests', ['objects', 'resource']),
  t('spec', 'The part of an object where you write what you want.', 'Controllers read spec and work towards it.', 'manifests'),
  t('status', 'The part of an object where Kubernetes writes what is really happening.', 'You never edit status; controllers and the kubelet fill it in.', 'manifests'),
  t('Declarative', 'Describing the end result you want instead of the steps to get there.', 'kubectl apply -f is declarative; kubectl create / scale / delete commands are imperative.', 'manifests', ['declaratively']),
  t('Imperative', 'Telling the cluster exactly what to do, one command at a time.', 'Fast for experiments; harder to repeat and review than files in Git.', 'manifests'),
  t('Label', 'A key=value tag on an object, like app=web, used to find and group things.', 'Selectors match labels. Services, ReplicaSets and NetworkPolicies all find their pods through labels.', 'labels-selectors', ['labels']),
  t('Selector', 'A filter that picks objects by their labels, like "app=web".', 'Equality-based (app=web, tier!=db) or set-based (env in (prod,staging)).', 'labels-selectors', ['selectors', 'label selector']),
  t('Annotation', 'A note attached to an object for tools and humans, not used for selecting.', 'Holds things like change-cause, last-applied-configuration or ingress controller settings.', 'labels-selectors', ['annotations']),
  t('Namespace', 'A named folder inside the cluster that keeps objects apart.', 'Names only need to be unique inside a namespace. Quotas, RBAC and NetworkPolicies are applied per namespace.', 'namespaces', ['namespaces']),
  t('API group', 'The family an object type belongs to, shown in apiVersion (apps/v1, batch/v1…).', 'Core types like Pod and Service have no group, so their apiVersion is just v1.', 'manifests', ['apiVersion']),

  // ---------- workloads ----------
  t('Pod', 'The smallest thing Kubernetes runs: one or more containers that live and die together.', 'Containers in a pod share an IP address (they talk over localhost) and can share volumes. Pods are disposable.', 'pods', ['pods']),
  t('Init container', 'A container that runs to completion before the app containers start.', 'Used for setup: waiting for a database, fetching config, running migrations.', 'pods', ['init containers']),
  t('Sidecar', 'A helper container that runs next to the main app in the same pod.', 'Log shippers and proxies are typical. Native sidecars are init containers with restartPolicy: Always.', 'pods', ['sidecars', 'sidecar container']),
  t('ReplicaSet', 'A controller that keeps a fixed number of identical pods running.', 'You rarely create one yourself — Deployments create and manage ReplicaSets for you.', 'replicasets', ['ReplicaSets']),
  t('Replica', 'One copy of a pod.', 'replicas: 3 means three identical pods, usually spread over different nodes.', 'replicasets', ['replicas']),
  t('Deployment', 'The usual way to run a stateless app: keeps N copies running and updates them safely.', 'Creates a new ReplicaSet for every change to the pod template and rolls traffic over gradually. Supports rollback.', 'deployments', ['Deployments']),
  t('Rolling update', 'Replacing old pods with new ones a few at a time, so the app never goes fully down.', 'Controlled by maxSurge (extra pods allowed) and maxUnavailable (pods that may be missing).', 'deployments', ['rollout', 'rolling updates']),
  t('Rollback', 'Going back to the previous version of a Deployment.', 'kubectl rollout undo switches the Deployment back to an older ReplicaSet\'s pod template.', 'deployments', ['rollout undo']),
  t('StatefulSet', 'Like a Deployment, but each pod keeps a fixed name, order and its own disk.', 'Pods are named db-0, db-1… get stable DNS names and their own PersistentVolumeClaim. Used for databases.', 'statefulsets', ['StatefulSets']),
  t('DaemonSet', 'Runs exactly one copy of a pod on every (matching) node.', 'Used for node agents: log collectors, monitoring exporters, CNI and kube-proxy.', 'daemonsets', ['DaemonSets']),
  t('Job', 'Runs pods until a task finishes successfully, then stops.', 'completions says how many successes you need; parallelism how many pods run at once; backoffLimit how many failures to allow.', 'jobs', ['Jobs']),
  t('CronJob', 'Creates a Job on a schedule, like cron on Linux.', 'schedule uses the five cron fields; concurrencyPolicy decides what happens if the last run is still going.', 'jobs', ['CronJobs']),
  t('Owner reference', 'A pointer from an object to the object that created it.', 'Pods point to their ReplicaSet, ReplicaSets to their Deployment. The garbage collector deletes children when the owner goes.', 'replicasets', ['ownerReferences', 'owner references']),
  t('Garbage collection', 'Automatic cleanup of objects whose owner was deleted.', 'Background (default), foreground or orphan cascading deletes.', 'replicasets', ['garbage collector']),
  t('Finalizer', 'A "not yet!" flag that blocks deletion until a controller finishes cleanup.', 'The object shows Terminating until every finalizer is removed.', 'operators-crds', ['finalizers']),

  // ---------- networking ----------
  t('Pod IP', 'The IP address every pod gets, reachable from every other pod in the cluster.', 'It changes whenever the pod is replaced, which is why you talk to Services instead.', 'pod-networking', ['pod IPs']),
  t('Service', 'A stable name and IP in front of a changing group of pods.', 'Finds pods by label selector and load-balances across the Ready ones. Types: ClusterIP, NodePort, LoadBalancer, ExternalName.', 'services', ['Services']),
  t('ClusterIP', 'A Service IP that is only reachable from inside the cluster.', 'The default Service type. kube-proxy forwards it to the pods behind it.', 'services'),
  t('NodePort', 'A Service that also opens the same port (30000–32767) on every node.', 'Traffic to any node:port reaches the Service. Simple, but usually fronted by a load balancer.', 'services'),
  t('LoadBalancer', 'A Service that asks the cloud (or MetalLB) for an external IP address.', 'Each LoadBalancer Service usually costs a cloud load balancer — Ingress lets many apps share one.', 'services'),
  t('Headless Service', 'A Service without a cluster IP: DNS returns the pod IPs directly.', 'clusterIP: None. StatefulSets use one to give each pod its own DNS name.', 'dns', ['headless']),
  t('Endpoints', 'The live list of pod IPs (and ports) behind a Service.', 'Kept up to date by a controller; only Ready pods are listed. EndpointSlices are the modern, scalable version.', 'services', ['EndpointSlice', 'EndpointSlices']),
  t('Ingress', 'Rules that route outside HTTP(S) traffic to Services by host name and path.', 'Needs an ingress controller (like ingress-nginx or Traefik) to actually do the routing; can terminate TLS.', 'ingress', ['Ingresses']),
  t('Ingress controller', 'The proxy that reads Ingress rules and actually routes the traffic.', 'Without one, Ingress objects do nothing.', 'ingress'),
  t('Gateway API', 'The newer, more powerful successor to Ingress.', 'Splits roles into GatewayClass (infrastructure), Gateway (the listener) and HTTPRoute (app routing); supports traffic splitting.', 'ingress', ['HTTPRoute', 'Gateway']),
  t('NetworkPolicy', 'A firewall rule for pods: which pods may talk to which.', 'Once any policy selects a pod, only allowed traffic gets through. Needs a CNI that enforces it.', 'network-policies', ['NetworkPolicies', 'network policy']),
  t('Port-forward', 'A temporary tunnel from your laptop to a pod or Service.', 'kubectl port-forward svc/web 8080:80 — handy for testing, not for real traffic.', 'services', ['port-forward']),

  // ---------- configuration and storage ----------
  t('ConfigMap', 'A named set of settings you keep outside the image.', 'Pods read it as environment variables or as files in a volume.', 'configmaps', ['ConfigMaps']),
  t('Secret', 'Like a ConfigMap, but for passwords, tokens and keys.', 'Values are base64-encoded (not encrypted!). Protect them with RBAC and encryption at rest.', 'secrets', ['Secrets']),
  t('base64', 'A way to write any bytes as plain letters — encoding, not encryption.', 'Anyone can decode it with base64 -d.', 'secrets'),
  t('Environment variable', 'A named value a program reads at start-up, like APP_MODE=production.', 'Set from env, envFrom, ConfigMaps or Secrets. Changes need a pod restart.', 'configmaps', ['env var', 'env vars', 'environment variables']),
  t('Volume', 'A folder that containers in a pod can mount, possibly outliving a container restart.', 'emptyDir, configMap, secret, persistentVolumeClaim and many more types.', 'storage', ['volumes']),
  t('emptyDir', 'A scratch folder that lives as long as the pod.', 'Shared by containers in the pod; deleted with the pod.', 'storage'),
  t('PersistentVolume', 'A piece of real storage (a disk) available to the cluster.', 'PV for short. Usually created automatically by a StorageClass.', 'storage', ['PV', 'PersistentVolumes']),
  t('PersistentVolumeClaim', 'A request for storage: "I need 1Gi I can write to".', 'PVC for short. Kubernetes binds it to a matching PV; pods mount the claim.', 'storage', ['PVC', 'PVCs', 'PersistentVolumeClaims']),
  t('StorageClass', 'A recipe for creating disks on demand (which provisioner, which type).', 'Sets reclaimPolicy, volumeBindingMode and whether volumes can grow.', 'storage', ['StorageClasses']),
  t('Access mode', 'Who may mount a volume and how: RWO, ROX, RWX or RWOP.', 'ReadWriteOnce means one node can mount it read-write at a time.', 'storage', ['access modes', 'ReadWriteOnce']),

  // ---------- health and resources ----------
  t('Probe', 'A regular health check the kubelet runs against a container.', 'Liveness restarts a stuck container, readiness removes it from Services, startup protects slow starters.', 'probes', ['probes']),
  t('Liveness probe', 'Checks "is the app still alive?" — if not, the container is restarted.', 'Never make it depend on other services, or one outage restarts everything.', 'probes', ['livenessProbe']),
  t('Readiness probe', 'Checks "can the app take traffic right now?" — if not, Services skip it.', 'The pod keeps running; it just gets no requests until it is ready again.', 'probes', ['readinessProbe']),
  t('Startup probe', 'Gives slow-starting apps time before liveness checks begin.', 'Liveness and readiness wait until the startup probe has passed once.', 'probes', ['startupProbe']),
  t('Request', 'The CPU and memory a container is guaranteed — what the scheduler reserves.', 'Pods are placed on nodes by their requests, not their real usage.', 'resources', ['requests']),
  t('Limit', 'The most CPU or memory a container may use.', 'Over the CPU limit it is slowed down (throttled); over the memory limit it is killed (OOMKilled).', 'resources', ['limits']),
  t('Millicore', 'A thousandth of a CPU core: 500m = half a core.', 'CPU requests and limits are written in cores or millicores.', 'resources', ['millicores']),
  t('QoS class', 'Guaranteed, Burstable or BestEffort — decides which pods are evicted first.', 'Set automatically from requests and limits.', 'resources', ['QoS']),
  t('OOMKilled', 'The container used more memory than its limit and the kernel killed it.', 'Exit code 137. Raise the limit or fix the leak.', 'resources', ['OOM']),
  t('ResourceQuota', 'A spending cap for a namespace: total CPU, memory, pods…', 'New pods that would go over the quota are rejected.', 'resources', ['quota']),
  t('LimitRange', 'Default and maximum requests/limits for containers in a namespace.', 'Fills in requests and limits for pods that forgot them.', 'resources'),

  // ---------- scheduling and scaling ----------
  t('Taint', 'A "keep out" mark on a node.', 'Only pods with a matching toleration may be scheduled there (NoSchedule) or keep running there (NoExecute).', 'scheduling', ['taints']),
  t('Toleration', 'A pod\'s permission to run on a node with a matching taint.', 'Tolerating a taint allows the pod there; it does not force it there.', 'scheduling', ['tolerations']),
  t('Node affinity', 'Rules that attract pods to nodes with certain labels.', 'Required (must) or preferred (nice to have) rules over node labels, like zone or disktype.', 'scheduling', ['nodeSelector', 'affinity']),
  t('Pod anti-affinity', 'A rule that keeps matching pods apart, for example one replica per node.', 'Spreads copies so one node failure cannot take them all down.', 'scheduling', ['anti-affinity']),
  t('Topology spread', 'Rules that spread pods evenly across zones or nodes.', 'topologySpreadConstraints with maxSkew.', 'scheduling', ['topologySpreadConstraints']),
  t('PriorityClass', 'A ranking that lets important pods push out less important ones when space runs out.', 'Higher priority pods can preempt (evict) lower priority pods.', 'scheduling', ['priority', 'preemption']),
  t('Pending', 'A pod that has been accepted but is not running yet.', 'Usually waiting for a node (scheduling) or for its image or volume.', 'debugging'),
  t('HorizontalPodAutoscaler', 'Adds or removes pods automatically based on load.', 'HPA for short. desired = ceil(current × currentMetric ÷ target).', 'autoscaling', ['HPA']),
  t('VerticalPodAutoscaler', 'Suggests or sets better CPU/memory requests for pods.', 'VPA for short. Don\'t combine it with an HPA on the same CPU metric.', 'autoscaling', ['VPA']),
  t('Cluster Autoscaler', 'Adds nodes when pods cannot fit, and removes idle nodes.', 'Karpenter is a popular alternative.', 'autoscaling', ['Karpenter']),
  t('metrics-server', 'A small add-on that collects current CPU and memory usage.', 'Powers kubectl top and the HPA. It keeps no history.', 'observability'),

  // ---------- security ----------
  t('RBAC', 'Role-Based Access Control: rules for who may do what in the cluster.', 'Roles list allowed verbs on resources; bindings give roles to users, groups or service accounts.', 'rbac', ['Role', 'Roles', 'RoleBinding', 'ClusterRole']),
  t('ServiceAccount', 'An identity for programs (pods) rather than people.', 'Pods get a short-lived token for their service account to call the API.', 'rbac', ['ServiceAccounts', 'service account', 'service accounts']),
  t('Authentication', 'Proving who you are.', 'Client certificates, OIDC tokens or service-account tokens. Kubernetes has no User objects.', 'rbac', ['authn']),
  t('Authorization', 'Deciding what you are allowed to do.', 'Usually RBAC. kubectl auth can-i answers it.', 'rbac', ['authz']),
  t('Admission control', 'Last checks (and edits) on a request before it is stored.', 'Quotas, LimitRanges, Pod Security Admission and webhooks run here.', 'rbac', ['admission', 'admission webhook']),
  t('securityContext', 'Per-pod or per-container security settings.', 'runAsNonRoot, readOnlyRootFilesystem, dropping capabilities, seccomp…', 'pod-security'),
  t('Pod Security Standards', 'Three ready-made security levels: privileged, baseline and restricted.', 'Pod Security Admission enforces them through namespace labels.', 'pod-security', ['Pod Security Admission', 'PSA']),

  // ---------- operations ----------
  t('Cordon', 'Mark a node "no new pods" without touching the ones already there.', 'kubectl cordon; undo with kubectl uncordon.', 'maintenance'),
  t('Drain', 'Move all pods off a node safely before maintenance.', 'Cordons the node, then evicts pods through the eviction API, respecting PodDisruptionBudgets.', 'maintenance', ['draining']),
  t('PodDisruptionBudget', 'A promise that at least N pods of an app stay up during maintenance.', 'PDB for short. Drains wait instead of breaking it.', 'maintenance', ['PDB']),
  t('Eviction', 'Kubernetes removing a pod from a node on purpose.', 'During drains (voluntary) or when a node runs out of memory or disk (node pressure).', 'maintenance', ['evicted']),
  t('Event', 'A short note about something that happened to an object ("Scheduled", "BackOff").', 'kubectl describe shows them at the bottom; kubectl get events lists them. They expire after about an hour.', 'debugging', ['events']),
  t('CrashLoopBackOff', 'The container keeps crashing, so Kubernetes waits longer and longer before restarting it.', 'Check kubectl logs --previous to see why it died.', 'debugging'),
  t('ImagePullBackOff', 'The node cannot download the image, so it keeps retrying with growing waits.', 'Usually a typo in the name/tag, a private registry without imagePullSecrets, or a rate limit.', 'debugging', ['ErrImagePull']),
  t('Ephemeral container', 'A temporary debugging container added to a running pod.', 'kubectl debug -it pod --image=busybox --target=app.', 'debugging', ['kubectl debug']),
  t('Logs', 'What a container prints to stdout and stderr.', 'kubectl logs reads them; they disappear with the pod unless a log agent ships them away.', 'observability'),
  t('Metrics', 'Numbers measured over time, like CPU usage or requests per second.', 'Prometheus scrapes and stores them; Grafana graphs them.', 'observability', ['Prometheus']),

  // ---------- packaging and extending ----------
  t('Helm', 'A package manager for Kubernetes: install a whole app with one command.', 'Charts are templates plus default values; each install is a release with revisions you can roll back.', 'helm-kustomize'),
  t('Chart', 'A Helm package: templates, default values and metadata.', 'Charts live in repositories or OCI registries.', 'helm-kustomize', ['charts', 'Helm chart']),
  t('Release', 'One installed copy of a Helm chart, with a revision history.', 'helm upgrade creates a new revision; helm rollback goes back.', 'helm-kustomize', ['releases']),
  t('Kustomize', 'A way to keep one base set of YAML and small per-environment changes (overlays).', 'Built into kubectl: kubectl apply -k. No templates — patches instead.', 'helm-kustomize', ['overlay', 'overlays']),
  t('GitOps', 'Keeping the cluster in sync with what is in a Git repository, automatically.', 'Argo CD and Flux pull from Git and apply changes for you.', 'helm-kustomize', ['Argo CD', 'Flux']),
  t('CustomResourceDefinition', 'A way to teach Kubernetes a brand-new object type.', 'CRD for short. After installing one you can kubectl get your new kind.', 'operators-crds', ['CRD', 'CRDs', 'custom resource']),
  t('Operator', 'A controller that encodes expert know-how to run one kind of app, like a database.', 'It watches custom resources and creates StatefulSets, Services, backups… for you.', 'operators-crds', ['operators']),
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALL = GLOSSARY.map((g) => ({ ...g, slug: g.term.toLowerCase().replace(/[^a-z0-9]+/g, '-'), re: new RegExp(`(^|[^\\w-])(${[g.term, ...g.aka].map(escapeRe).join('|')})(?![\\w-])`, 'i') }));
export const GLOSSARY_INDEX = ALL;

// Words every lesson uses; listing them everywhere would be noise.
const GENERIC = new Set(['Kubernetes', 'Cluster', 'kubectl', 'Object']);

/** Terms a lesson uses, in the order they first appear (max `limit`). */
export const termsInLesson = (lesson, limit = 12) => {
  const text = lesson.blocks.filter(([type]) => ['p', 'list', 'tip', 'warn', 'analogy', 'h', 'h3'].includes(type))
    .map(([, d]) => [].concat(d).join(' ')).join(' ').replace(/<[^>]+>/g, ' ');
  const plain = `${lesson.title} ${lesson.summary} ${lesson.plain || ''} ${text}`.replace(/<[^>]+>/g, ' ');
  return ALL.filter((g) => !GENERIC.has(g.term) || g.lesson === lesson.id).map((g) => ({ g, at: plain.search(g.re) })).filter((x) => x.at >= 0)
    .sort((a, b) => (b.g.lesson === lesson.id) - (a.g.lesson === lesson.id) || a.at - b.at)
    .slice(0, limit).map((x) => x.g);
};
