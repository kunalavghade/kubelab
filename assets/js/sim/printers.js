// How kubectl prints objects: the get tables (with -o wide), describe, JSONPath, custom columns.
import { humanAge, selectorString, parseCpu, parseMem, fmtCpu } from './api.js';
import { CommandError } from './util.js';
import { toYaml } from './yaml.js';

// ---------- small formatters ----------
const ageOf = (C, iso) => (iso ? humanAge(C.clock.now() - Date.parse(iso)) : '<unknown>');
const orNone = (v) => (v == null || v === '' ? '<none>' : v);
const csv = (list, max = 3) => (list.length > max ? `${list.slice(0, max).join(',')} + ${list.length - max} more...` : list.join(',')) || '<none>';
const labelsText = (labels) => Object.entries(labels || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>';
const containersOf = (spec) => spec?.containers || [];

/** kubectl's STATUS column for a pod. */
export const podStatus = (pod) => {
  if (pod.metadata.deletionTimestamp) return 'Terminating';
  if (pod.status.reason) return pod.status.reason;
  const inits = pod.status.initContainerStatuses || [];
  const initCount = pod.spec.initContainers?.length || 0;
  for (let i = 0; i < inits.length; i++) {
    const s = inits[i];
    if (s.state.terminated?.exitCode === 0) continue;
    if (pod.spec.initContainers?.[i]?.restartPolicy === 'Always' && s.started) continue;
    if (s.state.terminated) return `Init:${s.state.terminated.reason || 'Error'}`;
    if (s.state.waiting && s.state.waiting.reason !== 'PodInitializing' && s.state.waiting.reason !== 'ContainerCreating') return `Init:${s.state.waiting.reason}`;
    return `Init:${i}/${initCount}`;
  }
  let reason = pod.status.phase;
  for (const s of [...(pod.status.containerStatuses || [])].reverse()) {
    if (s.state.waiting?.reason) reason = s.state.waiting.reason;
    else if (s.state.terminated) reason = s.state.terminated.reason || `ExitCode:${s.state.terminated.exitCode}`;
  }
  if (reason === 'Pending' && pod.spec.nodeName) reason = 'ContainerCreating';
  if (reason === 'Succeeded') return 'Completed';
  return reason;
};

const podReady = (pod) => `${(pod.status.containerStatuses || []).filter((s) => s.ready).length}/${pod.spec.containers.length}`;
const podRestarts = (C, pod) => {
  const statuses = pod.status.containerStatuses || [];
  const n = statuses.reduce((s, c) => s + c.restartCount, 0);
  const last = statuses.map((c) => c.lastState?.terminated?.finishedAt).filter(Boolean).sort().pop();
  return n && last ? `${n} (${ageOf(C, last)} ago)` : String(n);
};

const svcPorts = (svc) => (svc.spec.ports || []).map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol}`).join(',') || '<none>';
const svcExternal = (svc) => {
  if (svc.spec.type === 'ExternalName') return svc.spec.externalName;
  if (svc.spec.type !== 'LoadBalancer') return (svc.spec.externalIPs || []).join(',') || '<none>';
  return svc.status.loadBalancer?.ingress?.map((i) => i.ip || i.hostname).join(',') || '<pending>';
};
const nodeStatus = (n) => {
  const ready = n.status.conditions.find((c) => c.type === 'Ready')?.status === 'True';
  return `${ready ? 'Ready' : 'NotReady'}${n.spec.unschedulable ? ',SchedulingDisabled' : ''}`;
};
const nodeRoles = (n) => Object.keys(n.metadata.labels || {}).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]).join(',') || '<none>';
const accessModes = (modes = []) => modes.map((m) => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[m] || m)).join(',');
const jobStatus = (job) => {
  const c = (type) => job.status.conditions?.some((x) => x.type === type && x.status === 'True');
  return c('Complete') ? 'Complete' : c('Failed') ? 'Failed' : job.spec.suspend ? 'Suspended' : 'Running';
};
const duration = (C, job) => {
  if (!job.status.startTime) return '';
  const end = job.status.completionTime ? Date.parse(job.status.completionTime) : C.clock.now();
  return humanAge(end - Date.parse(job.status.startTime));
};
const hpaTargets = (hpa) => (hpa.spec.metrics || []).map((m) => {
  const cur = hpa.status.currentMetrics?.find((x) => x.resource?.name === m.resource?.name)?.resource.current.averageUtilization;
  return `${m.resource?.name || m.type}: ${cur == null ? '<unknown>' : `${cur}%`}/${m.resource?.target?.averageUtilization ?? m.resource?.target?.averageValue}%`;
}).join(', ') || '<none>';
const images = (spec) => containersOf(spec).map((c) => c.image).join(',');
const names = (spec) => containersOf(spec).map((c) => c.name).join(',');
const subjectsOf = (rb, kind) => (rb.subjects || []).filter((s) => s.kind === kind).map((s) => (kind === 'ServiceAccount' ? `${s.namespace || rb.metadata.namespace}/${s.name}` : s.name)).join(', ');
const quotaPairs = (q, prefix) => Object.keys(q.spec.hard || {}).filter((k) => (prefix === 'limits' ? k.startsWith('limits') : !k.startsWith('limits'))).map((k) => `${k}: ${q.status.used?.[k] ?? 0}/${q.spec.hard[k]}`).join(', ');

// ---------- get tables ----------
// [header, value(C, obj)] pairs; `wide` adds columns for -o wide.
const COLUMNS = {
  Pod: { cols: [['READY', (C, p) => podReady(p)], ['STATUS', (C, p) => podStatus(p)], ['RESTARTS', podRestarts], ['AGE', (C, p) => ageOf(C, p.metadata.creationTimestamp)]],
    wide: [['IP', (C, p) => orNone(p.status.podIP)], ['NODE', (C, p) => orNone(p.spec.nodeName)], ['NOMINATED NODE', (C, p) => orNone(p.status.nominatedNodeName)], ['READINESS GATES', () => '<none>']] },
  Deployment: { cols: [['READY', (C, d) => `${d.status.readyReplicas || 0}/${d.spec.replicas}`], ['UP-TO-DATE', (C, d) => d.status.updatedReplicas || 0], ['AVAILABLE', (C, d) => d.status.availableReplicas || 0], ['AGE', (C, d) => ageOf(C, d.metadata.creationTimestamp)]],
    wide: [['CONTAINERS', (C, d) => names(d.spec.template.spec)], ['IMAGES', (C, d) => images(d.spec.template.spec)], ['SELECTOR', (C, d) => selectorString(d.spec.selector)]] },
  ReplicaSet: { cols: [['DESIRED', (C, r) => r.spec.replicas], ['CURRENT', (C, r) => r.status.replicas || 0], ['READY', (C, r) => r.status.readyReplicas || 0], ['AGE', (C, r) => ageOf(C, r.metadata.creationTimestamp)]],
    wide: [['CONTAINERS', (C, r) => names(r.spec.template.spec)], ['IMAGES', (C, r) => images(r.spec.template.spec)], ['SELECTOR', (C, r) => selectorString(r.spec.selector)]] },
  StatefulSet: { cols: [['READY', (C, s) => `${s.status.readyReplicas || 0}/${s.spec.replicas}`], ['AGE', (C, s) => ageOf(C, s.metadata.creationTimestamp)]],
    wide: [['CONTAINERS', (C, s) => names(s.spec.template.spec)], ['IMAGES', (C, s) => images(s.spec.template.spec)]] },
  DaemonSet: { cols: [['DESIRED', (C, d) => d.status.desiredNumberScheduled || 0], ['CURRENT', (C, d) => d.status.currentNumberScheduled || 0], ['READY', (C, d) => d.status.numberReady || 0], ['UP-TO-DATE', (C, d) => d.status.updatedNumberScheduled || 0], ['AVAILABLE', (C, d) => d.status.numberAvailable || 0], ['NODE SELECTOR', (C, d) => labelsText(d.spec.template.spec.nodeSelector)], ['AGE', (C, d) => ageOf(C, d.metadata.creationTimestamp)]],
    wide: [['CONTAINERS', (C, d) => names(d.spec.template.spec)], ['IMAGES', (C, d) => images(d.spec.template.spec)], ['SELECTOR', (C, d) => selectorString(d.spec.selector)]] },
  Service: { cols: [['TYPE', (C, s) => s.spec.type], ['CLUSTER-IP', (C, s) => s.spec.clusterIP || '<none>'], ['EXTERNAL-IP', (C, s) => svcExternal(s)], ['PORT(S)', (C, s) => svcPorts(s)], ['AGE', (C, s) => ageOf(C, s.metadata.creationTimestamp)]],
    wide: [['SELECTOR', (C, s) => labelsText(s.spec.selector)]] },
  Endpoints: { cols: [['ENDPOINTS', (C, e) => csv((e.subsets || []).flatMap((s) => (s.addresses || []).flatMap((a) => s.ports.map((p) => `${a.ip}:${p.port}`))))], ['AGE', (C, e) => ageOf(C, e.metadata.creationTimestamp)]] },
  EndpointSlice: { cols: [['ADDRESSTYPE', (C, e) => e.addressType], ['PORTS', (C, e) => (e.ports || []).map((p) => p.port).join(',') || '<unset>'], ['ENDPOINTS', (C, e) => csv(e.endpoints.flatMap((x) => x.addresses))], ['AGE', (C, e) => ageOf(C, e.metadata.creationTimestamp)]] },
  Node: { cols: [['STATUS', (C, n) => nodeStatus(n)], ['ROLES', (C, n) => nodeRoles(n)], ['AGE', (C, n) => ageOf(C, n.metadata.creationTimestamp)], ['VERSION', (C, n) => n.status.nodeInfo.kubeletVersion]],
    wide: [['INTERNAL-IP', (C, n) => n.status.addresses[0].address], ['EXTERNAL-IP', () => '<none>'], ['OS-IMAGE', (C, n) => n.status.nodeInfo.osImage], ['KERNEL-VERSION', (C, n) => n.status.nodeInfo.kernelVersion], ['CONTAINER-RUNTIME', (C, n) => n.status.nodeInfo.containerRuntimeVersion]] },
  Namespace: { cols: [['STATUS', (C, n) => n.status.phase], ['AGE', (C, n) => ageOf(C, n.metadata.creationTimestamp)]] },
  ConfigMap: { cols: [['DATA', (C, c) => Object.keys(c.data || {}).length + Object.keys(c.binaryData || {}).length], ['AGE', (C, c) => ageOf(C, c.metadata.creationTimestamp)]] },
  Secret: { cols: [['TYPE', (C, s) => s.type], ['DATA', (C, s) => Object.keys(s.data || {}).length], ['AGE', (C, s) => ageOf(C, s.metadata.creationTimestamp)]] },
  ServiceAccount: { cols: [['SECRETS', (C, s) => (s.secrets || []).length], ['AGE', (C, s) => ageOf(C, s.metadata.creationTimestamp)]] },
  PersistentVolumeClaim: { cols: [['STATUS', (C, p) => (p.metadata.deletionTimestamp ? 'Terminating' : p.status.phase)], ['VOLUME', (C, p) => p.spec.volumeName || ''], ['CAPACITY', (C, p) => p.status.capacity?.storage || ''], ['ACCESS MODES', (C, p) => (p.status.phase === 'Bound' ? accessModes(p.status.accessModes) : '')], ['STORAGECLASS', (C, p) => p.spec.storageClassName ?? '<unset>'], ['VOLUMEATTRIBUTESCLASS', () => '<unset>'], ['AGE', (C, p) => ageOf(C, p.metadata.creationTimestamp)]],
    wide: [['VOLUMEMODE', (C, p) => p.spec.volumeMode]] },
  PersistentVolume: { cols: [['CAPACITY', (C, p) => p.spec.capacity?.storage], ['ACCESS MODES', (C, p) => accessModes(p.spec.accessModes)], ['RECLAIM POLICY', (C, p) => p.spec.persistentVolumeReclaimPolicy], ['STATUS', (C, p) => p.status.phase], ['CLAIM', (C, p) => (p.spec.claimRef ? `${p.spec.claimRef.namespace}/${p.spec.claimRef.name}` : '')], ['STORAGECLASS', (C, p) => p.spec.storageClassName || ''], ['VOLUMEATTRIBUTESCLASS', () => '<unset>'], ['REASON', () => ''], ['AGE', (C, p) => ageOf(C, p.metadata.creationTimestamp)]] },
  StorageClass: { name: (s) => `${s.metadata.name}${s.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? ' (default)' : ''}`,
    cols: [['PROVISIONER', (C, s) => s.provisioner], ['RECLAIMPOLICY', (C, s) => s.reclaimPolicy || 'Delete'], ['VOLUMEBINDINGMODE', (C, s) => s.volumeBindingMode || 'Immediate'], ['ALLOWVOLUMEEXPANSION', (C, s) => String(!!s.allowVolumeExpansion)], ['AGE', (C, s) => ageOf(C, s.metadata.creationTimestamp)]] },
  Job: { cols: [['STATUS', (C, j) => jobStatus(j)], ['COMPLETIONS', (C, j) => `${j.status.succeeded || 0}/${j.spec.completions}`], ['DURATION', duration], ['AGE', (C, j) => ageOf(C, j.metadata.creationTimestamp)]],
    wide: [['CONTAINERS', (C, j) => names(j.spec.template.spec)], ['IMAGES', (C, j) => images(j.spec.template.spec)], ['SELECTOR', (C, j) => selectorString(j.spec.selector)]] },
  CronJob: { cols: [['SCHEDULE', (C, c) => c.spec.schedule], ['TIMEZONE', (C, c) => c.spec.timeZone || '<none>'], ['SUSPEND', (C, c) => String(!!c.spec.suspend)], ['ACTIVE', (C, c) => (c.status.active || []).length], ['LAST SCHEDULE', (C, c) => (c.status.lastScheduleTime ? ageOf(C, c.status.lastScheduleTime) : '<none>')], ['AGE', (C, c) => ageOf(C, c.metadata.creationTimestamp)]] },
  HorizontalPodAutoscaler: { cols: [['REFERENCE', (C, h) => `${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`], ['TARGETS', (C, h) => hpaTargets(h)], ['MINPODS', (C, h) => h.spec.minReplicas], ['MAXPODS', (C, h) => h.spec.maxReplicas], ['REPLICAS', (C, h) => h.status.currentReplicas || 0], ['AGE', (C, h) => ageOf(C, h.metadata.creationTimestamp)]] },
  Ingress: { cols: [['CLASS', (C, i) => i.spec.ingressClassName || '<none>'], ['HOSTS', (C, i) => (i.spec.rules || []).map((r) => r.host || '*').join(',') || '*'], ['ADDRESS', (C, i) => i.status.loadBalancer?.ingress?.map((x) => x.ip).join(',') || ''], ['PORTS', (C, i) => (i.spec.tls?.length ? '80, 443' : '80')], ['AGE', (C, i) => ageOf(C, i.metadata.creationTimestamp)]] },
  IngressClass: { cols: [['CONTROLLER', (C, i) => i.spec.controller], ['PARAMETERS', () => '<none>'], ['AGE', (C, i) => ageOf(C, i.metadata.creationTimestamp)]] },
  NetworkPolicy: { cols: [['POD-SELECTOR', (C, n) => selectorString(n.spec.podSelector).replace('<none>', '<none>')], ['AGE', (C, n) => ageOf(C, n.metadata.creationTimestamp)]] },
  PodDisruptionBudget: { cols: [['MIN AVAILABLE', (C, p) => p.spec.minAvailable ?? 'N/A'], ['MAX UNAVAILABLE', (C, p) => p.spec.maxUnavailable ?? 'N/A'], ['ALLOWED DISRUPTIONS', (C, p) => p.status.disruptionsAllowed ?? 0], ['AGE', (C, p) => ageOf(C, p.metadata.creationTimestamp)]] },
  Role: { cols: [['CREATED AT', (C, r) => r.metadata.creationTimestamp]] },
  ClusterRole: { cols: [['CREATED AT', (C, r) => r.metadata.creationTimestamp]] },
  RoleBinding: { cols: [['ROLE', (C, r) => `${r.roleRef.kind}/${r.roleRef.name}`], ['AGE', (C, r) => ageOf(C, r.metadata.creationTimestamp)]],
    wide: [['USERS', (C, r) => subjectsOf(r, 'User')], ['GROUPS', (C, r) => subjectsOf(r, 'Group')], ['SERVICEACCOUNTS', (C, r) => subjectsOf(r, 'ServiceAccount')]] },
  ClusterRoleBinding: { cols: [['ROLE', (C, r) => `${r.roleRef.kind}/${r.roleRef.name}`], ['AGE', (C, r) => ageOf(C, r.metadata.creationTimestamp)]],
    wide: [['USERS', (C, r) => subjectsOf(r, 'User')], ['GROUPS', (C, r) => subjectsOf(r, 'Group')], ['SERVICEACCOUNTS', (C, r) => subjectsOf(r, 'ServiceAccount')]] },
  ResourceQuota: { cols: [['AGE', (C, q) => ageOf(C, q.metadata.creationTimestamp)], ['REQUEST', (C, q) => quotaPairs(q, 'requests')], ['LIMIT', (C, q) => quotaPairs(q, 'limits')]] },
  LimitRange: { cols: [['CREATED AT', (C, r) => r.metadata.creationTimestamp]] },
  PriorityClass: { cols: [['VALUE', (C, p) => p.value], ['GLOBAL-DEFAULT', (C, p) => String(!!p.globalDefault)], ['AGE', (C, p) => ageOf(C, p.metadata.creationTimestamp)], ['PREEMPTIONPOLICY', (C, p) => p.preemptionPolicy || 'PreemptLowerPriority']] },
  CustomResourceDefinition: { cols: [['CREATED AT', (C, r) => r.metadata.creationTimestamp]] },
  Event: { name: null, cols: [['LAST SEEN', (C, e) => ageOf(C, e.lastTimestamp)], ['TYPE', (C, e) => e.type], ['REASON', (C, e) => e.reason], ['OBJECT', (C, e) => `${e.involvedObject.kind.toLowerCase()}/${e.involvedObject.name}`], ['MESSAGE', (C, e) => e.message]] },
};
const DEFAULT_COLUMNS = { cols: [['AGE', (C, o) => ageOf(C, o.metadata.creationTimestamp)]] };

const pad = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)) + 3);
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c ?? '') : String(c ?? '').padEnd(widths[i]))).join('').trimEnd());
};

/**
 * Rows for one kind. opts: { wide, showNs, prefix (pod/), labelsCol, extraCols (-L), noHeaders }.
 */
export const tableFor = (C, def, objs, opts = {}) => {
  const spec = COLUMNS[def.kind] || DEFAULT_COLUMNS;
  const cols = [...spec.cols, ...(opts.wide ? spec.wide || [] : [])];
  const extra = (opts.extraCols || []).map((k) => [k.split('/').pop().toUpperCase(), (Cc, o) => o.metadata.labels?.[k] ?? '']);
  const hasName = spec.name !== null;
  const header = [...(opts.showNs ? ['NAMESPACE'] : []), ...(hasName ? ['NAME'] : []), ...cols.map(([h]) => h), ...extra.map(([h]) => h), ...(opts.labelsCol ? ['LABELS'] : [])];
  const rows = objs.map((o) => [
    ...(opts.showNs ? [o.metadata.namespace] : []),
    ...(hasName ? [`${opts.prefix ? `${def.singular}${def.group ? `.${def.group}` : ''}/` : ''}${spec.name ? spec.name(o) : o.metadata.name}`] : []),
    ...cols.map(([, f]) => f(C, o)), ...extra.map(([, f]) => f(C, o)), ...(opts.labelsCol ? [labelsText(o.metadata.labels)] : []),
  ]);
  return pad(opts.noHeaders ? rows.length ? rows : [[]] : [header, ...rows]).filter((l, i) => !(opts.noHeaders && !rows.length && i === 0));
};

// ---------- JSONPath ----------
const splitPath = (path) => {
  const tokens = [];
  const re = /\.\.([\w-]+)|\.((?:[^.[\]\\]|\\.)+)|\[\?\(@\.([\w.]+)\s*(==|!=)\s*["']?([^"')]*)["']?\)\]|\[(\*|-?\d+)(?::(-?\d*))?\]|\['([^']+)'\]/g;
  let m;
  while ((m = re.exec(path))) {
    if (m[1]) tokens.push({ deep: m[1] });
    else if (m[2]) tokens.push({ field: m[2].replace(/\\\./g, '.') });
    else if (m[3]) tokens.push({ filter: m[3], op: m[4], value: m[5] });
    else if (m[6]) tokens.push({ index: m[6], end: m[7] });
    else if (m[8]) tokens.push({ field: m[8] });
  }
  return tokens;
};

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const collectDeep = (node, key, out) => {
  if (!node || typeof node !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(node, key)) out.push(node[key]);
  Object.values(node).forEach((v) => collectDeep(v, key, out));
};

export const evalPath = (root, path) => {
  let nodes = [root];
  for (const t of splitPath(path.replace(/^\$/, ''))) {
    nodes = nodes.flatMap((n) => {
      if (n == null) return [];
      if (t.field) return n[t.field] === undefined ? [] : [n[t.field]];
      if (t.deep) { const out = []; collectDeep(n, t.deep, out); return out; }
      if (!Array.isArray(n)) return [];
      if (t.filter) return n.filter((x) => (t.op === '==' ? String(getPath(x, t.filter)) === t.value : String(getPath(x, t.filter)) !== t.value));
      if (t.index === '*') return n;
      if (t.end !== undefined) return n.slice(Number(t.index), t.end === '' ? undefined : Number(t.end));
      const i = Number(t.index);
      const v = n[i < 0 ? n.length + i : i];
      return v === undefined ? [] : [v];
    });
  }
  return nodes;
};

const show = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Renders a kubectl JSONPath template such as '{range .items[*]}{.metadata.name}{"\n"}{end}'. */
export const renderJsonPath = (template, root) => {
  const tpl = template.replace(/^'|'$/g, '');
  const parts = [];
  const re = /\{([^{}]*)\}|([^{}]+)/g;
  let m;
  while ((m = re.exec(tpl))) parts.push(m[1] !== undefined ? { expr: m[1].trim() } : { text: m[2] });
  if (!parts.length) throw new CommandError('error: error parsing jsonpath: unclosed action', 'JSONPATH');

  const render = (list, ctx) => {
    let out = '';
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.text) { out += p.text; continue; }
      const e = p.expr;
      if (/^range\s+/.test(e)) {
        let depth = 1, j = i + 1;
        for (; j < list.length; j++) {
          if (/^range\s+/.test(list[j].expr || '')) depth++;
          if (list[j].expr === 'end' && --depth === 0) break;
        }
        const body = list.slice(i + 1, j);
        evalPath(ctx, e.replace(/^range\s+/, '')).forEach((item) => { out += render(body, item); });
        i = j;
        continue;
      }
      if (/^".*"$|^'.*'$/.test(e)) { out += e.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t'); continue; }
      if (e === '@' || e === '.') { out += show(ctx); continue; }
      out += evalPath(ctx, e.startsWith('.') || e.startsWith('$') || e.startsWith('[') ? e : `.${e}`).map(show).join(' ');
    }
    return out;
  };
  return render(parts, root);
};

/** custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[*].image */
export const customColumns = (spec, items, noHeaders) => {
  const cols = spec.split(',').map((c) => { const at = c.indexOf(':'); return [c.slice(0, at), c.slice(at + 1)]; });
  const rows = items.map((o) => cols.map(([, path]) => evalPath(o, path).map(show).join(',') || '<none>'));
  return pad(noHeaders ? rows : [cols.map(([h]) => h), ...rows]);
};

export const sortBy = (items, path) => [...items].sort((a, b) => {
  const [x] = evalPath(a, path), [y] = evalPath(b, path);
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
});

// ---------- field selectors ----------
export const matchesFieldSelector = (obj, selector) => !selector || selector.split(',').every((part) => {
  const m = /^([\w.]+)\s*(==|=|!=)\s*(.*)$/.exec(part.trim());
  if (!m) throw new CommandError(`error: invalid field selector: '${part}'`, 'FIELD_SELECTOR');
  const value = String(getPath(obj, m[1]) ?? '');
  return m[2] === '!=' ? value !== m[3] : value === m[3];
});

// ---------- describe ----------
const kv = (key, value, width = 0) => `${`${key}:`.padEnd(width || key.length + 2)}${value}`;
const block = (pairs) => {
  const w = Math.max(...pairs.filter(Boolean).map(([k]) => k.length)) + 2;
  return pairs.filter(Boolean).map(([k, v]) => (v === null ? `${k}:` : kv(k, v, w)));
};
const mapLines = (title, map, w) => {
  const entries = Object.entries(map || {});
  if (!entries.length) return [title, '<none>'];
  return [title, entries.map(([k, v]) => `${k}=${v}`).join(`\n${' '.repeat(w)}`)];
};
const indent = (lines, n = 2) => lines.map((l) => (l ? `${' '.repeat(n)}${l}` : l));

export const eventsSection = (C, obj) => {
  const events = C.store.list(C.def('event'), obj.metadata.namespace || 'default').filter((e) => e.involvedObject.uid === obj.metadata.uid).sort((a, b) => a.firstTimestamp.localeCompare(b.firstTimestamp)).slice(-12);
  if (!events.length) return ['Events:  <none>'];
  const rows = events.map((e) => [e.type, e.reason, e.count > 1 ? `${ageOf(C, e.lastTimestamp)} (x${e.count} over ${ageOf(C, e.firstTimestamp)})` : ageOf(C, e.firstTimestamp), e.source.component, e.message]);
  return ['Events:', ...indent(pad([['Type', 'Reason', 'Age', 'From', 'Message'], ['----', '------', '----', '----', '-------'], ...rows]))];
};

const containerLines = (C, pod, c, status) => {
  const state = status?.state || {};
  const [stateName, detail] = Object.entries(state)[0] || ['Waiting', { reason: 'ContainerCreating' }];
  const res = c.resources || {};
  const lines = [
    `${c.name}:`,
    ...indent(block([
      ['Container ID', status?.containerID || ''],
      ['Image', c.image],
      ['Image ID', status?.imageID || ''],
      ['Port', (c.ports || []).map((p) => `${p.containerPort}/${p.protocol}`).join(', ') || '<none>'],
      ['Host Port', (c.ports || []).map((p) => `${p.hostPort || 0}/${p.protocol}`).join(', ') || '<none>'],
      c.command ? ['Command', null] : null,
      ['State', stateName[0].toUpperCase() + stateName.slice(1)],
      ...(detail.reason ? [['  Reason', detail.reason]] : []),
      ...(detail.message ? [['  Message', detail.message]] : []),
      ...(detail.exitCode != null ? [['  Exit Code', detail.exitCode]] : []),
      ...(detail.startedAt ? [['  Started', new Date(detail.startedAt).toUTCString().replace('GMT', '+0000')]] : []),
      ...(status?.lastState?.terminated ? [['Last State', 'Terminated'], ['  Reason', status.lastState.terminated.reason], ['  Exit Code', status.lastState.terminated.exitCode]] : []),
      ['Ready', status?.ready ? 'True' : 'False'],
      ['Restart Count', status?.restartCount ?? 0],
      ...(res.limits ? [['Limits', null], ...Object.entries(res.limits).map(([k, v]) => [`  ${k}`, v])] : []),
      ...(res.requests && Object.keys(res.requests).length ? [['Requests', null], ...Object.entries(res.requests).map(([k, v]) => [`  ${k}`, v])] : []),
      ...['livenessProbe', 'readinessProbe', 'startupProbe'].filter((p) => c[p]).map((p) => [p.replace('Probe', '').replace(/^./, (x) => x.toUpperCase()), probeLine(c[p])]),
      ['Environment', (c.env || []).length || (c.envFrom || []).length ? null : '<none>'],
      ...(c.envFrom || []).map((e) => [`  ${e.configMapRef ? `${e.configMapRef.name}  ConfigMap` : `${e.secretRef.name}  Secret`}`, ' Optional: false'.trim()]),
      ...(c.env || []).map((e) => [`  ${e.name}`, 'value' in e ? e.value : e.valueFrom?.secretKeyRef ? `<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>  Optional: false` : e.valueFrom?.configMapKeyRef ? `<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>  Optional: false` : `(${e.valueFrom?.fieldRef?.fieldPath || ''})`]),
      ['Mounts', null],
    ])),
    ...indent([...(c.volumeMounts || []).map((m) => `  ${m.mountPath} from ${m.name} (${m.readOnly ? 'ro' : 'rw'})`), `  /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-${pod.metadata.uid.slice(0, 5)} (ro)`]),
  ];
  if (c.command) lines.splice(6, 0, ...indent([...c.command, ...(c.args || [])].map((x) => `  ${x}`)));
  return lines;
};
const probeLine = (p) => {
  const how = p.httpGet ? `http-get http://:${p.httpGet.port}${p.httpGet.path || '/'}` : p.tcpSocket ? `tcp-socket :${p.tcpSocket.port}` : p.exec ? `exec [${p.exec.command.join(' ')}]` : p.grpc ? `grpc <pod>:${p.grpc.port}` : '';
  return `${how} delay=${p.initialDelaySeconds ?? 0}s timeout=${p.timeoutSeconds ?? 1}s period=${p.periodSeconds ?? 10}s #success=${p.successThreshold ?? 1} #failure=${p.failureThreshold ?? 3}`;
};

const volumeLines = (pod) => [
  'Volumes:',
  ...(pod.spec.volumes || []).flatMap((v) => {
    const [type, src] = Object.entries(v).find(([k]) => k !== 'name') || ['emptyDir', {}];
    const desc = {
      configMap: ['ConfigMap (a volume populated by a ConfigMap)', ['Name', src.name]],
      secret: ['Secret (a volume populated by a Secret)', ['SecretName', src.secretName]],
      persistentVolumeClaim: ['PersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)', ['ClaimName', src.claimName]],
      emptyDir: ['EmptyDir (a temporary directory that shares a pod\'s lifetime)', ['Medium', src.medium || '']],
      hostPath: ['HostPath (bare host directory volume)', ['Path', src.path]],
    }[type] || [type, ['Source', JSON.stringify(src)]];
    return [`  ${v.name}:`, ...indent(block([['Type', desc[0]], desc[1]]), 4)];
  }),
  `  kube-api-access-${pod.metadata.uid.slice(0, 5)}:`,
  '    Type:                    Projected (a volume that contains injected data from multiple sources)',
  '    TokenExpirationSeconds:  3607',
];

const HIDDEN_ANNOTATIONS = /^kubectl\.kubernetes\.io\/last-applied-configuration$/;
const header = (o, extra = []) => {
  const keys = ['Name', 'Namespace', 'Labels', 'Annotations', ...extra.filter(Boolean).map(([k]) => k)];
  const w = Math.max(...keys.map((k) => k.length)) + 2;
  const cont = `\n${' '.repeat(w)}`;
  return block([
    ['Name', o.metadata.name],
    ...(o.metadata.namespace ? [['Namespace', o.metadata.namespace]] : []),
    ...extra.filter((e) => e && e[2] === 'top').map(([k, v]) => [k, v]),
    ['Labels', Object.entries(o.metadata.labels || {}).map(([k, v]) => `${k}=${v}`).join(cont) || '<none>'],
    ['Annotations', Object.entries(o.metadata.annotations || {}).filter(([k]) => !HIDDEN_ANNOTATIONS.test(k)).map(([k, v]) => `${k}: ${String(v).length > 60 ? `${String(v).slice(0, 57)}...` : v}`).join(cont) || '<none>'],
    ...extra.filter((e) => e && e[2] !== 'top').map(([k, v]) => [k, v]),
  ]);
};

const podTemplateLines = (tpl) => [
  'Pod Template:',
  `  Labels:  ${labelsText(tpl.metadata?.labels).split(',').join('\n           ')}`,
  ...(tpl.spec.serviceAccountName ? [`  Service Account:  ${tpl.spec.serviceAccountName}`] : []),
  '  Containers:',
  ...tpl.spec.containers.flatMap((c) => indent([`${c.name}:`, `  Image:      ${c.image}`, `  Port:       ${(c.ports || []).map((p) => `${p.containerPort}/${p.protocol || 'TCP'}`).join(', ') || '<none>'}`, ...(c.resources?.limits ? [`  Limits:`, ...Object.entries(c.resources.limits).map(([k, v]) => `    ${k}:  ${v}`)] : []), ...(c.resources?.requests ? [`  Requests:`, ...Object.entries(c.resources.requests).map(([k, v]) => `    ${k}:  ${v}`)] : []), `  Environment:  ${(c.env || []).length ? (c.env || []).map((e) => `${e.name}=${e.value ?? '<from ref>'}`).join(', ') : '<none>'}`, `  Mounts:       ${(c.volumeMounts || []).map((m) => `${m.mountPath} from ${m.name}`).join(', ') || '<none>'}`], 4)),
  `  Volumes:         ${(tpl.spec.volumes || []).map((v) => v.name).join(', ') || '<none>'}`,
  `  Node-Selectors:  ${labelsText(tpl.spec.nodeSelector)}`,
  `  Tolerations:     ${(tpl.spec.tolerations || []).map((t) => `${t.key || ''}${t.operator === 'Exists' ? ' op=Exists' : `=${t.value || ''}`}:${t.effect || ''}`).join(', ') || '<none>'}`,
];

const DESCRIBERS = {
  Pod: (C, pod) => [
    ...block([
      ['Name', pod.metadata.name], ['Namespace', pod.metadata.namespace], ['Priority', pod.spec.priority ?? 0],
      ...(pod.spec.priorityClassName ? [['Priority Class Name', pod.spec.priorityClassName]] : []),
      ['Service Account', pod.spec.serviceAccountName],
      ['Node', pod.spec.nodeName ? `${pod.spec.nodeName}/${pod.status.hostIP || ''}` : '<none>'],
      ['Start Time', pod.status.startTime ? new Date(pod.status.startTime).toUTCString().replace('GMT', '+0000') : '<unset>'],
      ['Labels', labelsText(pod.metadata.labels).split(',').join('\n                      ')],
      ['Annotations', Object.entries(pod.metadata.annotations || {}).filter(([k]) => !HIDDEN_ANNOTATIONS.test(k)).map(([k, v]) => `${k}: ${v}`).join('\n                      ') || '<none>'],
      ['Status', pod.metadata.deletionTimestamp ? `Terminating (lasts ${pod.metadata.deletionGracePeriodSeconds}s)` : pod.status.phase],
      ...(pod.metadata.deletionTimestamp ? [['Termination Grace Period', `${pod.metadata.deletionGracePeriodSeconds}s`]] : []),
      ['IP', pod.status.podIP || ''],
      ['IPs', pod.status.podIP ? null : '<none>'],
    ]),
    ...(pod.status.podIP ? [`  IP:  ${pod.status.podIP}`] : []),
    ...(pod.metadata.ownerReferences?.[0] ? [`Controlled By:  ${pod.metadata.ownerReferences[0].kind}/${pod.metadata.ownerReferences[0].name}`] : []),
    ...(pod.spec.initContainers?.length ? ['Init Containers:', ...indent(pod.spec.initContainers.flatMap((c) => containerLines(C, pod, c, pod.status.initContainerStatuses?.find((s) => s.name === c.name))))] : []),
    'Containers:',
    ...indent(pod.spec.containers.flatMap((c) => containerLines(C, pod, c, pod.status.containerStatuses?.find((s) => s.name === c.name)))),
    ...(pod.spec.ephemeralContainers?.length ? ['Ephemeral Containers:', ...indent(pod.spec.ephemeralContainers.flatMap((c) => [`${c.name}:`, `  Image:          ${c.image}`, ...(c.targetContainerName ? [`  Target:         ${c.targetContainerName}`] : []), '  State:          Running', `    Started:      ${new Date(pod.status.ephemeralContainerStatuses?.find((s) => s.name === c.name)?.state.running?.startedAt || Date.now()).toUTCString().replace('GMT', '+0000')}`]))] : []),
    'Conditions:',
    ...indent(pad([['Type', 'Status'], ...['PodReadyToStartContainers', 'Initialized', 'Ready', 'ContainersReady', 'PodScheduled'].map((t) => {
      const c = pod.status.conditions?.find((x) => x.type === t);
      return [t, t === 'PodReadyToStartContainers' ? (pod.status.podIP ? 'True' : 'False') : c?.status ?? 'False'];
    })])),
    ...volumeLines(pod),
    `QoS Class:                   ${pod.status.qosClass}`,
    `Node-Selectors:              ${labelsText(pod.spec.nodeSelector)}`,
    `Tolerations:                 ${(pod.spec.tolerations || []).map((t) => `${t.key || ''}${t.operator === 'Exists' ? ' op=Exists' : `=${t.value || ''}`}${t.effect ? `:${t.effect}` : ''}${t.tolerationSeconds ? ` for ${t.tolerationSeconds}s` : ''}`).join('\n                             ') || '<none>'}`,
    ...eventsSection(C, pod),
  ],
  Deployment: (C, d) => {
    const rsList = C.ownedBy(d, 'replicaset');
    const newRS = rsList.find((r) => r.metadata.annotations?.['deployment.kubernetes.io/revision'] === d.metadata.annotations?.['deployment.kubernetes.io/revision']);
    const old = rsList.filter((r) => r !== newRS && r.spec.replicas);
    return [
      ...header(d, [['CreationTimestamp', new Date(d.metadata.creationTimestamp).toUTCString().replace('GMT', '+0000'), 'top']]),
      `Selector:               ${selectorString(d.spec.selector)}`,
      `Replicas:               ${d.spec.replicas} desired | ${d.status.updatedReplicas || 0} updated | ${d.status.replicas || 0} total | ${d.status.availableReplicas || 0} available | ${d.status.unavailableReplicas || 0} unavailable`,
      `StrategyType:           ${d.spec.strategy.type}`,
      `MinReadySeconds:        ${d.spec.minReadySeconds || 0}`,
      ...(d.spec.strategy.type === 'RollingUpdate' ? [`RollingUpdateStrategy:  ${d.spec.strategy.rollingUpdate.maxUnavailable} max unavailable, ${d.spec.strategy.rollingUpdate.maxSurge} max surge`] : []),
      ...podTemplateLines(d.spec.template),
      'Conditions:',
      ...indent(pad([['Type', 'Status', 'Reason'], ['----', '------', '------'], ...(d.status.conditions || []).map((c) => [c.type, c.status, c.reason])])),
      `OldReplicaSets:  ${old.map((r) => `${r.metadata.name} (${r.status.replicas || 0}/${r.spec.replicas} replicas created)`).join(', ') || '<none>'}`,
      `NewReplicaSet:   ${newRS ? `${newRS.metadata.name} (${newRS.status.replicas || 0}/${newRS.spec.replicas} replicas created)` : '<none>'}`,
      ...eventsSection(C, d),
    ];
  },
  ReplicaSet: (C, rs) => [
    ...header(rs),
    `Selector:     ${selectorString(rs.spec.selector)}`,
    ...(rs.metadata.ownerReferences?.[0] ? [`Controlled By:  ${rs.metadata.ownerReferences[0].kind}/${rs.metadata.ownerReferences[0].name}`] : []),
    `Replicas:     ${rs.status.replicas || 0} current / ${rs.spec.replicas} desired`,
    `Pods Status:  ${(C.ownedBy(rs, 'pod').filter((p) => p.status.phase === 'Running').length)} Running / ${C.ownedBy(rs, 'pod').filter((p) => p.status.phase === 'Pending').length} Waiting / 0 Succeeded / 0 Failed`,
    ...podTemplateLines(rs.spec.template),
    ...eventsSection(C, rs),
  ],
  StatefulSet: (C, s) => [
    ...header(s, [['CreationTimestamp', new Date(s.metadata.creationTimestamp).toUTCString().replace('GMT', '+0000'), 'top']]),
    `Selector:           ${selectorString(s.spec.selector)}`,
    `Replicas:           ${s.spec.replicas} desired | ${s.status.replicas || 0} total`,
    `Update Strategy:    ${s.spec.updateStrategy.type}`,
    ...(s.spec.updateStrategy.rollingUpdate ? [`  Partition:        ${s.spec.updateStrategy.rollingUpdate.partition ?? 0}`] : []),
    `Pods Status:        ${C.ownedBy(s, 'pod').filter((p) => p.status.phase === 'Running').length} Running / ${C.ownedBy(s, 'pod').filter((p) => p.status.phase === 'Pending').length} Waiting / 0 Succeeded / 0 Failed`,
    ...podTemplateLines(s.spec.template),
    'Volume Claims:',
    ...(s.spec.volumeClaimTemplates || []).flatMap((t) => [`  Name:          ${t.metadata.name}`, `  StorageClass:  ${t.spec.storageClassName || ''}`, `  Capacity:      ${t.spec.resources?.requests?.storage}`, `  Access Modes:  [${(t.spec.accessModes || []).join(' ')}]`]),
    ...eventsSection(C, s),
  ],
  DaemonSet: (C, ds) => [
    ...header(ds),
    `Selector:        ${selectorString(ds.spec.selector)}`,
    `Node-Selector:   ${labelsText(ds.spec.template.spec.nodeSelector)}`,
    `Desired Number of Nodes Scheduled: ${ds.status.desiredNumberScheduled || 0}`,
    `Current Number of Nodes Scheduled: ${ds.status.currentNumberScheduled || 0}`,
    `Number of Nodes Scheduled with Up-to-date Pods: ${ds.status.updatedNumberScheduled || 0}`,
    `Number of Nodes Scheduled with Available Pods: ${ds.status.numberAvailable || 0}`,
    'Number of Nodes Misscheduled: 0',
    `Pods Status:  ${ds.status.numberReady || 0} Running / ${(ds.status.currentNumberScheduled || 0) - (ds.status.numberReady || 0)} Waiting / 0 Succeeded / 0 Failed`,
    ...podTemplateLines(ds.spec.template),
    ...eventsSection(C, ds),
  ],
  Service: (C, svc) => {
    const ep = C.store.get(C.def('endpoints'), svc.metadata.namespace, svc.metadata.name);
    const addrs = (ep?.subsets || []).flatMap((s) => (s.addresses || []).flatMap((a) => s.ports.map((p) => `${a.ip}:${p.port}`)));
    return [
      ...header(svc, [
        ['Selector', labelsText(svc.spec.selector)], ['Type', svc.spec.type], ['IP Family Policy', 'SingleStack'], ['IP Families', 'IPv4'],
        ['IP', svc.spec.clusterIP], ['IPs', svc.spec.clusterIP],
        ...(svc.spec.type === 'LoadBalancer' ? [['LoadBalancer Ingress', svc.status.loadBalancer?.ingress?.map((i) => `${i.ip} (VIP)`).join(', ') || '']] : []),
        ...(svc.spec.ports || []).flatMap((p) => [['Port', `${p.name || '<unset>'}  ${p.port}/${p.protocol}`], ['TargetPort', `${p.targetPort}/${p.protocol}`], ...(p.nodePort ? [['NodePort', `${p.name || '<unset>'}  ${p.nodePort}/${p.protocol}`]] : []), ['Endpoints', addrs.join(',') || '']]),
        ['Session Affinity', svc.spec.sessionAffinity], ['Internal Traffic Policy', 'Cluster'],
        ...(svc.spec.type !== 'ClusterIP' ? [['External Traffic Policy', 'Cluster']] : []),
      ]),
      ...eventsSection(C, svc),
    ];
  },
  Node: (C, n) => {
    const pods = C.podsOn(n.metadata.name);
    const cpuReq = pods.reduce((s, p) => s + p.spec.containers.reduce((r, c) => r + parseCpu(c.resources?.requests?.cpu), 0), 0);
    const memReq = pods.reduce((s, p) => s + p.spec.containers.reduce((r, c) => r + parseMem(c.resources?.requests?.memory), 0), 0);
    const cpuLim = pods.reduce((s, p) => s + p.spec.containers.reduce((r, c) => r + parseCpu(c.resources?.limits?.cpu), 0), 0);
    const memLim = pods.reduce((s, p) => s + p.spec.containers.reduce((r, c) => r + parseMem(c.resources?.limits?.memory), 0), 0);
    const pct = (v, total) => `${Math.round((v / total) * 100)}%`;
    const allocCpu = parseCpu(n.status.allocatable.cpu), allocMem = parseMem(n.status.allocatable.memory);
    return [
      ...block([['Name', n.metadata.name], ['Roles', nodeRoles(n)], ['Labels', labelsText(n.metadata.labels).split(',').join('\n                    ')], ['Annotations', Object.entries(n.metadata.annotations || {}).map(([k, v]) => `${k}: ${v}`).join('\n                    ')],
        ['CreationTimestamp', new Date(n.metadata.creationTimestamp).toUTCString().replace('GMT', '+0000')],
        ['Taints', (n.spec.taints || []).map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`).join('\n                    ') || '<none>'],
        ['Unschedulable', String(!!n.spec.unschedulable)]]),
      'Conditions:',
      ...indent(pad([['Type', 'Status', 'Reason', 'Message'], ['----', '------', '------', '-------'],
        ['MemoryPressure', 'False', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'],
        ['DiskPressure', 'False', 'KubeletHasNoDiskPressure', 'kubelet has no disk pressure'],
        ['PIDPressure', 'False', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'],
        ...n.status.conditions.map((c) => [c.type, c.status, c.reason, c.message])])),
      'Addresses:', ...n.status.addresses.map((a) => `  ${a.type}:  ${a.address}`),
      'Capacity:', ...Object.entries(n.status.capacity).map(([k, v]) => `  ${k}:  ${v}`),
      'Allocatable:', ...Object.entries(n.status.allocatable).map(([k, v]) => `  ${k}:  ${v}`),
      'System Info:', ...indent(block([['Kernel Version', n.status.nodeInfo.kernelVersion], ['OS Image', n.status.nodeInfo.osImage], ['Operating System', 'linux'], ['Architecture', 'amd64'], ['Container Runtime Version', n.status.nodeInfo.containerRuntimeVersion], ['Kubelet Version', n.status.nodeInfo.kubeletVersion]])),
      `PodCIDR:                      ${n.spec.podCIDR}`,
      `Non-terminated Pods:          (${pods.length} in total)`,
      ...indent(pad([['Namespace', 'Name', 'CPU Requests', 'CPU Limits', 'Memory Requests', 'Memory Limits', 'Age'], ['---------', '----', '------------', '----------', '---------------', '-------------', '---'],
        ...pods.map((p) => {
          const r = (f, res) => p.spec.containers.reduce((s, c) => s + (res === 'cpu' ? parseCpu(c.resources?.[f]?.cpu) : parseMem(c.resources?.[f]?.memory)), 0);
          return [p.metadata.namespace, p.metadata.name, `${fmtCpu(r('requests', 'cpu'))} (${pct(r('requests', 'cpu'), allocCpu)})`, `${fmtCpu(r('limits', 'cpu'))} (${pct(r('limits', 'cpu'), allocCpu)})`, `${Math.round(r('requests', 'memory') / 1024 ** 2)}Mi (${pct(r('requests', 'memory'), allocMem)})`, `${Math.round(r('limits', 'memory') / 1024 ** 2)}Mi (${pct(r('limits', 'memory'), allocMem)})`, ageOf(C, p.metadata.creationTimestamp)];
        })])),
      'Allocated resources:',
      '  (Total limits may be over 100 percent, i.e., overcommitted.)',
      ...indent(pad([['Resource', 'Requests', 'Limits'], ['--------', '--------', '------'], ['cpu', `${fmtCpu(cpuReq)} (${pct(cpuReq, allocCpu)})`, `${fmtCpu(cpuLim)} (${pct(cpuLim, allocCpu)})`], ['memory', `${Math.round(memReq / 1024 ** 2)}Mi (${pct(memReq, allocMem)})`, `${Math.round(memLim / 1024 ** 2)}Mi (${pct(memLim, allocMem)})`]])),
      ...eventsSection(C, n),
    ];
  },
  ConfigMap: (C, cm) => [...header(cm), '', 'Data', '====', ...Object.entries(cm.data || {}).flatMap(([k, v]) => [`${k}:`, '----', String(v).replace(/\n$/, ''), '']), 'BinaryData', '====', '', ...eventsSection(C, cm)],
  Secret: (C, s) => [...header(s), '', `Type:  ${s.type}`, '', 'Data', '====', ...Object.entries(s.data || {}).map(([k, v]) => `${k}:  ${C.unb64(v).length} bytes`)],
  PersistentVolumeClaim: (C, pvc) => [
    ...header(pvc, [['StorageClass', pvc.spec.storageClassName ?? '', 'top'], ['Status', pvc.status.phase, 'top'], ['Volume', pvc.spec.volumeName || '', 'top']]),
    `Finalizers:    [${(pvc.metadata.finalizers || []).join(' ')}]`,
    `Capacity:      ${pvc.status.capacity?.storage || ''}`,
    `Access Modes:  ${accessModes(pvc.status.accessModes || [])}`,
    `VolumeMode:    ${pvc.spec.volumeMode}`,
    `Used By:       ${C.store.list(C.def('pod'), pvc.metadata.namespace).filter((p) => (p.spec.volumes || []).some((v) => v.persistentVolumeClaim?.claimName === pvc.metadata.name)).map((p) => p.metadata.name).join('\n               ') || '<none>'}`,
    ...eventsSection(C, pvc),
  ],
  PersistentVolume: (C, pv) => [
    ...header(pv, [['Finalizers', `[${(pv.metadata.finalizers || []).join(' ')}]`], ['StorageClass', pv.spec.storageClassName || ''], ['Status', pv.status.phase], ['Claim', pv.spec.claimRef ? `${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}` : ''], ['Reclaim Policy', pv.spec.persistentVolumeReclaimPolicy], ['Access Modes', accessModes(pv.spec.accessModes)], ['VolumeMode', pv.spec.volumeMode || 'Filesystem'], ['Capacity', pv.spec.capacity?.storage],
      ['Node Affinity', pv.spec.nodeAffinity ? `\n  Required Terms:\n    Term 0:        kubernetes.io/hostname in [${pv.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values.join(', ')}]` : '<none>']]),
    ...eventsSection(C, pv),
  ],
  Ingress: (C, ing) => [
    ...header(ing, [['Ingress Class', ing.spec.ingressClassName || '<none>', 'top']]),
    `Address:          ${ing.status.loadBalancer?.ingress?.map((x) => x.ip).join(',') || ''}`,
    `Default backend:  ${ing.spec.defaultBackend ? `${ing.spec.defaultBackend.service.name}:${ing.spec.defaultBackend.service.port.number}` : '<default>'}`,
    ...(ing.spec.tls?.length ? ['TLS:', ...ing.spec.tls.map((t) => `  ${t.secretName} terminates ${(t.hosts || []).join(',')}`)] : []),
    'Rules:',
    ...indent(pad([['Host', 'Path', 'Backends'], ['----', '----', '--------'], ...(ing.spec.rules || []).flatMap((r) => r.http.paths.map((p, i) => {
      const ep = C.store.get(C.def('endpoints'), ing.metadata.namespace, p.backend.service.name);
      const ips = (ep?.subsets || []).flatMap((s) => (s.addresses || []).map((a) => `${a.ip}:${s.ports[0].port}`));
      return [i ? '' : r.host || '*', p.path || '/', `${p.backend.service.name}:${p.backend.service.port.number ?? p.backend.service.port.name} (${ips.join(',') || '<error: endpoints not found>'})`];
    }))])),
    ...eventsSection(C, ing),
  ],
  Job: (C, j) => [
    ...header(j),
    `Selector:         ${selectorString(j.spec.selector)}`,
    `Parallelism:      ${j.spec.parallelism}`,
    `Completions:      ${j.spec.completions}`,
    `Completion Mode:  ${j.spec.completionMode}`,
    `Suspend:          ${j.spec.suspend}`,
    `Backoff Limit:    ${j.spec.backoffLimit}`,
    ...(j.spec.ttlSecondsAfterFinished != null ? [`TTL Seconds After Finished:  ${j.spec.ttlSecondsAfterFinished}`] : []),
    ...(j.status.startTime ? [`Start Time:       ${new Date(j.status.startTime).toUTCString().replace('GMT', '+0000')}`] : []),
    ...(j.status.completionTime ? [`Completed At:     ${new Date(j.status.completionTime).toUTCString().replace('GMT', '+0000')}`, `Duration:         ${duration(C, j)}`] : []),
    `Pods Statuses:    ${j.status.active || 0} Active (${j.status.ready || 0} Ready) / ${j.status.succeeded || 0} Succeeded / ${j.status.failed || 0} Failed`,
    ...podTemplateLines(j.spec.template),
    ...eventsSection(C, j),
  ],
  CronJob: (C, c) => [
    ...header(c),
    `Schedule:                      ${c.spec.schedule}`,
    `Concurrency Policy:            ${c.spec.concurrencyPolicy}`,
    `Suspend:                       ${c.spec.suspend ? 'True' : 'False'}`,
    `Successful Job History Limit:  ${c.spec.successfulJobsHistoryLimit}`,
    `Failed Job History Limit:      ${c.spec.failedJobsHistoryLimit}`,
    `Starting Deadline Seconds:     ${c.spec.startingDeadlineSeconds ?? '<unset>'}`,
    `Last Schedule Time:            ${c.status.lastScheduleTime ? new Date(c.status.lastScheduleTime).toUTCString().replace('GMT', '+0000') : '<unset>'}`,
    `Active Jobs:                   ${(c.status.active || []).map((a) => a.name).join(', ') || '<none>'}`,
    ...eventsSection(C, c),
  ],
  HorizontalPodAutoscaler: (C, hpa) => [
    ...header(hpa, [['CreationTimestamp', new Date(hpa.metadata.creationTimestamp).toUTCString().replace('GMT', '+0000'), 'top']]),
    `Reference:                                             ${hpa.spec.scaleTargetRef.kind}/${hpa.spec.scaleTargetRef.name}`,
    'Metrics:                                               ( current / target )',
    ...(hpa.spec.metrics || []).map((m) => `  resource ${m.resource.name} on pods  (as a percentage of request):  ${hpa.status.currentMetrics?.[0]?.resource.current.averageUtilization ?? '<unknown>'}% (${hpa.status.currentMetrics?.[0]?.resource.current.averageValue ?? '<unknown>'}) / ${m.resource.target.averageUtilization}%`),
    `Min replicas:                                          ${hpa.spec.minReplicas}`,
    `Max replicas:                                          ${hpa.spec.maxReplicas}`,
    `${hpa.spec.scaleTargetRef.kind} pods:                                       ${hpa.status.currentReplicas} current / ${hpa.status.desiredReplicas} desired`,
    'Conditions:',
    ...indent(pad([['Type', 'Status', 'Reason', 'Message'], ['----', '------', '------', '-------'], ...(hpa.status.conditions || []).map((c) => [c.type, c.status, c.reason, c.message])])),
    ...eventsSection(C, hpa),
  ],
  Namespace: (C, ns) => {
    const quotas = C.store.list(C.def('resourcequota'), ns.metadata.name);
    return [...header(ns), `Status:       ${ns.status.phase}`, '', quotas.length ? 'Resource Quotas' : 'No resource quota.', ...quotas.flatMap((q) => [`  Name:  ${q.metadata.name}`, ...indent(pad([['Resource', 'Used', 'Hard'], ['--------', '---', '---'], ...Object.keys(q.spec.hard).map((k) => [k, q.status.used?.[k] ?? '0', q.spec.hard[k]])]))]), '', C.store.list(C.def('limitrange'), ns.metadata.name).length ? 'Resource Limits' : 'No LimitRange resource.'];
  },
  ResourceQuota: (C, q) => [`Name:            ${q.metadata.name}`, `Namespace:       ${q.metadata.namespace}`, ...pad([['Resource', 'Used', 'Hard'], ['--------', '----', '----'], ...Object.keys(q.spec.hard).map((k) => [k, q.status.used?.[k] ?? '0', q.spec.hard[k]])])],
  ServiceAccount: (C, sa) => [...header(sa), 'Image pull secrets:  <none>', 'Mountable secrets:   <none>', 'Tokens:              <none>', ...eventsSection(C, sa)],
  Role: (C, r) => roleLines(r),
  ClusterRole: (C, r) => roleLines(r),
  RoleBinding: (C, rb) => bindingLines(rb),
  ClusterRoleBinding: (C, rb) => bindingLines(rb),
  NetworkPolicy: (C, np) => [
    ...header(np, [['Created on', np.metadata.creationTimestamp, 'top']]),
    'Spec:',
    `  PodSelector:     ${selectorString(np.spec.podSelector) === '<none>' ? '<none> (Allowing the specific traffic to all pods in this namespace)' : selectorString(np.spec.podSelector)}`,
    ...['Ingress', 'Egress'].flatMap((dir) => {
      const rules = np.spec[dir.toLowerCase()] || [];
      const applies = (np.spec.policyTypes || ['Ingress']).includes(dir);
      if (!applies) return [`  Not affecting ${dir} traffic`];
      if (!rules.length) return [`  Allowing ${dir.toLowerCase()} traffic:`, '    <none> (Selected pods are isolated for ' + dir.toLowerCase() + ' connectivity)'];
      return [`  Allowing ${dir.toLowerCase()} traffic:`, ...rules.flatMap((r) => [`    To Port: ${(r.ports || []).map((p) => `${p.port}/${p.protocol || 'TCP'}`).join(', ') || '<any> (traffic allowed to all ports)'}`, `    ${dir === 'Ingress' ? 'From' : 'To'}:`, ...((dir === 'Ingress' ? r.from : r.to) || []).map((peer) => `      ${peer.podSelector ? `PodSelector: ${selectorString(peer.podSelector)}` : ''}${peer.namespaceSelector ? `NamespaceSelector: ${selectorString(peer.namespaceSelector)}` : ''}${peer.ipBlock ? `IPBlock: CIDR: ${peer.ipBlock.cidr}` : ''}`), '    ----------'])];
    }),
    `  Policy Types: ${(np.spec.policyTypes || ['Ingress']).join(', ')}`,
  ],
  PodDisruptionBudget: (C, p) => [`Name:           ${p.metadata.name}`, `Namespace:      ${p.metadata.namespace}`, ...(p.spec.minAvailable != null ? [`Min available:  ${p.spec.minAvailable}`] : [`Max unavailable:  ${p.spec.maxUnavailable}`]), `Selector:       ${selectorString(p.spec.selector)}`, 'Status:', `    Allowed disruptions:  ${p.status.disruptionsAllowed}`, `    Current:              ${p.status.currentHealthy}`, `    Desired:              ${p.status.desiredHealthy}`, `    Total:                ${p.status.expectedPods}`, ...eventsSection(C, p)],
  StorageClass: (C, s) => [`Name:                  ${s.metadata.name}`, `IsDefaultClass:        ${s.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? 'Yes' : 'No'}`, `Provisioner:           ${s.provisioner}`, 'Parameters:            <none>', `AllowVolumeExpansion:  ${s.allowVolumeExpansion ? 'True' : 'False'}`, 'MountOptions:          <none>', `ReclaimPolicy:         ${s.reclaimPolicy}`, `VolumeBindingMode:     ${s.volumeBindingMode}`, 'Events:                <none>'],
  Endpoints: (C, e) => [...header(e), 'Subsets:', ...(e.subsets || []).flatMap((s) => [`  Addresses:          ${(s.addresses || []).map((a) => a.ip).join(',') || '<none>'}`, `  NotReadyAddresses:  ${(s.notReadyAddresses || []).map((a) => a.ip).join(',') || '<none>'}`, '  Ports:', `    Name  Port  Protocol`, ...s.ports.map((p) => `    ${p.name || '<unset>'}  ${p.port}  ${p.protocol}`)]), '', ...eventsSection(C, e)],
};

const roleLines = (r) => [
  ...header(r),
  'PolicyRule:',
  ...indent(pad([['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], ['---------', '-----------------', '--------------', '-----'],
    ...(r.rules || []).flatMap((rule) => (rule.resources || ['']).map((res) => [rule.apiGroups?.[0] ? `${res}.${rule.apiGroups[0]}` : res, `[${(rule.nonResourceURLs || []).join(' ')}]`, `[${(rule.resourceNames || []).join(' ')}]`, `[${(rule.verbs || []).join(' ')}]`]))])),
];
const bindingLines = (rb) => [
  ...header(rb),
  'Role:', `  Kind:  ${rb.roleRef.kind}`, `  Name:  ${rb.roleRef.name}`,
  'Subjects:',
  ...indent(pad([['Kind', 'Name', 'Namespace'], ['----', '----', '---------'], ...(rb.subjects || []).map((s) => [s.kind, s.name, s.namespace || ''])])),
];

/** Lines for kubectl describe. Unknown kinds get a generic description. */
export const describe = (C, obj) => {
  const fn = DESCRIBERS[obj.kind];
  if (fn) return fn(C, obj);
  return [...header(obj), `API Version:  ${obj.apiVersion}`, `Kind:         ${obj.kind}`, ...(obj.spec ? ['Spec:', ...toYaml(obj.spec, 2).split('\n')] : []), ...(obj.status && Object.keys(obj.status).length ? ['Status:', ...toYaml(obj.status, 2).split('\n')] : []), ...eventsSection(C, obj)];
};
