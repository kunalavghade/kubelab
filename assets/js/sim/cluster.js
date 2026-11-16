// The simulated cluster: API store + defaulting, validation and admission, events, IP
// allocation, and the reconcile loop that runs every controller until nothing changes.
import { CommandError } from './util.js';
import { createStore, createClock, parseCpu, parseMem, fmtCpu, matchesSelector, randSuffix, TICK_SECONDS, clone } from './api.js';
import { nodeObjects, bootstrapObjects, IMAGES } from './data.js';
import { CONTROLLERS, TICK_CONTROLLERS } from './controllers.js';
import { schedule } from './scheduler.js';
import { kubeletTick } from './kubelet.js';

const MAX_PASSES = 25; // a pass that keeps changing objects this many times is a controller bug
export const NODE_EVICTION_TICKS = 2; // real default is 300s via tolerations; shortened for the lab

// ---------- defaulting ----------
const qosClass = (pod) => {
  const ctrs = pod.spec.containers || [];
  const all = (fn) => ctrs.every(fn);
  const none = ctrs.every((c) => !Object.keys(c.resources?.requests || {}).length && !Object.keys(c.resources?.limits || {}).length);
  if (none) return 'BestEffort';
  const guaranteed = all((c) => ['cpu', 'memory'].every((r) => c.resources?.limits?.[r] && (c.resources?.requests?.[r] ?? c.resources.limits[r]) === c.resources.limits[r]));
  return guaranteed ? 'Guaranteed' : 'Burstable';
};

const applyLimitRange = (C, pod) => {
  const ranges = C.store.list(C.def('limitrange'), pod.metadata.namespace).flatMap((lr) => lr.spec.limits || []).filter((l) => l.type === 'Container');
  ranges.forEach((lim) => pod.spec.containers.forEach((c) => {
    c.resources ||= {};
    if (lim.default) c.resources.limits = { ...lim.default, ...c.resources.limits };
    if (lim.defaultRequest || lim.default) c.resources.requests = { ...(lim.defaultRequest || lim.default), ...c.resources.requests };
  }));
  if (ranges.length) pod.metadata.annotations = { ...pod.metadata.annotations, 'kubernetes.io/limit-ranger': 'LimitRanger plugin set: default requests/limits for containers' };
};

const defaultPodSpec = (spec) => {
  spec.restartPolicy ||= 'Always';
  spec.dnsPolicy ||= 'ClusterFirst';
  spec.schedulerName ||= 'default-scheduler';
  spec.serviceAccountName ||= spec.serviceAccount || 'default';
  spec.terminationGracePeriodSeconds ??= 30;
  [...(spec.initContainers || []), ...(spec.containers || [])].forEach((c) => {
    c.imagePullPolicy ||= /:latest$|^[^:]+$/.test(c.image || '') ? 'Always' : 'IfNotPresent';
    (c.ports || []).forEach((p) => { p.protocol ||= 'TCP'; });
    c.resources ||= {};
    // Limits without requests: requests default to the limits.
    if (c.resources.limits) c.resources.requests = { ...c.resources.limits, ...c.resources.requests };
  });
};

const DEFAULTERS = {
  Pod: (C, pod) => {
    defaultPodSpec(pod.spec);
    applyLimitRange(C, pod);
    pod.spec.tolerations = [...(pod.spec.tolerations || []),
      ...['not-ready', 'unreachable'].filter((t) => !(pod.spec.tolerations || []).some((x) => x.key === `node.kubernetes.io/${t}`))
        .map((t) => ({ key: `node.kubernetes.io/${t}`, operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 }))];
    const pc = pod.spec.priorityClassName && C.store.get(C.def('priorityclass'), null, pod.spec.priorityClassName);
    pod.spec.priority = pc?.value ?? 0;
    pod.status = { phase: 'Pending', qosClass: qosClass(pod), conditions: [] };
  },
  Deployment: (C, d) => {
    d.spec.replicas ??= 1;
    d.spec.revisionHistoryLimit ??= 10;
    d.spec.progressDeadlineSeconds ??= 600;
    d.spec.strategy ||= { type: 'RollingUpdate' };
    if (d.spec.strategy.type === 'RollingUpdate') d.spec.strategy.rollingUpdate = { maxSurge: '25%', maxUnavailable: '25%', ...d.spec.strategy.rollingUpdate };
    d.status = { observedGeneration: 0 };
  },
  ReplicaSet: (C, rs) => { rs.spec.replicas ??= 1; rs.status = { replicas: 0 }; },
  StatefulSet: (C, s) => {
    s.spec.replicas ??= 1;
    s.spec.podManagementPolicy ||= 'OrderedReady';
    s.spec.updateStrategy ||= { type: 'RollingUpdate', rollingUpdate: { partition: 0 } };
    s.spec.revisionHistoryLimit ??= 10;
    s.status = { replicas: 0 };
  },
  DaemonSet: (C, ds) => {
    ds.spec.updateStrategy ||= { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } };
    ds.spec.revisionHistoryLimit ??= 10;
    ds.status = {};
  },
  Job: (C, job) => {
    job.spec.parallelism ??= 1;
    job.spec.completions ??= 1;
    job.spec.backoffLimit ??= 6;
    job.spec.completionMode ||= 'NonIndexed';
    job.spec.suspend ??= false;
    const ids = { 'batch.kubernetes.io/controller-uid': job.metadata.uid, 'batch.kubernetes.io/job-name': job.metadata.name, 'controller-uid': job.metadata.uid, 'job-name': job.metadata.name };
    job.spec.selector ||= { matchLabels: { 'batch.kubernetes.io/controller-uid': job.metadata.uid } };
    job.spec.template.metadata = { ...job.spec.template.metadata, labels: { ...job.spec.template.metadata?.labels, ...ids } };
    job.metadata.labels = { ...ids, ...job.metadata.labels };
    job.status = { active: 0, succeeded: 0, failed: 0 };
  },
  CronJob: (C, cj) => {
    cj.spec.concurrencyPolicy ||= 'Allow';
    cj.spec.suspend ??= false;
    cj.spec.successfulJobsHistoryLimit ??= 3;
    cj.spec.failedJobsHistoryLimit ??= 1;
    cj.status = {};
  },
  Service: (C, svc) => {
    const spec = svc.spec ||= {};
    spec.type ||= 'ClusterIP';
    spec.sessionAffinity ||= 'None';
    if (spec.type !== 'ExternalName') {
      if (spec.clusterIP !== 'None') spec.clusterIP ||= C.allocServiceIp();
      spec.clusterIPs = [spec.clusterIP];
      spec.ipFamilies = ['IPv4'];
    }
    (spec.ports || []).forEach((p) => {
      p.protocol ||= 'TCP';
      p.targetPort ??= p.port;
      if (['NodePort', 'LoadBalancer'].includes(spec.type)) p.nodePort ||= C.allocNodePort();
    });
    svc.status = { loadBalancer: {} };
  },
  Secret: (C, s) => {
    s.type ||= 'Opaque';
    if (s.stringData) {
      s.data = { ...s.data, ...Object.fromEntries(Object.entries(s.stringData).map(([k, v]) => [k, C.b64(String(v))])) };
      delete s.stringData;
    }
    s.data ||= {};
  },
  ConfigMap: (C, cm) => { if (cm.data) cm.data = Object.fromEntries(Object.entries(cm.data).map(([k, v]) => [k, v == null ? '' : String(v)])); },
  PersistentVolumeClaim: (C, pvc) => {
    if (pvc.spec.storageClassName === undefined) pvc.spec.storageClassName = C.defaultStorageClass()?.metadata.name;
    pvc.spec.volumeMode ||= 'Filesystem';
    pvc.status = { phase: 'Pending' };
  },
  PersistentVolume: (C, pv) => { pv.spec.persistentVolumeReclaimPolicy ||= 'Retain'; pv.status = { phase: 'Available' }; },
  Namespace: (C, ns) => {
    ns.metadata.labels = { ...ns.metadata.labels, 'kubernetes.io/metadata.name': ns.metadata.name };
    ns.spec = { finalizers: ['kubernetes'] };
    ns.status = { phase: 'Active' };
  },
  HorizontalPodAutoscaler: (C, hpa) => { hpa.spec.minReplicas ??= 1; hpa.status = { currentReplicas: 0, desiredReplicas: 0 }; },
  Ingress: (C, ing) => { ing.spec.ingressClassName ||= C.store.list(C.def('ingressclass')).find((c) => c.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true')?.metadata.name; ing.status = { loadBalancer: {} }; },
  PodDisruptionBudget: (C, pdb) => { pdb.status = { currentHealthy: 0, desiredHealthy: 0, disruptionsAllowed: 0, expectedPods: 0 }; },
  ResourceQuota: (C, q) => { q.status = { hard: { ...q.spec.hard }, used: {} }; },
};

// ---------- validation ----------
const invalid = (kind, name, field, msg) => new CommandError(`The ${kind} "${name}" is invalid: ${field}: ${msg}`, 'INVALID');

const validatePodSpec = (kind, name, spec, path = 'spec') => {
  if (!spec?.containers?.length) throw invalid(kind, name, `${path}.containers`, 'Required value');
  const seen = new Set();
  spec.containers.forEach((c, i) => {
    if (!c.name) throw invalid(kind, name, `${path}.containers[${i}].name`, 'Required value');
    if (!c.image) throw invalid(kind, name, `${path}.containers[${i}].image`, 'Required value');
    if (seen.has(c.name)) throw invalid(kind, name, `${path}.containers[${i}].name`, `Duplicate value: "${c.name}"`);
    seen.add(c.name);
  });
};

const validateWorkload = (obj) => {
  const { kind, metadata: { name }, spec } = obj;
  if (!spec?.selector) throw invalid(kind, name, 'spec.selector', 'Required value');
  validatePodSpec(kind, name, spec.template?.spec, 'spec.template.spec');
  const labels = spec.template?.metadata?.labels || {};
  if (!matchesSelector(labels, spec.selector)) {
    throw invalid(kind, name, 'spec.template.metadata.labels', `Invalid value: map[string]string{${Object.entries(labels).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}: \`selector\` does not match template \`labels\``);
  }
};

const VALIDATORS = {
  Pod: (pod) => validatePodSpec('Pod', pod.metadata.name, pod.spec),
  Deployment: validateWorkload,
  ReplicaSet: validateWorkload,
  StatefulSet: validateWorkload,
  DaemonSet: validateWorkload,
  Job: (job) => {
    validatePodSpec('Job', job.metadata.name, job.spec.template?.spec, 'spec.template.spec');
    if (!['Never', 'OnFailure'].includes(job.spec.template.spec.restartPolicy)) throw invalid('Job', job.metadata.name, 'spec.template.spec.restartPolicy', 'Required value: valid values: "OnFailure", "Never"');
  },
  CronJob: (cj) => {
    if (!cj.spec?.schedule) throw invalid('CronJob', cj.metadata.name, 'spec.schedule', 'Required value');
    if (String(cj.spec.schedule).trim().split(/\s+/).length !== 5 && !String(cj.spec.schedule).startsWith('@')) throw invalid('CronJob', cj.metadata.name, 'spec.schedule', `Invalid value: "${cj.spec.schedule}": expected exactly 5 fields`);
  },
  Service: (svc) => {
    if (svc.spec.type !== 'ExternalName' && !svc.spec.ports?.length) throw invalid('Service', svc.metadata.name, 'spec.ports', 'Required value');
    (svc.spec.ports || []).forEach((p, i) => {
      if (p.nodePort && (p.nodePort < 30000 || p.nodePort > 32767)) throw invalid('Service', svc.metadata.name, `spec.ports[${i}].nodePort`, `Invalid value: ${p.nodePort}: provided port is not in the valid range. The range of valid ports is 30000-32767`);
    });
  },
};

// ---------- admission ----------
const podRequests = (pod, res, field = 'requests') => (pod.spec.containers || []).reduce((sum, c) => sum + (res === 'cpu' ? parseCpu(c.resources?.[field]?.cpu) : parseMem(c.resources?.[field]?.memory)), 0);
export const podCpuRequest = (pod) => podRequests(pod, 'cpu');
export const podMemRequest = (pod) => podRequests(pod, 'memory');

const QUOTA_USAGE = {
  pods: () => 1,
  'requests.cpu': (p) => podRequests(p, 'cpu'),
  cpu: (p) => podRequests(p, 'cpu'),
  'requests.memory': (p) => podRequests(p, 'memory'),
  memory: (p) => podRequests(p, 'memory'),
  'limits.cpu': (p) => podRequests(p, 'cpu', 'limits'),
  'limits.memory': (p) => podRequests(p, 'memory', 'limits'),
};
const isCpuKey = (k) => k.endsWith('cpu');
const quotaLimit = (k, v) => (k === 'pods' ? Number(v) : isCpuKey(k) ? parseCpu(v) : parseMem(v));
const quotaFmt = (k, v) => (k === 'pods' ? String(v) : isCpuKey(k) ? fmtCpu(v) : `${Math.round(v / 1024 ** 2)}Mi`);

const admitQuota = (C, pod) => {
  const quotas = C.store.list(C.def('resourcequota'), pod.metadata.namespace);
  const live = C.store.list(C.def('pod'), pod.metadata.namespace).filter((p) => !['Succeeded', 'Failed'].includes(p.status?.phase));
  quotas.forEach((q) => Object.entries(q.spec.hard || {}).forEach(([k, hard]) => {
    const usage = QUOTA_USAGE[k];
    if (!usage) return;
    const field = k.startsWith('limits') ? 'limits' : 'requests';
    const res = k.endsWith('cpu') ? 'cpu' : 'memory';
    if (k !== 'pods' && pod.spec.containers.some((c) => !c.resources?.[field]?.[res])) {
      throw new CommandError(`Error from server (Forbidden): pods "${pod.metadata.name}" is forbidden: failed quota: ${q.metadata.name}: must specify ${k}`, 'FORBIDDEN');
    }
    const used = live.reduce((s, p) => s + usage(p), 0);
    const requested = usage(pod);
    const limit = quotaLimit(k, hard);
    if (used + requested > limit) {
      throw new CommandError(`Error from server (Forbidden): pods "${pod.metadata.name}" is forbidden: exceeded quota: ${q.metadata.name}, requested: ${k}=${quotaFmt(k, requested)}, used: ${k}=${quotaFmt(k, used)}, limited: ${k}=${hard}`, 'FORBIDDEN');
    }
  }));
};

// Pod Security Standards: a subset of the baseline and restricted checks with the real wording.
const PSS_CHECKS = {
  baseline: [
    [(c) => c.securityContext?.privileged === true, (n) => `privileged (container${n} must not set securityContext.privileged=true)`],
    [(c, pod) => pod.spec.hostNetwork === true, () => 'host namespaces (hostNetwork=true)'],
    [(c, pod) => (pod.spec.volumes || []).some((v) => v.hostPath), (n, pod) => `hostPath volumes (volume${(pod.spec.volumes || []).filter((v) => v.hostPath).map((v) => ` "${v.name}"`).join(',')})`],
  ],
  restricted: [
    [(c) => c.securityContext?.allowPrivilegeEscalation !== false, (n) => `allowPrivilegeEscalation != false (container${n} must set securityContext.allowPrivilegeEscalation=false)`],
    [(c) => !(c.securityContext?.capabilities?.drop || []).includes('ALL'), (n) => `unrestricted capabilities (container${n} must set securityContext.capabilities.drop=["ALL"])`],
    [(c, pod) => !(c.securityContext?.runAsNonRoot ?? pod.spec.securityContext?.runAsNonRoot), (n) => `runAsNonRoot != true (pod or container${n} must set securityContext.runAsNonRoot=true)`],
    [(c, pod) => !(c.securityContext?.seccompProfile?.type ?? pod.spec.securityContext?.seccompProfile?.type), (n) => `seccompProfile (pod or container${n} must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")`],
  ],
};
const LEVELS = { privileged: [], baseline: ['baseline'], restricted: ['baseline', 'restricted'] };

export const podSecurityViolations = (pod, level) => {
  const found = [];
  (LEVELS[level] || []).forEach((lvl) => PSS_CHECKS[lvl].forEach(([fails, describe]) => {
    const bad = pod.spec.containers.filter((c) => fails(c, pod)).map((c) => c.name);
    if (bad.length) found.push(describe(bad.length === 1 ? ` "${bad[0]}"` : `s ${bad.map((b) => `"${b}"`).join(', ')}`, pod));
  }));
  return [...new Set(found)];
};

const admitPodSecurity = (C, pod) => {
  const labels = C.store.get(C.def('namespace'), null, pod.metadata.namespace)?.metadata.labels || {};
  const check = (mode) => {
    const level = labels[`pod-security.kubernetes.io/${mode}`];
    const found = level ? podSecurityViolations(pod, level) : [];
    return found.length ? `PodSecurity "${level}:${labels[`pod-security.kubernetes.io/${mode}-version`] || 'latest'}": ${found.join(', ')}` : null;
  };
  const enforced = check('enforce');
  if (enforced) throw new CommandError(`Error from server (Forbidden): pods "${pod.metadata.name}" is forbidden: violates ${enforced}`, 'FORBIDDEN');
  const warn = check('warn');
  if (warn) C.warnings.push(`Warning: would violate ${warn}`);
};

const ADMISSION = {
  Pod: (C, pod) => { admitPodSecurity(C, pod); admitQuota(C, pod); },
};

// ---------- the cluster ----------
export const createCluster = () => {
  const clock = createClock();
  const store = createStore(clock);
  let serviceIp = 1, podIp = 2, nodePort = 30000, lbIp = 200;
  const usedNodePorts = new Set([30080, 30443]);

  const C = {
    clock, store,
    warnings: [],
    rt: new Map(), // pod uid → kubelet runtime state
    imageCache: new Map(), // node → Set(image)
    volumeData: new Map(), // pv name or emptyDir key → Map(path → content)
    portForwards: [], // { localPort, ns, pod, port }
    nodePower: new Map(), // node → false when powered off
    deployProgress: new Map(), // deployment uid → { revision, since }
    hpaHistory: new Map(),
    def: (name) => store.defFor(name),
    b64: (s) => (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64')),
    unb64: (s) => (typeof atob === 'function' ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, 'base64').toString('utf8')),
    allocServiceIp: () => { const n = ++serviceIp + 100; return `10.96.${Math.floor(n / 250)}.${n % 250}`; },
    allocPodIp: (node) => `10.244.${['control-plane', 'node-1', 'node-2', 'node-3'].indexOf(node) >= 0 ? ['control-plane', 'node-1', 'node-2', 'node-3'].indexOf(node) : 9}.${(podIp++ % 250) + 2}`,
    allocNodePort: () => { while (usedNodePorts.has(nodePort)) nodePort++; usedNodePorts.add(nodePort); return nodePort; },
    allocLbIp: () => `172.18.255.${lbIp++}`,
    defaultStorageClass: () => store.list(store.defFor('storageclass')).find((s) => s.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'),
  };

  // ---------- events ----------
  C.record = (obj, type, reason, message, source = 'kubelet') => {
    const ns = obj.metadata.namespace || 'default';
    const existing = store.list(C.def('event'), ns).find((e) => e.involvedObject.uid === obj.metadata.uid && e.reason === reason && e.message === message);
    if (existing) {
      existing.count += 1;
      existing.lastTimestamp = clock.iso();
      return store.update(existing);
    }
    return store.create({
      apiVersion: 'v1', kind: 'Event',
      metadata: { name: `${obj.metadata.name}.${randSuffix(8)}${randSuffix(8)}`, namespace: ns },
      involvedObject: { kind: obj.kind, name: obj.metadata.name, namespace: obj.metadata.namespace, uid: obj.metadata.uid, apiVersion: obj.apiVersion },
      type, reason, message, count: 1, source: { component: source },
      firstTimestamp: clock.iso(), lastTimestamp: clock.iso(), reportingComponent: source,
    });
  };

  // ---------- lifecycle helpers ----------
  const hooks = {
    default: (obj) => DEFAULTERS[obj.kind]?.(C, obj),
    validate: (obj) => VALIDATORS[obj.kind]?.(obj),
    admit: (obj) => ADMISSION[obj.kind]?.(C, obj),
  };
  C.create = (obj) => store.create(obj, hooks);
  C.validate = (obj) => VALIDATORS[obj.kind]?.(obj);

  /** Deletes an object the way the API server would: pods terminate gracefully, finalizers wait. */
  C.delete = (obj, { grace = null, force = false, cascade = 'background' } = {}) => {
    if (obj.metadata.deletionTimestamp && !force) return obj;
    if (cascade === 'orphan') store.all().filter((o) => o.metadata.ownerReferences?.some((r) => r.uid === obj.metadata.uid)).forEach((child) => {
      child.metadata.ownerReferences = child.metadata.ownerReferences.filter((r) => r.uid !== obj.metadata.uid);
      if (!child.metadata.ownerReferences.length) delete child.metadata.ownerReferences;
      store.update(child);
    });
    const graceful = obj.kind === 'Pod' && !force && grace !== 0 && obj.spec.nodeName && !['Succeeded', 'Failed'].includes(obj.status?.phase);
    const waits = graceful || obj.metadata.finalizers?.length || obj.kind === 'Namespace';
    if (!waits || force) {
      if (obj.kind === 'Pod') C.rt.delete(obj.metadata.uid);
      store.remove(obj);
      return null;
    }
    obj.metadata.deletionTimestamp = clock.iso();
    obj.metadata.deletionGracePeriodSeconds = grace ?? obj.spec?.terminationGracePeriodSeconds ?? 0;
    if (obj.kind === 'Namespace') obj.status.phase = 'Terminating';
    if (obj.kind === 'Pod') C.record(obj, 'Normal', 'Killing', `Stopping container ${obj.spec.containers.map((c) => c.name).join(', ')}`);
    return store.update(obj);
  };

  C.ownerRef = (owner) => ({ apiVersion: owner.apiVersion, kind: owner.kind, name: owner.metadata.name, uid: owner.metadata.uid, controller: true, blockOwnerDeletion: true });
  C.ownedBy = (owner, def) => store.list(C.def(def), owner.metadata.namespace).filter((o) => o.metadata.ownerReferences?.some((r) => r.uid === owner.metadata.uid && r.controller));
  C.controllerOf = (obj) => {
    const ref = obj.metadata.ownerReferences?.find((r) => r.controller);
    return ref ? store.list(C.def(ref.kind), obj.metadata.namespace).find((o) => o.metadata.uid === ref.uid) || null : null;
  };
  C.nodes = () => store.list(C.def('node'));
  C.isNodeReady = (node) => node.status.conditions.find((c) => c.type === 'Ready')?.status === 'True';
  C.podsOn = (nodeName) => store.list(C.def('pod')).filter((p) => p.spec.nodeName === nodeName && !['Succeeded', 'Failed'].includes(p.status.phase));
  C.isPodReady = (pod) => pod.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True';
  C.isTerminating = (o) => !!o.metadata.deletionTimestamp;
  C.isActivePod = (p) => !C.isTerminating(p) && !['Succeeded', 'Failed'].includes(p.status?.phase);
  C.setCondition = (obj, type, status, extra = {}) => {
    obj.status.conditions ||= [];
    const cur = obj.status.conditions.find((c) => c.type === type);
    if (cur && cur.status === status && Object.entries(extra).every(([k, v]) => cur[k] === v)) return false;
    const next = { type, status, lastTransitionTime: cur?.status === status ? cur.lastTransitionTime : clock.iso(), ...extra };
    obj.status.conditions = [...obj.status.conditions.filter((c) => c.type !== type), next];
    return true;
  };

  /** Creates a pod from a template for a controller; admission failures become FailedCreate events. */
  C.createPodFrom = (owner, template, name, extra = {}) => {
    const pod = {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name, namespace: owner.metadata.namespace, labels: { ...template.metadata?.labels, ...extra.labels }, annotations: { ...template.metadata?.annotations, ...extra.annotations }, ownerReferences: [C.ownerRef(owner)] },
      spec: { ...clone(template.spec), ...extra.spec },
    };
    if (!Object.keys(pod.metadata.annotations).length) delete pod.metadata.annotations;
    try {
      const created = C.create(pod);
      C.record(owner, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, `${owner.kind.toLowerCase()}-controller`);
      return created;
    } catch (err) {
      // Controllers create pods with generateName, so the message names the prefix, not a pod.
      const generated = owner.kind === 'StatefulSet' ? name : name.replace(/[a-z0-9]{5}$/, '');
      C.record(owner, 'Warning', 'FailedCreate', `Error creating: ${err.message.replace(/^Error from server \(\w+\): /, '').replace(`"${name}"`, `"${generated}"`)}`, `${owner.kind.toLowerCase()}-controller`);
      return null;
    }
  };

  // ---------- nodes ----------
  C.setNodePower = (name, on) => {
    const node = store.mustGet(C.def('node'), null, name);
    C.nodePower.set(name, on);
    const ready = node.status.conditions.find((c) => c.type === 'Ready');
    Object.assign(ready, on
      ? { status: 'True', reason: 'KubeletReady', message: 'kubelet is posting ready status', lastTransitionTime: clock.iso() }
      : { status: 'Unknown', reason: 'NodeStatusUnknown', message: 'Kubelet stopped posting node status.', lastTransitionTime: clock.iso() });
    const others = (node.spec.taints || []).filter((t) => !t.key.startsWith('node.kubernetes.io/unreachable'));
    node.spec.taints = on ? others : [...others, { key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule' }, { key: 'node.kubernetes.io/unreachable', effect: 'NoExecute', timeAdded: clock.iso() }];
    if (!node.spec.taints.length) delete node.spec.taints;
    C.nodeDownSince ||= new Map();
    if (on) C.nodeDownSince.delete(name); else C.nodeDownSince.set(name, clock.seconds());
    C.record(node, on ? 'Normal' : 'Warning', on ? 'NodeReady' : 'NodeNotReady', on ? `Node ${name} status is now: NodeReady` : `Node ${name} status is now: NodeNotReady`, 'node-controller');
    store.update(node);
  };

  // ---------- the loop ----------
  /** Runs every controller (and the scheduler) until the store stops changing. */
  C.settle = () => {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const before = store.resourceVersion();
      CONTROLLERS.forEach((ctrl) => ctrl(C));
      schedule(C);
      if (store.resourceVersion() === before) return;
    }
  };

  /** Time passes: the kubelet makes progress, timed controllers run, then everything settles. */
  C.tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(TICK_SECONDS);
      kubeletTick(C);
      TICK_CONTROLLERS.forEach((ctrl) => ctrl(C));
      C.settle();
    }
  };

  /** Ticks until pred() is true (or the limit is hit). Returns whether it became true. */
  C.tickUntil = (pred, limit = 30) => {
    for (let i = 0; i < limit; i++) {
      if (pred()) return true;
      C.tick();
    }
    return pred();
  };

  C.boot = () => {
    nodeObjects().forEach((n) => store.create(n, hooks));
    C.nodes().forEach((n) => C.imageCache.set(n.metadata.name, new Set(Object.entries(IMAGES).filter(([, v]) => v.system).flatMap(([repo, v]) => v.tags.map((t) => `${repo}:${t}`)))));
    bootstrapObjects().forEach((o) => C.create(o));
    C.settle();
    C.tickUntil(() => store.list(C.def('pod')).every((p) => p.status.phase === 'Running' && C.isPodReady(p)), 6);
    store.list(C.def('event')).forEach((e) => store.remove(e)); // start with a clean event log
  };

  return C;
};
