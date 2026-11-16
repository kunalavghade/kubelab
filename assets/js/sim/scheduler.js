// kube-scheduler: for every unscheduled pod, filter the nodes it may run on, score the rest,
// bind it to the best one — or explain exactly why no node fits, and try preemption.
import { parseCpu, parseMem, matchesSelector } from './api.js';
import { podCpuRequest, podMemRequest } from './cluster.js';

const tolerates = (tolerations = [], taint) => tolerations.some((t) => (t.operator === 'Exists' && !t.key)
  || (t.key === taint.key && (t.operator === 'Exists' || (t.value ?? '') === (taint.value ?? '')) && (!t.effect || t.effect === taint.effect)));

const nodeTermMatches = (node, term) => (term.matchExpressions || []).every((e) => matchesSelector(node.metadata.labels, [e]))
  && (term.matchFields || []).every((f) => f.key === 'metadata.name' && (f.operator === 'In' ? f.values.includes(node.metadata.name) : !f.values.includes(node.metadata.name)));

const requiredNodeAffinity = (pod) => pod.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
const topologyValue = (node, key) => node.metadata.labels?.[key];

const usedOn = (C, nodeName, exclude = new Set()) => C.podsOn(nodeName).filter((p) => !exclude.has(p.metadata.uid))
  .reduce((acc, p) => ({ cpu: acc.cpu + podCpuRequest(p), mem: acc.mem + podMemRequest(p), pods: acc.pods + 1 }), { cpu: 0, mem: 0, pods: 0 });

const podsInDomain = (C, ns, node, topologyKey, selector) => {
  const domain = topologyValue(node, topologyKey);
  if (domain == null) return [];
  const names = new Set(C.nodes().filter((n) => topologyValue(n, topologyKey) === domain).map((n) => n.metadata.name));
  return C.store.list(C.def('pod'), ns).filter((p) => names.has(p.spec.nodeName) && C.isActivePod(p) && matchesSelector(p.metadata.labels, selector));
};

/**
 * Filter plugins in the order the real scheduler reports them. Each returns null when the node
 * passes, or the reason text used in "0/N nodes are available: …".
 */
const FILTERS = [
  (C, pod, node) => (!C.isNodeReady(node) ? 'node(s) were not ready' : null),
  (C, pod, node) => (node.spec.unschedulable ? 'node(s) were unschedulable' : null),
  (C, pod, node) => {
    const taint = (node.spec.taints || []).find((t) => ['NoSchedule', 'NoExecute'].includes(t.effect) && !tolerates(pod.spec.tolerations, t));
    return taint ? `node(s) had untolerated taint {${taint.key}: ${taint.value ?? ''}}` : null;
  },
  (C, pod, node) => {
    const bySelector = Object.entries(pod.spec.nodeSelector || {}).every(([k, v]) => node.metadata.labels?.[k] === String(v));
    const terms = requiredNodeAffinity(pod);
    const byAffinity = !terms || terms.some((t) => nodeTermMatches(node, t));
    return bySelector && byAffinity ? null : "node(s) didn't match Pod's node affinity/selector";
  },
  (C, pod, node, ctx) => {
    const used = usedOn(C, node.metadata.name, ctx.exclude);
    const free = { cpu: parseCpu(node.status.allocatable.cpu) - used.cpu, mem: parseMem(node.status.allocatable.memory) - used.mem };
    if (podCpuRequest(pod) > free.cpu) return 'Insufficient cpu';
    if (podMemRequest(pod) > free.mem) return 'Insufficient memory';
    return used.pods >= Number(node.status.allocatable.pods) ? 'Too many pods' : null;
  },
  (C, pod, node) => {
    const terms = pod.spec.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution || [];
    const clash = terms.some((t) => podsInDomain(C, pod.metadata.namespace, node, t.topologyKey, t.labelSelector).some((p) => p.metadata.uid !== pod.metadata.uid));
    return clash ? "node(s) didn't match pod anti-affinity rules" : null;
  },
  (C, pod, node) => {
    const terms = pod.spec.affinity?.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution || [];
    return terms.every((t) => podsInDomain(C, pod.metadata.namespace, node, t.topologyKey, t.labelSelector).length) ? null : "node(s) didn't match pod affinity rules";
  },
  (C, pod, node) => {
    const constraints = (pod.spec.topologySpreadConstraints || []).filter((c) => c.whenUnsatisfiable === 'DoNotSchedule');
    const violates = constraints.some((c) => {
      const domains = [...new Set(C.nodes().filter((n) => C.isNodeReady(n) && !n.spec.unschedulable && !(n.spec.taints || []).some((t) => t.effect === 'NoSchedule' && !tolerates(pod.spec.tolerations, t))).map((n) => topologyValue(n, c.topologyKey)).filter((d) => d != null))];
      const count = (d) => C.store.list(C.def('pod'), pod.metadata.namespace).filter((p) => C.isActivePod(p) && p.spec.nodeName && topologyValue(C.store.get(C.def('node'), null, p.spec.nodeName), c.topologyKey) === d && matchesSelector(p.metadata.labels, c.labelSelector)).length;
      const min = Math.min(...domains.map(count));
      return count(topologyValue(node, c.topologyKey)) + 1 - min > c.maxSkew;
    });
    return violates ? "node(s) didn't match pod topology spread constraints" : null;
  },
  (C, pod, node) => {
    for (const v of pod.spec.volumes || []) {
      const claim = v.persistentVolumeClaim?.claimName;
      if (!claim) continue;
      const pvc = C.store.get(C.def('pvc'), pod.metadata.namespace, claim);
      if (!pvc) return `persistentvolumeclaim "${claim}" not found`;
      if (pvc.status.phase !== 'Bound') {
        const sc = pvc.spec.storageClassName && C.store.get(C.def('storageclass'), null, pvc.spec.storageClassName);
        if (!sc || sc.volumeBindingMode !== 'WaitForFirstConsumer') return 'pod has unbound immediate PersistentVolumeClaims';
        continue;
      }
      const pv = C.store.get(C.def('pv'), null, pvc.spec.volumeName);
      const terms = pv?.spec.nodeAffinity?.required?.nodeSelectorTerms;
      if (terms && !terms.some((t) => nodeTermMatches(node, t))) return 'node(s) had volume node affinity conflict';
    }
    return null;
  },
];

const failureReason = (C, pod, node, ctx) => {
  for (const f of FILTERS) {
    const reason = f(C, pod, node, ctx);
    if (reason) return reason;
  }
  return null;
};

const preferredScore = (C, pod, node) => {
  const nodePrefs = pod.spec.affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution || [];
  const podPrefs = pod.spec.affinity?.podAntiAffinity?.preferredDuringSchedulingIgnoredDuringExecution || [];
  return nodePrefs.reduce((s, p) => s + (nodeTermMatches(node, p.preference) ? p.weight : 0), 0)
    - podPrefs.reduce((s, p) => s + (podsInDomain(C, pod.metadata.namespace, node, p.podAffinityTerm.topologyKey, p.podAffinityTerm.labelSelector).length ? p.weight : 0), 0);
};

const scoreNode = (C, pod, node) => {
  const owner = pod.metadata.ownerReferences?.[0]?.uid;
  const siblings = owner ? C.podsOn(node.metadata.name).filter((p) => p.metadata.ownerReferences?.[0]?.uid === owner).length : 0;
  const used = usedOn(C, node.metadata.name);
  const freeCpu = 1 - used.cpu / Math.max(1, parseCpu(node.status.allocatable.cpu));
  return preferredScore(C, pod, node) * 10 - siblings * 30 + freeCpu * 20 - used.pods * 0.5;
};

const summarise = (reasons, total) => {
  const counts = new Map();
  reasons.forEach((r) => counts.set(r, (counts.get(r) || 0) + 1));
  const parts = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([r, n]) => `${n} ${r}`);
  return `0/${total} nodes are available: ${parts.join(', ')}.`;
};

// Preemption: evict lower-priority pods on one node so a higher-priority pod fits.
const tryPreempt = (C, pod, nodes) => {
  for (const node of nodes) {
    const victims = C.podsOn(node.metadata.name).filter((p) => (p.spec.priority ?? 0) < (pod.spec.priority ?? 0) && C.isActivePod(p))
      .sort((a, b) => (a.spec.priority ?? 0) - (b.spec.priority ?? 0));
    const exclude = new Set();
    for (const v of victims) {
      exclude.add(v.metadata.uid);
      if (failureReason(C, pod, node, { exclude })) continue;
      victims.filter((x) => exclude.has(x.metadata.uid)).forEach((x) => {
        C.record(x, 'Normal', 'Preempted', `Preempted by pod ${pod.metadata.uid} on node ${node.metadata.name}`, 'default-scheduler');
        C.delete(x);
      });
      pod.status.nominatedNodeName = node.metadata.name;
      return node.metadata.name;
    }
  }
  return null;
};

const bind = (C, pod, node) => {
  pod.spec.nodeName = node.metadata.name;
  pod.status.hostIP = node.status.addresses[0].address;
  delete pod.status.nominatedNodeName;
  C.setCondition(pod, 'PodScheduled', 'True');
  C.record(pod, 'Normal', 'Scheduled', `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`, 'default-scheduler');
  // WaitForFirstConsumer volumes are provisioned on the node the pod lands on.
  (pod.spec.volumes || []).forEach((v) => {
    const pvc = v.persistentVolumeClaim && C.store.get(C.def('pvc'), pod.metadata.namespace, v.persistentVolumeClaim.claimName);
    if (pvc && pvc.status.phase === 'Pending') {
      pvc.metadata.annotations = { ...pvc.metadata.annotations, 'volume.kubernetes.io/selected-node': node.metadata.name };
      C.store.update(pvc);
    }
  });
  C.store.update(pod);
};

/** Schedules every pending pod that has no node yet (static and DaemonSet pods bring their own). */
export const schedule = (C) => {
  const nodes = C.nodes();
  const pending = C.store.list(C.def('pod')).filter((p) => !p.spec.nodeName && !C.isTerminating(p) && p.status.phase === 'Pending' && p.spec.schedulerName === 'default-scheduler')
    .sort((a, b) => (b.spec.priority ?? 0) - (a.spec.priority ?? 0) || a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp));
  pending.forEach((pod) => {
    const ctx = { exclude: new Set() };
    const reasons = nodes.map((n) => [n, failureReason(C, pod, n, ctx)]);
    const fits = reasons.filter(([, r]) => !r).map(([n]) => n);
    if (fits.length) {
      const best = fits.sort((a, b) => scoreNode(C, pod, b) - scoreNode(C, pod, a) || a.metadata.name.localeCompare(b.metadata.name))[0];
      return bind(C, pod, best);
    }
    const nominated = (pod.spec.priority ?? 0) > 0 ? tryPreempt(C, pod, nodes.filter((n) => C.isNodeReady(n) && !n.spec.unschedulable)) : null;
    const message = `${summarise(reasons.map(([, r]) => r), nodes.length)} preemption: ${nominated ? `nominated node ${nominated}` : `0/${nodes.length} nodes are available: ${nodes.length} No preemption victims found for incoming pod.`}`;
    const changed = C.setCondition(pod, 'PodScheduled', 'False', { reason: 'Unschedulable', message });
    if (!changed) return;
    C.record(pod, 'Warning', 'FailedScheduling', message, 'default-scheduler');
    C.store.update(pod);
  });
};
