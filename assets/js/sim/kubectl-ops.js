// kubectl day-two commands: rollout, logs, exec, port-forward, cp, debug, top, cordon/drain,
// taint, wait, events, auth, config, cluster-info, version, api-resources and explain.
import { CommandError, parseArgs, flagSpec } from './util.js';
import { apiVersionOf, parseSelector, matchesSelector, randSuffix, humanAge, clone, parseCpu, parseMem } from './api.js';
import { K8S_VERSION } from './data.js';
import { containerLogs } from './kubelet.js';
import { podCpuUsage } from './controllers.js';
import { runInContainer } from './podshell.js';
import { parseTargets, typeDef, slashName, authorize, identity, forbidden, printObjects } from './kubectl.js';
import { renderJsonPath } from './printers.js';
import { toYaml } from './yaml.js';
import { EXPLAIN_DOCS } from './explain.js';

const pad = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)) + 3);
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c ?? '') : String(c ?? '').padEnd(widths[i]))).join('').trimEnd());
};
const revisionOf = (rs) => Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0);
const ROLLABLE = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

export const opsCommands = (E) => {
  const { C } = E;
  const nsOf = (g) => g.namespace || E.namespace();
  const mustFind = (def, ns, name) => C.store.get(def, def.namespaced ? ns : null, name) || (() => { throw new CommandError(`Error from server (NotFound): ${def.resource}${def.group ? `.${def.group}` : ''} "${name}" not found`, 'NOT_FOUND'); })();
  const check = (g, verb, resource, ns, name) => {
    const id = identity(E, g);
    if (!id.admin && !authorize(C, id, verb, resource, ns, name)) throw forbidden(id, verb, C.def(resource.split('/')[0]), ns, name);
  };
  const oneTarget = (g, pos, allowed) => {
    const targets = parseTargets(C, pos);
    if (targets.length !== 1 || targets[0].names.length !== 1) throw new CommandError('error: you must provide exactly one resource (TYPE/NAME)', 'ARGS');
    const { def, names: [name] } = targets[0];
    if (allowed && !allowed.has(def.kind)) throw new CommandError(`error: no rollbacker has been implemented for "${def.kind}"`, 'ARGS');
    return { def, obj: mustFind(def, nsOf(g), name) };
  };

  /** "deploy/web", "web" (a pod), "job/pi", "svc/web" → a pod (and the controller it came from). */
  const podFor = (g, ref, { running = false } = {}) => {
    const ns = nsOf(g);
    if (!ref.includes('/')) return mustFind(C.def('pod'), ns, ref);
    const [type, name] = ref.split('/');
    const def = typeDef(C, type);
    if (def.kind === 'Pod') return mustFind(def, ns, name);
    const owner = mustFind(def, ns, name);
    const selector = def.kind === 'Service' ? { matchLabels: owner.spec.selector } : owner.spec.selector;
    const pods = C.store.list(C.def('pod'), ns).filter((p) => matchesSelector(p.metadata.labels, selector) && !p.metadata.deletionTimestamp)
      .sort((a, b) => (b.status.phase === 'Running') - (a.status.phase === 'Running') || a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp));
    if (!pods.length) throw new CommandError(`error: no pods found for ${type}/${name}`, 'NO_PODS');
    return running ? pods.find((p) => p.status.phase === 'Running') || pods[0] : pods[0];
  };
  const containerOf = (pod, name, out) => {
    if (name) {
      const c = [...pod.spec.containers, ...(pod.spec.initContainers || []), ...(pod.spec.ephemeralContainers || [])].find((x) => x.name === name);
      if (!c) throw new CommandError(`error: container ${name} is not valid for pod ${pod.metadata.name}`, 'NO_CONTAINER');
      return c;
    }
    if (pod.spec.containers.length > 1) out?.push(`Defaulted container "${pod.spec.containers[0].name}" out of: ${pod.spec.containers.map((c) => c.name).join(', ')}`);
    return pod.spec.containers[0];
  };
  const waitingError = (pod, c) => {
    const st = [...(pod.status.containerStatuses || []), ...(pod.status.initContainerStatuses || [])].find((s) => s.name === c.name);
    const reason = st?.state?.waiting?.reason || (pod.spec.nodeName ? 'ContainerCreating' : 'PodInitializing');
    const why = { ImagePullBackOff: 'trying and failing to pull image', ErrImagePull: 'trying and failing to pull image', CreateContainerConfigError: st?.state?.waiting?.message }[reason] || reason;
    return new CommandError(`Error from server (BadRequest): container "${c.name}" in pod "${pod.metadata.name}" is waiting to start: ${why}`, 'BAD_REQUEST');
  };

  // ---------- rollout ----------
  const rolloutStatus = (g, { def, obj }) => {
    const out = [];
    const name = obj.metadata.name;
    const step = () => {
      C.settle();
      if (def.kind === 'Deployment') {
        const s = obj.status, want = obj.spec.replicas;
        if (s.conditions?.some((c) => c.reason === 'ProgressDeadlineExceeded')) throw new CommandError([...out, `error: deployment "${name}" exceeded its progress deadline`].join('\n'), 'DEADLINE');
        if ((s.updatedReplicas || 0) < want) return `Waiting for deployment "${name}" rollout to finish: ${s.updatedReplicas || 0} out of ${want} new replicas have been updated...`;
        if ((s.replicas || 0) > (s.updatedReplicas || 0)) return `Waiting for deployment "${name}" rollout to finish: ${s.replicas - s.updatedReplicas} old replicas are pending termination...`;
        if ((s.availableReplicas || 0) < want) return `Waiting for deployment "${name}" rollout to finish: ${s.availableReplicas || 0} of ${want} updated replicas are available...`;
        return null;
      }
      if (def.kind === 'StatefulSet') {
        const s = obj.status;
        if ((s.readyReplicas || 0) < obj.spec.replicas) return `Waiting for ${obj.spec.replicas - (s.readyReplicas || 0)} pods to be ready...`;
        if ((s.updatedReplicas || 0) < obj.spec.replicas - (obj.spec.updateStrategy.rollingUpdate?.partition || 0)) return `Waiting for partitioned roll out to finish: ${s.updatedReplicas || 0} out of ${obj.spec.replicas} new pods have been updated...`;
        return null;
      }
      const s = obj.status;
      if ((s.updatedNumberScheduled || 0) < (s.desiredNumberScheduled || 0)) return `Waiting for daemon set "${name}" rollout to finish: ${s.updatedNumberScheduled || 0} out of ${s.desiredNumberScheduled} new pods have been updated...`;
      if ((s.numberAvailable || 0) < (s.desiredNumberScheduled || 0)) return `Waiting for daemon set "${name}" rollout to finish: ${s.numberAvailable || 0} of ${s.desiredNumberScheduled} updated pods are available...`;
      return null;
    };
    let stalled = 0, last = null;
    for (let i = 0; i < 30; i++) {
      const msg = step();
      if (!msg) break;
      if (msg !== last) out.push(msg); else stalled++;
      last = msg;
      // A rollout stuck on broken pods would wait for the full progress deadline; skip ahead.
      if (stalled >= 5 && def.kind === 'Deployment') C.deployProgress.set(obj.metadata.uid, { since: -1e9, ready: null });
      C.tick();
    }
    if (step()) throw new CommandError([...out, 'error: timed out waiting for the condition'].join('\n'), 'TIMEOUT');
    const done = { Deployment: `deployment "${name}" successfully rolled out`, StatefulSet: `statefulset rolling update complete ${obj.spec.replicas} pods at revision ${obj.status.updateRevision}...`, DaemonSet: `daemon set "${name}" successfully rolled out` }[def.kind];
    return [...out, done];
  };

  const history = (g, { def, obj }, revision) => {
    if (def.kind !== 'Deployment') return [`${slashName(def, obj.metadata.name)}`, 'REVISION  CHANGE-CAUSE', '1         <none>'];
    const rsList = C.ownedBy(obj, 'replicaset').sort((a, b) => revisionOf(a) - revisionOf(b));
    if (revision) {
      const rs = rsList.find((r) => revisionOf(r) === Number(revision));
      if (!rs) throw new CommandError(`error: unable to find the specified revision`, 'REVISION');
      return [`${slashName(def, obj.metadata.name)} with revision #${revision}`, 'Pod Template:', `  Labels:       ${Object.entries(rs.spec.template.metadata.labels).map(([k, v]) => `${k}=${v}`).join('\n                ')}`, ...(rs.metadata.annotations?.['kubernetes.io/change-cause'] ? [`  Annotations:  kubernetes.io/change-cause: ${rs.metadata.annotations['kubernetes.io/change-cause']}`] : []), '  Containers:', ...rs.spec.template.spec.containers.flatMap((c) => [`   ${c.name}:`, `    Image:      ${c.image}`, `    Port:       ${(c.ports || []).map((p) => `${p.containerPort}/TCP`).join(', ') || '<none>'}`])];
    }
    return [`${slashName(def, obj.metadata.name)} `, ...pad([['REVISION', 'CHANGE-CAUSE'], ...rsList.map((r) => [revisionOf(r), r.metadata.annotations?.['kubernetes.io/change-cause'] || '<none>'])]), ''];
  };

  const undo = (g, { def, obj }, toRevision) => {
    if (def.kind !== 'Deployment') throw new CommandError(`error: rollback is only simulated for deployments`, 'ARGS');
    const rsList = C.ownedBy(obj, 'replicaset').sort((a, b) => revisionOf(b) - revisionOf(a));
    const target = toRevision ? rsList.find((r) => revisionOf(r) === Number(toRevision)) : rsList[1];
    if (!target) throw new CommandError(toRevision ? `error: unable to find specified revision ${toRevision} in history` : `error: no rollout history found for deployment "${obj.metadata.name}"`, 'REVISION');
    if (target === rsList[0]) return [`${slashName(def, obj.metadata.name)} skipped rollback (current template already matches revision ${toRevision})`];
    const template = clone(target.spec.template);
    delete template.metadata.labels['pod-template-hash'];
    obj.spec.template = template;
    if (target.metadata.annotations?.['kubernetes.io/change-cause']) obj.metadata.annotations = { ...obj.metadata.annotations, 'kubernetes.io/change-cause': target.metadata.annotations['kubernetes.io/change-cause'] };
    C.store.update(obj, { specChanged: true });
    C.record(obj, 'Normal', 'DeploymentRollback', `Rolled back deployment "${obj.metadata.name}" to revision ${revisionOf(target)}`, 'deployment-controller');
    C.settle();
    return [`${slashName(def, obj.metadata.name)} rolled back`];
  };

  const rollout = (g, args) => {
    const [sub, ...rest] = args;
    const p = parseArgs(rest, flagSpec('watch:w', 'revision to-revision timeout selector:l'), { command: `kubectl rollout ${sub}` });
    const t = oneTarget(g, p.pos, ROLLABLE);
    check(g, sub === 'status' || sub === 'history' ? 'get' : 'patch', t.def.resource, nsOf(g), t.obj.metadata.name);
    const name = slashName(t.def, t.obj.metadata.name);
    const SUBS = {
      status: () => rolloutStatus(g, t),
      history: () => history(g, t, p.get('revision')),
      undo: () => undo(g, t, p.get('to-revision')),
      restart: () => {
        if (t.obj.spec.paused) throw new CommandError(`error: ${name.split('/')[0]}s/${t.obj.metadata.name} can't restart paused deployment (run rollout resume first)`, 'PAUSED');
        t.obj.spec.template.metadata = { ...t.obj.spec.template.metadata, annotations: { ...t.obj.spec.template.metadata?.annotations, 'kubectl.kubernetes.io/restartedAt': C.clock.iso() } };
        C.store.update(t.obj, { specChanged: true });
        C.settle();
        return [`${name} restarted`];
      },
      pause: () => { if (t.obj.spec.paused) return [`${name} already paused`]; t.obj.spec.paused = true; C.store.update(t.obj, { specChanged: true }); C.settle(); return [`${name} paused`]; },
      resume: () => { if (!t.obj.spec.paused) throw new CommandError(`error: ${t.def.resource}/${t.obj.metadata.name} is not paused`, 'NOT_PAUSED'); delete t.obj.spec.paused; C.store.update(t.obj, { specChanged: true }); C.settle(); return [`${name} resumed`]; },
    };
    if (!SUBS[sub]) throw new CommandError(`error: unknown command "${sub}" for "kubectl rollout"\nAvailable: history, pause, restart, resume, status, undo`, 'ARGS');
    return SUBS[sub]();
  };

  // ---------- logs ----------
  const logs = (g, args) => {
    const p = parseArgs(args, flagSpec('follow:f previous:p all-containers timestamps prefix ignore-errors', 'container:c tail since since-time selector:l limit-bytes max-log-requests pod-running-timeout'), { command: 'kubectl logs' });
    const ns = nsOf(g);
    const pods = p.get('selector') ? C.store.list(C.def('pod'), ns).filter((x) => matchesSelector(x.metadata.labels, parseSelector(p.get('selector')))) : [podFor(g, p.pos[0] || (() => { throw new CommandError('error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\nPOD or TYPE/NAME is a required argument for the logs command', 'ARGS'); })())];
    if (!pods.length) return ['No resources found in ' + ns + ' namespace.'];
    pods.forEach((pod) => check(g, 'get', 'pods/log', ns, pod.metadata.name));
    const tail = p.get('tail') != null ? Number(p.get('tail')) : (p.get('selector') ? 10 : -1);
    const out = [];
    const linesFor = (pod) => {
      const ctrs = p.has('all-containers') ? pod.spec.containers : [containerOf(pod, p.get('container'), p.get('selector') ? null : out)];
      return ctrs.flatMap((c) => {
        const lines = containerLogs(C, pod, c.name, { previous: p.has('previous') });
        if (lines == null) {
          if (p.has('previous')) throw new CommandError(`Error from server (BadRequest): previous terminated container "${c.name}" in pod "${pod.metadata.name}" not found`, 'BAD_REQUEST');
          throw waitingError(pod, c);
        }
        const st = pod.status.containerStatuses?.find((s) => s.name === c.name);
        if (!p.has('previous') && st?.state?.waiting && !st.restartCount) throw waitingError(pod, c);
        const picked = tail >= 0 ? lines.slice(-tail || lines.length) : lines;
        const prefix = p.has('prefix') || pods.length > 1 || p.has('all-containers') ? `[pod/${pod.metadata.name}/${c.name}] ` : '';
        return (tail === 0 ? [] : picked).map((l) => `${prefix}${p.has('timestamps') ? `${C.clock.iso()} ` : ''}${l}`);
      });
    };
    pods.forEach((pod) => out.push(...linesFor(pod)));
    if (!p.has('follow')) return out;
    const seen = new Map(pods.map((pod) => [pod.metadata.uid, pod.spec.containers.map((c) => (containerLogs(C, pod, c.name) || []).length)]));
    for (let i = 0; i < 3; i++) {
      C.tick();
      pods.forEach((pod) => pod.spec.containers.forEach((c, j) => {
        const lines = containerLogs(C, pod, c.name) || [];
        out.push(...lines.slice(seen.get(pod.metadata.uid)[j]));
        seen.get(pod.metadata.uid)[j] = lines.length;
      }));
    }
    return [...out, '^C  (the simulator stops following after 30 seconds of simulated time)'];
  };

  // ---------- exec / attach ----------
  const exec = (g, args) => {
    const dash = args.indexOf('--');
    const p = parseArgs(dash >= 0 ? args.slice(0, dash) : args, flagSpec('stdin:i tty:t quiet:q', 'container:c filename:f pod-running-timeout'), { command: 'kubectl exec' });
    const cmd = dash >= 0 ? args.slice(dash + 1) : p.pos.slice(1);
    if (dash < 0 && p.pos.length > 1) throw new CommandError(`error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead`, 'ARGS');
    if (!p.pos[0]) throw new CommandError('error: pod, type/name or --filename must be specified', 'ARGS');
    if (!cmd.length) throw new CommandError('error: you must specify at least one command for the container', 'ARGS');
    const pod = podFor(g, p.pos[0], { running: true });
    check(g, 'create', 'pods/exec', nsOf(g), pod.metadata.name);
    const notes = [];
    const c = containerOf(pod, p.get('container'), notes);
    if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') throw new CommandError('error: cannot exec into a container in a completed pod; current phase is ' + pod.status.phase, 'COMPLETED');
    const st = pod.status.containerStatuses?.find((s) => s.name === c.name);
    if (!st?.state?.running) throw new CommandError(`error: unable to upgrade connection: container not found ("${c.name}")`, 'NOT_RUNNING');
    const shell = /^(\/bin\/)?(sh|bash|ash)$/.test(cmd[0]) && cmd.length === 1;
    if (shell && p.has('stdin')) {
      if (cmd[0].endsWith('bash') && !/^(nginx|httpd|postgres|redis|mysql|perl|kubelab|bitnami)/.test(c.image)) throw new CommandError(`error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${randSuffix(12)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "bash": executable file not found in $PATH: unknown`, 'NO_BASH');
      E.enterShell(pod, c, { tty: p.has('tty') });
      return notes;
    }
    const line = cmd.length === 3 && /sh$/.test(cmd[0]) && cmd[1] === '-c' ? cmd[2] : cmd.map((a) => (/[\s;&|$]/.test(a) ? `'${a}'` : a)).join(' ');
    const r = runInContainer(C, pod, c, line, { forwards: E.forwards });
    C.settle();
    if (r.code) throw new CommandError([...notes, ...r.lines, `command terminated with exit code ${r.code}`].join('\n'), 'EXIT');
    return [...notes, ...r.lines];
  };

  // ---------- port-forward / cp ----------
  const portForward = (g, args) => {
    const p = parseArgs(args, flagSpec('', 'address pod-running-timeout'), { command: 'kubectl port-forward' });
    const [ref, ...specs] = p.pos;
    if (!ref || !specs.length) throw new CommandError('error: TYPE/NAME and list of ports are required for port-forward', 'ARGS');
    const pod = podFor(g, ref, { running: true });
    check(g, 'create', 'pods/portforward', nsOf(g), pod.metadata.name);
    if (pod.status.phase !== 'Running') throw new CommandError(`error: unable to forward port because pod is not running. Current status=${pod.status.phase}`, 'NOT_RUNNING');
    const [type, name] = ref.includes('/') ? ref.split('/') : ['pod', ref];
    const svc = /^(svc|service|services)$/.test(type) ? mustFind(C.def('service'), nsOf(g), name) : null;
    const out = [];
    specs.forEach((s) => {
      const [local, remoteRaw] = s.startsWith(':') ? [String(10000 + Math.floor(Math.random() * 50000)), s.slice(1)] : s.split(':');
      let remote = Number(remoteRaw ?? local);
      if (svc) { const sp = svc.spec.ports.find((x) => x.port === remote || x.name === remoteRaw); if (!sp) throw new CommandError(`error: Service ${name} does not have a service port ${remoteRaw ?? local}`, 'NO_PORT'); remote = typeof sp.targetPort === 'number' ? sp.targetPort : pod.spec.containers.flatMap((c) => c.ports || []).find((x) => x.name === sp.targetPort)?.containerPort; }
      const localPort = Number(local);
      if (E.forwards.some((f) => f.localPort === localPort)) throw new CommandError(`Unable to listen on port ${localPort}: Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:${localPort}: bind: address already in use]\nerror: unable to listen on any of the requested ports: [{${localPort} ${remote}}]`, 'IN_USE');
      E.forwards.push({ localPort, remotePort: remote, ns: nsOf(g), pod: pod.metadata.name, id: E.forwards.length + 1, label: `kubectl port-forward ${ref} ${s}` });
      out.push(`Forwarding from 127.0.0.1:${localPort} -> ${remote}`, `Forwarding from [::1]:${localPort} -> ${remote}`);
    });
    return [...out, `# (simulator: the forward keeps running in the background — curl localhost:${specs[0].split(':')[0]} · list with 'jobs' · stop with 'kill %${E.forwards.length}')`];
  };

  const cp = (g, args) => {
    const p = parseArgs(args, flagSpec('no-preserve', 'container:c retries'), { command: 'kubectl cp' });
    const [src, dst] = p.pos;
    if (!src || !dst) throw new CommandError('error: source and destination are required', 'ARGS');
    const remote = (s) => /^[\w.-]+(\/[\w.-]+)?:/.test(s) && !s.startsWith('/') ? { pod: s.slice(0, s.indexOf(':')).split('/').pop(), ns: s.includes('/') && s.indexOf('/') < s.indexOf(':') ? s.split('/')[0] : nsOf(g), path: s.slice(s.indexOf(':') + 1) } : null;
    const r = remote(src) || remote(dst);
    if (!r) throw new CommandError('error: one of src or dest must be a remote file specification', 'ARGS');
    const pod = mustFind(C.def('pod'), r.ns, r.pod);
    const c = containerOf(pod, p.get('container'));
    const fsRun = (line) => runInContainer(C, pod, c, line);
    if (remote(dst)) {
      const content = E.files.read(src);
      if (content == null) throw new CommandError(`error: ${src} doesn't exist in local filesystem`, 'NO_FILE');
      const target = r.path.endsWith('/') ? `${r.path}${src.split('/').pop()}` : r.path;
      const rt = C.rt.get(pod.metadata.uid);
      rt.fs[c.name] ||= {};
      const res = fsRun(`touch ${target}`);
      if (res.code) throw new CommandError(`error: ${res.lines[0]}`, 'READ_ONLY');
      rt.fs[c.name][target] = content;
      return [];
    }
    const res = fsRun(`cat ${r.path}`);
    if (res.code) throw new CommandError(`error: ${r.path}: No such file or directory`, 'NO_FILE');
    E.files.write(dst, `${res.lines.join('\n')}\n`);
    return ['tar: removing leading \'/\' from member names'];
  };

  // ---------- debug ----------
  const debug = (g, args) => {
    const dash = args.indexOf('--');
    const p = parseArgs(dash >= 0 ? args.slice(0, dash) : args, flagSpec('stdin:i tty:t share-processes attach quiet:q keep-labels same-node', 'image target container:c copy-to set-image profile env'), { command: 'kubectl debug' });
    const cmd = dash >= 0 ? args.slice(dash + 1) : [];
    const ref = p.pos[0];
    if (!ref) throw new CommandError('error: one of the POD or node/NODE is required', 'ARGS');
    const image = p.get('image', 'busybox:1.37');
    if (/^(node|nodes|no)\//.test(ref)) {
      const node = mustFind(C.def('node'), null, ref.split('/')[1]);
      const name = `node-debugger-${node.metadata.name}-${randSuffix(5)}`;
      const pod = C.create({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: nsOf(g) }, spec: { nodeName: node.metadata.name, hostPID: true, hostNetwork: true, restartPolicy: 'Never', tolerations: [{ operator: 'Exists' }], volumes: [{ name: 'host-root', hostPath: { path: '/' } }], containers: [{ name: 'debugger', image, stdin: true, tty: true, volumeMounts: [{ name: 'host-root', mountPath: '/host' }] }] } });
      C.settle();
      C.tickUntil(() => pod.status.phase === 'Running', 4);
      const hostStore = C.volumeData.get(`host:${node.metadata.name}:/`) || new Map();
      C.volumeData.set(`host:${node.metadata.name}:/`, hostStore);
      hostStore.set('etc/kubernetes/kubelet.conf', 'apiVersion: v1\nkind: Config\n…\n');
      hostStore.set('var/log/syslog', `Nov 16 09:00:00 ${node.metadata.name} kubelet[612]: I1116 "SyncLoop UPDATE" source="api"\n`);
      if (p.has('stdin')) E.enterShell(pod, pod.spec.containers[0], { tty: true, rmOnExit: false });
      return [`Creating debugging pod ${name} with container debugger on node ${node.metadata.name}.`, ...(p.has('stdin') ? ['If you don\'t see a command prompt, try pressing enter.', '# the node\'s file system is mounted at /host'] : [])];
    }
    const pod = podFor(g, ref);
    if (p.get('copy-to')) {
      const copy = clone(pod);
      const copyName = p.get('copy-to');
      const spec = copy.spec;
      delete spec.nodeName;
      if (p.has('share-processes')) spec.shareProcessNamespace = true;
      if (p.get('set-image')) p.get('set-image').split(',').forEach((pair) => { const [cn, img] = pair.split('='); spec.containers.filter((c) => cn === '*' || c.name === cn).forEach((c) => { c.image = img; }); });
      const debugName = p.get('container') || `debugger-${randSuffix(5)}`;
      if (p.get('image') && !spec.containers.some((c) => c.name === debugName)) spec.containers.push({ name: debugName, image, stdin: true, tty: true, ...(cmd.length ? { command: cmd } : {}) });
      if (cmd.length && p.get('container') && !p.get('image')) spec.containers.forEach((c) => { if (c.name === p.get('container')) c.command = cmd; });
      const created = C.create({ apiVersion: 'v1', kind: 'Pod', metadata: { name: copyName, namespace: pod.metadata.namespace, labels: p.has('keep-labels') ? pod.metadata.labels : undefined }, spec });
      C.settle();
      C.tickUntil(() => created.status.phase !== 'Pending', 4);
      const target = spec.containers.find((c) => c.name === (p.get('container') || debugName)) || spec.containers[0];
      if (p.has('stdin')) E.enterShell(created, target, { tty: true });
      return p.has('stdin') ? ['If you don\'t see a command prompt, try pressing enter.'] : [`pod/${copyName} created`];
    }
    const name = p.get('container') || `debugger-${randSuffix(5)}`;
    const target = p.get('target');
    const eph = { name, image, stdin: p.has('stdin'), tty: p.has('tty'), ...(target ? { targetContainerName: target } : {}), ...(cmd.length ? { command: cmd } : {}) };
    pod.spec.ephemeralContainers = [...(pod.spec.ephemeralContainers || []), eph];
    pod.status.ephemeralContainerStatuses = [...(pod.status.ephemeralContainerStatuses || []), { name, image, ready: false, restartCount: 0, state: { running: { startedAt: C.clock.iso() } } }];
    C.store.update(pod);
    C.record(pod, 'Normal', 'Started', `Started container ${name}`);
    const out = [...(target ? [`Targeting container "${target}". If you don't see processes from this container it may be because the container runtime doesn't support this feature.`] : []), `Defaulting debug container name to ${name}.`];
    if (p.has('stdin')) { E.enterShell(pod, { ...eph, volumeMounts: [] }, { tty: true }); out.push('If you don\'t see a command prompt, try pressing enter.'); }
    return out;
  };

  // ---------- top ----------
  const metricsUp = () => C.store.list(C.def('pod'), 'kube-system').some((p) => p.metadata.labels?.['k8s-app'] === 'metrics-server' && p.status.phase === 'Running');
  const memOf = (pod) => C.memUsage?.get(pod.metadata.uid) ?? 0;
  const top = (g, args) => {
    const [kind, ...rest] = args;
    const p = parseArgs(rest, flagSpec('containers no-headers use-protocol-buffers', 'selector:l sort-by'), { command: `kubectl top ${kind}` });
    if (!metricsUp()) throw new CommandError('error: Metrics API not available', 'NO_METRICS');
    if (/^(node|nodes|no)$/.test(kind)) {
      const rows = C.nodes().filter((n) => !p.pos[0] || n.metadata.name === p.pos[0]).map((n) => {
        const pods = C.podsOn(n.metadata.name).filter((x) => x.status.phase === 'Running');
        const cpu = 60 + pods.reduce((s, x) => s + podCpuUsage(C, x), 0);
        const mem = 512 + pods.reduce((s, x) => s + memOf(x), 0);
        if (C.nodePower.get(n.metadata.name) === false) return [n.metadata.name, '<unknown>', '<unknown>', '<unknown>', '<unknown>'];
        return [n.metadata.name, `${cpu}m`, `${Math.round((cpu / parseCpu(n.status.allocatable.cpu)) * 100)}%`, `${mem}Mi`, `${Math.round((mem * 1024 ** 2 / parseMem(n.status.allocatable.memory)) * 100)}%`];
      });
      return pad([['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)'], ...rows]);
    }
    if (!/^(pod|pods|po)$/.test(kind)) throw new CommandError(`error: unknown command "${kind}" for "kubectl top"\nAvailable: node, pod`, 'ARGS');
    let pods = C.store.list(C.def('pod'), g.all ? null : nsOf(g)).filter((x) => x.status.phase === 'Running' && (!p.pos[0] || x.metadata.name === p.pos[0]));
    if (p.get('selector')) pods = pods.filter((x) => matchesSelector(x.metadata.labels, parseSelector(p.get('selector'))));
    if (!pods.length) return [`No resources found in ${g.all ? 'any' : nsOf(g)} namespace.`];
    if (p.get('sort-by')) pods.sort((a, b) => (p.get('sort-by') === 'cpu' ? podCpuUsage(C, b) - podCpuUsage(C, a) : memOf(b) - memOf(a)));
    const rows = pods.flatMap((x) => (p.has('containers') ? x.spec.containers.map((c, i) => [...(g.all ? [x.metadata.namespace] : []), x.metadata.name, c.name, `${i ? 1 : podCpuUsage(C, x)}m`, `${i ? 2 : memOf(x)}Mi`]) : [[...(g.all ? [x.metadata.namespace] : []), x.metadata.name, `${podCpuUsage(C, x)}m`, `${memOf(x)}Mi`]]));
    return pad([[...(g.all ? ['NAMESPACE'] : []), ...(p.has('containers') ? ['POD', 'NAME'] : ['NAME']), 'CPU(cores)', 'MEMORY(bytes)'], ...rows]);
  };

  // ---------- nodes: cordon / uncordon / drain / taint ----------
  const setCordon = (node, on) => {
    node.spec.unschedulable = on || undefined;
    const others = (node.spec.taints || []).filter((t) => t.key !== 'node.kubernetes.io/unschedulable');
    node.spec.taints = on ? [...others, { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule', timeAdded: C.clock.iso() }] : others;
    if (!node.spec.taints.length) delete node.spec.taints;
    C.record(node, 'Normal', on ? 'NodeNotSchedulable' : 'NodeSchedulable', `Node ${node.metadata.name} status is now: ${on ? 'NodeNotSchedulable' : 'NodeSchedulable'}`, 'kubelet');
    C.store.update(node);
  };
  const nodesFrom = (g, p) => (p.get('selector') ? C.nodes().filter((n) => matchesSelector(n.metadata.labels, parseSelector(p.get('selector')))) : p.pos.map((n) => mustFind(C.def('node'), null, n.replace(/^(node|nodes|no)\//, ''))));
  const cordon = (on) => (g, args) => {
    const p = parseArgs(args, flagSpec('', 'selector:l dry-run'), { command: `kubectl ${on ? 'cordon' : 'uncordon'}` });
    return nodesFrom(g, p).map((n) => {
      if (!!n.spec.unschedulable === on) return `node/${n.metadata.name} already ${on ? 'cordoned' : 'uncordoned'}`;
      setCordon(n, on);
      C.settle();
      return `node/${n.metadata.name} ${on ? 'cordoned' : 'uncordoned'}`;
    });
  };

  /** The Eviction API: refuses when it would break a PodDisruptionBudget. */
  const evict = (pod) => {
    const pdbs = C.store.list(C.def('pdb'), pod.metadata.namespace).filter((b) => matchesSelector(pod.metadata.labels, b.spec.selector));
    C.settle();
    if (C.isPodReady(pod) && pdbs.some((b) => (b.status.disruptionsAllowed ?? 0) <= 0)) return false;
    C.record(pod, 'Normal', 'Evicted', 'Evicted by the drain', 'eviction-api');
    C.delete(pod);
    pdbs.forEach((b) => { b.status.disruptionsAllowed = Math.max(0, (b.status.disruptionsAllowed || 0) - 1); });
    return true;
  };
  const drain = (g, args) => {
    const p = parseArgs(args, flagSpec('ignore-daemonsets delete-emptydir-data delete-local-data force disable-eviction dry-run', 'grace-period timeout selector:l pod-selector skip-wait-for-delete-timeout'), { command: 'kubectl drain' });
    const out = [];
    for (const node of nodesFrom(g, p)) {
      const name = node.metadata.name;
      if (!node.spec.unschedulable) setCordon(node, true);
      out.push(`node/${name} cordoned`);
      const pods = C.podsOn(name).filter((x) => !x.metadata.deletionTimestamp && !x.metadata.annotations?.['kubernetes.io/config.source']);
      const ds = pods.filter((x) => x.metadata.ownerReferences?.some((r) => r.kind === 'DaemonSet'));
      const bare = pods.filter((x) => !x.metadata.ownerReferences?.length);
      const local = pods.filter((x) => (x.spec.volumes || []).some((v) => v.emptyDir));
      const problems = [
        ...(ds.length && !p.has('ignore-daemonsets') ? [`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${ds.map((x) => `${x.metadata.namespace}/${x.metadata.name}`).join(', ')}`] : []),
        ...(bare.length && !p.has('force') ? [`cannot delete Pods that declare no controller (use --force to override): ${bare.map((x) => `${x.metadata.namespace}/${x.metadata.name}`).join(', ')}`] : []),
        ...(local.length && !p.has('delete-emptydir-data') && !p.has('delete-local-data') ? [`cannot delete Pods with local storage (use --delete-emptydir-data to override): ${local.map((x) => `${x.metadata.namespace}/${x.metadata.name}`).join(', ')}`] : []),
      ];
      if (problems.length) throw new CommandError([...out, `error: unable to drain node "${name}" due to error: [${problems.join(', ')}], continuing command...`, 'There are pending nodes to be drained:', ` ${name}`, ...problems.map((x) => `error: ${x}`)].join('\n'), 'DRAIN');
      if (ds.length) out.push(`Warning: ignoring DaemonSet-managed Pods: ${ds.map((x) => `${x.metadata.namespace}/${x.metadata.name}`).join(', ')}`);
      if (bare.length) out.push(`Warning: deleting Pods that declare no controller: ${bare.map((x) => `${x.metadata.namespace}/${x.metadata.name}`).join(', ')}`);
      let pending = pods.filter((x) => !ds.includes(x));
      pending.forEach((x) => out.push(`evicting pod ${x.metadata.namespace}/${x.metadata.name}`));
      for (let round = 0; round < 12 && pending.length; round++) {
        pending = pending.filter((x) => {
          if (evict(x)) { out.push(`pod/${x.metadata.name} evicted`); return false; }
          out.push(`error when evicting pods/"${x.metadata.name}" -n "${x.metadata.namespace}" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.`);
          return true;
        });
        C.tick();
      }
      if (pending.length) throw new CommandError([...out, `error: unable to drain node "${name}" due to error: global timeout reached: 2m0s, continuing command...`, 'There are pending nodes to be drained:', ` ${name}`].join('\n'), 'TIMEOUT');
      C.tickUntil(() => !C.podsOn(name).some((x) => !ds.includes(x) && pods.includes(x)), 4);
      out.push(`node/${name} drained`);
    }
    return out;
  };

  const taint = (g, args) => {
    const [type, ...rest] = args;
    if (!/^(node|nodes|no)$/.test(type)) throw new CommandError(`error: invalid resource type ${type}, only node types are supported`, 'ARGS');
    const p = parseArgs(rest, flagSpec('overwrite all', 'selector:l'), { command: 'kubectl taint' });
    const specs = p.pos.filter((x) => x.includes(':') || x.endsWith('-'));
    const names = p.pos.filter((x) => !specs.includes(x));
    const nodes = p.has('all') ? C.nodes() : nodesFrom(g, { get: (k) => (k === 'selector' ? p.get('selector') : null), pos: names });
    if (!specs.length) throw new CommandError('error: at least one taint update is required', 'ARGS');
    return nodes.map((node) => {
      let taints = [...(node.spec.taints || [])];
      let removedOnly = true;
      specs.forEach((s) => {
        const remove = s.endsWith('-');
        const body = remove ? s.slice(0, -1) : s;
        const [kv, effect] = body.split(':');
        const [key, value] = kv.split('=');
        if (effect && !['NoSchedule', 'PreferNoSchedule', 'NoExecute'].includes(effect)) throw new CommandError(`error: invalid taint effect: ${effect}, unsupported taint effect`, 'INVALID');
        if (remove) {
          const before = taints.length;
          taints = taints.filter((t) => !(t.key === key && (!effect || t.effect === effect)));
          if (before === taints.length) throw new CommandError(`error: taint "${body}" not found`, 'NOT_FOUND');
          return;
        }
        removedOnly = false;
        if (!effect) throw new CommandError(`error: invalid taint spec: ${s}, unknown taint effect`, 'INVALID');
        const existing = taints.find((t) => t.key === key && t.effect === effect);
        if (existing && !p.has('overwrite')) throw new CommandError(`error: node ${node.metadata.name} already has ${key} taint(s) with same effect(s) and --overwrite is false`, 'EXISTS');
        taints = [...taints.filter((t) => t !== existing), { key, ...(value ? { value } : {}), effect, ...(effect === 'NoExecute' ? { timeAdded: C.clock.iso() } : {}) }];
      });
      node.spec.taints = taints.length ? taints : undefined;
      C.store.update(node);
      // NoExecute evicts running pods that don't tolerate it.
      (node.spec.taints || []).filter((t) => t.effect === 'NoExecute').forEach((t) => C.podsOn(node.metadata.name).filter((x) => !(x.spec.tolerations || []).some((tol) => (tol.operator === 'Exists' && !tol.key) || (tol.key === t.key && (!tol.effect || tol.effect === 'NoExecute')))).forEach((x) => {
        C.record(x, 'Normal', 'TaintManagerEviction', `Marking for deletion Pod ${x.metadata.namespace}/${x.metadata.name}`, 'taint-eviction-controller');
        C.delete(x);
      }));
      C.settle();
      return `node/${node.metadata.name} ${removedOnly ? 'untainted' : 'tainted'}`;
    });
  };

  // ---------- wait ----------
  const wait = (g, args) => {
    const p = parseArgs(args, flagSpec('all', 'for timeout selector:l filename:f'), { command: 'kubectl wait' });
    const cond = p.get('for');
    if (!cond) throw new CommandError('error: --for must be specified', 'ARGS');
    const timeout = /^(\d+)(s|m)?$/.exec(p.get('timeout', '30s'));
    const ticks = Math.min(60, Math.ceil(Number(timeout?.[1] || 30) * (timeout?.[2] === 'm' ? 60 : 1) / 10));
    const ns = nsOf(g);
    const targets = parseTargets(C, p.pos);
    const objs = () => targets.flatMap(({ def, names }) => (names.length ? names.map((n) => ({ def, name: n, obj: C.store.get(def, def.namespaced ? ns : null, n) })) : C.store.list(def, ns).filter((o) => !p.get('selector') || matchesSelector(o.metadata.labels, parseSelector(p.get('selector')))).map((o) => ({ def, name: o.metadata.name, obj: o }))));
    const initial = objs();
    if (!initial.length) throw new CommandError('error: no matching resources found', 'NOT_FOUND');
    const met = ({ def, name }) => {
      const o = C.store.get(def, def.namespaced ? ns : null, name);
      if (cond === 'delete') return !o;
      if (!o) return false;
      if (cond.startsWith('condition=')) {
        const [type, value = 'True'] = cond.slice(10).split('=');
        return (o.status?.conditions || []).some((c) => c.type.toLowerCase() === type.toLowerCase() && c.status.toLowerCase() === value.toLowerCase());
      }
      if (cond.startsWith('jsonpath=')) {
        const expr = cond.slice(9);
        const at = expr.lastIndexOf('=');
        return renderJsonPath(expr.slice(0, at), o).trim() === expr.slice(at + 1);
      }
      if (cond === 'create') return true;
      throw new CommandError(`error: unrecognized condition: "${cond}"`, 'ARGS');
    };
    C.tickUntil(() => initial.every(met), ticks);
    return initial.map((t) => {
      if (!met(t)) throw new CommandError(`error: timed out waiting for the condition on ${t.def.resource}/${t.name}`, 'TIMEOUT');
      return `${slashName(t.def, t.name)} ${cond === 'delete' ? 'condition met' : 'condition met'}`;
    });
  };

  // ---------- events ----------
  const events = (g, args) => {
    const p = parseArgs(args, flagSpec('watch:w no-headers', 'for types output:o'), { command: 'kubectl events' });
    let list = C.store.list(C.def('event'), g.all ? null : nsOf(g));
    if (p.get('for')) {
      const [type, name] = p.get('for').split('/');
      const def = typeDef(C, type);
      list = list.filter((e) => e.involvedObject.kind === def.kind && e.involvedObject.name === name);
    }
    if (p.get('types')) list = list.filter((e) => p.get('types').split(',').includes(e.type));
    list.sort((a, b) => a.lastTimestamp.localeCompare(b.lastTimestamp));
    if (p.get('output')) return printObjects(C, list, p.get('output'));
    if (!list.length) return [`No events found in ${g.all ? 'any' : nsOf(g)} namespace.`];
    return pad([[...(g.all ? ['NAMESPACE'] : []), 'LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], ...list.map((e) => [...(g.all ? [e.metadata.namespace] : []), humanAge(C.clock.now() - Date.parse(e.lastTimestamp)) + (e.count > 1 ? ` (x${e.count} over ${humanAge(C.clock.now() - Date.parse(e.firstTimestamp))})` : ''), e.type, e.reason, `${e.involvedObject.kind}/${e.involvedObject.name}`, e.message])]);
  };

  // ---------- auth ----------
  const auth = (g, args) => {
    const [sub, ...rest] = args;
    const id = identity(E, g);
    if (sub === 'whoami') {
      const p = parseArgs(rest, flagSpec('', 'output:o'), { command: 'kubectl auth whoami' });
      if (p.get('output')) return printObjects(C, [{ apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview', metadata: { creationTimestamp: null }, status: { userInfo: { username: id.user, groups: id.groups } } }], p.get('output'), { single: true });
      return pad([['ATTRIBUTE', 'VALUE'], ['Username', id.user], ['Groups', `[${id.groups.join(' ')}]`]]);
    }
    if (sub !== 'can-i') throw new CommandError(`error: unknown command "${sub}" for "kubectl auth"\nAvailable: can-i, reconcile, whoami`, 'ARGS');
    const p = parseArgs(rest, flagSpec('list quiet:q no-headers', 'subresource'), { command: 'kubectl auth can-i' });
    const ns = g.all ? null : nsOf(g);
    if (p.has('list')) {
      const resources = ['pods', 'pods/log', 'pods/exec', 'services', 'deployments', 'configmaps', 'secrets', 'jobs', 'nodes', 'namespaces'];
      const verbs = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'];
      const rows = resources.map((r) => [C.def(r.split('/')[0]).group ? `${r}.${C.def(r.split('/')[0]).group}` : r, '[]', '[]', `[${verbs.filter((v) => id.admin || authorize(C, id, v, r, ns || 'default')).join(' ')}]`]).filter((r) => r[3] !== '[]');
      return pad([['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], ...(id.admin ? [['*.*', '[]', '[]', '[*]'], ['', '[*]', '[]', '[*]']] : rows)]);
    }
    const [verb, target] = p.pos;
    if (!verb || !target) throw new CommandError('error: you must specify two arguments: verb resource or verb resource/resourceName.', 'ARGS');
    const [resource, name] = target.split('/');
    const def = C.def(resource);
    if (!def && resource !== '*') return [`Warning: the server doesn't have a resource type '${resource}'`, 'no'];
    const full = `${def ? def.resource : resource}${p.get('subresource') ? `/${p.get('subresource')}` : ''}`;
    const ok = id.admin || authorize(C, id, verb, full, ns || 'default', name);
    return [ok ? 'yes' : 'no'];
  };

  // ---------- config ----------
  const kc = E.kubeconfig;
  const config = (g, args) => {
    const [sub, ...rest] = args;
    const p = parseArgs(rest, flagSpec('current minify raw flatten no-headers', 'namespace:n cluster user output:o server'), { command: `kubectl config ${sub}` });
    const ctxRows = () => pad([['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ...Object.entries(kc.contexts).filter(([n]) => !p.pos[0] || n === p.pos[0]).map(([n, c]) => [n === kc.current ? '*' : '', n, c.cluster, c.user, c.namespace || ''])]);
    const SUBS = {
      'current-context': () => [kc.current],
      'get-contexts': () => (p.get('output') === 'name' ? Object.keys(kc.contexts) : ctxRows()),
      'use-context': () => { if (!kc.contexts[p.pos[0]]) throw new CommandError(`error: no context exists with the name: "${p.pos[0]}"`, 'NO_CONTEXT'); kc.current = p.pos[0]; return [`Switched to context "${p.pos[0]}".`]; },
      use: () => SUBS['use-context'](),
      'set-context': () => {
        const name = p.has('current') ? kc.current : p.pos[0];
        if (!name) throw new CommandError('error: you must specify a non-empty context name or --current', 'ARGS');
        const existed = !!kc.contexts[name];
        kc.contexts[name] = { ...(kc.contexts[name] || { cluster: p.get('cluster', 'kind-kubelab'), user: p.get('user', 'kind-kubelab') }), ...(p.get('namespace') != null ? { namespace: p.get('namespace') } : {}), ...(p.get('cluster') ? { cluster: p.get('cluster') } : {}), ...(p.get('user') ? { user: p.get('user') } : {}) };
        return [`Context "${name}" ${existed ? 'modified' : 'created'}.`];
      },
      'get-clusters': () => ['NAME', ...Object.keys(kc.clusters)],
      'get-users': () => ['NAME', ...[...new Set(Object.values(kc.contexts).map((c) => c.user))]],
      'rename-context': () => { const [from, to] = p.pos; if (!kc.contexts[from]) throw new CommandError(`error: cannot rename the context "${from}", it's not in kubeconfig`, 'NO_CONTEXT'); kc.contexts[to] = kc.contexts[from]; delete kc.contexts[from]; if (kc.current === from) kc.current = to; return [`Context "${from}" renamed to "${to}".`]; },
      'delete-context': () => { if (!kc.contexts[p.pos[0]]) throw new CommandError(`error: cannot delete context ${p.pos[0]}, not in kubeconfig`, 'NO_CONTEXT'); delete kc.contexts[p.pos[0]]; return [`deleted context ${p.pos[0]} from ~/.kube/config`]; },
      'set-cluster': () => { kc.clusters[p.pos[0]] = { server: p.get('server', 'https://127.0.0.1:6443') }; return [`Cluster "${p.pos[0]}" set.`]; },
      'set-credentials': () => [`User "${p.pos[0]}" set.`],
      view: () => {
        const ctxNames = p.has('minify') ? [kc.current] : Object.keys(kc.contexts);
        const doc = {
          apiVersion: 'v1', kind: 'Config', preferences: {}, 'current-context': kc.current,
          clusters: [...new Set(ctxNames.map((n) => kc.contexts[n].cluster))].map((n) => ({ name: n, cluster: { server: kc.clusters[n]?.server, 'certificate-authority-data': 'DATA+OMITTED' } })),
          contexts: ctxNames.map((n) => ({ name: n, context: { cluster: kc.contexts[n].cluster, user: kc.contexts[n].user, ...(kc.contexts[n].namespace ? { namespace: kc.contexts[n].namespace } : {}) } })),
          users: [...new Set(ctxNames.map((n) => kc.contexts[n].user))].map((n) => ({ name: n, user: { 'client-certificate-data': p.has('raw') ? 'LS0tLS1CRUdJTi…' : 'DATA+OMITTED', 'client-key-data': p.has('raw') ? 'LS0tLS1CRUdJTi…' : 'DATA+OMITTED' } })),
        };
        if (p.get('output')?.startsWith('jsonpath=')) return renderJsonPath(p.get('output').slice(9), doc).split('\n');
        return toYaml(doc).split('\n');
      },
    };
    if (!SUBS[sub]) throw new CommandError(`error: unknown command "${sub}" for "kubectl config"\nAvailable: current-context, delete-context, get-clusters, get-contexts, get-users, rename-context, set-cluster, set-context, set-credentials, use-context, view`, 'ARGS');
    return SUBS[sub]();
  };

  // ---------- cluster info, versions, discovery, explain ----------
  const clusterInfo = (g, args) => {
    if (args[0] === 'dump') return ['{', '    "kind": "NodeList",', `    "items": [ ${C.nodes().map((n) => `"${n.metadata.name}"`).join(', ')} ]`, '}', '# (the real dump prints every object and log in the cluster — thousands of lines)'];
    return ['Kubernetes control plane is running at https://127.0.0.1:6443', 'CoreDNS is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy', '', 'To further debug and diagnose cluster problems, use \'kubectl cluster-info dump\'.'];
  };
  const version = (g, args) => {
    const p = parseArgs(args, flagSpec('client short', 'output:o'), { command: 'kubectl version' });
    const info = { clientVersion: { major: '1', minor: '34', gitVersion: K8S_VERSION, goVersion: 'go1.24.9', platform: 'linux/amd64' }, kustomizeVersion: 'v5.7.1', ...(p.has('client') ? {} : { serverVersion: { major: '1', minor: '34', gitVersion: K8S_VERSION, goVersion: 'go1.24.9', platform: 'linux/amd64' } }) };
    if (p.get('output')) return p.get('output') === 'json' ? JSON.stringify(info, null, 2).split('\n') : toYaml(info).split('\n');
    return [`Client Version: ${K8S_VERSION}`, 'Kustomize Version: v5.7.1', ...(p.has('client') ? [] : [`Server Version: ${K8S_VERSION}`])];
  };
  const apiResources = (g, args) => {
    const p = parseArgs(args, flagSpec('no-headers cached', 'namespaced api-group output:o verbs sort-by categories'), { command: 'kubectl api-resources' });
    let defs = C.store.allKinds().filter((d) => d.kind !== 'Lease' || true);
    if (p.get('namespaced') != null) defs = defs.filter((d) => String(d.namespaced) === String(p.get('namespaced')));
    if (p.get('api-group') != null) defs = defs.filter((d) => d.group === p.get('api-group'));
    defs.sort((a, b) => (a.group === '' ? -1 : 0) - (b.group === '' ? -1 : 0) || a.group.localeCompare(b.group) || a.resource.localeCompare(b.resource));
    if (p.get('output') === 'name') return defs.map((d) => `${d.resource}${d.group ? `.${d.group}` : ''}`);
    return pad([['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], ...defs.map((d) => [d.resource, d.short.join(','), apiVersionOf(d), String(d.namespaced), d.kind])]);
  };
  const apiVersions = () => [...new Set(C.store.allKinds().map(apiVersionOf))].sort();

  const explain = (g, args) => {
    const p = parseArgs(args, flagSpec('recursive', 'api-version output'), { command: 'kubectl explain' });
    const [resource, ...path] = (p.pos[0] || '').split('.');
    if (!resource) throw new CommandError('error: You must specify the type of resource to explain. Use "kubectl api-resources" for a complete list of supported resources.', 'ARGS');
    const def = typeDef(C, resource);
    const docs = EXPLAIN_DOCS[def.kind];
    if (!docs) return [`GROUP:      ${def.group}`, `KIND:       ${def.kind}`, `VERSION:    ${def.version}`, '', 'DESCRIPTION:', `    ${def.kind} is a ${def.custom ? 'custom resource defined by a CustomResourceDefinition' : 'Kubernetes resource'}.`, '', 'FIELDS:', '  apiVersion\t<string>', '  kind\t<string>', '  metadata\t<ObjectMeta>', '  spec\t<Object>', '  status\t<Object>'];
    let node = { type: def.kind, desc: docs.desc, fields: docs.fields };
    for (const segment of path) {
      const next = node.fields?.[segment];
      if (!next) throw new CommandError(`error: field "${segment}" does not exist`, 'NO_FIELD');
      node = next;
    }
    const head = [...(def.group ? [`GROUP:      ${def.group}`] : []), `KIND:       ${def.kind}`, `VERSION:    ${def.version}`, ''];
    const fieldLine = (name, f, depth = 1) => {
      const lines = [`${'  '.repeat(depth)}${name}\t<${f.type}>${f.required ? ' -required-' : ''}`];
      if (!p.has('recursive')) lines.push(...wrap(f.desc || '', `${'  '.repeat(depth + 1)}`));
      if (p.has('recursive') && f.fields) Object.entries(f.fields).forEach(([k, v]) => lines.push(...fieldLine(k, v, depth + 1)));
      if (!p.has('recursive')) lines.push('');
      return lines;
    };
    return [
      ...head,
      ...(path.length ? [`FIELD: ${path.at(-1)} <${node.type}>`, ''] : []),
      'DESCRIPTION:', ...wrap(node.desc || '', '    '), '',
      ...(node.fields ? ['FIELDS:', ...Object.entries(node.fields).flatMap(([k, v]) => fieldLine(k, v))] : []),
    ];
  };
  const wrap = (text, indent, width = 76) => {
    const out = [];
    let line = '';
    text.split(/\s+/).forEach((w) => { if ((line + w).length > width) { out.push(indent + line.trim()); line = ''; } line += `${w} `; });
    if (line.trim()) out.push(indent + line.trim());
    return out;
  };

  return {
    rollout, logs, exec, 'port-forward': portForward, cp, debug, top, cordon: cordon(true), uncordon: cordon(false), drain, taint, wait, events, auth, config,
    'cluster-info': clusterInfo, version, 'api-resources': apiResources, 'api-versions': apiVersions, explain,
    attach: (g, args) => logs(g, [...args.filter((a) => !['-i', '-t', '-it'].includes(a))]),
    proxy: () => { E.proxy = true; return ['Starting to serve on 127.0.0.1:8001', '# (simulator: running in the background — try curl localhost:8001/api/v1/namespaces/default/pods)']; },
    completion: (g, args) => [`# ${args[0] || 'bash'} completion for kubectl (simulated)`, 'source <(kubectl completion bash)  # add this to your ~/.bashrc'],
    plugin: () => ['error: unable to find any kubectl plugins in your PATH'],
    certificate: (g, args) => { if (!['approve', 'deny'].includes(args[0])) throw new CommandError('error: unknown command for "kubectl certificate"\nAvailable: approve, deny', 'ARGS'); return [`certificatesigningrequest.certificates.k8s.io/${args[1]} ${args[0]}d`]; },
    kustomize: (g, args) => E.kustomize(args.find((a) => !a.startsWith('-')) || '.').flatMap((doc, i) => [...(i ? ['---'] : []), ...toYaml(doc).split('\n')]),
    options: () => ['The following options can be passed to any command:', '', '    -n, --namespace=\'\':', '\tIf present, the namespace scope for this CLI request', '', '    --context=\'\':', '\tThe name of the kubeconfig context to use', '', '    --as=\'\':', '\tUsername to impersonate for the operation'],
  };
};
