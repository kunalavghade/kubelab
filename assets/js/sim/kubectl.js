// kubectl: parses a command line, talks to the simulated API server, and prints like the real
// thing. Day-two commands (rollout, logs, exec, drain, auth, …) live in kubectl-ops.js.
import { CommandError, parseArgs, flagSpec } from './util.js';
import { apiVersionOf, parseSelector, matchesSelector, clone, randSuffix, isValidQuantity } from './api.js';
import { parseYamlDocs, toYaml } from './yaml.js';
import { tableFor, describe, renderJsonPath, customColumns, sortBy, matchesFieldSelector, podStatus } from './printers.js';
import { b64encode } from './filters.js';
import { jobFromTemplate } from './controllers.js';

// ---------- small helpers ----------
export const fqName = (def) => `${def.singular}${def.group ? `.${def.group}` : ''}`;
const quoteName = (def, name) => `${fqName(def)} "${name}"`;
export const slashName = (def, name) => `${fqName(def)}/${name}`;
const ALL_TYPES = ['pods', 'services', 'daemonsets', 'deployments', 'replicasets', 'statefulsets', 'jobs', 'cronjobs', 'horizontalpodautoscalers'];
const notFoundType = (t) => new CommandError(`error: the server doesn't have a resource type "${t}"`, 'NO_TYPE');

export const GLOBAL_SPEC = { value: ['namespace:n', 'context', 'kubeconfig', 'as', 'as-group', 'request-timeout', 'v:v', 'cluster', 'user'], bool: ['all-namespaces:A'] };

/** Splits kubectl's global flags (anywhere on the line) from the rest. */
export const splitGlobals = (args) => {
  const globals = {}, rest = [];
  const value = new Map([['-n', 'namespace'], ['--namespace', 'namespace'], ['--context', 'context'], ['--kubeconfig', 'kubeconfig'], ['--as', 'as'], ['--as-group', 'as-group'], ['--request-timeout', 'request-timeout'], ['-v', 'v'], ['--v', 'v'], ['--cluster', 'cluster'], ['--user', 'user']]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i)); break; }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (value.has(name)) { globals[value.get(name)] = eq > 0 ? a.slice(eq + 1) : args[++i]; continue; }
    if (/^-n\S+$/.test(a) && !a.startsWith('--')) { globals.namespace = a.slice(2); continue; }
    if (a === '-A' || a === '--all-namespaces') { globals.all = true; continue; }
    rest.push(a);
  }
  if (globals.namespace === undefined && 'namespace' in globals) throw new CommandError('error: flag needs an argument: \'n\' in -n', 'FLAG');
  return { globals, rest };
};

// ---------- RBAC ----------
const ruleAllows = (rule, group, resource, verb, name) => (rule.apiGroups || []).some((g) => g === '*' || g === group)
  && (rule.resources || []).some((r) => r === '*' || r === resource || (r.endsWith('/*') && resource.startsWith(r.slice(0, -1))))
  && (rule.verbs || []).some((v) => v === '*' || v === verb)
  && (!rule.resourceNames?.length || (name && rule.resourceNames.includes(name)));

/** Is `who` ({user, groups}) allowed `verb` on `resource` (e.g. "pods", "pods/log") in ns? */
export const authorize = (C, who, verb, resource, ns, name) => {
  const [base, sub] = resource.split('/');
  const def = C.def(base);
  const group = def?.group ?? '';
  const full = def ? `${def.resource}${sub ? `/${sub}` : ''}` : resource;
  const subjectMatches = (s, bindingNs) => (s.kind === 'User' && s.name === who.user) || (s.kind === 'Group' && who.groups.includes(s.name))
    || (s.kind === 'ServiceAccount' && who.user === `system:serviceaccount:${s.namespace || bindingNs}:${s.name}`);
  const rulesOf = (ref, bindingNs) => {
    const role = ref.kind === 'ClusterRole' ? C.store.get(C.def('clusterrole'), null, ref.name) : C.store.get(C.def('role'), bindingNs, ref.name);
    return role?.rules || [];
  };
  const crbs = C.store.list(C.def('clusterrolebinding')).filter((b) => (b.subjects || []).some((s) => subjectMatches(s)));
  if (crbs.some((b) => rulesOf(b.roleRef).some((r) => ruleAllows(r, group, full, verb, name)))) return true;
  if (!ns || !def?.namespaced) return false;
  return C.store.list(C.def('rolebinding'), ns).filter((b) => (b.subjects || []).some((s) => subjectMatches(s, ns)))
    .some((b) => rulesOf(b.roleRef, ns).some((r) => ruleAllows(r, group, full, verb, name)));
};

export const identity = (E, globals) => {
  if (!globals.as) return { user: 'kubernetes-admin', groups: ['kubeadm:cluster-admins', 'system:authenticated'], admin: true };
  const sa = /^system:serviceaccount:([^:]+):(.+)$/.exec(globals.as);
  return { user: globals.as, groups: [...(globals['as-group'] ? [globals['as-group']] : []), ...(sa ? ['system:serviceaccounts', `system:serviceaccounts:${sa[1]}`] : []), 'system:authenticated'] };
};

export const forbidden = (who, verb, def, ns, name) => new CommandError(`Error from server (Forbidden): ${def.resource}${name ? ` "${name}"` : ''} is forbidden: User "${who.user}" cannot ${verb} resource "${def.resource}" in API group "${def.group}"${def.namespaced ? ` in the namespace "${ns}"` : ' at the cluster scope'}`, 'FORBIDDEN');

// ---------- resolving TYPE / NAME arguments ----------
export const typeDef = (C, t) => C.def(t) || (() => { throw notFoundType(t); })();

/**
 * "pods", "pod web", "deploy/web", "pods,svc", "po web-1 web-2", "all" → [{ def, names[] }].
 */
export const parseTargets = (C, pos) => {
  if (!pos.length) return [];
  if (pos.every((p) => p.includes('/'))) {
    return pos.map((p) => { const [t, n] = p.split('/'); return { def: typeDef(C, t), names: [n] }; });
  }
  const [types, ...names] = pos;
  if (names.some((n) => n.includes('/'))) throw new CommandError('error: there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. \'kubectl get resource/<resource_name>\' instead of \'kubectl get resource resource/<resource_name>\'', 'ARGS');
  const list = types.split(',').flatMap((t) => (t === 'all' ? ALL_TYPES : [t]));
  return list.map((t) => ({ def: typeDef(C, t), names, all: types === 'all' }));
};

// ---------- reading manifests ----------
const MANIFEST = /\.(ya?ml|json)$/;

/** Reads -f sources: file, directory, "-" (stdin). Returns [{ doc, source }]. */
export const readManifests = (E, paths, { stdin = [], recursive = false } = {}) => paths.flatMap((p) => {
  if (p === '-') return docsFrom(stdin.join('\n'), 'STDIN');
  if (/^https?:\/\//.test(p)) throw new CommandError(`error: unable to read URL "${p}": the simulator has no internet access — use the files in ~/k8s (ls)`, 'URL');
  if (E.files.isDir(p)) {
    const files = E.files.list(p, recursive).filter((f) => MANIFEST.test(f));
    if (!files.length) throw new CommandError(`error: no objects passed to apply`, 'EMPTY');
    return files.flatMap((f) => docsFrom(E.files.read(f), f));
  }
  const text = E.files.read(p);
  if (text == null) throw new CommandError(`error: the path "${p}" does not exist`, 'NO_FILE');
  return docsFrom(text, p);
});

const docsFrom = (text, source) => {
  const trimmed = text.trim();
  const docs = trimmed.startsWith('{') ? [JSON.parse(trimmed)] : parseYamlDocs(text);
  return docs.flatMap((d) => (d.kind === 'List' ? d.items || [] : [d])).map((doc) => {
    if (!doc.kind || !doc.apiVersion) throw new CommandError(`error: error validating "${source}": error validating data: [${!doc.apiVersion ? 'apiVersion not set' : ''}${!doc.apiVersion && !doc.kind ? ', ' : ''}${!doc.kind ? 'kind not set' : ''}]; if you choose to ignore these errors, turn validation off with --validate=false`, 'INVALID');
    return { doc, source };
  });
};

// ---------- updating existing objects ----------
const SERVER_FIELDS = new Set(['apiVersion', 'kind', 'metadata', 'status']);
const KEEP_ANNOTATIONS = /^(deployment\.kubernetes\.io\/|meta\.helm\.sh\/|pv\.kubernetes\.io\/|volume\.kubernetes\.io\/)/;

/** Applies a desired object onto the live one. Returns whether anything changed. */
export const mergeInto = (C, live, desired) => {
  const before = JSON.stringify({ ...live, metadata: { labels: live.metadata.labels, annotations: live.metadata.annotations }, status: null });
  if (live.kind === 'Deployment' || live.kind === 'StatefulSet' || live.kind === 'DaemonSet') {
    if (desired.spec?.selector && JSON.stringify(desired.spec.selector) !== JSON.stringify(live.spec.selector)) {
      throw new CommandError(`The ${live.kind} "${live.metadata.name}" is invalid: spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string{${Object.entries(desired.spec.selector.matchLabels || {}).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}}: field is immutable`, 'IMMUTABLE');
    }
  }
  if (live.kind === 'Pod') {
    const strip = (spec) => JSON.stringify({ ...spec, containers: spec.containers.map((c) => ({ name: c.name, ports: c.ports, command: c.command })) });
    if (strip(desired.spec) !== strip({ ...live.spec, containers: live.spec.containers }) && JSON.stringify(desired.spec.containers.map((c) => c.name)) !== JSON.stringify(live.spec.containers.map((c) => c.name))) {
      throw new CommandError(`The Pod "${live.metadata.name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`,\`spec.initContainers[*].image\`,\`spec.activeDeadlineSeconds\`,\`spec.tolerations\` (only additions to existing tolerations),\`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)`, 'FORBIDDEN');
    }
    live.spec.containers.forEach((c) => { const d = desired.spec.containers.find((x) => x.name === c.name); if (d) c.image = d.image; });
  } else {
    Object.keys(desired).filter((k) => !SERVER_FIELDS.has(k)).forEach((k) => {
      if (k === 'spec' && live.kind === 'Service') {
        const keep = { clusterIP: live.spec.clusterIP, clusterIPs: live.spec.clusterIPs, ipFamilies: live.spec.ipFamilies };
        live.spec = { ...clone(desired.spec), ...keep, type: desired.spec.type || 'ClusterIP', sessionAffinity: desired.spec.sessionAffinity || 'None' };
        (live.spec.ports || []).forEach((p) => { p.protocol ||= 'TCP'; p.targetPort ??= p.port; if (['NodePort', 'LoadBalancer'].includes(live.spec.type)) p.nodePort ||= C.allocNodePort(); else delete p.nodePort; });
        return;
      }
      if (k === 'spec' && live.kind === 'PersistentVolumeClaim') {
        const size = desired.spec.resources?.requests?.storage;
        if (size && size !== live.spec.resources.requests.storage) live.spec.resources.requests.storage = size;
        return;
      }
      if (k === 'stringData' && live.kind === 'Secret') { live.data = { ...live.data, ...Object.fromEntries(Object.entries(desired.stringData).map(([a, b]) => [a, b64encode(String(b))])) }; return; }
      if (k === 'spec' && desired.spec && live.spec) {
        live.spec = { ...clone(desired.spec), ...(live.kind === 'Job' ? { selector: live.spec.selector } : {}) };
        return;
      }
      live[k] = clone(desired[k]);
    });
    if (live.kind === 'Deployment') {
      live.spec.replicas ??= 1;
      live.spec.strategy ||= { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } };
      if (live.spec.strategy.type === 'RollingUpdate') live.spec.strategy.rollingUpdate = { maxSurge: '25%', maxUnavailable: '25%', ...live.spec.strategy.rollingUpdate };
      live.spec.revisionHistoryLimit ??= 10;
      live.spec.progressDeadlineSeconds ??= 600;
    }
    if (live.kind === 'StatefulSet') { live.spec.podManagementPolicy ||= 'OrderedReady'; live.spec.updateStrategy ||= { type: 'RollingUpdate', rollingUpdate: { partition: 0 } }; live.spec.replicas ??= 1; }
    if (live.kind === 'DaemonSet') live.spec.updateStrategy ||= { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } };
    if (live.kind === 'HorizontalPodAutoscaler') live.spec.minReplicas ??= 1;
  }
  const kept = Object.fromEntries(Object.entries(live.metadata.annotations || {}).filter(([k]) => KEEP_ANNOTATIONS.test(k)));
  live.metadata.labels = desired.metadata?.labels ? { ...desired.metadata.labels } : live.metadata.labels;
  const annotations = { ...kept, ...desired.metadata?.annotations };
  live.metadata.annotations = Object.keys(annotations).length ? annotations : undefined;
  C.validate(live);
  const changed = before !== JSON.stringify({ ...live, metadata: { labels: live.metadata.labels, annotations: live.metadata.annotations }, status: null });
  if (changed) C.store.update(live, { specChanged: true });
  return changed;
};

const project = (live, shape) => {
  if (Array.isArray(shape)) return Array.isArray(live) ? shape.map((s, i) => project(live[i], s)) : live;
  if (shape && typeof shape === 'object') return Object.fromEntries(Object.keys(shape).filter((k) => shape[k] !== undefined).map((k) => [k, project(live?.[k], shape[k])]));
  return live;
};

// ---------- output for get ----------
const asList = (objs) => ({ apiVersion: 'v1', items: objs, kind: 'List', metadata: { resourceVersion: '' } });
const ORDER = ['apiVersion', 'kind', 'metadata', 'spec', 'data', 'stringData', 'type', 'rules', 'roleRef', 'subjects', 'status'];
const ordered = (o) => Object.fromEntries([...ORDER.filter((k) => k in o).map((k) => [k, o[k]]), ...Object.entries(o).filter(([k]) => !ORDER.includes(k))]);

export const printObjects = (C, objs, output, { single = false, noHeaders = false, def = null } = {}) => {
  const value = single ? objs[0] : asList(objs);
  if (output === 'yaml') return toYaml(value).split('\n');
  if (output === 'json') return JSON.stringify(single ? ordered(value) : { ...value, items: value.items.map(ordered) }, null, 4).split('\n');
  if (output === 'name') return objs.map((o) => slashName(def || C.store.defOf(o), o.metadata.name));
  if (/^jsonpath=|^jsonpath-as-json=/.test(output)) return renderJsonPath(output.slice(output.indexOf('=') + 1), value).split('\n');
  if (/^custom-columns=/.test(output)) return customColumns(output.slice(15), objs, noHeaders);
  if (/^go-template=/.test(output)) return [output.slice(12).replace(/\{\{\s*\.metadata\.name\s*\}\}/g, objs[0]?.metadata.name || '')];
  throw new CommandError(`error: unable to match a printer suitable for the output format "${output}", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,name,template,templatefile,wide,yaml`, 'OUTPUT');
};

// ---------- the command set ----------
const OUTPUT_FLAGS = 'output:o';

/** Creates the kubectl command table bound to an engine context E. */
export const coreCommands = (E) => {
  const { C } = E;
  const nsOf = (g) => g.namespace || E.namespace();
  const who = (g) => identity(E, g);
  const check = (g, verb, def, ns, name) => {
    const id = who(g);
    if (!id.admin && !authorize(C, id, verb, def.resource, ns, name)) throw forbidden(id, verb, def, ns, name);
  };
  const lookup = (def, ns, name) => C.store.get(def, def.namespaced ? ns : null, name);
  const mustFind = (def, ns, name) => lookup(def, ns, name) || (() => { throw new CommandError(`Error from server (NotFound): ${def.resource}${def.group ? `.${def.group}` : ''} "${name}" not found`, 'NOT_FOUND'); })();
  const dryRun = (p) => { const v = p.get('dry-run'); if (v && v !== true && !['client', 'server', 'none'].includes(v)) throw new CommandError(`error: Invalid dry-run value (${v}). Must be "none", "server", or "client".`, 'FLAG'); return v && v !== 'none' ? (v === true ? 'client' : v) : null; };

  /** Creates (or dry-runs) an object and prints like kubectl. */
  const createOrPrint = (g, p, obj, verb = 'created') => {
    obj.metadata.namespace ||= C.store.defOf(obj)?.namespaced ? nsOf(g) : undefined;
    const def = C.store.defOf(obj);
    if (!def.namespaced) delete obj.metadata.namespace;
    const mode = dryRun(p);
    const output = p.get('output');
    if (mode === 'client') return output ? printObjects(C, [{ ...obj, metadata: { ...obj.metadata, creationTimestamp: null } }], output, { single: true }) : [`${slashName(def, obj.metadata.name)} ${verb} (dry run)`];
    check(g, 'create', def, obj.metadata.namespace, obj.metadata.name);
    const created = C.create(obj);
    C.settle();
    return [...C.warnings.splice(0), ...(output ? printObjects(C, [created], output, { single: true }) : [`${slashName(def, created.metadata.name)} ${verb}${mode === 'server' ? ' (server dry run)' : ''}`])];
  };

  // ---------- get ----------
  const get = (g, args) => {
    const p = parseArgs(args, flagSpec('watch:w show-labels no-headers ignore-not-found watch-only show-kind', `${OUTPUT_FLAGS} selector:l field-selector label-columns:L sort-by filename:f raw chunk-size template`), { command: 'kubectl get' });
    if (p.get('raw')) return rawApi(p.get('raw'));
    const output = p.get('output');
    const ns = g.all ? null : nsOf(g);
    let targets = p.get('filename') ? readManifests(E, p.all('filename')).map(({ doc }) => ({ def: C.store.defOf(doc), names: [doc.metadata.name], nsOverride: doc.metadata.namespace })) : parseTargets(C, p.pos);
    if (!targets.length) throw new CommandError('You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.\nUse "kubectl explain <resource>" for a detailed description of that resource (e.g. kubectl explain pods).\nSee \'kubectl get -h\' for help and examples', 'ARGS');
    const selector = p.get('selector') ? parseSelector(p.get('selector')) : null;
    const groups = targets.map(({ def, names, nsOverride }) => {
      check(g, names.length ? 'get' : 'list', def, ns, names[0]);
      let objs = names.length
        ? names.map((n) => { const o = lookup(def, nsOverride || ns || nsOf(g), n); if (!o && !p.has('ignore-not-found')) throw new CommandError(`Error from server (NotFound): ${def.resource}${def.group ? `.${def.group}` : ''} "${n}" not found`, 'NOT_FOUND'); return o; }).filter(Boolean)
        : C.store.list(def, def.namespaced ? ns : null);
      if (selector) objs = objs.filter((o) => matchesSelector(o.metadata.labels, selector));
      if (p.get('field-selector')) objs = objs.filter((o) => matchesFieldSelector(o, p.get('field-selector')));
      if (def.kind === 'Event') objs = sortBy(objs, '.lastTimestamp');
      if (p.get('sort-by')) objs = sortBy(objs, p.get('sort-by').replace(/^\{|\}$/g, ''));
      return { def, objs, single: names.length === 1 && targets.length === 1 };
    });
    const all = groups.flatMap((x) => x.objs);
    if (output && output !== 'wide') return printObjects(C, all, output, { single: groups.length === 1 && groups[0].single && all.length === 1, noHeaders: p.has('no-headers'), def: groups.length === 1 ? groups[0].def : null });
    const nonEmpty = groups.filter((x) => x.objs.length);
    if (!nonEmpty.length) return p.has('ignore-not-found') ? [] : [ns ? `No resources found in ${ns} namespace.` : 'No resources found'];
    const multi = targets.length > 1 || p.has('show-kind');
    const opts = { wide: output === 'wide', showNs: !!g.all, prefix: multi, labelsCol: p.has('show-labels'), extraCols: p.all('label-columns').flatMap((x) => x.split(',')), noHeaders: p.has('no-headers') };
    const lines = nonEmpty.flatMap((x, i) => [...(i ? [''] : []), ...tableFor(C, x.def, x.objs, opts)]);
    if (!p.has('watch')) return lines;
    return [...lines, ...watch(nonEmpty, opts, ns, selector)];
  };

  // -w: let time pass and print rows that changed, like a live watch.
  const watch = (groups, opts, ns, selector) => {
    const seen = new Map();
    const rowsNow = () => groups.flatMap(({ def }) => {
      let objs = C.store.list(def, def.namespaced ? ns : null);
      if (selector) objs = objs.filter((o) => matchesSelector(o.metadata.labels, selector));
      return objs.map((o) => [`${def.kind}/${o.metadata.namespace}/${o.metadata.name}`, tableFor(C, def, [o], { ...opts, noHeaders: true })[0]]);
    });
    rowsNow().forEach(([k, row]) => seen.set(k, row.replace(/\s+\S+$/, '')));
    const out = [];
    for (let i = 0; i < 6; i++) {
      C.tick();
      rowsNow().forEach(([k, row]) => {
        const sig = row.replace(/\s+\S+$/, '');
        if (seen.get(k) !== sig) { seen.set(k, sig); out.push(row); }
      });
    }
    return [...out, '^C  (the simulator stops watching after a minute of simulated time)'];
  };

  const rawApi = (path) => {
    if (path === '/healthz' || path === '/readyz' || path === '/livez') return ['ok'];
    if (path === '/version') return JSON.stringify({ major: '1', minor: '34', gitVersion: 'v1.34.2', platform: 'linux/amd64' }, null, 2).split('\n');
    const m = /^\/api\/v1\/(?:namespaces\/([^/]+)\/)?([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!m) return [JSON.stringify({ kind: 'APIVersions', versions: ['v1'] })];
    const def = typeDef(C, m[2]);
    return [JSON.stringify(m[3] ? mustFind(def, m[1], m[3]) : asList(C.store.list(def, m[1] || null)))];
  };

  // ---------- describe ----------
  const describeCmd = (g, args) => {
    const p = parseArgs(args, flagSpec('show-events', 'selector:l filename:f'), { command: 'kubectl describe' });
    const ns = g.all ? null : nsOf(g);
    const targets = p.get('filename') ? readManifests(E, p.all('filename')).map(({ doc }) => ({ def: C.store.defOf(doc), names: [doc.metadata.name] })) : parseTargets(C, p.pos);
    if (!targets.length) throw new CommandError('error: You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.', 'ARGS');
    const objs = targets.flatMap(({ def, names }) => {
      check(g, 'get', def, ns || nsOf(g), names[0]);
      if (names.length) {
        return names.map((n) => {
          const exact = lookup(def, ns || nsOf(g), n);
          if (exact) return exact;
          // describe also accepts a name prefix (describe pod web → every web-… pod)
          const prefixed = C.store.list(def, def.namespaced ? ns || nsOf(g) : null).filter((o) => o.metadata.name.startsWith(n));
          if (!prefixed.length) throw new CommandError(`Error from server (NotFound): ${def.resource}${def.group ? `.${def.group}` : ''} "${n}" not found`, 'NOT_FOUND');
          return prefixed;
        }).flat();
      }
      let list = C.store.list(def, def.namespaced ? ns : null);
      if (p.get('selector')) list = list.filter((o) => matchesSelector(o.metadata.labels, parseSelector(p.get('selector'))));
      return list;
    });
    if (!objs.length) return [`No resources found in ${ns || 'all'} namespace${ns ? '' : 's'}.`];
    return objs.flatMap((o, i) => [...(i ? ['', ''] : []), ...describe(C, o)]);
  };

  // ---------- apply / create -f / replace / diff ----------
  const sourcesOf = (p, stdin) => {
    if (p.get('kustomize')) return E.kustomize(p.get('kustomize')).map((doc) => ({ doc, source: p.get('kustomize') }));
    const files = p.all('filename');
    if (!files.length) throw new CommandError('error: must specify one of -f and -k', 'ARGS');
    return readManifests(E, files, { stdin, recursive: p.has('recursive') });
  };
  const namespaceFor = (g, def, doc) => {
    if (!def.namespaced) return undefined;
    if (doc.metadata?.namespace && g.namespace && doc.metadata.namespace !== g.namespace) throw new CommandError(`error: the namespace from the provided object "${doc.metadata.namespace}" does not match the namespace "${g.namespace}". You must pass '--namespace=${doc.metadata.namespace}' to perform this operation.`, 'NS');
    return doc.metadata?.namespace || nsOf(g);
  };

  const apply = (g, args, stdin) => {
    const p = parseArgs(args, flagSpec('recursive:R server-side force-conflicts prune validate overwrite', `filename:f kustomize:k ${OUTPUT_FLAGS} dry-run selector:l field-manager`), { command: 'kubectl apply' });
    const out = [];
    for (const { doc } of sourcesOf(p, stdin)) {
      const def = C.store.defOf(doc);
      if (!def) throw new CommandError(`error: resource mapping not found for name: "${doc.metadata?.name}" namespace: "${doc.metadata?.namespace || ''}" from "${p.get('filename') || p.get('kustomize')}": no matches for kind "${doc.kind}" in version "${doc.apiVersion}"\nensure CRDs are installed first`, 'NO_KIND');
      const obj = clone(doc);
      obj.metadata ||= {};
      obj.metadata.namespace = namespaceFor(g, def, obj);
      const live = lookup(def, obj.metadata.namespace, obj.metadata.name);
      const name = slashName(def, obj.metadata.name);
      if (!p.has('server-side')) obj.metadata.annotations = { ...obj.metadata.annotations, 'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify(doc) };
      const mode = dryRun(p);
      if (mode === 'client') { out.push(`${name} ${live ? 'configured' : 'created'} (dry run)`); continue; }
      check(g, live ? 'patch' : 'create', def, obj.metadata.namespace, obj.metadata.name);
      try {
        if (!live) { C.create(obj); out.push(...C.warnings.splice(0), `${name} ${p.has('server-side') ? 'serverside-applied' : 'created'}`); }
        else {
          const changed = mergeInto(C, live, obj);
          out.push(`${name} ${p.has('server-side') ? 'serverside-applied' : changed ? 'configured' : 'unchanged'}`);
        }
      } catch (err) {
        throw new CommandError([...out, `Error from server: error when ${live ? 'applying patch' : 'creating'} "${p.get('filename') || p.get('kustomize')}": ${err.message.replace(/^Error from server \(\w+\): /, '')}`].join('\n'), err.code);
      }
      C.settle();
    }
    return out;
  };

  const replace = (g, args, stdin) => {
    const p = parseArgs(args, flagSpec('force', 'filename:f grace-period'), { command: 'kubectl replace' });
    return sourcesOf(p, stdin).map(({ doc }) => {
      const def = C.store.defOf(doc);
      const ns = namespaceFor(g, def, doc);
      const live = mustFind(def, ns, doc.metadata.name);
      if (p.has('force')) {
        C.delete(live, { force: true });
        C.create({ ...clone(doc), metadata: { ...doc.metadata, namespace: ns } });
        C.settle();
        return `${slashName(def, doc.metadata.name)} replaced`;
      }
      mergeInto(C, live, doc);
      C.settle();
      return `${slashName(def, doc.metadata.name)} replaced`;
    });
  };

  const diff = (g, args, stdin) => {
    const p = parseArgs(args, flagSpec('server-side', 'filename:f kustomize:k'), { command: 'kubectl diff' });
    const out = [];
    for (const { doc } of sourcesOf(p, stdin)) {
      const def = C.store.defOf(doc);
      const ns = namespaceFor(g, def, doc);
      const live = lookup(def, ns, doc.metadata.name);
      const name = `${apiVersionOf(def).replace('/', '.')}.${def.kind}.${ns ? `${ns}.` : ''}${doc.metadata.name}`;
      // Only the fields the file sets are compared, so server defaults don't show up as changes.
      const desired = { spec: doc.spec, data: doc.data, metadata: { labels: doc.metadata.labels } };
      const before = live ? toYaml(project(live, desired)).split('\n') : [];
      const after = toYaml(desired).split('\n');
      if (live && JSON.stringify(before) === JSON.stringify(after)) continue;
      out.push(`diff -u -N /tmp/LIVE-${name} /tmp/MERGED-${name}`, `--- /tmp/LIVE-${name}\t2026-11-16 09:00:00`, `+++ /tmp/MERGED-${name}\t2026-11-16 09:00:00`);
      const removed = before.filter((l) => !after.includes(l));
      const added = after.filter((l) => !before.includes(l));
      out.push(`@@ -1,${before.length} +1,${after.length} @@`);
      after.forEach((l) => { if (added.includes(l)) out.push(`+${l}`); else out.push(` ${l}`); });
      removed.forEach((l) => out.push(`-${l}`));
    }
    return out;
  };

  // ---------- create ----------
  const literalData = (p, { secret = false } = {}) => {
    const data = {};
    p.all('from-literal').forEach((kv) => {
      const at = kv.indexOf('=');
      if (at < 1) throw new CommandError(`error: invalid literal source ${kv}, expected key=value`, 'ARGS');
      data[kv.slice(0, at)] = kv.slice(at + 1);
    });
    p.all('from-file').forEach((spec) => {
      const [key, path] = spec.includes('=') ? spec.split('=') : [spec.split('/').pop(), spec];
      const text = E.files.read(path);
      if (text == null) throw new CommandError(`error: error reading ${path}: no such file or directory`, 'NO_FILE');
      data[key] = text;
    });
    p.all('from-env-file').forEach((path) => {
      const text = E.files.read(path);
      if (text == null) throw new CommandError(`error: error reading ${path}: no such file or directory`, 'NO_FILE');
      text.split('\n').filter((l) => l.trim() && !l.startsWith('#')).forEach((l) => { const at = l.indexOf('='); data[l.slice(0, at)] = l.slice(at + 1); });
    });
    return secret ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64encode(v)])) : data;
  };
  const commandAfterDash = (args) => { const i = args.indexOf('--'); return i >= 0 ? [args.slice(0, i), args.slice(i + 1)] : [args, []]; };
  const meta = (name, extra = {}) => ({ name, ...extra });

  const CREATE = {
    namespace: (g, p) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: meta(p.pos[0]) }),
    deployment: (g, p, cmd) => {
      const name = p.pos[0];
      if (!p.get('image')) throw new CommandError('error: required flag(s) "image" not set', 'ARGS');
      const images = p.all('image');
      const labels = { app: name };
      return {
        apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(name, { labels }),
        spec: {
          replicas: Number(p.get('replicas', 1)), selector: { matchLabels: labels },
          template: { metadata: { labels }, spec: { containers: images.map((img) => ({ name: (img.split('/').pop().split(':')[0]).replace(/[^a-z0-9-]/g, '-'), image: img, ...(p.get('port') ? { ports: [{ containerPort: Number(p.get('port')) }] } : {}), ...(cmd.length ? { command: cmd } : {}) })) } },
          strategy: {},
        },
      };
    },
    service: (g, p) => {
      const [type, name] = p.pos;
      const TYPES = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer', externalname: 'ExternalName' };
      if (!TYPES[type]) throw new CommandError(`error: unknown command "${type}" for "kubectl create service"\nAvailable: clusterip, externalname, loadbalancer, nodeport`, 'ARGS');
      const ports = p.all('tcp').map((t) => { const [port, target] = t.split(':').map(Number); return { name: `${port}-${target ?? port}`, port, targetPort: target ?? port, protocol: 'TCP', ...(p.get('node-port') ? { nodePort: Number(p.get('node-port')) } : {}) }; });
      if (TYPES[type] !== 'ExternalName' && !ports.length) throw new CommandError('error: at least one tcp port specifier must be provided', 'ARGS');
      return { apiVersion: 'v1', kind: 'Service', metadata: meta(name, { labels: { app: name } }), spec: { type: TYPES[type], ...(TYPES[type] === 'ExternalName' ? { externalName: p.get('external-name') } : { selector: { app: name }, ports }), ...(p.get('clusterip') ? { clusterIP: p.get('clusterip') } : {}) } };
    },
    configmap: (g, p) => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta(p.pos[0]), data: literalData(p) }),
    secret: (g, p) => {
      const [type, name] = p.pos;
      if (type === 'generic') return { apiVersion: 'v1', kind: 'Secret', metadata: meta(name), type: p.get('type', 'Opaque'), data: literalData(p, { secret: true }) };
      if (type === 'tls') {
        const cert = E.files.read(p.get('cert') || ''), key = E.files.read(p.get('key') || '');
        if (cert == null || key == null) throw new CommandError(`error: open ${cert == null ? p.get('cert') : p.get('key')}: no such file or directory`, 'NO_FILE');
        return { apiVersion: 'v1', kind: 'Secret', metadata: meta(name), type: 'kubernetes.io/tls', data: { 'tls.crt': b64encode(cert), 'tls.key': b64encode(key) } };
      }
      if (type === 'docker-registry') {
        const server = p.get('docker-server', 'https://index.docker.io/v1/');
        const auth = { auths: { [server]: { username: p.get('docker-username'), password: p.get('docker-password'), email: p.get('docker-email'), auth: b64encode(`${p.get('docker-username')}:${p.get('docker-password')}`) } } };
        return { apiVersion: 'v1', kind: 'Secret', metadata: meta(name), type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': b64encode(JSON.stringify(auth)) } };
      }
      throw new CommandError(`error: unknown command "${type}" for "kubectl create secret"\nAvailable: docker-registry, generic, tls`, 'ARGS');
    },
    job: (g, p, cmd) => {
      const name = p.pos[0];
      if (p.get('from')) {
        const [kind, src] = p.get('from').split('/');
        if (!/^(cronjob|cj|cronjobs)$/.test(kind)) throw new CommandError(`error: from must be an existing cronjob: ${p.get('from')}`, 'ARGS');
        const cj = mustFind(C.def('cronjob'), nsOf(g), src);
        if (dryRun(p)) return { apiVersion: 'batch/v1', kind: 'Job', metadata: meta(name), spec: clone(cj.spec.jobTemplate.spec) };
        jobFromTemplate(C, cj, name, { manual: true });
        C.settle();
        return null;
      }
      return { apiVersion: 'batch/v1', kind: 'Job', metadata: meta(name), spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name, image: p.get('image'), ...(cmd.length ? { command: cmd } : {}) }] } } } };
    },
    cronjob: (g, p, cmd) => {
      const name = p.pos[0];
      if (!p.get('schedule')) throw new CommandError('error: required flag(s) "schedule" not set', 'ARGS');
      return { apiVersion: 'batch/v1', kind: 'CronJob', metadata: meta(name), spec: { schedule: p.get('schedule'), jobTemplate: { metadata: { name }, spec: { template: { spec: { restartPolicy: p.get('restart', 'OnFailure'), containers: [{ name, image: p.get('image'), ...(cmd.length ? { command: cmd } : {}) }] } } } } } };
    },
    serviceaccount: (g, p) => ({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta(p.pos[0]) }),
    role: (g, p) => ({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: meta(p.pos[0]), rules: rulesFrom(p) }),
    clusterrole: (g, p) => ({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: meta(p.pos[0]), rules: rulesFrom(p) }),
    rolebinding: (g, p) => bindingFrom(g, p, 'RoleBinding'),
    clusterrolebinding: (g, p) => bindingFrom(g, p, 'ClusterRoleBinding'),
    ingress: (g, p) => {
      const rules = p.all('rule').map((r) => {
        const [hostPath, backend] = r.split('=');
        const [svc, port] = backend.split(',')[0].split(':');
        const slash = hostPath.indexOf('/');
        const host = slash >= 0 ? hostPath.slice(0, slash) : hostPath;
        const path = slash >= 0 ? hostPath.slice(slash) : '/';
        return { host, path: path.replace(/\*$/, ''), pathType: path.endsWith('*') ? 'Prefix' : 'Exact', svc, port: Number(port), tls: backend.split(',')[1]?.replace('tls=', '') };
      });
      const byHost = new Map();
      rules.forEach((r) => byHost.set(r.host, [...(byHost.get(r.host) || []), r]));
      const tls = rules.filter((r) => r.tls !== undefined);
      return {
        apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: meta(p.pos[0]),
        spec: {
          ...(p.get('class') ? { ingressClassName: p.get('class') } : {}),
          rules: [...byHost.entries()].map(([host, rs]) => ({ ...(host ? { host } : {}), http: { paths: rs.map((r) => ({ path: r.path, pathType: r.pathType, backend: { service: { name: r.svc, port: { number: r.port } } } })) } })),
          ...(tls.length ? { tls: tls.map((r) => ({ hosts: [r.host], ...(r.tls ? { secretName: r.tls } : {}) })) } : {}),
        },
      };
    },
    quota: (g, p) => ({ apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta(p.pos[0]), spec: { hard: Object.fromEntries((p.get('hard') || '').split(',').filter(Boolean).map((kv) => kv.split('='))) } }),
    priorityclass: (g, p) => ({ apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: meta(p.pos[0]), value: Number(p.get('value', 0)), globalDefault: p.has('global-default'), description: p.get('description', ''), preemptionPolicy: p.get('preemption-policy', 'PreemptLowerPriority') }),
    poddisruptionbudget: (g, p) => ({ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: meta(p.pos[0]), spec: { ...(p.get('min-available') != null ? { minAvailable: /%$/.test(p.get('min-available')) ? p.get('min-available') : Number(p.get('min-available')) } : { maxUnavailable: /%$/.test(p.get('max-unavailable')) ? p.get('max-unavailable') : Number(p.get('max-unavailable')) }), selector: { matchLabels: Object.fromEntries((p.get('selector') || '').split(',').filter(Boolean).map((kv) => kv.split('='))) } } }),
    token: (g, p) => {
      const sa = mustFind(C.def('serviceaccount'), nsOf(g), p.pos[0]);
      const claims = { aud: ['https://kubernetes.default.svc.cluster.local'], exp: Math.floor(C.clock.now() / 1000) + 3600, sub: `system:serviceaccount:${sa.metadata.namespace}:${sa.metadata.name}` };
      return [`eyJhbGciOiJSUzI1NiIsImtpZCI6Imt1YmVsYWIifQ.${b64encode(JSON.stringify(claims)).replace(/=+$/, '')}.${randSuffix(20)}`];
    },
  };
  const CREATE_ALIASES = { ns: 'namespace', deploy: 'deployment', svc: 'service', cm: 'configmap', sa: 'serviceaccount', pdb: 'poddisruptionbudget', pc: 'priorityclass', cj: 'cronjob', resourcequota: 'quota' };

  const rulesFrom = (p) => {
    const verbs = p.all('verb').flatMap((v) => v.split(','));
    const resources = p.all('resource').flatMap((r) => r.split(','));
    if (!verbs.length || !resources.length) throw new CommandError('error: at least one verb and one resource must be specified', 'ARGS');
    const byGroup = new Map();
    resources.forEach((r) => {
      const [res, sub] = r.split('/');
      const [plural, ...groupParts] = res.split('.');
      const def = C.def(plural);
      if (!def) throw new CommandError(`error: the server doesn't have a resource type "${plural}"`, 'NO_TYPE');
      const group = groupParts.join('.') || def.group;
      byGroup.set(group, [...(byGroup.get(group) || []), `${def.resource}${sub ? `/${sub}` : ''}`]);
    });
    return [...byGroup.entries()].map(([group, res]) => ({ apiGroups: [group], resources: res, verbs, ...(p.all('resource-name').length ? { resourceNames: p.all('resource-name') } : {}) }));
  };
  const bindingFrom = (g, p, kind) => {
    const roleKind = p.get('clusterrole') ? 'ClusterRole' : 'Role';
    if (!p.get('clusterrole') && !p.get('role')) throw new CommandError('error: exactly one of clusterrole or role must be specified', 'ARGS');
    return {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind, metadata: meta(p.pos[0]),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: roleKind, name: p.get('clusterrole') || p.get('role') },
      subjects: [
        ...p.all('user').map((name) => ({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name })),
        ...p.all('group').map((name) => ({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name })),
        ...p.all('serviceaccount').map((s) => { const [namespace, name] = s.split(':'); if (!name) throw new CommandError(`error: serviceaccount must be <namespace>:<name>`, 'ARGS'); return { kind: 'ServiceAccount', name, namespace }; }),
      ],
    };
  };

  const create = (g, args, stdin) => {
    const [flagArgs, cmd] = commandAfterDash(args);
    const sub = CREATE_ALIASES[flagArgs[0]] || flagArgs[0];
    if (!sub || sub.startsWith('-')) {
      const p = parseArgs(flagArgs, flagSpec('save-config recursive:R', `filename:f kustomize:k ${OUTPUT_FLAGS} dry-run`), { command: 'kubectl create' });
      if (!p.get('filename') && !p.get('kustomize')) throw new CommandError('error: must specify one of -f and -k', 'ARGS');
      return sourcesOf(p, stdin).flatMap(({ doc }) => createOrPrint(g, p, clone(doc)));
    }
    if (!CREATE[sub]) throw new CommandError(`error: unknown command "${sub}" for "kubectl create"\n\nDid you mean this?\n\tdeployment`, 'ARGS');
    const p = parseArgs(flagArgs.slice(1), flagSpec('global-default save-config', `image replicas port ${OUTPUT_FLAGS} dry-run from-literal from-file from-env-file type cert key docker-server docker-username docker-password docker-email schedule restart verb resource resource-name role clusterrole user group serviceaccount rule class hard value description preemption-policy selector min-available max-unavailable tcp node-port external-name clusterip from duration`), { command: `kubectl create ${sub}` });
    if (!p.pos.length || (['service', 'secret'].includes(sub) && p.pos.length < 2)) throw new CommandError(`error: exactly one NAME is required, got 0\nSee 'kubectl create ${sub} -h' for help and examples`, 'ARGS');
    const result = CREATE[sub](g, p, cmd);
    if (result === null) return [`job.batch/${p.pos[0]} created`];
    if (Array.isArray(result)) return result;
    return createOrPrint(g, p, result);
  };

  // ---------- run / expose ----------
  const run = (g, args, stdin) => {
    const [flagArgs, cmd] = commandAfterDash(args);
    const p = parseArgs(flagArgs, flagSpec('stdin:i tty:t rm command attach expose privileged quiet:q', `image port labels:l env restart ${OUTPUT_FLAGS} dry-run overrides image-pull-policy annotations namespace`), { command: 'kubectl run' });
    const name = p.pos[0];
    if (!name) throw new CommandError('error: NAME is required for run', 'ARGS');
    if (!p.get('image')) throw new CommandError('error: required flag(s) "image" not set', 'ARGS');
    const labels = p.get('labels') ? Object.fromEntries(p.get('labels').split(',').map((kv) => kv.split('='))) : { run: name };
    const extra = p.pos.slice(1);
    const command = p.has('command') ? [...extra, ...cmd] : null;
    const pod = {
      apiVersion: 'v1', kind: 'Pod', metadata: meta(name, { labels }),
      spec: {
        restartPolicy: p.get('restart', 'Always'),
        containers: [{
          name, image: p.get('image'),
          ...(command ? { command } : cmd.length ? { args: cmd } : {}),
          ...(p.get('port') ? { ports: [{ containerPort: Number(p.get('port')) }] } : {}),
          ...(p.all('env').length ? { env: p.all('env').map((e) => { const at = e.indexOf('='); return { name: e.slice(0, at), value: e.slice(at + 1) }; }) } : {}),
          ...(p.has('stdin') ? { stdin: true, tty: p.has('tty') } : {}),
        }],
      },
    };
    if (p.get('overrides')) Object.assign(pod.spec, JSON.parse(p.get('overrides')).spec || {});
    if (dryRun(p)) return createOrPrint(g, p, pod);
    const lines = createOrPrint(g, p, pod);
    if (p.has('expose')) {
      if (!p.get('port')) throw new CommandError('error: --port must be set when exposing a service', 'ARGS');
      lines.unshift(...createOrPrint(g, p, { apiVersion: 'v1', kind: 'Service', metadata: meta(name), spec: { selector: labels, ports: [{ port: Number(p.get('port')), targetPort: Number(p.get('port')) }] } }));
    }
    if (!p.has('stdin') && !p.has('attach')) return lines;
    return E.attachRun({ ns: nsOf(g), name, rm: p.has('rm'), tty: p.has('tty'), hasCommand: cmd.length > 0 || extra.length > 0, quiet: p.has('quiet') });
  };

  const expose = (g, args) => {
    const p = parseArgs(args, flagSpec('', `port target-port type name protocol selector labels:l ${OUTPUT_FLAGS} dry-run external-ip node-port cluster-ip`), { command: 'kubectl expose' });
    const [{ def, names: [name] }] = parseTargets(C, p.pos);
    const obj = mustFind(def, nsOf(g), name);
    const selector = p.get('selector') ? Object.fromEntries(p.get('selector').split(',').map((kv) => kv.split('='))) : def.kind === 'Pod' ? obj.metadata.labels : def.kind === 'Service' ? obj.spec.selector : obj.spec.selector?.matchLabels;
    if (!selector || !Object.keys(selector).length) throw new CommandError(`error: couldn't retrieve selectors via --selector flag or introspection: the ${def.kind} has no selector`, 'ARGS');
    const containerPort = (def.kind === 'Pod' ? obj.spec : obj.spec.template?.spec)?.containers?.[0]?.ports?.[0]?.containerPort;
    const port = Number(p.get('port') ?? containerPort ?? NaN);
    if (!port) throw new CommandError(`error: couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples`, 'ARGS');
    const target = p.get('target-port') ? (/^\d+$/.test(p.get('target-port')) ? Number(p.get('target-port')) : p.get('target-port')) : port;
    const svc = { apiVersion: 'v1', kind: 'Service', metadata: meta(p.get('name') || name, { labels: { ...(obj.metadata.labels || {}) } }), spec: { type: p.get('type', 'ClusterIP'), selector, ports: [{ port, targetPort: target, protocol: p.get('protocol', 'TCP'), ...(p.get('node-port') ? { nodePort: Number(p.get('node-port')) } : {}) }] } };
    if (dryRun(p)) return createOrPrint(g, p, svc);
    check(g, 'create', C.def('service'), nsOf(g));
    C.create({ ...svc, metadata: { ...svc.metadata, namespace: nsOf(g) } });
    C.settle();
    return [`service/${svc.metadata.name} exposed`];
  };

  // ---------- delete ----------
  const del = (g, args, stdin) => {
    const p = parseArgs(args, flagSpec('all force now ignore-not-found recursive:R wait', `filename:f kustomize:k selector:l grace-period cascade field-selector timeout ${OUTPUT_FLAGS}`), { command: 'kubectl delete' });
    const ns = g.all ? null : nsOf(g);
    const opts = { force: p.has('force'), grace: p.has('now') ? 1 : p.get('grace-period') != null ? Number(p.get('grace-period')) : null, cascade: p.get('cascade', 'background') };
    let objs;
    if (p.get('filename') || p.get('kustomize')) {
      objs = sourcesOf(p, stdin).map(({ doc }) => {
        const def = C.store.defOf(doc);
        if (!def) return null;
        const o = lookup(def, namespaceFor(g, def, doc), doc.metadata.name);
        if (!o && !p.has('ignore-not-found')) throw new CommandError(`Error from server (NotFound): error when deleting "${p.get('filename')}": ${def.resource}${def.group ? `.${def.group}` : ''} "${doc.metadata.name}" not found`, 'NOT_FOUND');
        return o;
      }).filter(Boolean);
    } else {
      const targets = parseTargets(C, p.pos);
      if (!targets.length) throw new CommandError('error: You must provide one or more resources by argument or filename.\nExample resource specifications include:\n   \'-f rsrc.yaml\'\n   \'--filename=rsrc.json\'\n   \'<resource> <name>\'\n   \'<resource>\'', 'ARGS');
      objs = targets.flatMap(({ def, names }) => {
        if (!names.length && !p.has('all') && !p.get('selector') && !p.get('field-selector')) throw new CommandError('error: resource(s) were provided, but no name was specified', 'ARGS');
        if (names.length) {
          return names.map((n) => {
            const o = lookup(def, ns || nsOf(g), n);
            if (!o && !p.has('ignore-not-found')) throw new CommandError(`Error from server (NotFound): ${def.resource}${def.group ? `.${def.group}` : ''} "${n}" not found`, 'NOT_FOUND');
            return o;
          }).filter(Boolean);
        }
        let list = C.store.list(def, def.namespaced ? ns : null);
        if (p.get('selector')) list = list.filter((o) => matchesSelector(o.metadata.labels, parseSelector(p.get('selector'))));
        if (p.get('field-selector')) list = list.filter((o) => matchesFieldSelector(o, p.get('field-selector')));
        if (def.kind === 'Namespace' && p.has('all')) list = list.filter((n) => !['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(n.metadata.name));
        return list;
      });
    }
    if (!objs.length) return [ns ? `No resources found in ${ns} namespace.` : 'No resources found'];
    const out = [];
    if (opts.force && opts.grace === 0) out.push('Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.');
    objs.forEach((o) => {
      const def = C.store.defOf(o);
      check(g, 'delete', def, o.metadata.namespace, o.metadata.name);
      if (def.kind === 'Namespace' && ['default', 'kube-system', 'kube-public'].includes(o.metadata.name)) throw new CommandError(`Error from server (Forbidden): namespaces "${o.metadata.name}" is forbidden: this namespace may not be deleted`, 'FORBIDDEN');
      C.delete(o, { ...opts, force: opts.force && opts.grace === 0 });
      out.push(`${quoteName(def, o.metadata.name)} ${opts.force && opts.grace === 0 ? 'force deleted' : 'deleted'}${def.namespaced ? ` from ${o.metadata.namespace} namespace` : ''}`);
    });
    C.settle();
    // kubectl waits for the objects to disappear (pods finish terminating, namespaces empty).
    if (p.get('wait') !== false && p.get('wait') !== 'false') C.tickUntil(() => objs.every((o) => !lookup(C.store.defOf(o), o.metadata.namespace, o.metadata.name) || C.nodePower.get(o.spec?.nodeName) === false), 6);
    return out;
  };

  // ---------- label / annotate ----------
  const metaEdit = (field, verb) => (g, args) => {
    const p = parseArgs(args, flagSpec('overwrite all list', `selector:l ${OUTPUT_FLAGS} dry-run resource-version`), { command: `kubectl ${verb.replace(/ed$/, '')}` });
    const changes = p.pos.filter((x, i) => x.includes('=') || (i > 0 && x.length > 1 && x.endsWith('-')));
    const targetArgs = p.pos.filter((x) => !changes.includes(x));
    const ns = g.all ? null : nsOf(g);
    const targets = parseTargets(C, targetArgs);
    if (!targets.length) throw new CommandError(`error: one or more resources must be specified as <resource> <name> or <resource>/<name>`, 'ARGS');
    if (!changes.length && !p.has('list')) throw new CommandError(`error: at least one ${field === 'labels' ? 'label' : 'annotation'} update is required`, 'ARGS');
    const objs = targets.flatMap(({ def, names }) => (names.length ? names.map((n) => mustFind(def, ns || nsOf(g), n)) : C.store.list(def, def.namespaced ? ns : null).filter((o) => (p.get('selector') ? matchesSelector(o.metadata.labels, parseSelector(p.get('selector'))) : p.has('all')))));
    if (p.has('list')) return objs.flatMap((o) => Object.entries(o.metadata[field] || {}).map(([k, v]) => `${k}=${v}`));
    return objs.map((o) => {
      const def = C.store.defOf(o);
      const map = { ...(o.metadata[field] || {}) };
      let removed = false;
      changes.forEach((ch) => {
        if (ch.endsWith('-') && !ch.includes('=')) { delete map[ch.slice(0, -1)]; removed = true; return; }
        const at = ch.indexOf('=');
        const k = ch.slice(0, at), v = ch.slice(at + 1);
        if (k in map && map[k] !== v && !p.has('overwrite')) throw new CommandError(`error: '${k}' already has a value (${map[k]}), and --overwrite is false`, 'OVERWRITE');
        if (field === 'labels' && !/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$|^$/.test(v)) throw new CommandError(`error: invalid label value: "${ch}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character`, 'INVALID');
        map[k] = v;
      });
      const unchanged = JSON.stringify(map) === JSON.stringify(o.metadata[field] || {});
      o.metadata[field] = Object.keys(map).length ? map : undefined;
      if (!unchanged) { C.store.update(o); C.settle(); }
      return `${slashName(def, o.metadata.name)} ${unchanged ? `not ${verb}` : removed && !changes.some((c) => c.includes('=')) ? `un${verb}` : verb}`;
    });
  };

  // ---------- patch ----------
  const mergePatch = (target, patch) => {
    if (patch === null) return undefined;
    if (typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
    const out = { ...(target && typeof target === 'object' && !Array.isArray(target) ? target : {}) };
    Object.entries(patch).forEach(([k, v]) => {
      if (v === null) delete out[k];
      else if (Array.isArray(v) && Array.isArray(out[k]) && v.every((x) => x?.name)) {
        // strategic merge: lists of named items merge by name
        const merged = [...out[k]];
        v.forEach((item) => { const i = merged.findIndex((x) => x.name === item.name); if (i >= 0) merged[i] = mergePatch(merged[i], item); else merged.push(item); });
        out[k] = merged;
      } else out[k] = mergePatch(out[k], v);
    });
    return out;
  };
  const jsonPatch = (obj, ops) => {
    ops.forEach((op) => {
      const path = op.path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
      const last = path.pop();
      const parent = path.reduce((o, k) => o?.[k], obj);
      if (parent == null) throw new CommandError(`The request is invalid: the server rejected our request due to an error in our request`, 'PATCH');
      if (op.op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(last), 1); else delete parent[last]; }
      else if (op.op === 'add' && Array.isArray(parent)) parent.splice(last === '-' ? parent.length : Number(last), 0, op.value);
      else parent[last] = op.value;
    });
  };
  const patch = (g, args) => {
    const p = parseArgs(args, flagSpec('local', `patch:p type ${OUTPUT_FLAGS} dry-run filename:f subresource`), { command: 'kubectl patch' });
    const [{ def, names: [name] }] = parseTargets(C, p.pos);
    const obj = mustFind(def, nsOf(g), name);
    check(g, 'patch', def, nsOf(g), name);
    let body;
    try { body = JSON.parse(p.get('patch')); } catch { body = parseYamlDocs(p.get('patch') || '')[0]; }
    const before = JSON.stringify(obj);
    const next = clone(obj);
    if (p.get('type') === 'json') jsonPatch(next, body);
    else Object.assign(next, mergePatch(next, body));
    if (JSON.stringify(next) === before) return [`${slashName(def, name)} patched (no change)`];
    if (def.kind === 'Pod') mergeInto(C, obj, next); else { Object.assign(obj, next); C.validate(obj); C.store.update(obj, { specChanged: true }); }
    C.settle();
    return [`${slashName(def, name)} patched`];
  };

  // ---------- scale / autoscale / set ----------
  const SCALABLE = new Set(['Deployment', 'ReplicaSet', 'StatefulSet']);
  const scale = (g, args) => {
    const p = parseArgs(args, flagSpec('all', 'replicas current-replicas selector:l filename:f timeout'), { command: 'kubectl scale' });
    if (p.get('replicas') == null) throw new CommandError('error: required flag(s) "replicas" not set', 'ARGS');
    const n = Number(p.get('replicas'));
    if (!Number.isInteger(n) || n < 0) throw new CommandError('error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0', 'ARGS');
    const targets = parseTargets(C, p.pos);
    return targets.flatMap(({ def, names }) => names.map((name) => {
      if (!SCALABLE.has(def.kind)) throw new CommandError(`error: no objects passed to scale ${def.resource} "${name}" is not scalable`, 'ARGS');
      const obj = mustFind(def, nsOf(g), name);
      check(g, 'patch', def, nsOf(g), name);
      if (p.get('current-replicas') != null && Number(p.get('current-replicas')) !== obj.spec.replicas) throw new CommandError(`error: Expected replicas to be ${p.get('current-replicas')}, was ${obj.spec.replicas}`, 'PRECONDITION');
      obj.spec.replicas = n;
      C.store.update(obj, { specChanged: true });
      C.settle();
      return `${slashName(def, name)} scaled`;
    }));
  };

  const autoscale = (g, args) => {
    const p = parseArgs(args, flagSpec('', `min max cpu-percent cpu name ${OUTPUT_FLAGS} dry-run`), { command: 'kubectl autoscale' });
    const [{ def, names: [name] }] = parseTargets(C, p.pos);
    mustFind(def, nsOf(g), name);
    if (!p.get('max')) throw new CommandError('error: required flag(s) "max" not set', 'ARGS');
    const cpu = Number(String(p.get('cpu') ?? p.get('cpu-percent') ?? 80).replace('%', ''));
    const hpa = { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: meta(p.get('name') || name), spec: { scaleTargetRef: { apiVersion: apiVersionOf(def), kind: def.kind, name }, minReplicas: Number(p.get('min', 1)), maxReplicas: Number(p.get('max')), metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: cpu } } }] } };
    if (dryRun(p)) return createOrPrint(g, p, hpa);
    C.create({ ...hpa, metadata: { ...hpa.metadata, namespace: nsOf(g) } });
    C.settle();
    return [`horizontalpodautoscaler.autoscaling/${hpa.metadata.name} autoscaled`];
  };

  const podSpecOf = (obj) => (obj.kind === 'Pod' ? obj.spec : obj.kind === 'CronJob' ? obj.spec.jobTemplate.spec.template.spec : obj.spec.template.spec);
  const SET = {
    image: (g, p, obj, def) => {
      const pairs = p.pos.slice(obj ? 1 : 0).filter((x) => x.includes('='));
      const spec = podSpecOf(obj);
      let changed = false;
      pairs.forEach((pair) => {
        const [ctr, image] = pair.split('=');
        const targets = ctr === '*' ? [...spec.containers, ...(spec.initContainers || [])] : [...spec.containers, ...(spec.initContainers || [])].filter((c) => c.name === ctr);
        if (!targets.length) throw new CommandError(`error: unable to find container named "${ctr}"`, 'NO_CONTAINER');
        targets.forEach((c) => { if (c.image !== image) { c.image = image; changed = true; } });
      });
      return changed ? 'image updated' : null;
    },
    env: (g, p, obj) => {
      const spec = podSpecOf(obj);
      const ctrs = p.get('containers') ? spec.containers.filter((c) => c.name === p.get('containers')) : spec.containers;
      if (p.has('list')) return { list: ctrs.flatMap((c) => [`# ${def0(obj)} ${obj.metadata.name}, container ${c.name}`, ...(c.env || []).map((e) => `${e.name}=${e.value ?? `{from ${e.valueFrom?.configMapKeyRef ? 'configmap' : 'secret'}}`}`)]) };
      const pairs = p.pos.slice(1).filter((x) => x.includes('=') || x.endsWith('-'));
      ctrs.forEach((c) => {
        pairs.forEach((pair) => {
          if (pair.endsWith('-') && !pair.includes('=')) { c.env = (c.env || []).filter((e) => e.name !== pair.slice(0, -1)); return; }
          const at = pair.indexOf('=');
          const env = (c.env || []).filter((e) => e.name !== pair.slice(0, at));
          c.env = [...env, { name: pair.slice(0, at), value: pair.slice(at + 1) }];
        });
        if (p.get('from')) {
          const [kind, name] = p.get('from').split('/');
          const ref = /^(configmap|cm)$/.test(kind) ? 'configMapRef' : 'secretRef';
          c.envFrom = [...(c.envFrom || []), { [ref]: { name } }];
        }
        if (c.env && !c.env.length) delete c.env;
      });
      return 'env updated';
    },
    resources: (g, p, obj) => {
      const spec = podSpecOf(obj);
      const ctrs = p.get('containers') ? spec.containers.filter((c) => c.name === p.get('containers')) : spec.containers;
      const parse = (s) => Object.fromEntries((s || '').split(',').filter(Boolean).map((kv) => {
        const [k, v] = kv.split('=');
        if (!isValidQuantity(v)) throw new CommandError(`error: quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'`, 'INVALID');
        return [k, v];
      }));
      ctrs.forEach((c) => {
        c.resources ||= {};
        if (p.get('limits')) c.resources.limits = { ...c.resources.limits, ...parse(p.get('limits')) };
        if (p.get('requests')) c.resources.requests = { ...c.resources.requests, ...parse(p.get('requests')) };
      });
      return 'resource requirements updated';
    },
    serviceaccount: (g, p, obj) => { podSpecOf(obj).serviceAccountName = p.pos.at(-1); return 'serviceaccount updated'; },
    sa: (g, p, obj) => SET.serviceaccount(g, p, obj),
  };
  const def0 = (obj) => obj.kind.toLowerCase();
  const set = (g, args) => {
    const [sub, ...rest] = args;
    if (!SET[sub]) throw new CommandError(`error: unknown command "${sub}" for "kubectl set"\nAvailable: env, image, resources, selector, serviceaccount, subject`, 'ARGS');
    const p = parseArgs(rest, flagSpec('all list local overwrite', `containers:c limits requests from selector:l ${OUTPUT_FLAGS} dry-run filename:f prefix keys`), { command: `kubectl set ${sub}` });
    const target = p.pos[0];
    const [type, name] = target.includes('/') ? target.split('/') : [target, p.pos[1]];
    const def = typeDef(C, type);
    const obj = mustFind(def, nsOf(g), name);
    check(g, 'patch', def, nsOf(g), name);
    if (!target.includes('/')) p.pos.splice(0, 1);
    if (def.kind === 'Pod' && sub !== 'image') throw new CommandError(`The Pod "${name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`,\`spec.initContainers[*].image\`,\`spec.activeDeadlineSeconds\`,\`spec.tolerations\` (only additions to existing tolerations),\`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)\n# (change the Deployment that owns the pod instead, or delete and recreate the pod)`, 'FORBIDDEN');
    const result = SET[sub](g, p, obj, def);
    if (result?.list) return result.list;
    if (!result) return [];
    C.validate(obj);
    C.store.update(obj, { specChanged: true });
    C.settle();
    return [`${slashName(def, name)} ${result}`];
  };

  return {
    get, describe: describeCmd, apply, create, replace, diff, run, expose, delete: del, patch, scale, autoscale, set,
    label: metaEdit('labels', 'labeled'), annotate: metaEdit('annotations', 'annotated'),
    edit: (g, args) => { throw new CommandError(`error: the simulator can't open an editor for "kubectl edit ${args.join(' ')}".\nUse one of these instead:\n  kubectl patch ${args.join(' ') || 'deployment web'} -p '{"spec":{"replicas":5}}'\n  kubectl set image / set env / set resources …\n  kubectl get ${args.join(' ') || 'deployment web'} -o yaml > web.yaml, change it with sed -i, then kubectl apply -f web.yaml`, 'EDITOR'); },
  };
};

export { podStatus };
