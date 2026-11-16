// The simulated API server: resource types, an object store with defaulting and validation,
// label selectors, resource quantities and the simulated clock.
import { CommandError } from './util.js';

// ---------- resource types ----------
const kindDef = (kind, resource, group, version, namespaced, short = [], extra = {}) => ({ kind, resource, singular: kind.toLowerCase(), group, version, namespaced, short, ...extra });

export const BUILTIN_KINDS = [
  kindDef('Pod', 'pods', '', 'v1', true, ['po']),
  kindDef('Service', 'services', '', 'v1', true, ['svc']),
  kindDef('Endpoints', 'endpoints', '', 'v1', true, ['ep']),
  kindDef('ConfigMap', 'configmaps', '', 'v1', true, ['cm']),
  kindDef('Secret', 'secrets', '', 'v1', true),
  kindDef('Namespace', 'namespaces', '', 'v1', false, ['ns']),
  kindDef('Node', 'nodes', '', 'v1', false, ['no']),
  kindDef('PersistentVolume', 'persistentvolumes', '', 'v1', false, ['pv']),
  kindDef('PersistentVolumeClaim', 'persistentvolumeclaims', '', 'v1', true, ['pvc']),
  kindDef('ServiceAccount', 'serviceaccounts', '', 'v1', true, ['sa']),
  kindDef('Event', 'events', '', 'v1', true, ['ev']),
  kindDef('ResourceQuota', 'resourcequotas', '', 'v1', true, ['quota']),
  kindDef('LimitRange', 'limitranges', '', 'v1', true, ['limits']),
  kindDef('Deployment', 'deployments', 'apps', 'v1', true, ['deploy']),
  kindDef('ReplicaSet', 'replicasets', 'apps', 'v1', true, ['rs']),
  kindDef('StatefulSet', 'statefulsets', 'apps', 'v1', true, ['sts']),
  kindDef('DaemonSet', 'daemonsets', 'apps', 'v1', true, ['ds']),
  kindDef('ControllerRevision', 'controllerrevisions', 'apps', 'v1', true),
  kindDef('Job', 'jobs', 'batch', 'v1', true),
  kindDef('CronJob', 'cronjobs', 'batch', 'v1', true, ['cj']),
  kindDef('HorizontalPodAutoscaler', 'horizontalpodautoscalers', 'autoscaling', 'v2', true, ['hpa']),
  kindDef('Ingress', 'ingresses', 'networking.k8s.io', 'v1', true, ['ing']),
  kindDef('IngressClass', 'ingressclasses', 'networking.k8s.io', 'v1', false),
  kindDef('NetworkPolicy', 'networkpolicies', 'networking.k8s.io', 'v1', true, ['netpol']),
  kindDef('EndpointSlice', 'endpointslices', 'discovery.k8s.io', 'v1', true),
  kindDef('PodDisruptionBudget', 'poddisruptionbudgets', 'policy', 'v1', true, ['pdb']),
  kindDef('Role', 'roles', 'rbac.authorization.k8s.io', 'v1', true),
  kindDef('RoleBinding', 'rolebindings', 'rbac.authorization.k8s.io', 'v1', true),
  kindDef('ClusterRole', 'clusterroles', 'rbac.authorization.k8s.io', 'v1', false),
  kindDef('ClusterRoleBinding', 'clusterrolebindings', 'rbac.authorization.k8s.io', 'v1', false),
  kindDef('StorageClass', 'storageclasses', 'storage.k8s.io', 'v1', false, ['sc']),
  kindDef('PriorityClass', 'priorityclasses', 'scheduling.k8s.io', 'v1', false, ['pc']),
  kindDef('CustomResourceDefinition', 'customresourcedefinitions', 'apiextensions.k8s.io', 'v1', false, ['crd', 'crds']),
  kindDef('Lease', 'leases', 'coordination.k8s.io', 'v1', true),
];

export const apiVersionOf = (def) => (def.group ? `${def.group}/${def.version}` : def.version);

// ---------- quantities ----------
const MEM_UNITS = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };

/** "250m" → 250, "1" → 1000, "1.5" → 1500 (millicores). */
export const parseCpu = (q) => {
  if (q == null || q === '') return 0;
  const s = String(q);
  return s.endsWith('m') ? Number(s.slice(0, -1)) : Math.round(Number(s) * 1000);
};

/** "64Mi" → bytes. */
export const parseMem = (q) => {
  if (q == null || q === '') return 0;
  const m = /^([\d.]+)([A-Za-z]*)$/.exec(String(q));
  if (!m) return 0;
  return Math.round(Number(m[1]) * (MEM_UNITS[m[2]] || 1));
};

export const fmtCpu = (milli) => (milli % 1000 === 0 ? String(milli / 1000) : `${Math.round(milli)}m`);
export const fmtMemMi = (bytes) => `${Math.round(bytes / 1024 ** 2)}Mi`;
export const isValidQuantity = (q) => /^\d+(\.\d+)?(m|Ki|Mi|Gi|Ti|k|K|M|G|T)?$/.test(String(q));

// ---------- simulated clock ----------
export const TICK_SECONDS = 10;
const EPOCH = Date.UTC(2026, 10, 16, 9, 0, 0);

export const createClock = () => {
  let seconds = 0;
  return {
    now: () => EPOCH + seconds * 1000,
    seconds: () => seconds,
    advance: (s = TICK_SECONDS) => { seconds += s; },
    iso: (t) => new Date(t ?? EPOCH + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
};

/** kubectl's human durations: 45s, 3m20s, 25m, 5h10m, 3d4h. */
export const humanAge = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  if (m < 180) return `${m}m`;
  const hrs = Math.floor(m / 60);
  if (hrs < 8) return `${hrs}h${m % 60 ? `${m % 60}m` : ''}`;
  if (hrs < 48) return `${hrs}h`;
  const d = Math.floor(hrs / 24);
  return `${d}d${hrs % 24 && d < 8 ? `${hrs % 24}h` : ''}`;
};

// ---------- label selectors ----------
const parseRequirement = (raw) => {
  const r = raw.trim();
  let m;
  if ((m = /^([\w./-]+)\s+(in|notin)\s+\(([^)]*)\)$/.exec(r))) return { key: m[1], operator: m[2] === 'in' ? 'In' : 'NotIn', values: m[3].split(',').map((v) => v.trim()) };
  if ((m = /^!([\w./-]+)$/.exec(r))) return { key: m[1], operator: 'DoesNotExist' };
  if ((m = /^([\w./-]+)\s*(==|=|!=)\s*([\w./-]*)$/.exec(r))) return { key: m[1], operator: m[2] === '!=' ? 'NotIn' : 'In', values: [m[3]] };
  if ((m = /^([\w./-]+)$/.exec(r))) return { key: m[1], operator: 'Exists' };
  throw new CommandError(`error: unable to parse requirement: found '${r}', expected: identifier`, 'SELECTOR');
};

/** "app=web,tier in (a,b),!legacy" → matchExpressions-style requirements. */
export const parseSelector = (text) => {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of String(text)) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && !depth) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(parseRequirement);
};

const meets = (labels, { key, operator, values = [] }) => {
  const has = Object.prototype.hasOwnProperty.call(labels, key);
  switch (operator) {
    case 'In': return has && values.includes(String(labels[key]));
    case 'NotIn': return !has || !values.includes(String(labels[key]));
    case 'Exists': return has;
    case 'DoesNotExist': return !has;
    default: return false;
  }
};

/** Matches a LabelSelector object ({matchLabels, matchExpressions}) or a parsed requirement list. */
export const matchesSelector = (labels = {}, selector) => {
  if (!selector) return false;
  const reqs = Array.isArray(selector) ? selector : [
    ...Object.entries(selector.matchLabels || {}).map(([key, v]) => ({ key, operator: 'In', values: [String(v)] })),
    ...(selector.matchExpressions || []),
  ];
  return reqs.every((r) => meets(labels || {}, r));
};

/** A plain map selector (Service.spec.selector): every key must match; empty matches nothing. */
export const matchesMap = (labels = {}, map) => !!map && Object.keys(map).length > 0 && Object.entries(map).every(([k, v]) => labels?.[k] === String(v));

export const selectorString = (sel) => {
  if (!sel) return '<none>';
  const reqs = [
    ...Object.entries(sel.matchLabels || (sel.matchExpressions ? {} : sel)).map(([k, v]) => `${k}=${v}`),
    ...(sel.matchExpressions || []).map((e) => (e.operator === 'Exists' ? e.key : e.operator === 'DoesNotExist' ? `!${e.key}` : `${e.key} ${e.operator.toLowerCase()} (${e.values.join(',')})`)),
  ];
  return reqs.join(',') || '<none>';
};

// ---------- names and ids ----------
const SAFE = 'bcdfghjklmnpqrstvwxz2456789';
export const randSuffix = (n = 5) => Array.from({ length: n }, () => SAFE[Math.floor(Math.random() * SAFE.length)]).join('');
export const uid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
/** Stable short hash of any JSON-able value — used for pod-template-hash. */
export const hashOf = (value, n = 10) => {
  let x = 2166136261;
  for (const ch of JSON.stringify(value)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  let out = '';
  while (out.length < n) { x = Math.imul(x ^ (x >>> 13), 2246822507) >>> 0; out += SAFE[x % SAFE.length]; }
  return out;
};

export const DNS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
export const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

// ---------- the store ----------
export class NotFoundError extends CommandError {
  constructor(def, name) { super(`Error from server (NotFound): ${def.resource}${def.group ? `.${def.group}` : ''} "${name}" not found`, 'NOT_FOUND'); }
}

/**
 * Holds every API object. Objects are plain Kubernetes-shaped JSON; `key()` indexes them by
 * resource, namespace and name. Defaulting and validation hooks run on create/update.
 */
export const createStore = (clock) => {
  const kinds = new Map(); // lower-case name/short/plural → def
  const objects = new Map();
  let resourceVersion = 1000;
  const watchers = [];

  const registerKind = (def) => {
    [def.kind.toLowerCase(), def.resource, def.singular, ...def.short, `${def.resource}.${def.group}`, `${def.singular}.${def.group}`]
      .filter(Boolean).forEach((n) => kinds.set(n.toLowerCase(), def));
  };
  BUILTIN_KINDS.forEach(registerKind);

  const key = (def, ns, name) => `${def.resource}|${def.namespaced ? ns || 'default' : ''}|${name}`;
  const defFor = (name) => kinds.get(String(name).toLowerCase()) || null;
  const defOf = (obj) => [...kinds.values()].find((d) => d.kind === obj.kind && (!obj.apiVersion || apiVersionOf(d) === obj.apiVersion || d.group === obj.apiVersion.split('/')[0])) || defFor(obj.kind);

  const notify = (type, obj) => watchers.forEach((w) => w(type, obj));

  const get = (def, ns, name) => objects.get(key(def, ns, name)) || null;
  const mustGet = (def, ns, name) => get(def, ns, name) || (() => { throw new NotFoundError(def, name); })();
  const list = (def, ns = null) => [...objects.values()].filter((o) => o.kind === def.kind && (o.apiVersion === apiVersionOf(def) || def.group === '' || (o.apiVersion || '').startsWith(def.group)) && (!def.namespaced || ns == null || o.metadata.namespace === ns))
    .sort((a, b) => (a.metadata.namespace || '').localeCompare(b.metadata.namespace || '') || a.metadata.name.localeCompare(b.metadata.name));

  const put = (obj) => {
    const def = defOf(obj);
    objects.set(key(def, obj.metadata.namespace, obj.metadata.name), obj);
  };

  const create = (input, hooks = {}) => {
    const def = defOf(input);
    if (!def) throw new CommandError(`error: resource mapping not found for name: "${input.metadata?.name}" namespace: "" from "STDIN": no matches for kind "${input.kind}" in version "${input.apiVersion}"\nensure CRDs are installed first`, 'NO_KIND');
    const obj = clone(input);
    obj.apiVersion ||= apiVersionOf(def);
    obj.metadata ||= {};
    if (!obj.metadata.name && obj.metadata.generateName) obj.metadata.name = `${obj.metadata.generateName}${randSuffix()}`;
    const { name } = obj.metadata;
    if (!name) throw new CommandError('error: resource name may not be empty', 'INVALID');
    if (!DNS_NAME.test(name) || name.length > 253) throw new CommandError(`The ${def.kind} "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character`, 'INVALID');
    if (def.namespaced) obj.metadata.namespace ||= 'default';
    else delete obj.metadata.namespace;
    if (def.namespaced && def.kind !== 'Event') {
      const ns = get(defFor('namespace'), null, obj.metadata.namespace);
      if (!ns) throw new CommandError(`Error from server (NotFound): namespaces "${obj.metadata.namespace}" not found`, 'NOT_FOUND');
      if (ns.status?.phase === 'Terminating') throw new CommandError(`Error from server (Forbidden): ${def.resource} "${name}" is forbidden: unable to create new content in namespace ${obj.metadata.namespace} because it is being terminated`, 'FORBIDDEN');
    }
    if (get(def, obj.metadata.namespace, name)) throw new CommandError(`Error from server (AlreadyExists): ${def.resource}${def.group ? `.${def.group}` : ''} "${name}" already exists`, 'ALREADY_EXISTS');
    Object.assign(obj.metadata, {
      uid: uid(), creationTimestamp: clock.iso(), resourceVersion: String(++resourceVersion),
      ...(obj.spec ? { generation: 1 } : {}),
    });
    hooks.default?.(obj, def);
    hooks.validate?.(obj, def);
    hooks.admit?.(obj, def);
    put(obj);
    if (def.kind === 'CustomResourceDefinition') registerCrd(obj);
    notify('ADDED', obj);
    return obj;
  };

  const update = (obj, { specChanged = false } = {}) => {
    obj.metadata.resourceVersion = String(++resourceVersion);
    if (specChanged && obj.metadata.generation) obj.metadata.generation += 1;
    put(obj);
    notify('MODIFIED', obj);
    return obj;
  };

  const remove = (obj) => {
    const def = defOf(obj);
    objects.delete(key(def, obj.metadata.namespace, obj.metadata.name));
    if (def.kind === 'CustomResourceDefinition') unregisterCrd(obj);
    notify('DELETED', obj);
  };

  const crdDef = (crd) => {
    const { names, group, versions, scope } = crd.spec;
    const version = (versions || []).find((v) => v.storage)?.name || versions?.[0]?.name || 'v1';
    return kindDef(names.kind, names.plural, group, version, scope !== 'Cluster', names.shortNames || [], { singular: names.singular || names.kind.toLowerCase(), custom: true });
  };
  const registerCrd = (crd) => registerKind(crdDef(crd));
  const unregisterCrd = (crd) => {
    const def = crdDef(crd);
    [...kinds.entries()].filter(([, d]) => d.kind === def.kind && d.group === def.group).forEach(([k]) => kinds.delete(k));
    [...objects.values()].filter((o) => o.kind === def.kind).forEach(remove);
  };

  return {
    defFor, defOf, get, mustGet, list, create, update, remove,
    allKinds: () => [...new Set(kinds.values())],
    all: () => [...objects.values()],
    watch: (fn) => watchers.push(fn),
    resourceVersion: () => resourceVersion,
  };
};
