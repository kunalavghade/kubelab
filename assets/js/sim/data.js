// Static data for the simulated cluster: container images and how they behave, the starting
// cluster (nodes and system add-ons) and the project folder of sample manifests.

export const K8S_VERSION = 'v1.34.2';
export const CLUSTER_NAME = 'kubelab';
export const SERVICE_CIDR_BASE = '10.96';
export const POD_CIDR_BASE = '10.244';

/**
 * How each image behaves when the kubelet runs it.
 * kind: server (runs until stopped) | command (runs its command) | crash (exits 1) | stress (allocates memory)
 * port: the port the app listens on. body(ctx): HTTP response. env: required env vars (missing → crash).
 * logs(ctx): lines printed on start. sizeMB: pull size (bigger = slower pull, purely cosmetic).
 */
export const IMAGES = {
  nginx: {
    kind: 'server', port: 80, tags: ['latest', '1.27', '1.27.3', '1.26', '1.25', 'alpine', 'stable'],
    body: () => '<!DOCTYPE html>\n<html>\n<head><title>Welcome to nginx!</title></head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and working.</p>\n</body>\n</html>',
    logs: () => ['/docker-entrypoint.sh: Configuration complete; ready for start up', '2026/11/16 09:00:00 [notice] 1#1: nginx/1.27.3', '2026/11/16 09:00:00 [notice] 1#1: start worker processes'],
    accessLog: (ctx) => `${ctx.clientIp} - - [16/Nov/2026:09:01:00 +0000] "GET ${ctx.path} HTTP/1.1" 200 615 "-" "curl/8.11.1"`,
  },
  httpd: { kind: 'server', port: 80, tags: ['latest', '2.4', 'alpine'], body: () => '<html><body><h1>It works!</h1></body></html>', logs: () => ['AH00558: httpd: Could not reliably determine the server\'s fully qualified domain name', '[mpm_event:notice] AH00489: Apache/2.4.62 (Unix) configured -- resuming normal operations'] },
  'kubelab/hello': {
    kind: 'server', port: 8080, tags: ['1.0', '2.0', 'latest'],
    body: (ctx) => `Hello from ${ctx.pod} (version ${ctx.tag === 'latest' ? '2.0' : ctx.tag})`,
    logs: (ctx) => [`hello ${ctx.tag}: listening on :8080`],
    accessLog: (ctx) => `GET ${ctx.path} 200 from ${ctx.clientIp}`,
  },
  'registry.k8s.io/hpa-example': { kind: 'server', port: 80, tags: ['latest'], body: () => 'OK!', logs: () => ['AH00094: Command line: \'apache2 -D FOREGROUND\''], cpuPerRequest: 1 },
  redis: { kind: 'server', port: 6379, tags: ['latest', '7', '7.4', 'alpine'], logs: () => ['1:C 16 Nov 2026 09:00:00.000 * Redis version=7.4.1, bits=64', '1:M 16 Nov 2026 09:00:00.001 * Ready to accept connections tcp'] },
  postgres: {
    kind: 'server', port: 5432, tags: ['latest', '17', '16', '15'], env: ['POSTGRES_PASSWORD'],
    logs: () => ['PostgreSQL init process complete; ready for start up.', 'LOG:  database system is ready to accept connections'],
    missingEnvLogs: () => ['Error: Database is uninitialized and superuser password is not specified.', '       You must specify POSTGRES_PASSWORD to a non-empty value for the', '       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".'],
  },
  mysql: { kind: 'server', port: 3306, tags: ['latest', '8.4', '9'], env: ['MYSQL_ROOT_PASSWORD'], logs: () => ['[Server] /usr/sbin/mysqld: ready for connections. Version: \'8.4.3\''], missingEnvLogs: () => ['[ERROR] [Entrypoint]: Database is uninitialized and password option is not specified', '    You need to specify one of the following as an environment variable:', '    - MYSQL_ROOT_PASSWORD'] },
  busybox: { kind: 'command', tags: ['latest', '1.37', 'stable'] },
  alpine: { kind: 'command', tags: ['latest', '3.21', '3.20'] },
  'curlimages/curl': { kind: 'command', tags: ['latest', '8.11.1'] },
  'nicolaka/netshoot': { kind: 'command', tags: ['latest'] },
  perl: { kind: 'command', tags: ['latest', '5.40'] },
  'kubelab/crash': { kind: 'crash', tags: ['latest'], logs: () => ['starting app…', 'panic: could not connect to database at db:5432: connection refused', 'goroutine 1 [running]:', 'main.main()'] },
  'polinux/stress': { kind: 'stress', tags: ['latest'], logs: () => ['stress: info: [1] dispatching hogs: 0 cpu, 0 io, 1 vm, 0 hdd'] },
  'fluent/fluent-bit': { kind: 'server', port: 2020, tags: ['latest', '3.2'], logs: () => ['[ info] [fluent bit] version=3.2.2', '[ info] [input:tail:tail.0] initializing', '[ info] [sp] stream processor started'] },
  'prom/node-exporter': { kind: 'server', port: 9100, tags: ['latest', 'v1.8.2'], logs: () => ['msg="Starting node_exporter" version="(version=1.8.2)"', 'msg="Listening on" address=[::]:9100'] },
  'registry.k8s.io/pause': { kind: 'server', tags: ['3.10'] },
  // System add-ons (already on every node).
  'registry.k8s.io/coredns/coredns': { kind: 'server', port: 53, tags: ['v1.12.0'], system: true, logs: () => ['.:53', 'CoreDNS-1.12.0', 'linux/amd64, go1.23.3'] },
  'registry.k8s.io/kube-proxy': { kind: 'server', tags: ['v1.34.2'], system: true, logs: () => ['"Using iptables Proxier"', '"Starting service config controller"'] },
  'registry.k8s.io/metrics-server/metrics-server': { kind: 'server', port: 10250, tags: ['v0.7.2'], system: true, logs: () => ['"Serving securely on [::]:10250"'] },
  'docker.io/calico/node': { kind: 'server', tags: ['v3.29.1'], system: true, logs: () => ['Calico node started successfully'] },
  'docker.io/calico/kube-controllers': { kind: 'server', tags: ['v3.29.1'], system: true, logs: () => ['Starting Calico kube-controllers'] },
  'registry.k8s.io/ingress-nginx/controller': { kind: 'server', port: 80, tags: ['v1.12.0'], system: true, logs: () => ['NGINX Ingress controller', 'Release: v1.12.0', 'Starting NGINX Ingress controller'] },
  'rancher/local-path-provisioner': { kind: 'server', tags: ['v0.0.30'], system: true, logs: () => ['Provisioner started'] },
  'registry.k8s.io/etcd': { kind: 'server', port: 2379, tags: ['3.5.16-0'], system: true, logs: () => ['"serving client traffic securely","address":"[::]:2379"'] },
  'registry.k8s.io/kube-apiserver': { kind: 'server', port: 6443, tags: ['v1.34.2'], system: true, logs: () => ['"Serving securely on [::]:6443"'] },
  'registry.k8s.io/kube-controller-manager': { kind: 'server', tags: ['v1.34.2'], system: true, logs: () => ['"Started controller" controller="deployment-controller"', '"Started controller" controller="replicaset-controller"'] },
  'registry.k8s.io/kube-scheduler': { kind: 'server', tags: ['v1.34.2'], system: true, logs: () => ['"Serving securely on 127.0.0.1:10259"', '"Successfully acquired lease" lease="kube-system/kube-scheduler"'] },
  'bitnami/nginx': { kind: 'server', port: 8080, tags: ['1.27.3', 'latest'], body: () => '<html><body><h1>Welcome to nginx!</h1><p>(Bitnami)</p></body></html>', logs: () => ['nginx 09:00:00.00 INFO  ==> ** Starting NGINX **'] },
  'bitnami/redis': { kind: 'server', port: 6379, tags: ['7.4.1', 'latest'], logs: () => ['redis 09:00:00.00 INFO  ==> ** Starting Redis **', '1:M * Ready to accept connections tcp'] },
  'kubelab/postgres-operator': { kind: 'server', tags: ['1.0'], logs: () => ['operator started: watching PostgresCluster resources'] },
};

/** "docker.io/library/nginx:1.27" → { repo: 'nginx', tag: '1.27' } */
export const parseImage = (ref) => {
  const clean = String(ref || '').replace(/^docker\.io\/library\//, '').replace(/^docker\.io\/(?=(bitnami|kubelab|polinux|fluent|prom|nicolaka|curlimages|rancher)\/)/, '').split('@')[0];
  const at = clean.lastIndexOf(':');
  const hasTag = at > 0 && !clean.slice(at).includes('/');
  return { repo: hasTag ? clean.slice(0, at) : clean, tag: hasTag ? clean.slice(at + 1) : 'latest' };
};

export const imageInfo = (ref) => {
  const { repo, tag } = parseImage(ref);
  const info = IMAGES[repo];
  return info && info.tags.includes(tag) ? { ...info, repo, tag } : null;
};

// ---------- the starting cluster ----------
const NODE_SPECS = [
  { name: 'control-plane', ip: '172.18.0.2', role: 'control-plane', zone: 'zone-a' },
  { name: 'node-1', ip: '172.18.0.3', zone: 'zone-a' },
  { name: 'node-2', ip: '172.18.0.4', zone: 'zone-b' },
  { name: 'node-3', ip: '172.18.0.5', zone: 'zone-c' },
];

export const nodeObjects = () => NODE_SPECS.map((n, i) => ({
  apiVersion: 'v1', kind: 'Node',
  metadata: {
    name: n.name,
    labels: {
      'kubernetes.io/arch': 'amd64', 'kubernetes.io/os': 'linux', 'kubernetes.io/hostname': n.name,
      'topology.kubernetes.io/zone': n.zone,
      ...(n.role ? { 'node-role.kubernetes.io/control-plane': '' } : {}),
    },
    annotations: { 'node.alpha.kubernetes.io/ttl': '0' },
  },
  spec: {
    podCIDR: `${POD_CIDR_BASE}.${i}.0/24`,
    ...(n.role ? { taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] } : {}),
  },
  status: {
    capacity: { cpu: '2', memory: '4019532Ki', pods: '110', 'ephemeral-storage': '61202244Ki' },
    allocatable: { cpu: '2', memory: '3917132Ki', pods: '110', 'ephemeral-storage': '61202244Ki' },
    addresses: [{ type: 'InternalIP', address: n.ip }, { type: 'Hostname', address: n.name }],
    conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is posting ready status' }],
    nodeInfo: { kubeletVersion: K8S_VERSION, containerRuntimeVersion: 'containerd://2.0.1', osImage: 'Debian GNU/Linux 12 (bookworm)', kernelVersion: '6.8.0-49-generic', architecture: 'amd64', operatingSystem: 'linux' },
  },
}));

const sysDeploy = (name, ns, image, { replicas = 1, labels = { 'k8s-app': name }, ports = [], cpu = '100m', mem = '70Mi', tolerateCP = false } = {}) => ({
  apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels },
  spec: {
    replicas, selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        priorityClassName: 'system-cluster-critical',
        containers: [{ name, image, ports, resources: { requests: { cpu, memory: mem } } }],
        ...(tolerateCP ? { tolerations: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] } : {}),
      },
    },
  },
});

const sysDaemon = (name, ns, image) => ({
  apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name, namespace: ns, labels: { 'k8s-app': name } },
  spec: {
    selector: { matchLabels: { 'k8s-app': name } },
    template: {
      metadata: { labels: { 'k8s-app': name } },
      spec: { priorityClassName: 'system-node-critical', tolerations: [{ operator: 'Exists' }], containers: [{ name, image, resources: { requests: { cpu: '100m' } } }] },
    },
  },
});

// The four control-plane components run as static pods on the control-plane node.
const staticPod = (component, image) => ({
  apiVersion: 'v1', kind: 'Pod',
  metadata: { name: `${component}-control-plane`, namespace: 'kube-system', labels: { component, tier: 'control-plane' }, annotations: { 'kubernetes.io/config.source': 'file' } },
  spec: { nodeName: 'control-plane', priorityClassName: 'system-node-critical', containers: [{ name: component, image: `registry.k8s.io/${image}`, resources: { requests: { cpu: component === 'kube-apiserver' ? '250m' : '100m' } } }] },
});

/** Objects created when the cluster boots, in order. Controllers then create their pods. */
export const bootstrapObjects = () => [
  ...['default', 'kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx', 'local-path-storage'].map((name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: { 'kubernetes.io/metadata.name': name } } })),
  { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'system-cluster-critical' }, value: 2000000000, description: 'Used for system critical pods that must run in the cluster, but can be moved to another node if necessary.' },
  { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'system-node-critical' }, value: 2000001000, description: 'Used for system critical pods that must not be moved from their current node.' },
  { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'standard', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: true },
  { apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: { name: 'nginx', annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' } }, spec: { controller: 'k8s.io/ingress-nginx' } },
  staticPod('etcd', 'etcd:3.5.16-0'), staticPod('kube-apiserver', 'kube-apiserver:v1.34.2'), staticPod('kube-controller-manager', 'kube-controller-manager:v1.34.2'), staticPod('kube-scheduler', 'kube-scheduler:v1.34.2'),
  sysDeploy('coredns', 'kube-system', 'registry.k8s.io/coredns/coredns:v1.12.0', { replicas: 2, labels: { 'k8s-app': 'kube-dns' }, ports: [{ name: 'dns', containerPort: 53, protocol: 'UDP' }], tolerateCP: true }),
  sysDeploy('metrics-server', 'kube-system', 'registry.k8s.io/metrics-server/metrics-server:v0.7.2', { labels: { 'k8s-app': 'metrics-server' } }),
  sysDeploy('calico-kube-controllers', 'kube-system', 'docker.io/calico/kube-controllers:v3.29.1', { labels: { 'k8s-app': 'calico-kube-controllers' }, tolerateCP: true }),
  sysDeploy('ingress-nginx-controller', 'ingress-nginx', 'registry.k8s.io/ingress-nginx/controller:v1.12.0', { labels: { 'app.kubernetes.io/name': 'ingress-nginx', 'app.kubernetes.io/component': 'controller' }, ports: [{ name: 'http', containerPort: 80 }, { name: 'https', containerPort: 443 }] }),
  sysDeploy('local-path-provisioner', 'local-path-storage', 'docker.io/rancher/local-path-provisioner:v0.0.30', { labels: { app: 'local-path-provisioner' }, tolerateCP: true }),
  sysDaemon('kube-proxy', 'kube-system', 'registry.k8s.io/kube-proxy:v1.34.2'),
  sysDaemon('calico-node', 'kube-system', 'docker.io/calico/node:v3.29.1'),
  { apiVersion: 'v1', kind: 'Service', metadata: { name: 'kubernetes', namespace: 'default', labels: { component: 'apiserver', provider: 'kubernetes' } }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.1', ports: [{ name: 'https', port: 443, targetPort: 6443, protocol: 'TCP' }] } },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: 'kube-dns', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' } }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.10', selector: { 'k8s-app': 'kube-dns' }, ports: [{ name: 'dns', port: 53, protocol: 'UDP', targetPort: 53 }, { name: 'dns-tcp', port: 53, protocol: 'TCP', targetPort: 53 }] } },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: 'metrics-server', namespace: 'kube-system', labels: { 'k8s-app': 'metrics-server' } }, spec: { type: 'ClusterIP', selector: { 'k8s-app': 'metrics-server' }, ports: [{ name: 'https', port: 443, targetPort: 10250 }] } },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: 'ingress-nginx-controller', namespace: 'ingress-nginx' }, spec: { type: 'LoadBalancer', selector: { 'app.kubernetes.io/name': 'ingress-nginx', 'app.kubernetes.io/component': 'controller' }, ports: [{ name: 'http', port: 80, targetPort: 80, nodePort: 30080 }, { name: 'https', port: 443, targetPort: 443, nodePort: 30443 }] } },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'cluster-admin' }, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }, { nonResourceURLs: ['*'], verbs: ['*'] }] },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'admin' }, rules: [{ apiGroups: ['', 'apps', 'batch', 'autoscaling', 'networking.k8s.io', 'policy', 'rbac.authorization.k8s.io'], resources: ['*'], verbs: ['*'] }] },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'edit' }, rules: [{ apiGroups: ['', 'apps', 'batch', 'autoscaling', 'networking.k8s.io', 'policy'], resources: ['pods', 'pods/log', 'pods/exec', 'services', 'endpoints', 'configmaps', 'secrets', 'persistentvolumeclaims', 'deployments', 'deployments/scale', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'horizontalpodautoscalers', 'ingresses', 'networkpolicies', 'poddisruptionbudgets', 'serviceaccounts', 'events'], verbs: ['create', 'delete', 'deletecollection', 'get', 'list', 'patch', 'update', 'watch'] }] },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'view' }, rules: [{ apiGroups: ['', 'apps', 'batch', 'autoscaling', 'networking.k8s.io', 'policy'], resources: ['pods', 'pods/log', 'services', 'endpoints', 'configmaps', 'persistentvolumeclaims', 'deployments', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'horizontalpodautoscalers', 'ingresses', 'networkpolicies', 'poddisruptionbudgets', 'serviceaccounts', 'events', 'namespaces'], verbs: ['get', 'list', 'watch'] }] },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'cluster-admin' }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'kubeadm:cluster-admins' }] },
];

// ---------- the project folder (~/k8s) ----------
const DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx:1.27
        ports:
        - containerPort: 80
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
          limits:
            memory: 128Mi
        readinessProbe:
          httpGet:
            path: /
            port: 80
          periodSeconds: 5
`;

export const PROJECT_DIR = '~/k8s';
export const PROJECT_FILES = {
  'pod.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: hello
  labels:
    app: hello
spec:
  containers:
  - name: hello
    image: kubelab/hello:1.0
    ports:
    - containerPort: 8080
`,
  'deployment.yaml': DEPLOYMENT_YAML,
  'service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  type: ClusterIP
  selector:
    app: web
  ports:
  - name: http
    port: 80
    targetPort: 80
`,
  'namespace.yaml': `apiVersion: v1
kind: Namespace
metadata:
  name: shop
  labels:
    team: shop
`,
  'configmap.yaml': `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  APP_COLOR: blue
  APP_MODE: production
  app.properties: |
    greeting=Hello from a ConfigMap
    cache.ttl=60
`,
  'secret.yaml': `apiVersion: v1
kind: Secret
metadata:
  name: db-secret
type: Opaque
stringData:
  POSTGRES_USER: shop
  POSTGRES_PASSWORD: s3cr3t-pa55
`,
  'ingress.yaml': `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
spec:
  ingressClassName: nginx
  rules:
  - host: shop.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web
            port:
              number: 80
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api
            port:
              number: 80
`,
  'pvc.yaml': `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: standard
  resources:
    requests:
      storage: 1Gi
`,
  'statefulset.yaml': `apiVersion: v1
kind: Service
metadata:
  name: db
spec:
  clusterIP: None
  selector:
    app: db
  ports:
  - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  serviceName: db
  replicas: 3
  selector:
    matchLabels:
      app: db
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
      - name: postgres
        image: postgres:17
        env:
        - name: POSTGRES_PASSWORD
          value: example
        ports:
        - containerPort: 5432
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 1Gi
`,
  'daemonset.yaml': `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: log-agent
spec:
  selector:
    matchLabels:
      app: log-agent
  template:
    metadata:
      labels:
        app: log-agent
    spec:
      containers:
      - name: fluent-bit
        image: fluent/fluent-bit:3.2
        resources:
          requests:
            cpu: 50m
            memory: 32Mi
`,
  'job.yaml': `apiVersion: batch/v1
kind: Job
metadata:
  name: pi
spec:
  completions: 3
  parallelism: 2
  backoffLimit: 4
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: pi
        image: perl:5.40
        command: ["perl", "-Mbignum=bpi", "-wle", "print bpi(50)"]
`,
  'cronjob.yaml': `apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup
spec:
  schedule: "*/1 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: backup
            image: busybox:1.37
            command: ["sh", "-c", "echo backing up the database; sleep 5; echo done"]
`,
  'hpa.yaml': `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
`,
  'networkpolicy.yaml': `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
spec:
  podSelector: {}
  policyTypes:
  - Ingress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend-to-web
spec:
  podSelector:
    matchLabels:
      app: web
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: frontend
    ports:
    - protocol: TCP
      port: 80
`,
  'rbac.yaml': `apiVersion: v1
kind: ServiceAccount
metadata:
  name: viewer
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: viewer-reads-pods
subjects:
- kind: ServiceAccount
  name: viewer
  namespace: default
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: pod-reader
`,
  'pdb.yaml': `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: web
`,
  'quota.yaml': `apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-quota
spec:
  hard:
    pods: "10"
    requests.cpu: "2"
    requests.memory: 2Gi
    limits.memory: 4Gi
---
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
spec:
  limits:
  - type: Container
    defaultRequest:
      cpu: 100m
      memory: 64Mi
    default:
      memory: 256Mi
`,
  'crd.yaml': `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: postgresclusters.db.kubelab.io
spec:
  group: db.kubelab.io
  scope: Namespaced
  names:
    kind: PostgresCluster
    plural: postgresclusters
    singular: postgrescluster
    shortNames: ["pgc"]
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              instances:
                type: integer
              version:
                type: string
`,
  'postgrescluster.yaml': `apiVersion: db.kubelab.io/v1
kind: PostgresCluster
metadata:
  name: orders
spec:
  instances: 2
  version: "17"
`,
  'kustomize/base/kustomization.yaml': `resources:
- deployment.yaml
- service.yaml
labels:
- pairs:
    app.kubernetes.io/part-of: shop
`,
  'kustomize/base/deployment.yaml': DEPLOYMENT_YAML.replace('replicas: 3', 'replicas: 1'),
  'kustomize/base/service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
  - port: 80
    targetPort: 80
`,
  'kustomize/overlays/dev/namespace.yaml': `apiVersion: v1
kind: Namespace
metadata:
  name: dev
`,
  'kustomize/overlays/dev/kustomization.yaml': `resources:
- namespace.yaml
- ../../base
namePrefix: dev-
namespace: dev
configMapGenerator:
- name: app-config
  literals:
  - APP_MODE=development
`,
  'kustomize/overlays/prod/namespace.yaml': `apiVersion: v1
kind: Namespace
metadata:
  name: prod
`,
  'kustomize/overlays/prod/kustomization.yaml': `resources:
- namespace.yaml
- ../../base
namespace: prod
replicas:
- name: web
  count: 4
images:
- name: nginx
  newTag: "1.27.3"
configMapGenerator:
- name: app-config
  literals:
  - APP_MODE=production
`,
  'charts/web/Chart.yaml': `apiVersion: v2
name: web
description: A small web app chart for Kube Lab
version: 0.1.0
appVersion: "1.0"
`,
  'charts/web/values.yaml': `replicaCount: 2
image:
  repository: kubelab/hello
  tag: "1.0"
service:
  type: ClusterIP
  port: 80
`,
  'charts/web/values-prod.yaml': `replicaCount: 4
image:
  tag: "2.0"
service:
  type: LoadBalancer
`,
  'charts/web/templates/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-web
  labels:
    app.kubernetes.io/name: web
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      containers:
      - name: web
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
        ports:
        - containerPort: 8080
`,
  'charts/web/templates/service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-web
spec:
  type: {{ .Values.service.type }}
  selector:
    app.kubernetes.io/instance: {{ .Release.Name }}
  ports:
  - port: {{ .Values.service.port }}
    targetPort: 8080
`,
  'shop/00-namespace.yaml': `apiVersion: v1
kind: Namespace
metadata:
  name: shop
  labels:
    app.kubernetes.io/part-of: shop
`,
  'shop/10-config.yaml': `apiVersion: v1
kind: ConfigMap
metadata:
  name: shop-config
  namespace: shop
data:
  APP_MODE: production
  DB_HOST: db-0.db
  DB_NAME: shop
---
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: shop
type: Opaque
stringData:
  POSTGRES_USER: shop
  POSTGRES_PASSWORD: change-me-please
`,
  'shop/20-database.yaml': `apiVersion: v1
kind: Service
metadata:
  name: db
  namespace: shop
spec:
  clusterIP: None
  selector:
    app: db
  ports:
  - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
  namespace: shop
spec:
  serviceName: db
  replicas: 1
  selector:
    matchLabels:
      app: db
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
      - name: postgres
        image: postgres:17
        envFrom:
        - secretRef:
            name: db-credentials
        ports:
        - containerPort: 5432
        readinessProbe:
          tcpSocket:
            port: 5432
          periodSeconds: 10
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            memory: 512Mi
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 1Gi
`,
  'shop/30-api.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: shop
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
      - name: api
        image: kubelab/hello:1.0
        ports:
        - containerPort: 8080
        envFrom:
        - configMapRef:
            name: shop-config
        env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: POSTGRES_PASSWORD
        readinessProbe:
          httpGet:
            path: /
            port: 8080
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /
            port: 8080
          periodSeconds: 10
          failureThreshold: 3
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
          limits:
            memory: 128Mi
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: shop
spec:
  selector:
    app: api
  ports:
  - port: 80
    targetPort: 8080
`,
  'shop/40-web.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx:1.27
        ports:
        - containerPort: 80
        readinessProbe:
          httpGet:
            path: /
            port: 80
          periodSeconds: 5
        resources:
          requests:
            cpu: 50m
            memory: 32Mi
          limits:
            memory: 64Mi
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: shop
spec:
  selector:
    app: web
  ports:
  - port: 80
    targetPort: 80
`,
  'shop/60-ingress.yaml': `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
  namespace: shop
spec:
  ingressClassName: nginx
  rules:
  - host: shop.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web
            port:
              number: 80
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api
            port:
              number: 80
`,
};
