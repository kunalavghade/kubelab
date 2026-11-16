// The kubelet on every node: pulls images, starts containers, runs probes, restarts crashed
// containers with back-off, finishes run-to-completion containers and terminates pods.
import { imageInfo, parseImage } from './data.js';
import { parseMem, TICK_SECONDS } from './api.js';
import { NODE_EVICTION_TICKS } from './cluster.js';

const MAX_BACKOFF_TICKS = 6; // real cap is 5 minutes
const STRESS_MB = 250; // polinux/stress allocates this much unless told otherwise

// ---------- what a container does ----------
const commandLine = (c) => [...(c.command || []), ...(c.args || [])].join(' ');

/** Decides how a container behaves from its image and command. */
export const behaviourOf = (c) => {
  const info = imageInfo(c.image);
  if (!info) return { kind: 'pull-error' };
  const cmd = commandLine(c);
  if (info.kind === 'stress') {
    const m = /--vm-bytes\s+(\d+)([MG])/.exec(cmd);
    return { kind: 'stress', info, mb: m ? Number(m[1]) * (m[2] === 'G' ? 1024 : 1) : STRESS_MB };
  }
  if (info.kind === 'crash') return { kind: 'crash', info };
  if (info.kind === 'server' && !cmd) return { kind: 'server', info };
  if (info.kind === 'server' && cmd) return /\b(exit [1-9]|false)\b/.test(cmd) ? { kind: 'fail', info } : { kind: 'server', info };
  // command images
  if (!cmd) return { kind: 'complete', info, ticks: 0, output: [] };
  if (/sleep\s+(infinity|\d{3,})|while\s+(true|sleep|:)|tail\s+-f|sleep\s+[6-9]\d\b/.test(cmd)) return { kind: 'server', info, loop: true, output: /while/.test(cmd) ? [] : echoes(cmd) };
  if (/\bexit\s+[1-9]|\bfalse\b/.test(cmd)) return { kind: 'fail', info, output: echoes(cmd) };
  const sleep = /sleep\s+(\d+)/.exec(cmd);
  return { kind: 'complete', info, ticks: Math.max(1, Math.ceil((sleep ? Number(sleep[1]) : 1) / TICK_SECONDS)), output: echoes(cmd) };
};

const PI = '3.1415926535897932384626433832795028841971693993751';
const echoes = (cmd) => {
  if (/bpi\((\d+)\)/.test(cmd)) return [PI.slice(0, Number(/bpi\((\d+)\)/.exec(cmd)[1]) + 1)];
  const out = [...cmd.matchAll(/echo\s+(?:-n\s+)?(?:"([^"]*)"|'([^']*)'|([^;&|]+))/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim());
  return out.map((l) => l.replace(/\$\(date\)/g, 'Mon Nov 16 09:00:00 UTC 2026').replace(/\$HOSTNAME/g, 'pod'));
};

// ---------- runtime state ----------
const rtOf = (C, pod) => {
  if (!C.rt.has(pod.metadata.uid)) {
    C.rt.set(pod.metadata.uid, { containers: {}, created: C.clock.seconds(), init: 0, pullTicks: {}, fs: {} });
  }
  return C.rt.get(pod.metadata.uid);
};
const crt = (rt, name) => (rt.containers[name] ||= { restarts: 0, backoff: 0, backoffLeft: 0, logs: [], prevLogs: [], ticksRun: 0, probeFails: 0, startedAt: null, state: 'waiting', reason: 'ContainerCreating' });

const statusOf = (pod, name) => pod.status.containerStatuses?.find((s) => s.name === name);

const writeStatus = (C, pod, c, cr) => {
  const now = C.clock.iso();
  const state = {
    running: { running: { startedAt: cr.startedAt } },
    waiting: { waiting: { reason: cr.reason, ...(cr.message ? { message: cr.message } : {}) } },
    terminated: { terminated: { exitCode: cr.exitCode, reason: cr.reason, startedAt: cr.startedAt, finishedAt: cr.finishedAt || now } },
  }[cr.state];
  const next = {
    name: c.name, image: c.image, imageID: cr.imageId || '', containerID: cr.startedAt ? `containerd://${pod.metadata.uid.replace(/-/g, '')}${c.name.length}` : undefined,
    ready: !!cr.ready, started: cr.state === 'running', restartCount: cr.restarts, state,
    ...(cr.last ? { lastState: { terminated: cr.last } } : { lastState: {} }),
  };
  const list = (pod.status.containerStatuses ||= []);
  const i = list.findIndex((s) => s.name === c.name);
  if (i >= 0) list[i] = next; else list.push(next);
};

// ---------- config checks ----------
const missingEnvRef = (C, pod, c) => {
  const ns = pod.metadata.namespace;
  for (const e of c.env || []) {
    const ref = e.valueFrom?.configMapKeyRef || e.valueFrom?.secretKeyRef;
    if (!ref || ref.optional) continue;
    const isCm = !!e.valueFrom.configMapKeyRef;
    const obj = C.store.get(C.def(isCm ? 'configmap' : 'secret'), ns, ref.name);
    if (!obj) return `${isCm ? 'configmap' : 'secret'} "${ref.name}" not found`;
    if (!(ref.key in (obj.data || {}))) return `couldn't find key ${ref.key} in ${isCm ? 'ConfigMap' : 'Secret'} ${ns}/${ref.name}`;
  }
  for (const src of c.envFrom || []) {
    const ref = src.configMapRef || src.secretRef;
    if (ref?.optional) continue;
    if (ref && !C.store.get(C.def(src.configMapRef ? 'configmap' : 'secret'), ns, ref.name)) return `${src.configMapRef ? 'configmap' : 'secret'} "${ref.name}" not found`;
  }
  return null;
};

const missingVolume = (C, pod) => {
  for (const v of pod.spec.volumes || []) {
    const ref = v.configMap || v.secret;
    if (!ref || ref.optional) continue;
    const name = v.configMap ? ref.name : ref.secretName;
    if (!C.store.get(C.def(v.configMap ? 'configmap' : 'secret'), pod.metadata.namespace, name)) {
      return `MountVolume.SetUp failed for volume "${v.name}" : ${v.configMap ? 'configmap' : 'secret'} "${name}" not found`;
    }
    const pvc = v.persistentVolumeClaim && C.store.get(C.def('pvc'), pod.metadata.namespace, v.persistentVolumeClaim.claimName);
    if (v.persistentVolumeClaim && pvc?.status.phase !== 'Bound') return `waiting for volume "${v.name}" to be bound`;
  }
  return null;
};

/** Environment a container sees: its own env, envFrom, and service link variables. */
export const containerEnv = (C, pod, c) => {
  const ns = pod.metadata.namespace;
  const env = { HOSTNAME: pod.metadata.name, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' };
  if (pod.spec.enableServiceLinks !== false) {
    C.store.list(C.def('service'), ns).filter((s) => s.spec.clusterIP && s.spec.clusterIP !== 'None').forEach((s) => {
      const p = s.metadata.name.toUpperCase().replace(/-/g, '_');
      env[`${p}_SERVICE_HOST`] = s.spec.clusterIP;
      env[`${p}_SERVICE_PORT`] = String(s.spec.ports?.[0]?.port ?? '');
    });
  }
  for (const src of c.envFrom || []) {
    const obj = C.store.get(C.def(src.configMapRef ? 'configmap' : 'secret'), ns, (src.configMapRef || src.secretRef)?.name);
    Object.entries(obj?.data || {}).forEach(([k, v]) => { env[`${src.prefix || ''}${k}`] = src.secretRef ? C.unb64(v) : v; });
  }
  for (const e of c.env || []) {
    if ('value' in e) env[e.name] = String(e.value ?? '');
    const ref = e.valueFrom?.configMapKeyRef || e.valueFrom?.secretKeyRef;
    if (ref) {
      const obj = C.store.get(C.def(e.valueFrom.configMapKeyRef ? 'configmap' : 'secret'), ns, ref.name);
      const raw = obj?.data?.[ref.key];
      if (raw != null) env[e.name] = e.valueFrom.secretKeyRef ? C.unb64(raw) : raw;
    }
    const field = e.valueFrom?.fieldRef?.fieldPath;
    if (field) env[e.name] = { 'metadata.name': pod.metadata.name, 'metadata.namespace': ns, 'spec.nodeName': pod.spec.nodeName, 'status.podIP': pod.status.podIP }[field] ?? '';
  }
  return env;
};

// ---------- probes ----------
const probeTarget = (c, probe) => {
  const port = probe.httpGet?.port ?? probe.tcpSocket?.port ?? probe.grpc?.port;
  if (port == null) return null;
  return typeof port === 'number' ? port : (c.ports || []).find((p) => p.name === port)?.containerPort ?? -1;
};

/** A probe passes when the app listens on the probed port (exec probes check files). */
const probePasses = (C, pod, c, probe, cr, rt) => {
  if (!probe) return true;
  if (cr.hung) return false;
  if (probe.exec) {
    const file = /(?:cat|test -f|ls)\s+(\/\S+)/.exec(probe.exec.command?.join(' ') || '');
    return !file || file[1] in (rt.fs[c.name] || {});
  }
  const target = probeTarget(c, probe);
  if (target == null) return true;
  const b = behaviourOf(c);
  const listens = b.kind === 'server' && !b.loop ? b.info.port : null;
  return target === listens;
};

// ---------- container state transitions ----------
const startContainer = (C, pod, c, cr, rt) => {
  const now = C.clock.iso();
  cr.state = 'running';
  cr.reason = null;
  cr.message = null;
  cr.startedAt = now;
  cr.startedSec = C.clock.seconds();
  cr.ticksRun = 0;
  cr.probeFails = 0;
  cr.startupDone = !c.startupProbe;
  cr.readyAt = C.clock.seconds() + (c.readinessProbe?.initialDelaySeconds ?? 0);
  cr.imageId = `docker.io/${parseImage(c.image).repo.includes('/') ? '' : 'library/'}${parseImage(c.image).repo}@sha256:${pod.metadata.uid.replace(/-/g, '').padEnd(64, '0').slice(0, 64)}`;
  rt.fs[c.name] = {}; // a restarted container gets a fresh writable layer
  const b = behaviourOf(c);
  const ctx = { pod: pod.metadata.name, tag: parseImage(c.image).tag };
  const missing = (b.info?.env || []).filter((k) => !(k in containerEnv(C, pod, c)));
  cr.missingEnv = missing.length > 0;
  cr.logs = cr.missingEnv ? (b.info.missingEnvLogs?.(ctx) || [`error: ${missing[0]} is not set`]) : (b.info?.logs?.(ctx) || []);
  C.record(pod, 'Normal', 'Created', `Created container: ${c.name}`);
  C.record(pod, 'Normal', 'Started', `Started container ${c.name}`);
};

const terminate = (C, pod, c, cr, { exitCode, reason }) => {
  cr.state = 'terminated';
  cr.exitCode = exitCode;
  cr.reason = reason;
  cr.finishedAt = C.clock.iso();
  cr.ready = false;
};

/** After a container stops: restart it (with back-off) or leave it terminated. */
const afterExit = (C, pod, c, cr) => {
  const policy = pod.spec.restartPolicy;
  const restart = policy === 'Always' || (policy === 'OnFailure' && cr.exitCode !== 0);
  if (!restart) return;
  cr.last = { exitCode: cr.exitCode, reason: cr.reason, startedAt: cr.startedAt, finishedAt: cr.finishedAt };
  cr.prevLogs = cr.logs;
  cr.restarts += 1;
  cr.backoff = Math.min(MAX_BACKOFF_TICKS, Math.max(1, cr.backoff * 2));
  cr.backoffLeft = cr.backoff;
  cr.state = 'waiting';
  cr.reason = 'CrashLoopBackOff';
  cr.message = `back-off ${cr.backoff * TICK_SECONDS}s restarting failed container=${c.name} pod=${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`;
  C.record(pod, 'Warning', 'BackOff', 'Back-off restarting failed container');
};

const runContainer = (C, pod, c, cr, rt) => {
  const b = behaviourOf(c);
  cr.ticksRun += 1;
  const limit = parseMem(c.resources?.limits?.memory);
  const exits = {
    crash: () => cr.ticksRun >= 1 && { exitCode: 1, reason: 'Error' },
    fail: () => cr.ticksRun >= 1 && { exitCode: 1, reason: 'Error' },
    complete: () => cr.ticksRun >= b.ticks && { exitCode: 0, reason: 'Completed' },
    stress: () => limit && b.mb * 1024 ** 2 > limit && { exitCode: 137, reason: 'OOMKilled' },
    server: () => cr.missingEnv && { exitCode: 1, reason: 'Error' },
  };
  if (cr.ticksRun === 1 && b.output?.length) cr.logs.push(...b.output);
  const exit = exits[b.kind]?.();
  if (exit) {
    terminate(C, pod, c, cr, exit);
    if (exit.reason === 'OOMKilled') C.record(pod, 'Warning', 'OOMKilling', `Memory cgroup out of memory: Killed process (stress) total-vm:${b.mb * 1024}kB, container ${c.name}`);
    return afterExit(C, pod, c, cr);
  }

  // Probes: startup gates the others; liveness restarts; readiness gates traffic.
  if (!cr.startupDone) {
    const warmedUp = C.clock.seconds() - cr.startedSec >= (c.startupProbe.initialDelaySeconds ?? 0);
    cr.startupDone = warmedUp && probePasses(C, pod, c, c.startupProbe, cr, rt);
    const budget = (c.startupProbe.initialDelaySeconds ?? 0) + (c.startupProbe.failureThreshold ?? 3) * (c.startupProbe.periodSeconds ?? 10);
    if (!cr.startupDone && C.clock.seconds() - cr.startedSec >= budget) {
      C.record(pod, 'Warning', 'Unhealthy', `Startup probe failed: ${probeText(c.startupProbe)}`);
      C.record(pod, 'Normal', 'Killing', `Container ${c.name} failed startup probe, will be restarted`);
      terminate(C, pod, c, cr, { exitCode: 137, reason: 'Error' });
      return afterExit(C, pod, c, cr);
    }
    if (cr.startupDone) cr.readyAt = C.clock.seconds() + (c.readinessProbe?.initialDelaySeconds ?? 0);
    return;
  }
  if (c.livenessProbe && C.clock.seconds() >= cr.readyAt + (c.livenessProbe.initialDelaySeconds ?? 0)) {
    if (probePasses(C, pod, c, c.livenessProbe, cr, rt)) cr.probeFails = 0;
    else {
      cr.probeFails += Math.max(1, Math.round(TICK_SECONDS / (c.livenessProbe.periodSeconds ?? 10)));
      C.record(pod, 'Warning', 'Unhealthy', `Liveness probe failed: ${probeText(c.livenessProbe)}`);
      if (cr.probeFails >= (c.livenessProbe.failureThreshold ?? 3)) {
        C.record(pod, 'Normal', 'Killing', `Container ${c.name} failed liveness probe, will be restarted`);
        cr.hung = false;
        terminate(C, pod, c, cr, { exitCode: 137, reason: 'Error' });
        cr.last = { exitCode: 137, reason: 'Error', startedAt: cr.startedAt, finishedAt: cr.finishedAt };
        cr.prevLogs = cr.logs;
        cr.restarts += 1;
        return startContainer(C, pod, c, cr, rt);
      }
    }
  }
  const readyByTime = C.clock.seconds() >= cr.readyAt;
  const ready = readyByTime && probePasses(C, pod, c, c.readinessProbe, cr, rt);
  if (!ready && readyByTime && c.readinessProbe && cr.ready !== false) C.record(pod, 'Warning', 'Unhealthy', `Readiness probe failed: ${probeText(c.readinessProbe)}`);
  cr.ready = ready;
};

const probeText = (p) => (p.httpGet ? `Get "http://10.244.0.0:${p.httpGet.port}${p.httpGet.path || '/'}": dial tcp: connect: connection refused` : p.tcpSocket ? `dial tcp :${p.tcpSocket.port}: connect: connection refused` : 'command terminated with non-zero exit code');

// ---------- per-pod progress ----------
const pullImage = (C, pod, c, cr, rt) => {
  const node = pod.spec.nodeName;
  const cache = C.imageCache.get(node) || new Set();
  C.imageCache.set(node, cache);
  const { repo, tag } = parseImage(c.image);
  const key = `${repo}:${tag}`;
  if (!imageInfo(c.image)) {
    const pulls = (rt.pullTicks[c.name] = (rt.pullTicks[c.name] || 0) + 1);
    cr.reason = pulls % 2 ? 'ErrImagePull' : 'ImagePullBackOff';
    cr.message = pulls % 2 ? `failed to pull and unpack image "docker.io/library/${key}": failed to resolve reference "docker.io/library/${key}": docker.io/library/${key}: not found` : `Back-off pulling image "${c.image}"`;
    C.record(pod, pulls % 2 ? 'Normal' : 'Warning', pulls % 2 ? 'Pulling' : 'BackOff', pulls % 2 ? `Pulling image "${c.image}"` : `Back-off pulling image "${c.image}"`);
    if (pulls % 2) C.record(pod, 'Warning', 'Failed', `Failed to pull image "${c.image}": rpc error: code = NotFound desc = ${cr.message}`);
    return false;
  }
  if (cache.has(key) && c.imagePullPolicy !== 'Always') {
    C.record(pod, 'Normal', 'Pulled', `Container image "${c.image}" already present on machine`);
    return true;
  }
  if (!rt.pullTicks[c.name]) {
    rt.pullTicks[c.name] = 1;
    C.record(pod, 'Normal', 'Pulling', `Pulling image "${c.image}"`);
    if (!cache.has(key)) return false; // the first pull takes one tick
  }
  cache.add(key);
  C.record(pod, 'Normal', 'Pulled', `Successfully pulled image "${c.image}" in 2.41s (2.41s including waiting). Image size: 72099501 bytes.`);
  return true;
};

const progressContainer = (C, pod, c, rt) => {
  const cr = crt(rt, c.name);
  if (cr.state === 'running') return runContainer(C, pod, c, cr, rt);
  if (cr.state === 'terminated') return;
  if (cr.reason === 'CrashLoopBackOff') {
    if (--cr.backoffLeft > 0) return;
    return startContainer(C, pod, c, cr, rt);
  }
  const configError = missingEnvRef(C, pod, c);
  if (configError && cr.pulled) {
    cr.reason = 'CreateContainerConfigError';
    cr.message = configError;
    C.record(pod, 'Warning', 'Failed', `Error: ${configError}`);
    return;
  }
  if (!cr.pulled) {
    cr.pulled = pullImage(C, pod, c, cr, rt);
    if (!cr.pulled) return;
    if (configError) return progressContainer(C, pod, c, rt);
  }
  startContainer(C, pod, c, cr, rt);
};

const runInitContainers = (C, pod, rt) => {
  const inits = pod.spec.initContainers || [];
  while (rt.init < inits.length) {
    const c = inits[rt.init];
    const cr = crt(rt, c.name);
    if (c.restartPolicy === 'Always') { // native sidecar: start it and move on
      if (cr.state !== 'running') progressContainer(C, pod, c, rt);
      if (cr.state !== 'running') return false;
      cr.ready = true;
      rt.init++;
      continue;
    }
    if (cr.state === 'terminated' && cr.exitCode === 0) { rt.init++; continue; }
    if (cr.state === 'terminated' && cr.exitCode !== 0) {
      if (pod.spec.restartPolicy === 'Never') return false;
      afterExit(C, pod, c, cr);
      return false;
    }
    progressContainer(C, pod, c, rt);
    return false;
  }
  return true;
};

const setPhase = (C, pod, rt) => {
  const all = pod.spec.containers.map((c) => crt(rt, c.name));
  const inits = pod.spec.initContainers || [];
  const initDone = rt.init >= inits.length;
  const terminated = all.every((cr) => cr.state === 'terminated');
  const phase = !initDone ? (inits.some((c) => crt(rt, c.name).state === 'terminated' && crt(rt, c.name).exitCode !== 0) && pod.spec.restartPolicy === 'Never' ? 'Failed' : 'Pending')
    : terminated ? (all.every((cr) => cr.exitCode === 0) ? 'Succeeded' : 'Failed')
      : all.some((cr) => cr.state === 'running' || cr.restarts > 0) ? 'Running' : 'Pending';
  pod.status.phase = phase;
  if (phase !== 'Pending' && !pod.status.startTime) pod.status.startTime = C.clock.iso();
  const ready = phase === 'Running' && all.every((cr) => cr.ready);
  C.setCondition(pod, 'Initialized', initDone ? 'True' : 'False');
  C.setCondition(pod, 'ContainersReady', ready ? 'True' : 'False');
  C.setCondition(pod, 'Ready', ready ? 'True' : 'False');
  if (inits.length) pod.status.initContainerStatuses = [];
  inits.forEach((c) => {
    const cr = crt(rt, c.name);
    const list = pod.status.containerStatuses;
    writeStatus(C, pod, c, cr);
    pod.status.initContainerStatuses.push(list.pop());
  });
  pod.spec.containers.forEach((c) => writeStatus(C, pod, c, crt(rt, c.name)));
};

const progressPod = (C, pod) => {
  const rt = rtOf(C, pod);
  if (!pod.status.podIP) pod.status.podIP = C.allocPodIp(pod.spec.nodeName);
  pod.status.podIPs = [{ ip: pod.status.podIP }];
  if (['Succeeded', 'Failed'].includes(pod.status.phase)) return;
  const volumeProblem = missingVolume(C, pod);
  if (volumeProblem) {
    pod.spec.containers.forEach((c) => Object.assign(crt(rt, c.name), { state: 'waiting', reason: 'ContainerCreating' }));
    C.record(pod, 'Warning', 'FailedMount', volumeProblem);
  } else if (runInitContainers(C, pod, rt)) {
    pod.spec.containers.forEach((c) => progressContainer(C, pod, c, rt));
  }
  setPhase(C, pod, rt);
};

const finishTermination = (C, pod) => {
  const rt = rtOf(C, pod);
  rt.terminatingTicks = (rt.terminatingTicks || 0) + 1;
  const grace = pod.metadata.deletionGracePeriodSeconds ?? 30;
  // Well-behaved apps exit on SIGTERM within a tick; crash/loop images use the full grace period.
  const needed = grace === 0 ? 0 : behaviourOf(pod.spec.containers[0]).loop ? Math.ceil(grace / TICK_SECONDS) : 1;
  if (rt.terminatingTicks >= needed) {
    C.rt.delete(pod.metadata.uid);
    C.store.remove(pod);
  }
};

/** One kubelet heartbeat on every node. */
export const kubeletTick = (C) => {
  const nodesUp = new Map(C.nodes().map((n) => [n.metadata.name, C.nodePower.get(n.metadata.name) !== false]));
  C.store.list(C.def('pod')).forEach((pod) => {
    if (!pod.spec.nodeName) return;
    if (!nodesUp.get(pod.spec.nodeName)) return; // a dead node reports nothing
    if (pod.metadata.deletionTimestamp) return finishTermination(C, pod);
    progressPod(C, pod);
    C.store.update(pod);
  });

  // Node lifecycle: pods on nodes that stopped reporting are evicted after the toleration time.
  C.nodeDownSince?.forEach((since, name) => {
    if (C.clock.seconds() - since < NODE_EVICTION_TICKS * TICK_SECONDS) return;
    C.podsOn(name).filter((p) => !p.metadata.deletionTimestamp && !p.metadata.ownerReferences?.some((r) => r.kind === 'DaemonSet')).forEach((p) => {
      C.record(p, 'Normal', 'TaintManagerEviction', `Marking for deletion Pod ${p.metadata.namespace}/${p.metadata.name}`, 'taint-eviction-controller');
      C.delete(p);
    });
  });
};

/** Lines `kubectl logs` prints for a container (previous = the last crashed instance). */
export const containerLogs = (C, pod, name, { previous = false } = {}) => {
  const cr = C.rt.get(pod.metadata.uid)?.containers?.[name];
  if (!cr) return null;
  return previous ? (cr.restarts ? cr.prevLogs : null) : cr.logs;
};

export const runtimeOf = (C, pod) => rtOf(C, pod);
export const containerRuntime = (C, pod, name) => crt(rtOf(C, pod), name);
