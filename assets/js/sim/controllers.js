// kube-controller-manager: every controller is a reconcile function that compares desired state
// (spec) with what exists and makes one step towards it. cluster.settle() runs them in a loop.
import { hashOf, randSuffix, matchesSelector, matchesMap, parseCpu, parseMem, TICK_SECONDS, clone } from './api.js';
import { imageInfo } from './data.js';

// ---------- shared helpers ----------
const resolveIntOrPercent = (value, total, roundUp) => {
  if (typeof value === 'string' && value.endsWith('%')) {
    const n = (Number(value.slice(0, -1)) / 100) * total;
    return roundUp ? Math.ceil(n) : Math.floor(n);
  }
  return Number(value ?? 0);
};

const podsMatching = (C, owner) => C.store.list(C.def('pod'), owner.metadata.namespace).filter((p) => matchesSelector(p.metadata.labels, owner.spec.selector));
const templateHash = (template) => hashOf(template, 10).slice(0, 10);
const setStatus = (C, obj, status) => {
  const merged = { ...obj.status, ...status };
  if (JSON.stringify(merged) === JSON.stringify(obj.status)) return;
  obj.status = merged;
  C.store.update(obj);
};
const scaleTo = (C, rs, replicas, deploy) => {
  if (rs.spec.replicas === replicas) return;
  const from = rs.spec.replicas;
  rs.spec.replicas = replicas;
  C.store.update(rs, { specChanged: true });
  if (deploy) C.record(deploy, 'Normal', 'ScalingReplicaSet', `Scaled ${replicas > from ? 'up' : 'down'} replica set ${rs.metadata.name} from ${from} to ${replicas}`, 'deployment-controller');
};

// ---------- Deployment ----------
const revisionOf = (rs) => Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0);

const deploymentController = (C) => C.store.list(C.def('deployment')).forEach((d) => {
  if (C.isTerminating(d)) return;
  const all = C.ownedBy(d, 'replicaset');
  const hash = templateHash(d.spec.template);
  let newRS = all.find((rs) => rs.metadata.labels?.['pod-template-hash'] === hash);
  const old = all.filter((rs) => rs !== newRS);
  const maxRevision = Math.max(0, ...all.map(revisionOf));

  if (!newRS && !d.spec.paused) {
    const template = clone(d.spec.template);
    template.metadata = { ...template.metadata, labels: { ...template.metadata?.labels, 'pod-template-hash': hash } };
    newRS = C.store.create({
      apiVersion: 'apps/v1', kind: 'ReplicaSet',
      metadata: {
        name: `${d.metadata.name}-${hash}`, namespace: d.metadata.namespace,
        labels: { ...template.metadata.labels },
        annotations: {
          'deployment.kubernetes.io/desired-replicas': String(d.spec.replicas), 'deployment.kubernetes.io/max-replicas': String(d.spec.replicas + 1),
          'deployment.kubernetes.io/revision': String(maxRevision + 1),
          ...(d.metadata.annotations?.['kubernetes.io/change-cause'] ? { 'kubernetes.io/change-cause': d.metadata.annotations['kubernetes.io/change-cause'] } : {}),
        },
        ownerReferences: [C.ownerRef(d)],
      },
      spec: { replicas: 0, minReadySeconds: d.spec.minReadySeconds || 0, selector: { matchLabels: { ...d.spec.selector.matchLabels, 'pod-template-hash': hash }, ...(d.spec.selector.matchExpressions ? { matchExpressions: d.spec.selector.matchExpressions } : {}) }, template },
      status: { replicas: 0 },
    });
    C.deployProgress.set(d.metadata.uid, { since: C.clock.seconds(), ready: 0 });
  } else if (newRS && revisionOf(newRS) < maxRevision && !d.spec.paused) {
    // Rolling back to an old template makes its ReplicaSet the newest revision again.
    newRS.metadata.annotations['deployment.kubernetes.io/revision'] = String(maxRevision + 1);
    C.store.update(newRS);
    C.deployProgress.set(d.metadata.uid, { since: C.clock.seconds(), ready: 0 });
  }
  if (!newRS) return;
  const cause = d.metadata.annotations?.['kubernetes.io/change-cause'];
  if (cause && newRS.metadata.annotations?.['kubernetes.io/change-cause'] !== cause) {
    newRS.metadata.annotations = { ...newRS.metadata.annotations, 'kubernetes.io/change-cause': cause };
    C.store.update(newRS);
  }

  const desired = d.spec.replicas;
  const readyOf = (rs) => rs.status?.readyReplicas || 0;
  if (d.spec.paused) {
    // Paused: only proportional scaling of the current ReplicaSet.
    if (!old.some((rs) => rs.spec.replicas)) scaleTo(C, newRS, desired, d);
  } else if (d.spec.strategy.type === 'Recreate') {
    old.forEach((rs) => scaleTo(C, rs, 0, d));
    const oldPodsGone = old.every((rs) => !C.ownedBy(rs, 'pod').length);
    if (oldPodsGone) scaleTo(C, newRS, desired, d);
  } else {
    const ru = d.spec.strategy.rollingUpdate || {};
    const maxSurge = resolveIntOrPercent(ru.maxSurge, desired, true);
    let maxUnavailable = resolveIntOrPercent(ru.maxUnavailable, desired, false);
    if (!maxSurge && !maxUnavailable) maxUnavailable = 1;
    const total = () => all.concat(newRS).filter((v, i, a) => a.indexOf(v) === i).reduce((s, rs) => s + rs.spec.replicas, 0);
    // Scale the new ReplicaSet up as far as the surge allows…
    if (newRS.spec.replicas > desired) scaleTo(C, newRS, desired, d);
    else {
      const room = desired + maxSurge - total();
      if (room > 0) scaleTo(C, newRS, Math.min(desired, newRS.spec.replicas + room), d);
    }
    // …and the old ones down as far as availability allows (unhealthy old pods go first).
    const available = [newRS, ...old].reduce((s, rs) => s + readyOf(rs), 0);
    let removable = available - (desired - maxUnavailable);
    old.sort((a, b) => revisionOf(a) - revisionOf(b)).forEach((rs) => {
      const unhealthy = rs.spec.replicas - readyOf(rs);
      const cut = Math.min(rs.spec.replicas, Math.max(0, removable) + Math.max(0, unhealthy));
      if (cut <= 0) return;
      removable -= Math.max(0, cut - unhealthy);
      scaleTo(C, rs, rs.spec.replicas - cut, d);
    });
  }

  // History: keep revisionHistoryLimit old ReplicaSets with zero replicas.
  old.filter((rs) => !rs.spec.replicas && !rs.status?.replicas).sort((a, b) => revisionOf(b) - revisionOf(a))
    .slice(d.spec.revisionHistoryLimit).forEach((rs) => C.store.remove(rs));

  const replicas = [newRS, ...old].reduce((s, rs) => s + (rs.status?.replicas || 0), 0);
  const ready = [newRS, ...old].reduce((s, rs) => s + readyOf(rs), 0);
  const updated = newRS.status?.replicas || 0;
  const updatedReady = readyOf(newRS);
  const done = updatedReady === desired && replicas === desired;
  const progress = C.deployProgress.get(d.metadata.uid) || { since: C.clock.seconds(), ready: 0 };
  const stuck = !done && C.clock.seconds() - progress.since > d.spec.progressDeadlineSeconds;
  // ready: null means "keep the clock, just record the count" (used to fast-forward a stalled rollout).
  if (progress.ready === null) C.deployProgress.set(d.metadata.uid, { since: progress.since, ready: updatedReady });
  else if (updatedReady !== progress.ready) C.deployProgress.set(d.metadata.uid, { since: C.clock.seconds(), ready: updatedReady });
  const conditions = [
    { type: 'Available', status: ready >= desired - resolveIntOrPercent(d.spec.strategy.rollingUpdate?.maxUnavailable ?? 0, desired, false) ? 'True' : 'False', reason: ready >= desired ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', message: ready >= desired ? 'Deployment has minimum availability.' : 'Deployment does not have minimum availability.' },
    stuck ? { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: `ReplicaSet "${newRS.metadata.name}" has timed out progressing.` }
      : { type: 'Progressing', status: 'True', reason: done ? 'NewReplicaSetAvailable' : 'ReplicaSetUpdated', message: `ReplicaSet "${newRS.metadata.name}" ${done ? 'has successfully progressed' : 'is progressing'}.` },
  ];
  if (d.spec.paused) conditions[1] = { type: 'Progressing', status: 'Unknown', reason: 'DeploymentPaused', message: 'Deployment is paused' };
  d.metadata.annotations = { ...d.metadata.annotations, 'deployment.kubernetes.io/revision': String(revisionOf(newRS)) };
  setStatus(C, d, {
    observedGeneration: d.metadata.generation, replicas, updatedReplicas: updated, readyReplicas: ready, availableReplicas: ready,
    unavailableReplicas: Math.max(0, desired - ready), conditions,
  });
});

// ---------- ReplicaSet ----------
const victimOrder = (C) => (a, b) => (!!a.spec.nodeName - !!b.spec.nodeName) || (C.isPodReady(a) - C.isPodReady(b)) || b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp);

const replicaSetController = (C) => C.store.list(C.def('replicaset')).forEach((rs) => {
  if (C.isTerminating(rs)) return;
  // Adopt orphans that match the selector, like the real controller.
  podsMatching(C, rs).filter((p) => !p.metadata.ownerReferences?.some((r) => r.controller) && C.isActivePod(p)).forEach((p) => {
    p.metadata.ownerReferences = [C.ownerRef(rs)];
    C.store.update(p);
  });
  const pods = C.ownedBy(rs, 'pod');
  const active = pods.filter(C.isActivePod);
  const diff = rs.spec.replicas - active.length;
  for (let i = 0; i < diff; i++) if (!C.createPodFrom(rs, rs.spec.template, `${rs.metadata.name}-${randSuffix(5)}`)) break;
  if (diff < 0) {
    active.sort(victimOrder(C)).slice(0, -diff).forEach((p) => {
      C.delete(p);
      C.record(rs, 'Normal', 'SuccessfulDelete', `Deleted pod: ${p.metadata.name}`, 'replicaset-controller');
    });
  }
  const live = C.ownedBy(rs, 'pod').filter(C.isActivePod);
  const ready = live.filter((p) => C.isPodReady(p)).length;
  setStatus(C, rs, { replicas: live.length, fullyLabeledReplicas: live.length, readyReplicas: ready, availableReplicas: ready, observedGeneration: rs.metadata.generation });
});

// ---------- StatefulSet ----------
const stsRevision = (sts) => `${sts.metadata.name}-${hashOf(sts.spec.template, 10)}`;

const statefulSetController = (C) => C.store.list(C.def('statefulset')).forEach((sts) => {
  if (C.isTerminating(sts)) return;
  const ns = sts.metadata.namespace;
  const name = sts.metadata.name;
  const revision = stsRevision(sts);
  const pods = C.ownedBy(sts, 'pod');
  const byOrdinal = new Map(pods.map((p) => [Number(p.metadata.name.slice(name.length + 1)), p]));
  const ordered = sts.spec.podManagementPolicy !== 'Parallel';
  const healthy = (p) => p && !C.isTerminating(p) && p.status.phase === 'Running' && C.isPodReady(p);

  const ensureClaims = (ordinal) => (sts.spec.volumeClaimTemplates || []).forEach((t) => {
    const claim = `${t.metadata.name}-${name}-${ordinal}`;
    if (C.store.get(C.def('pvc'), ns, claim)) return;
    C.create({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: claim, namespace: ns, labels: { ...sts.spec.selector.matchLabels } }, spec: clone(t.spec) });
    C.record(sts, 'Normal', 'SuccessfulCreate', `create Claim ${claim} Pod ${name}-${ordinal} in StatefulSet ${name} success`, 'statefulset-controller');
  });

  const createOrdinal = (i) => {
    ensureClaims(i);
    const podName = `${name}-${i}`;
    const claims = (sts.spec.volumeClaimTemplates || []).map((t) => ({ name: t.metadata.name, persistentVolumeClaim: { claimName: `${t.metadata.name}-${podName}` } }));
    const spec = { ...clone(sts.spec.template.spec), hostname: podName, subdomain: sts.spec.serviceName };
    spec.volumes = [...(spec.volumes || []).filter((v) => !claims.some((c) => c.name === v.name)), ...claims];
    C.createPodFrom(sts, { ...sts.spec.template, spec }, podName, {
      labels: { 'statefulset.kubernetes.io/pod-name': podName, 'apps.kubernetes.io/pod-index': String(i), 'controller-revision-hash': revision },
    });
  };

  // Scale up (in order) and recreate missing ordinals.
  for (let i = 0; i < sts.spec.replicas; i++) {
    const p = byOrdinal.get(i);
    if (p && C.isTerminating(p)) { if (ordered) break; continue; }
    if (!p) { createOrdinal(i); if (ordered) break; continue; }
    if (p.status.phase === 'Failed') { C.delete(p, { force: true }); if (ordered) break; continue; }
    if (ordered && !healthy(p)) break;
  }
  // Scale down from the highest ordinal, one at a time when ordered. Claims are kept.
  const extra = [...byOrdinal.entries()].filter(([i, p]) => i >= sts.spec.replicas && !C.isTerminating(p)).sort((a, b) => b[0] - a[0]);
  const allBelowHealthy = [...byOrdinal.entries()].filter(([i]) => i < sts.spec.replicas).every(([, p]) => healthy(p));
  if (extra.length && (!ordered || allBelowHealthy)) (ordered ? extra.slice(0, 1) : extra).forEach(([, p]) => { if (!pods.some((x) => C.isTerminating(x))) C.delete(p); });

  // Rolling update from the highest ordinal down to the partition.
  const partition = sts.spec.updateStrategy?.rollingUpdate?.partition ?? 0;
  if (sts.spec.updateStrategy?.type !== 'OnDelete' && !pods.some((p) => C.isTerminating(p))) {
    const stale = [...byOrdinal.entries()].filter(([i, p]) => i < sts.spec.replicas && i >= partition && p.metadata.labels['controller-revision-hash'] !== revision).sort((a, b) => b[0] - a[0]);
    const allHealthy = [...byOrdinal.entries()].filter(([i]) => i < sts.spec.replicas).every(([, p]) => healthy(p));
    if (stale.length && allHealthy) C.delete(stale[0][1]);
  }

  const live = C.ownedBy(sts, 'pod').filter(C.isActivePod);
  const updated = live.filter((p) => p.metadata.labels['controller-revision-hash'] === revision).length;
  setStatus(C, sts, {
    observedGeneration: sts.metadata.generation, replicas: live.length, readyReplicas: live.filter((p) => C.isPodReady(p)).length,
    availableReplicas: live.filter((p) => C.isPodReady(p)).length, currentReplicas: live.length - updated + (updated === live.length ? updated : 0),
    updatedReplicas: updated, currentRevision: updated === live.length ? revision : sts.status.currentRevision || revision, updateRevision: revision,
  });
});

// ---------- DaemonSet ----------
const tolerated = (tolerations = [], taint) => tolerations.some((t) => (t.operator === 'Exists' && !t.key) || (t.key === taint.key && (t.operator === 'Exists' || (t.value ?? '') === (taint.value ?? '')) && (!t.effect || t.effect === taint.effect)));

const daemonSetController = (C) => C.store.list(C.def('daemonset')).forEach((ds) => {
  if (C.isTerminating(ds)) return;
  const spec = ds.spec.template.spec;
  const hash = hashOf(ds.spec.template, 10);
  const eligible = C.nodes().filter((n) => Object.entries(spec.nodeSelector || {}).every(([k, v]) => n.metadata.labels?.[k] === String(v))
    && !(n.spec.taints || []).some((t) => ['NoSchedule', 'NoExecute'].includes(t.effect) && !t.key.startsWith('node.kubernetes.io/') && !tolerated(spec.tolerations, t))
    && (spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms || [{}]).some((term) => (term.matchExpressions || []).every((e) => matchesSelector(n.metadata.labels, [e]))));
  const names = new Set(eligible.map((n) => n.metadata.name));
  const pods = C.ownedBy(ds, 'pod').filter(C.isActivePod);
  pods.filter((p) => !names.has(p.spec.nodeName)).forEach((p) => C.delete(p));
  eligible.forEach((n) => {
    if (pods.some((p) => p.spec.nodeName === n.metadata.name)) return;
    if (C.ownedBy(ds, 'pod').some((p) => p.spec.nodeName === n.metadata.name && C.isTerminating(p))) return;
    const pod = C.createPodFrom(ds, ds.spec.template, `${ds.metadata.name}-${randSuffix(5)}`, { labels: { 'controller-revision-hash': hash }, spec: { nodeName: n.metadata.name } });
    if (pod) {
      C.setCondition(pod, 'PodScheduled', 'True');
      pod.status.hostIP = n.status.addresses[0].address;
      C.record(pod, 'Normal', 'Scheduled', `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${n.metadata.name}`, 'default-scheduler');
      C.store.update(pod);
    }
  });
  // Rolling update: replace up to maxUnavailable outdated pods while the rest are ready.
  if (ds.spec.updateStrategy.type === 'RollingUpdate') {
    const current = C.ownedBy(ds, 'pod').filter(C.isActivePod);
    const unavailable = current.filter((p) => !C.isPodReady(p)).length + C.ownedBy(ds, 'pod').filter((p) => C.isTerminating(p)).length;
    const budget = resolveIntOrPercent(ds.spec.updateStrategy.rollingUpdate?.maxUnavailable ?? 1, eligible.length, false) || 1;
    current.filter((p) => p.metadata.labels['controller-revision-hash'] !== hash).slice(0, Math.max(0, budget - unavailable)).forEach((p) => C.delete(p));
  }
  const live = C.ownedBy(ds, 'pod').filter(C.isActivePod);
  setStatus(C, ds, {
    desiredNumberScheduled: eligible.length, currentNumberScheduled: live.length, numberReady: live.filter((p) => C.isPodReady(p)).length,
    updatedNumberScheduled: live.filter((p) => p.metadata.labels['controller-revision-hash'] === hash).length,
    numberAvailable: live.filter((p) => C.isPodReady(p)).length, numberMisscheduled: 0, observedGeneration: ds.metadata.generation,
  });
});

// ---------- Job ----------
const jobFinished = (job) => job.status.conditions?.some((c) => ['Complete', 'Failed'].includes(c.type) && c.status === 'True');

const jobController = (C) => C.store.list(C.def('job')).forEach((job) => {
  if (C.isTerminating(job)) return;
  const pods = C.ownedBy(job, 'pod');
  const counted = (C.jobCounted ||= new Map()).get(job.metadata.uid) || { succeeded: new Set(), failed: new Set() };
  C.jobCounted.set(job.metadata.uid, counted);
  pods.forEach((p) => {
    if (p.status.phase === 'Succeeded') counted.succeeded.add(p.metadata.uid);
    if (p.status.phase === 'Failed') counted.failed.add(p.metadata.uid);
  });
  const restarts = pods.reduce((s, p) => s + (p.status.containerStatuses || []).reduce((r, cs) => r + cs.restartCount, 0), 0);
  const succeeded = counted.succeeded.size;
  const failed = counted.failed.size + (job.spec.template.spec.restartPolicy === 'OnFailure' ? restarts : 0);
  const active = pods.filter(C.isActivePod);
  const now = C.clock.iso();
  if (jobFinished(job)) return setStatus(C, job, { active: 0, ready: 0, succeeded, failed });

  const deadline = job.spec.activeDeadlineSeconds && job.status.startTime && (C.clock.now() - Date.parse(job.status.startTime)) / 1000 > job.spec.activeDeadlineSeconds;
  const fail = (reason, message) => {
    active.forEach((p) => C.delete(p));
    C.setCondition(job, 'FailureTarget', 'True', { reason, message });
    C.setCondition(job, 'Failed', 'True', { reason, message });
    C.record(job, 'Warning', reason, message, 'job-controller');
    setStatus(C, job, { active: 0, ready: 0, succeeded, failed });
  };
  if (failed > job.spec.backoffLimit) return fail('BackoffLimitExceeded', 'Job has reached the specified backoff limit');
  if (deadline) return fail('DeadlineExceeded', 'Job was active longer than specified deadline');
  if (succeeded >= job.spec.completions) {
    C.setCondition(job, 'SuccessCriteriaMet', 'True', { reason: 'CompletionsReached', message: 'Reached expected number of succeeded pods' });
    C.setCondition(job, 'Complete', 'True', { reason: 'CompletionsReached', message: 'Reached expected number of succeeded pods' });
    C.record(job, 'Normal', 'Completed', 'Job completed', 'job-controller');
    return setStatus(C, job, { active: 0, ready: 0, succeeded, failed, completionTime: now });
  }
  if (!job.spec.suspend) {
    const want = Math.min(job.spec.parallelism, job.spec.completions - succeeded) - active.length;
    const usedIdx = new Set([...pods.filter((p) => p.status.phase !== 'Failed').map((p) => p.metadata.annotations?.['batch.kubernetes.io/job-completion-index'])]);
    for (let i = 0; i < want; i++) {
      const indexed = job.spec.completionMode === 'Indexed';
      const idx = indexed ? [...Array(job.spec.completions).keys()].find((n) => !usedIdx.has(String(n))) : null;
      if (indexed) usedIdx.add(String(idx));
      C.createPodFrom(job, job.spec.template, `${job.metadata.name}-${indexed ? `${idx}-` : ''}${randSuffix(5)}`, indexed ? { annotations: { 'batch.kubernetes.io/job-completion-index': String(idx) }, spec: { hostname: `${job.metadata.name}-${idx}` } } : {});
    }
  } else active.forEach((p) => C.delete(p));
  const live = C.ownedBy(job, 'pod').filter(C.isActivePod);
  setStatus(C, job, { startTime: job.status.startTime || now, active: live.length, ready: live.filter((p) => C.isPodReady(p)).length, succeeded, failed });
});

// Finished jobs with ttlSecondsAfterFinished are deleted (with their pods) once the TTL passes.
const jobTtlController = (C) => C.store.list(C.def('job')).forEach((job) => {
  const finishedAt = job.status.completionTime || job.status.conditions?.find((c) => c.type === 'Failed')?.lastTransitionTime;
  if (job.spec.ttlSecondsAfterFinished == null || !finishedAt) return;
  if ((C.clock.now() - Date.parse(finishedAt)) / 1000 >= job.spec.ttlSecondsAfterFinished) C.delete(job);
});

// ---------- CronJob ----------
const MACROS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const fieldMatches = (field, value, min) => field.split(',').some((part) => {
  const [range, step = '1'] = part.split('/');
  const [lo, hi] = range === '*' ? [min, Infinity] : range.includes('-') ? range.split('-').map(Number) : [Number(range), part.includes('/') ? Infinity : Number(range)];
  return value >= lo && value <= hi && (value - lo) % Number(step) === 0;
});
export const cronMatches = (schedule, date) => {
  const [mi, hr, dom, mon, dow] = (MACROS[schedule] || schedule).trim().split(/\s+/);
  return fieldMatches(mi, date.getUTCMinutes(), 0) && fieldMatches(hr, date.getUTCHours(), 0) && fieldMatches(dom, date.getUTCDate(), 1) && fieldMatches(mon, date.getUTCMonth() + 1, 1) && fieldMatches(dow, date.getUTCDay(), 0);
};

export const jobFromTemplate = (C, cj, name, { manual = false } = {}) => C.create({
  apiVersion: 'batch/v1', kind: 'Job',
  metadata: { name, namespace: cj.metadata.namespace, labels: { ...cj.spec.jobTemplate.metadata?.labels }, annotations: manual ? { 'cronjob.kubernetes.io/instantiate': 'manual' } : { 'batch.kubernetes.io/cronjob-scheduled-timestamp': C.clock.iso() }, ownerReferences: manual ? undefined : [C.ownerRef(cj)] },
  spec: clone(cj.spec.jobTemplate.spec),
});

const cronJobController = (C) => C.store.list(C.def('cronjob')).forEach((cj) => {
  const minute = Math.floor(C.clock.now() / 60000);
  const last = cj.status.lastScheduleTime ? Math.floor(Date.parse(cj.status.lastScheduleTime) / 60000) : Math.floor(Date.parse(cj.metadata.creationTimestamp) / 60000);
  const jobs = C.ownedBy(cj, 'job');
  const running = jobs.filter((j) => !jobFinished(j));
  let changed = false;
  for (let m = last + 1; m <= minute && !cj.spec.suspend; m++) {
    if (!cronMatches(cj.spec.schedule, new Date(m * 60000))) continue;
    cj.status.lastScheduleTime = new Date(m * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    changed = true;
    if (running.length && cj.spec.concurrencyPolicy === 'Forbid') { C.record(cj, 'Normal', 'JobAlreadyActive', 'Not starting job because prior execution is running and concurrency policy is Forbid', 'cronjob-controller'); continue; }
    if (running.length && cj.spec.concurrencyPolicy === 'Replace') running.forEach((j) => { C.delete(j); C.record(cj, 'Normal', 'SuccessfulDelete', `Deleted job ${j.metadata.name}`, 'cronjob-controller'); });
    const job = jobFromTemplate(C, cj, `${cj.metadata.name}-${m}`);
    C.record(cj, 'Normal', 'SuccessfulCreate', `Created job ${job.metadata.name}`, 'cronjob-controller');
  }
  // History limits.
  const finished = (type) => C.ownedBy(cj, 'job').filter((j) => j.status.conditions?.some((c) => c.type === type && c.status === 'True')).sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp));
  finished('Complete').slice(cj.spec.successfulJobsHistoryLimit).forEach((j) => C.delete(j));
  finished('Failed').slice(cj.spec.failedJobsHistoryLimit).forEach((j) => C.delete(j));
  const active = C.ownedBy(cj, 'job').filter((j) => !jobFinished(j)).map((j) => ({ kind: 'Job', name: j.metadata.name, namespace: j.metadata.namespace, uid: j.metadata.uid }));
  const lastSuccess = finished('Complete')[0]?.status.completionTime;
  if (changed || JSON.stringify(active) !== JSON.stringify(cj.status.active || [])) {
    cj.status = { ...cj.status, active: active.length ? active : undefined, ...(lastSuccess ? { lastSuccessfulTime: lastSuccess } : {}) };
    C.store.update(cj);
  }
});

// ---------- HorizontalPodAutoscaler ----------
const SCALE_TARGETS = { Deployment: 'deployment', StatefulSet: 'statefulset', ReplicaSet: 'replicaset' };
const STABILIZATION_TICKS = 3; // real default is 300s for scale-down; shortened for the lab

export const podCpuUsage = (C, pod) => C.cpuUsage?.get(pod.metadata.uid) ?? 0;

const hpaController = (C) => C.store.list(C.def('hpa')).forEach((hpa) => {
  const ref = hpa.spec.scaleTargetRef;
  const target = C.store.get(C.def(SCALE_TARGETS[ref.kind] || ref.kind), hpa.metadata.namespace, ref.name);
  if (!target) {
    C.setCondition(hpa, 'AbleToScale', 'False', { reason: 'FailedGetScale', message: `the HPA controller was unable to get the target's current scale: ${ref.kind.toLowerCase()}s.apps "${ref.name}" not found` });
    return C.store.update(hpa);
  }
  const pods = podsMatching(C, target).filter((p) => C.isActivePod(p) && p.status.phase === 'Running');
  const metric = (hpa.spec.metrics || []).find((m) => m.type === 'Resource' && m.resource.name === 'cpu');
  const goal = metric?.resource.target.averageUtilization ?? 80;
  const missingRequest = pods.some((p) => p.spec.containers.some((c) => !c.resources?.requests?.cpu));
  const current = target.spec.replicas;
  let desired = current;
  let utilization = null;
  if (missingRequest) {
    C.setCondition(hpa, 'ScalingActive', 'False', { reason: 'FailedGetResourceMetric', message: 'the HPA was unable to compute the replica count: failed to get cpu utilization: missing request for cpu in container' });
    C.record(hpa, 'Warning', 'FailedGetResourceMetric', 'failed to get cpu utilization: missing request for cpu in container', 'horizontal-pod-autoscaler');
  } else if (pods.length) {
    const requests = pods.reduce((s, p) => s + p.spec.containers.reduce((r, c) => r + parseCpu(c.resources.requests.cpu), 0), 0);
    const usage = pods.reduce((s, p) => s + podCpuUsage(C, p), 0);
    utilization = Math.round((usage / requests) * 100);
    const ratio = utilization / goal;
    desired = Math.abs(ratio - 1) <= 0.1 ? current : Math.ceil(current * ratio);
    C.setCondition(hpa, 'ScalingActive', 'True', { reason: 'ValidMetricFound', message: 'the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)' });
  }
  // Default scale-up policy: at most double, or +4 pods, per step.
  if (desired > current) desired = Math.min(desired, Math.max(current * 2, current + 4));
  desired = Math.max(hpa.spec.minReplicas, Math.min(hpa.spec.maxReplicas, desired));
  // Scale-down stabilization: use the highest recommendation from the recent window.
  const history = [...(C.hpaHistory.get(hpa.metadata.uid) || []), desired].slice(-STABILIZATION_TICKS);
  C.hpaHistory.set(hpa.metadata.uid, history);
  if (desired < current) desired = Math.max(desired, ...history.slice(0, -1).filter((n) => n <= current), desired);
  if (desired !== current && !missingRequest) {
    target.spec.replicas = desired;
    C.store.update(target, { specChanged: true });
    C.record(hpa, 'Normal', 'SuccessfulRescale', `New size: ${desired}; reason: ${desired > current ? 'cpu resource utilization (percentage of request) above target' : 'All metrics below target'}`, 'horizontal-pod-autoscaler');
  }
  C.setCondition(hpa, 'AbleToScale', 'True', { reason: desired === current ? 'ReadyForNewScale' : 'SucceededRescale', message: desired === current ? 'recommended size matches current size' : `the HPA controller was able to update the target scale to ${desired}` });
  hpa.status = { ...hpa.status, currentReplicas: current, desiredReplicas: desired, lastScaleTime: desired !== current ? C.clock.iso() : hpa.status.lastScaleTime, currentMetrics: utilization == null ? undefined : [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: utilization, averageValue: `${Math.round(pods.reduce((s, p) => s + podCpuUsage(C, p), 0) / Math.max(1, pods.length))}m` } } }] };
  C.store.update(hpa);
});

// CPU usage per pod: a baseline plus any load generators aimed at the pod's Services.
const LOAD_PATTERN = /(?:wget|curl)\b.*?https?:\/\/([a-z0-9-]+)/;
const metricsController = (C) => {
  const load = new Map(); // service key → millicores
  C.store.list(C.def('pod')).filter((p) => p.status.phase === 'Running').forEach((p) => {
    const cmd = p.spec.containers.map((c) => [...(c.command || []), ...(c.args || [])].join(' ')).join(' ');
    if (!/while/.test(cmd)) return;
    const m = LOAD_PATTERN.exec(cmd);
    if (m) load.set(`${p.metadata.namespace}/${m[1]}`, (load.get(`${p.metadata.namespace}/${m[1]}`) || 0) + 500);
  });
  C.cpuUsage = new Map();
  C.memUsage ||= new Map();
  C.store.list(C.def('pod')).filter((p) => p.status.phase === 'Running').forEach((p) => {
    const svcs = C.store.list(C.def('service'), p.metadata.namespace).filter((s) => matchesMap(p.metadata.labels, s.spec.selector));
    const readyPeers = (s) => C.store.list(C.def('pod'), s.metadata.namespace).filter((x) => matchesMap(x.metadata.labels, s.spec.selector) && C.isPodReady(x)).length || 1;
    const extra = svcs.reduce((sum, s) => sum + (load.get(`${s.metadata.namespace}/${s.metadata.name}`) || 0) / readyPeers(s), 0);
    const info = imageInfo(p.spec.containers[0].image);
    const base = info?.system ? 4 : 1 + (p.metadata.name.length % 3);
    C.cpuUsage.set(p.metadata.uid, Math.round(base + (C.isPodReady(p) ? extra : 0)));
    const stress = p.spec.containers.some((c) => imageInfo(c.image)?.kind === 'stress');
    C.memUsage.set(p.metadata.uid, stress ? 250 : (info?.port === 5432 ? 38 : info?.system ? 22 : 3 + (p.metadata.name.length % 5)));
  });
};

// ---------- Services: endpoints and load balancers ----------
const endpointsController = (C) => C.store.list(C.def('service')).forEach((svc) => {
  if (!svc.spec.selector) return;
  const ns = svc.metadata.namespace;
  const pods = C.store.list(C.def('pod'), ns).filter((p) => matchesMap(p.metadata.labels, svc.spec.selector) && p.status.podIP && C.isActivePod(p) && p.spec.nodeName);
  const addr = (p) => ({ ip: p.status.podIP, nodeName: p.spec.nodeName, targetRef: { kind: 'Pod', name: p.metadata.name, namespace: ns, uid: p.metadata.uid }, ...(p.spec.hostname && p.spec.subdomain === svc.metadata.name ? { hostname: p.spec.hostname } : {}) });
  const ready = pods.filter((p) => C.isPodReady(p) || svc.spec.publishNotReadyAddresses);
  const notReady = pods.filter((p) => !ready.includes(p));
  const portOf = (sp) => {
    if (typeof sp.targetPort === 'number') return sp.targetPort;
    const named = pods[0]?.spec.containers.flatMap((c) => c.ports || []).find((p) => p.name === sp.targetPort);
    return named?.containerPort ?? sp.port;
  };
  const ports = (svc.spec.ports || []).map((sp) => ({ ...(sp.name ? { name: sp.name } : {}), port: portOf(sp), protocol: sp.protocol }));
  const subsets = pods.length ? [{ ...(ready.length ? { addresses: ready.map(addr) } : {}), ...(notReady.length ? { notReadyAddresses: notReady.map(addr) } : {}), ports }] : undefined;
  const ep = C.store.get(C.def('endpoints'), ns, svc.metadata.name);
  if (!ep) C.store.create({ apiVersion: 'v1', kind: 'Endpoints', metadata: { name: svc.metadata.name, namespace: ns, labels: { ...svc.metadata.labels } }, subsets });
  else if (JSON.stringify(ep.subsets) !== JSON.stringify(subsets)) { ep.subsets = subsets; C.store.update(ep); }

  const sliceName = `${svc.metadata.name}-${hashOf(svc.metadata.uid, 5)}`;
  const endpoints = pods.map((p) => ({ addresses: [p.status.podIP], conditions: { ready: ready.includes(p), serving: ready.includes(p), terminating: false }, nodeName: p.spec.nodeName, targetRef: addr(p).targetRef, zone: C.store.get(C.def('node'), null, p.spec.nodeName)?.metadata.labels['topology.kubernetes.io/zone'] }));
  const slice = C.store.get(C.def('endpointslice'), ns, sliceName);
  if (!slice) {
    C.store.create({ apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice', metadata: { name: sliceName, namespace: ns, labels: { 'kubernetes.io/service-name': svc.metadata.name, 'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io' }, ownerReferences: [C.ownerRef(svc)] }, addressType: 'IPv4', endpoints, ports });
  } else if (JSON.stringify(slice.endpoints) !== JSON.stringify(endpoints) || JSON.stringify(slice.ports) !== JSON.stringify(ports)) {
    slice.endpoints = endpoints;
    slice.ports = ports;
    C.store.update(slice);
  }
});

const loadBalancerController = (C) => {
  C.store.list(C.def('service')).filter((s) => s.spec.type === 'LoadBalancer' && !s.status.loadBalancer?.ingress).forEach((s) => {
    s.status.loadBalancer = { ingress: [{ ip: C.allocLbIp(), ipMode: 'VIP' }] };
    C.record(s, 'Normal', 'IPAllocated', `Assigned IP ["${s.status.loadBalancer.ingress[0].ip}"]`, 'metallb-controller');
    C.store.update(s);
  });
  C.store.list(C.def('service')).filter((s) => s.spec.type !== 'LoadBalancer' && s.status.loadBalancer?.ingress).forEach((s) => { s.status.loadBalancer = {}; C.store.update(s); });
  const lb = C.store.get(C.def('service'), 'ingress-nginx', 'ingress-nginx-controller')?.status.loadBalancer?.ingress;
  C.store.list(C.def('ingress')).filter((i) => i.spec.ingressClassName === 'nginx' && lb && !i.status.loadBalancer?.ingress).forEach((i) => {
    i.status.loadBalancer = { ingress: [{ ip: lb[0].ip }] };
    C.record(i, 'Normal', 'Sync', 'Scheduled for sync', 'nginx-ingress-controller');
    C.store.update(i);
  });
};

// ---------- storage ----------
const provision = (C, pvc, sc, node) => {
  const name = `pvc-${pvc.metadata.uid}`;
  const pv = C.store.create({
    apiVersion: 'v1', kind: 'PersistentVolume',
    metadata: { name, annotations: { 'pv.kubernetes.io/provisioned-by': sc.provisioner }, finalizers: ['kubernetes.io/pv-protection'] },
    spec: {
      capacity: { storage: pvc.spec.resources.requests.storage }, accessModes: pvc.spec.accessModes, storageClassName: sc.metadata.name,
      persistentVolumeReclaimPolicy: sc.reclaimPolicy || 'Delete', volumeMode: 'Filesystem',
      claimRef: { kind: 'PersistentVolumeClaim', namespace: pvc.metadata.namespace, name: pvc.metadata.name, uid: pvc.metadata.uid },
      ...(node ? { hostPath: { path: `/var/local-path-provisioner/${name}_${pvc.metadata.namespace}_${pvc.metadata.name}`, type: 'DirectoryOrCreate' }, nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [node] }] }] } } } : {}),
    },
    status: { phase: 'Bound' },
  });
  C.record(pvc, 'Normal', 'ProvisioningSucceeded', `Successfully provisioned volume ${name}`, `${sc.provisioner}_local-path-provisioner`);
  return pv;
};

const bindClaim = (C, pvc, pv) => {
  pv.status = { phase: 'Bound' };
  pv.spec.claimRef ||= { kind: 'PersistentVolumeClaim', namespace: pvc.metadata.namespace, name: pvc.metadata.name, uid: pvc.metadata.uid };
  C.store.update(pv);
  pvc.spec.volumeName = pv.metadata.name;
  pvc.status = { phase: 'Bound', accessModes: pv.spec.accessModes, capacity: { ...pv.spec.capacity } };
  pvc.metadata.annotations = { ...pvc.metadata.annotations, 'pv.kubernetes.io/bind-completed': 'yes' };
  pvc.metadata.finalizers = ['kubernetes.io/pvc-protection'];
  C.store.update(pvc);
};

const volumeController = (C) => {
  C.store.list(C.def('pvc')).filter((pvc) => pvc.status.phase === 'Pending' && !C.isTerminating(pvc)).forEach((pvc) => {
    const sc = pvc.spec.storageClassName ? C.store.get(C.def('storageclass'), null, pvc.spec.storageClassName) : null;
    if (!sc) {
      const pv = C.store.list(C.def('pv')).find((v) => v.status.phase === 'Available' && !v.spec.storageClassName === !pvc.spec.storageClassName
        && (pvc.spec.accessModes || []).every((m) => v.spec.accessModes?.includes(m)) && parseMem(v.spec.capacity?.storage) >= parseMem(pvc.spec.resources?.requests?.storage));
      if (pv) return bindClaim(C, pvc, pv);
      if (pvc.spec.storageClassName) C.record(pvc, 'Warning', 'ProvisioningFailed', `storageclass.storage.k8s.io "${pvc.spec.storageClassName}" not found`, 'persistentvolume-controller');
      return;
    }
    const selected = pvc.metadata.annotations?.['volume.kubernetes.io/selected-node'];
    if (sc.volumeBindingMode === 'WaitForFirstConsumer' && !selected) {
      C.record(pvc, 'Normal', 'WaitForFirstConsumer', 'waiting for first consumer to be created before binding', 'persistentvolume-controller');
      return;
    }
    bindClaim(C, pvc, provision(C, pvc, sc, selected));
  });
  // Deleting a claim: wait while a pod uses it, then release or delete its volume.
  C.store.list(C.def('pvc')).filter(C.isTerminating).forEach((pvc) => {
    const inUse = C.store.list(C.def('pod'), pvc.metadata.namespace).some((p) => (p.spec.volumes || []).some((v) => v.persistentVolumeClaim?.claimName === pvc.metadata.name));
    if (inUse) return;
    const pv = pvc.spec.volumeName && C.store.get(C.def('pv'), null, pvc.spec.volumeName);
    if (pv && pv.spec.persistentVolumeReclaimPolicy === 'Delete') { C.volumeData.delete(pv.metadata.name); C.store.remove(pv); }
    else if (pv) { pv.status = { phase: 'Released' }; C.store.update(pv); }
    C.store.remove(pvc);
  });
  C.store.list(C.def('pv')).filter(C.isTerminating).forEach((pv) => { if (pv.status.phase !== 'Bound') C.store.remove(pv); });
};

// ---------- namespaces and garbage collection ----------
const namespaceController = (C) => C.store.list(C.def('namespace')).forEach((ns) => {
  const name = ns.metadata.name;
  if (ns.status.phase === 'Active') {
    if (!C.store.get(C.def('serviceaccount'), name, 'default')) C.store.create({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: name } });
    if (!C.store.get(C.def('configmap'), name, 'kube-root-ca.crt')) C.store.create({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-root-ca.crt', namespace: name, annotations: { 'kubernetes.io/description': 'Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IPs or kubernetes.default.svc.' } }, data: { 'ca.crt': '-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIX…(simulated)…\n-----END CERTIFICATE-----\n' } });
    return;
  }
  const inside = C.store.all().filter((o) => o.metadata.namespace === name && o.kind !== 'Event');
  inside.forEach((o) => C.delete(o, { grace: o.kind === 'Pod' ? 1 : null, force: o.kind !== 'Pod' }));
  if (!C.store.all().some((o) => o.metadata.namespace === name && o.kind !== 'Event')) {
    C.store.all().filter((o) => o.metadata.namespace === name).forEach((o) => C.store.remove(o));
    C.store.remove(ns);
  }
});

const garbageCollector = (C) => {
  const uids = new Set(C.store.all().map((o) => o.metadata.uid));
  C.store.all().filter((o) => o.metadata.ownerReferences?.length && !o.metadata.deletionTimestamp && o.metadata.ownerReferences.every((r) => !uids.has(r.uid)))
    .forEach((o) => C.delete(o));
  // Owners being deleted take their dependents with them.
  C.store.all().filter((o) => o.metadata.deletionTimestamp && o.kind !== 'Pod' && o.kind !== 'Namespace' && !o.metadata.finalizers?.length).forEach((o) => C.store.remove(o));
};

// PodDisruptionBudget status: how many voluntary evictions are allowed right now.
const pdbController = (C) => C.store.list(C.def('pdb')).forEach((pdb) => {
  const pods = C.store.list(C.def('pod'), pdb.metadata.namespace).filter((p) => matchesSelector(p.metadata.labels, pdb.spec.selector) && C.isActivePod(p));
  const healthy = pods.filter((p) => C.isPodReady(p)).length;
  const expected = pods.length;
  const desired = pdb.spec.minAvailable != null ? resolveIntOrPercent(pdb.spec.minAvailable, expected, true) : expected - resolveIntOrPercent(pdb.spec.maxUnavailable, expected, false);
  setStatus(C, pdb, { currentHealthy: healthy, desiredHealthy: desired, disruptionsAllowed: Math.max(0, healthy - desired), expectedPods: expected, observedGeneration: pdb.metadata.generation });
});

const quotaController = (C) => C.store.list(C.def('resourcequota')).forEach((q) => {
  const pods = C.store.list(C.def('pod'), q.metadata.namespace).filter((p) => !['Succeeded', 'Failed'].includes(p.status.phase));
  const sum = (field, res) => pods.reduce((s, p) => s + p.spec.containers.reduce((r, c) => r + (res === 'cpu' ? parseCpu(c.resources?.[field]?.cpu) : Math.round(parseMem(c.resources?.[field]?.memory) / 1024 ** 2)), 0), 0);
  const fmt = (k, v) => (k === 'pods' ? String(v) : k.endsWith('cpu') ? (v % 1000 ? `${v}m` : String(v / 1000)) : `${v}Mi`);
  const used = Object.fromEntries(Object.keys(q.spec.hard || {}).map((k) => {
    const field = k.startsWith('limits') ? 'limits' : 'requests';
    const v = k === 'pods' ? pods.length : k.endsWith('cpu') ? sum(field, 'cpu') : k.endsWith('memory') ? sum(field, 'memory') : 0;
    return [k, fmt(k, v)];
  }));
  setStatus(C, q, { hard: { ...q.spec.hard }, used });
});

/** Run on every settle pass, in this order. */
export const CONTROLLERS = [namespaceController, deploymentController, replicaSetController, statefulSetController, daemonSetController, jobController, volumeController, endpointsController, loadBalancerController, garbageCollector, pdbController, quotaController];
/** Run once per tick, because they depend on time passing. */
export const TICK_CONTROLLERS = [metricsController, cronJobController, hpaController, jobTtlController];

export { podsMatching, TICK_SECONDS };
