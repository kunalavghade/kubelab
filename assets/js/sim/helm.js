// Helm: chart repos, a small Go-template renderer, and releases with revisions. Releases are
// stored the way Helm 3 stores them: as Secrets of type helm.sh/release.v1 in the release namespace.
import { CommandError, parseArgs, flagSpec } from './util.js';
import { parseYaml, parseYamlDocs, toYaml } from './yaml.js';
import { clone, randSuffix } from './api.js';
import { b64encode } from './filters.js';
import { mergeInto } from './kubectl.js';

const HELM_VERSION = 'v3.19.2';

// ---------- Go templates ----------
const splitTop = (text, sep) => {
  const parts = [];
  let quote = false, depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '"') quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && !depth && ch === sep) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter((p) => p !== '');
};
const words = (cmd) => cmd.match(/"(?:[^"\\]|\\.)*"|\([^)]*\)|\S+/g) || [];
const lookup = (ctx, path) => path.split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), ctx);
const indentText = (s, n) => String(s).split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

const FUNCS = {
  default: (dflt, v) => (v === undefined || v === null || v === '' ? dflt : v),
  quote: (v) => JSON.stringify(String(v ?? '')),
  squote: (v) => `'${v ?? ''}'`,
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  trunc: (n, v) => String(v).slice(0, n),
  trimSuffix: (s, v) => (String(v).endsWith(s) ? String(v).slice(0, -s.length) : String(v)),
  printf: (fmt, ...args) => { let i = 0; return fmt.replace(/%[sdv]/g, () => String(args[i++])); },
  toYaml: (v) => (v == null ? '' : toYaml(v)),
  nindent: (n, v) => `\n${indentText(v, n)}`,
  indent: (n, v) => indentText(v, n),
  int: (v) => Number.parseInt(v, 10),
  eq: (a, b) => a === b, ne: (a, b) => a !== b, not: (v) => !v,
  and: (...a) => a.every(Boolean), or: (...a) => a.find(Boolean) ?? a.at(-1),
  b64enc: (v) => b64encode(String(v)),
  randAlphaNum: (n) => randSuffix(n),
  required: (msg, v) => { if (v == null || v === '') throw new CommandError(`Error: execution error: ${msg}`, 'HELM'); return v; },
};

const evalArg = (ctx, tok) => {
  if (tok.startsWith('"')) return JSON.parse(tok);
  if (tok.startsWith('(')) return evalPipeline(ctx, tok.slice(1, -1));
  if (/^-?\d+$/.test(tok)) return Number(tok);
  if (tok === 'true' || tok === 'false') return tok === 'true';
  if (tok === '.') return ctx.dot;
  if (tok.startsWith('$.')) return lookup(ctx.root, tok.slice(2));
  if (tok.startsWith('.')) return lookup(ctx.dot, tok.slice(1));
  return tok;
};

const evalPipeline = (ctx, text) => {
  let value;
  splitTop(text, '|').forEach((cmd, i) => {
    const [head, ...rest] = words(cmd);
    const fn = FUNCS[head];
    if (!fn) { value = evalArg(ctx, head); return; }
    const args = rest.map((t) => evalArg(ctx, t));
    value = fn(...args, ...(i > 0 ? [value] : []));
  });
  return value;
};

/** Renders a template with {{ }}, {{- -}}, if/else/end, range/end and with/end. */
export const renderTemplate = (text, root) => {
  const tokens = [];
  const re = /\{\{(-?)\s*([\s\S]*?)\s*(-?)\}\}/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    let before = text.slice(last, m.index);
    if (m[1]) before = before.replace(/\s+$/, '');
    tokens.push({ text: before });
    tokens.push({ action: m[2], trimRight: !!m[3] });
    last = m.index + m[0].length;
  }
  tokens.push({ text: text.slice(last) });
  for (let i = 1; i < tokens.length; i++) if (tokens[i - 1].trimRight && tokens[i].text != null) tokens[i].text = tokens[i].text.replace(/^\s+/, '');

  let pos = 0;
  const block = (ctx, stopAt) => {
    let out = '';
    while (pos < tokens.length) {
      const t = tokens[pos++];
      if (t.text != null) { out += t.text; continue; }
      const a = t.action;
      if (a.startsWith('/*')) continue;
      if (stopAt.some((s) => a === s || a.startsWith(`${s} `))) { pos--; return out; }
      const kw = /^(if|range|with)\s+(.*)$/.exec(a);
      if (!kw) { const v = evalPipeline(ctx, a); out += v == null ? '' : typeof v === 'object' ? toYaml(v) : String(v); continue; }
      const [, keyword, expr] = kw;
      const value = evalPipeline(ctx, expr);
      if (keyword === 'range') {
        const start = pos;
        const items = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
        if (!items.length) { block(ctx, ['end']); pos++; continue; }
        items.forEach((item) => { pos = start; out += block({ ...ctx, dot: item }, ['end']); });
        pos++;
        continue;
      }
      const truthy = !!value && !(Array.isArray(value) && !value.length) && !(typeof value === 'object' && !Object.keys(value).length);
      const body = block(keyword === 'with' ? { ...ctx, dot: value } : ctx, ['else', 'end']);
      let elseBody = '';
      if (tokens[pos]?.action === 'else') { pos++; elseBody = block(ctx, ['end']); }
      pos++;
      out += truthy ? body : elseBody;
    }
    return out;
  };
  return block({ root, dot: root }, []);
};

// ---------- charts ----------
const BITNAMI_NGINX = {
  'Chart.yaml': 'apiVersion: v2\nname: nginx\nversion: 18.2.5\nappVersion: 1.27.3\ndescription: NGINX Open Source is a web server that can be also used as a reverse proxy, load balancer, and HTTP cache.\n',
  'values.yaml': 'replicaCount: 1\nimage:\n  registry: docker.io\n  repository: bitnami/nginx\n  tag: 1.27.3\nservice:\n  type: LoadBalancer\n  ports:\n    http: 80\nresources: {}\n',
  'templates/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}-nginx\n  labels:\n    app.kubernetes.io/name: nginx\n    app.kubernetes.io/instance: {{ .Release.Name }}\n    app.kubernetes.io/managed-by: Helm\nspec:\n  replicas: {{ .Values.replicaCount }}\n  selector:\n    matchLabels:\n      app.kubernetes.io/name: nginx\n      app.kubernetes.io/instance: {{ .Release.Name }}\n  template:\n    metadata:\n      labels:\n        app.kubernetes.io/name: nginx\n        app.kubernetes.io/instance: {{ .Release.Name }}\n    spec:\n      containers:\n      - name: nginx\n        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"\n        ports:\n        - name: http\n          containerPort: 8080\n        {{- with .Values.resources }}\n        resources:{{ toYaml . | nindent 10 }}\n        {{- end }}\n',
  'templates/svc.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ .Release.Name }}-nginx\n  labels:\n    app.kubernetes.io/instance: {{ .Release.Name }}\n    app.kubernetes.io/managed-by: Helm\nspec:\n  type: {{ .Values.service.type }}\n  selector:\n    app.kubernetes.io/name: nginx\n    app.kubernetes.io/instance: {{ .Release.Name }}\n  ports:\n  - name: http\n    port: {{ .Values.service.ports.http }}\n    targetPort: http\n',
  'templates/NOTES.txt': 'CHART NAME: {{ .Chart.Name }}\nCHART VERSION: {{ .Chart.Version }}\nAPP VERSION: {{ .Chart.AppVersion }}\n\n** Please be patient while the chart is being deployed **\nNGINX can be accessed through the following DNS name from within your cluster:\n\n    {{ .Release.Name }}-nginx.{{ .Release.Namespace }}.svc.cluster.local (port 80)\n',
};
const BITNAMI_REDIS = {
  'Chart.yaml': 'apiVersion: v2\nname: redis\nversion: 20.3.0\nappVersion: 7.4.1\ndescription: Redis(R) is an open source, advanced key-value store.\n',
  'values.yaml': 'architecture: replication\nauth:\n  enabled: true\n  password: ""\nreplica:\n  replicaCount: 2\nmaster:\n  persistence:\n    size: 1Gi\n',
  'templates/secret.yaml': '{{- if .Values.auth.enabled }}\napiVersion: v1\nkind: Secret\nmetadata:\n  name: {{ .Release.Name }}-redis\ntype: Opaque\ndata:\n  redis-password: {{ .Values.auth.password | default (randAlphaNum 10) | b64enc | quote }}\n{{- end }}\n',
  'templates/headless-svc.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ .Release.Name }}-redis-headless\nspec:\n  clusterIP: None\n  selector:\n    app.kubernetes.io/instance: {{ .Release.Name }}\n  ports:\n  - name: tcp-redis\n    port: 6379\n',
  'templates/master/service.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ .Release.Name }}-redis-master\nspec:\n  selector:\n    app.kubernetes.io/instance: {{ .Release.Name }}\n    app.kubernetes.io/component: master\n  ports:\n  - name: tcp-redis\n    port: 6379\n',
  'templates/master/statefulset.yaml': 'apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: {{ .Release.Name }}-redis-master\nspec:\n  replicas: 1\n  serviceName: {{ .Release.Name }}-redis-headless\n  selector:\n    matchLabels:\n      app.kubernetes.io/instance: {{ .Release.Name }}\n      app.kubernetes.io/component: master\n  template:\n    metadata:\n      labels:\n        app.kubernetes.io/instance: {{ .Release.Name }}\n        app.kubernetes.io/component: master\n    spec:\n      containers:\n      - name: redis\n        image: bitnami/redis:7.4.1\n        ports:\n        - containerPort: 6379\n  volumeClaimTemplates:\n  - metadata:\n      name: redis-data\n    spec:\n      accessModes: ["ReadWriteOnce"]\n      resources:\n        requests:\n          storage: {{ .Values.master.persistence.size }}\n',
  'templates/replicas/statefulset.yaml': '{{- if eq .Values.architecture "replication" }}\napiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: {{ .Release.Name }}-redis-replicas\nspec:\n  replicas: {{ .Values.replica.replicaCount }}\n  serviceName: {{ .Release.Name }}-redis-headless\n  selector:\n    matchLabels:\n      app.kubernetes.io/instance: {{ .Release.Name }}\n      app.kubernetes.io/component: replica\n  template:\n    metadata:\n      labels:\n        app.kubernetes.io/instance: {{ .Release.Name }}\n        app.kubernetes.io/component: replica\n    spec:\n      containers:\n      - name: redis\n        image: bitnami/redis:7.4.1\n        ports:\n        - containerPort: 6379\n{{- end }}\n',
  'templates/NOTES.txt': 'CHART NAME: {{ .Chart.Name }}\nCHART VERSION: {{ .Chart.Version }}\nAPP VERSION: {{ .Chart.AppVersion }}\n\nRedis&reg; can be accessed on the following DNS names from within your cluster:\n\n    {{ .Release.Name }}-redis-master.{{ .Release.Namespace }}.svc.cluster.local for read/write operations (port 6379)\n\nTo get your password run:\n\n    export REDIS_PASSWORD=$(kubectl get secret --namespace {{ .Release.Namespace }} {{ .Release.Name }}-redis -o jsonpath="{.data.redis-password}" | base64 -d)\n',
};
const BITNAMI_POSTGRES = {
  'Chart.yaml': 'apiVersion: v2\nname: postgresql\nversion: 16.2.0\nappVersion: 17.2.0\ndescription: PostgreSQL (Postgres) is an open source object-relational database.\n',
  'values.yaml': 'auth:\n  postgresPassword: ""\n  database: app\nprimary:\n  persistence:\n    size: 1Gi\n',
  'templates/secret.yaml': 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: {{ .Release.Name }}-postgresql\ntype: Opaque\ndata:\n  postgres-password: {{ .Values.auth.postgresPassword | default (randAlphaNum 10) | b64enc | quote }}\n',
  'templates/svc.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ .Release.Name }}-postgresql\nspec:\n  selector:\n    app.kubernetes.io/instance: {{ .Release.Name }}\n  ports:\n  - name: tcp-postgresql\n    port: 5432\n',
  'templates/statefulset.yaml': 'apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: {{ .Release.Name }}-postgresql\nspec:\n  replicas: 1\n  serviceName: {{ .Release.Name }}-postgresql\n  selector:\n    matchLabels:\n      app.kubernetes.io/instance: {{ .Release.Name }}\n  template:\n    metadata:\n      labels:\n        app.kubernetes.io/instance: {{ .Release.Name }}\n    spec:\n      containers:\n      - name: postgresql\n        image: postgres:17\n        env:\n        - name: POSTGRES_PASSWORD\n          valueFrom:\n            secretKeyRef:\n              name: {{ .Release.Name }}-postgresql\n              key: postgres-password\n        ports:\n        - containerPort: 5432\n  volumeClaimTemplates:\n  - metadata:\n      name: data\n    spec:\n      accessModes: ["ReadWriteOnce"]\n      resources:\n        requests:\n          storage: {{ .Values.primary.persistence.size }}\n',
  'templates/NOTES.txt': 'PostgreSQL can be accessed via port 5432 on the following DNS name from within your cluster:\n\n    {{ .Release.Name }}-postgresql.{{ .Release.Namespace }}.svc.cluster.local\n',
};
const REPOS = {
  bitnami: { url: 'https://charts.bitnami.com/bitnami', charts: { nginx: BITNAMI_NGINX, redis: BITNAMI_REDIS, postgresql: BITNAMI_POSTGRES } },
  'ingress-nginx': { url: 'https://kubernetes.github.io/ingress-nginx', charts: {} },
  'prometheus-community': { url: 'https://prometheus-community.github.io/helm-charts', charts: {} },
  jetstack: { url: 'https://charts.jetstack.io', charts: {} },
};

// ---------- values ----------
const deepMerge = (a, b) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : clone(b);
  const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
  Object.entries(b).forEach(([k, v]) => { out[k] = deepMerge(out[k], v); });
  return out;
};
const setPath = (obj, path, raw) => {
  const keys = path.split('.');
  const value = /^-?\d+$/.test(raw) ? Number(raw) : raw === 'true' || raw === 'false' ? raw === 'true' : raw === 'null' ? null : raw;
  keys.slice(0, -1).reduce((o, k) => (o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}), obj)[keys.at(-1)] = value;
  return obj;
};

export const createHelm = (E) => {
  const { C } = E;
  const state = E.helmState;
  const nsOf = (p) => p.get('namespace') || E.namespace();
  const fmtDate = (t) => new Date(t).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4');

  /** Loads a chart: a local directory, or repo/chart from an added repository. */
  const loadChart = (ref) => {
    if (E.files.isDir(ref)) {
      const files = Object.fromEntries(E.files.list(ref, true).map((f) => [f.slice(ref.replace(/\/$/, '').length + 1), E.files.read(f)]));
      if (!files['Chart.yaml']) throw new CommandError(`Error: Chart.yaml file is missing`, 'HELM');
      return files;
    }
    const [repo, name] = ref.split('/');
    if (!name) throw new CommandError(`Error: INSTALLATION FAILED: non-absolute URLs should be in form of repo_name/path_to_chart, got: ${ref}`, 'HELM');
    if (!state.repos.has(repo)) throw new CommandError(`Error: INSTALLATION FAILED: repo ${repo} not found`, 'HELM');
    const chart = REPOS[repo]?.charts[name];
    if (!chart) throw new CommandError(`Error: INSTALLATION FAILED: chart "${name}" matching  not found in ${repo} index. (try 'helm repo update'): no chart name found`, 'HELM');
    return chart;
  };

  const userValues = (p) => {
    let vals = {};
    p.all('values').forEach((f) => {
      const text = E.files.read(f);
      if (text == null) throw new CommandError(`Error: open ${f}: no such file or directory`, 'HELM');
      vals = deepMerge(vals, parseYaml(text) || {});
    });
    p.all('set').forEach((s) => s.split(',').forEach((kv) => { const at = kv.indexOf('='); setPath(vals, kv.slice(0, at), kv.slice(at + 1)); }));
    p.all('set-string').forEach((s) => { const at = s.indexOf('='); setPath(vals, s.slice(0, at), `${s.slice(at + 1)}`); });
    return vals;
  };

  const render = (chart, name, ns, values, revision = 1) => {
    const meta = parseYaml(chart['Chart.yaml']);
    const root = { Values: deepMerge(parseYaml(chart['values.yaml'] || '') || {}, values), Release: { Name: name, Namespace: ns, Revision: revision, Service: 'Helm', IsInstall: revision === 1, IsUpgrade: revision > 1 }, Chart: { Name: meta.name, Version: meta.version, AppVersion: meta.appVersion }, Capabilities: { KubeVersion: { Version: 'v1.34.2' } } };
    const sources = Object.entries(chart).filter(([f]) => f.startsWith('templates/') && /\.ya?ml$/.test(f)).sort(([a], [b]) => a.localeCompare(b));
    const rendered = sources.map(([f, text]) => ({ source: `${meta.name}/${f}`, text: renderTemplate(text, root) })).filter((r) => r.text.trim());
    const notes = chart['templates/NOTES.txt'] ? renderTemplate(chart['templates/NOTES.txt'], root) : '';
    return { meta, rendered, notes, docs: rendered.flatMap((r) => parseYamlDocs(r.text)) };
  };

  const releaseKey = (ns, name) => `${ns}/${name}`;
  const storeRevision = (ns, name, rev) => {
    C.store.list(C.def('secret'), ns).filter((s) => s.metadata.labels?.owner === 'helm' && s.metadata.labels.name === name).forEach((s) => { s.metadata.labels.status = 'superseded'; C.store.update(s); });
    C.create({ apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1', metadata: { name: `sh.helm.release.v1.${name}.v${rev.revision}`, namespace: ns, labels: { name, owner: 'helm', status: rev.status, version: String(rev.revision) } }, data: { release: b64encode(JSON.stringify({ name, version: rev.revision })).slice(0, 40) } });
  };

  /** Makes the cluster match the rendered manifests: create, update and prune. */
  const sync = (ns, name, docs, previous = []) => {
    const keyOf = (d) => `${d.kind}/${d.metadata.namespace || ns}/${d.metadata.name}`;
    docs.forEach((d) => {
      const obj = clone(d);
      const def = C.store.defOf(obj);
      obj.metadata.namespace = def.namespaced ? obj.metadata.namespace || ns : undefined;
      obj.metadata.labels = { ...obj.metadata.labels, 'app.kubernetes.io/managed-by': 'Helm' };
      obj.metadata.annotations = { ...obj.metadata.annotations, 'meta.helm.sh/release-name': name, 'meta.helm.sh/release-namespace': ns };
      const live = C.store.get(def, obj.metadata.namespace, obj.metadata.name);
      if (live) mergeInto(C, live, obj); else C.create(obj);
    });
    const wanted = new Set(docs.map(keyOf));
    previous.filter((d) => !wanted.has(keyOf(d))).forEach((d) => {
      const def = C.store.defOf(d);
      const live = C.store.get(def, def.namespaced ? d.metadata.namespace || ns : null, d.metadata.name);
      if (live) C.delete(live);
    });
    C.settle();
  };

  const statusLines = (rel, rev, { notes = true } = {}) => [
    `NAME: ${rel.name}`, `LAST DEPLOYED: ${fmtDate(rev.updated)}`, `NAMESPACE: ${rel.ns}`, `STATUS: ${rev.status}`, `REVISION: ${rev.revision}`, 'TEST SUITE: None',
    ...(notes && rev.notes ? ['NOTES:', ...rev.notes.replace(/\n$/, '').split('\n')] : []),
  ];

  const install = (args, { upgrade = false } = {}) => {
    const p = parseArgs(args, flagSpec('create-namespace dry-run install wait atomic generate-name reuse-values reset-values debug force', 'namespace:n values:f set set-string version timeout description'), { command: upgrade ? 'helm upgrade' : 'helm install' });
    const genName = p.has('generate-name');
    const [nameArg, chartRef] = genName ? [null, p.pos[0]] : p.pos;
    const ns = nsOf(p);
    if (!chartRef) throw new CommandError(`Error: "helm ${upgrade ? 'upgrade' : 'install'}" requires 2 arguments\n\nUsage:  helm ${upgrade ? 'upgrade [RELEASE] [CHART]' : 'install [NAME] [CHART]'} [flags]`, 'HELM');
    const chart = loadChart(chartRef);
    const name = nameArg || `${parseYaml(chart['Chart.yaml']).name}-${Math.floor(C.clock.now() / 1000)}`;
    const key = releaseKey(ns, name);
    const rel = state.releases.get(key);
    if (!upgrade && rel && rel.revisions.at(-1).status !== 'uninstalled') throw new CommandError('Error: INSTALLATION FAILED: cannot re-use a name that is still in use', 'HELM');
    if (upgrade && !rel && !p.has('install')) throw new CommandError(`Error: UPGRADE FAILED: "${name}" has no deployed releases`, 'HELM');
    if (!C.store.get(C.def('namespace'), null, ns)) {
      if (!p.has('create-namespace')) throw new CommandError(`Error: INSTALLATION FAILED: create: failed to create: namespaces "${ns}" not found`, 'HELM');
      C.create({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } });
      C.settle();
    }
    const prev = rel?.revisions.at(-1);
    const values = p.has('reuse-values') && prev ? deepMerge(prev.values, userValues(p)) : userValues(p);
    const revision = (prev?.revision || 0) + 1;
    const out = render(chart, name, ns, values, revision);
    if (p.has('dry-run')) return [...statusLines({ name, ns }, { revision, status: 'pending-install', updated: C.clock.now(), notes: '' }, { notes: false }), 'HOOKS:', 'MANIFEST:', ...out.rendered.flatMap((r) => ['---', `# Source: ${r.source}`, ...r.text.trim().split('\n')])];
    try {
      sync(ns, name, out.docs, prev?.docs || []);
    } catch (err) {
      throw new CommandError(`Error: ${upgrade ? 'UPGRADE' : 'INSTALLATION'} FAILED: ${err.message.replace(/^Error from server \(\w+\): /, '')}`, 'HELM');
    }
    const entry = { revision, chart: `${out.meta.name}-${out.meta.version}`, appVersion: String(out.meta.appVersion), values, docs: out.docs, notes: out.notes, status: 'deployed', updated: C.clock.now(), description: revision === 1 ? 'Install complete' : 'Upgrade complete', chartRef };
    if (prev) prev.status = 'superseded';
    const release = rel || { name, ns, revisions: [] };
    release.revisions.push(entry);
    state.releases.set(key, release);
    storeRevision(ns, name, entry);
    if (p.has('wait') || p.has('atomic')) C.tickUntil(() => C.store.list(C.def('pod'), ns).filter((x) => x.metadata.labels?.['app.kubernetes.io/instance'] === name).every((x) => C.isPodReady(x)), 8);
    return [...(upgrade && rel ? [`Release "${name}" has been upgraded. Happy Helming!`] : upgrade ? [`Release "${name}" does not exist. Installing it now.`] : []), ...statusLines(release, entry)];
  };

  const findRelease = (p, name) => {
    const rel = state.releases.get(releaseKey(nsOf(p), name));
    if (!rel || rel.revisions.at(-1).status === 'uninstalled') throw new CommandError(`Error: release: not found`, 'HELM');
    return rel;
  };
  const table = (rows) => {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('\t').trimEnd());
  };

  const COMMANDS = {
    version: () => [`version.BuildInfo{Version:"${HELM_VERSION}", GitCommit:"8f2d5d4", GitTreeState:"clean", GoVersion:"go1.24.9"}`],
    repo: (args) => {
      const [sub, ...rest] = args;
      const SUBS = {
        add: () => {
          const [name, url] = rest;
          if (!name || !url) throw new CommandError('Error: "helm repo add" requires 2 arguments', 'HELM');
          if (state.repos.has(name)) return [`"${name}" already exists with the same configuration, skipping`];
          state.repos.set(name, url);
          return [`"${name}" has been added to your repositories`];
        },
        list: () => (state.repos.size ? table([['NAME', 'URL'], ...[...state.repos.entries()]]) : ['Error: no repositories to show']),
        ls: () => SUBS.list(),
        update: () => (state.repos.size ? ['Hang tight while we grab the latest from your chart repositories...', ...[...state.repos.keys()].map((r) => `...Successfully got an update from the "${r}" chart repository`), 'Update Complete. ⎈Happy Helming!⎈'] : ['Error: no repositories found. You must add one before updating']),
        remove: () => { rest.forEach((r) => state.repos.delete(r)); return rest.map((r) => `"${r}" has been removed from your repositories`); },
      };
      if (!SUBS[sub]) throw new CommandError(`Error: unknown command "${sub}" for "helm repo"`, 'HELM');
      return SUBS[sub]();
    },
    search: (args) => {
      const [where, keyword = ''] = args;
      if (where === 'hub') return table([['URL', 'CHART VERSION', 'APP VERSION', 'DESCRIPTION'], ['https://artifacthub.io/packages/helm/bitnami/nginx', '18.2.5', '1.27.3', 'NGINX Open Source is a web server…'], ['https://artifacthub.io/packages/helm/bitnami/redis', '20.3.0', '7.4.1', 'Redis(R) is an open source, advanced key-value store…']]);
      const rows = [...state.repos.keys()].flatMap((r) => Object.entries(REPOS[r]?.charts || {}).map(([n, c]) => { const m = parseYaml(c['Chart.yaml']); return [`${r}/${n}`, m.version, m.appVersion, m.description.slice(0, 60)]; })).filter((r) => r[0].includes(keyword));
      return rows.length ? table([['NAME', 'CHART VERSION', 'APP VERSION', 'DESCRIPTION'], ...rows]) : ['No results found'];
    },
    install: (args) => install(args),
    upgrade: (args) => install(args, { upgrade: true }),
    list: (args) => {
      const p = parseArgs(args, flagSpec('all-namespaces:A all:a short:q', 'namespace:n output:o filter'), { command: 'helm list' });
      const rels = [...state.releases.values()].filter((r) => (p.has('all-namespaces') || r.ns === nsOf(p)) && (p.has('all') || r.revisions.at(-1).status === 'deployed'));
      if (p.has('short')) return rels.map((r) => r.name);
      return table([['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION'], ...rels.map((r) => { const v = r.revisions.at(-1); return [r.name, r.ns, v.revision, `${new Date(v.updated).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '.000000 +0000 UTC')}`, v.status, v.chart, v.appVersion]; })]);
    },
    status: (args) => { const p = parseArgs(args, flagSpec('show-resources', 'namespace:n output:o revision'), { command: 'helm status' }); const rel = findRelease(p, p.pos[0]); return statusLines(rel, rel.revisions.at(-1)); },
    history: (args) => {
      const p = parseArgs(args, flagSpec('', 'namespace:n max output:o'), { command: 'helm history' });
      const rel = findRelease(p, p.pos[0]);
      return table([['REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION', 'DESCRIPTION'], ...rel.revisions.map((v) => [v.revision, fmtDate(v.updated), v.status, v.chart, v.appVersion, v.description])]);
    },
    rollback: (args) => {
      const p = parseArgs(args, flagSpec('wait dry-run force', 'namespace:n timeout'), { command: 'helm rollback' });
      const rel = findRelease(p, p.pos[0]);
      const current = rel.revisions.at(-1);
      const target = p.pos[1] ? rel.revisions.find((v) => v.revision === Number(p.pos[1])) : rel.revisions.at(-2);
      if (!target) throw new CommandError(`Error: release has no ${p.pos[1] || 'previous'} version`, 'HELM');
      sync(rel.ns, rel.name, target.docs, current.docs);
      current.status = 'superseded';
      const entry = { ...target, revision: current.revision + 1, status: 'deployed', updated: C.clock.now(), description: `Rollback to ${target.revision}` };
      rel.revisions.push(entry);
      storeRevision(rel.ns, rel.name, entry);
      return ['Rollback was a success! Happy Helming!'];
    },
    uninstall: (args) => {
      const p = parseArgs(args, flagSpec('keep-history dry-run wait', 'namespace:n timeout'), { command: 'helm uninstall' });
      return p.pos.map((name) => {
        const rel = findRelease(p, name);
        sync(rel.ns, name, [], rel.revisions.at(-1).docs);
        C.store.list(C.def('secret'), rel.ns).filter((s) => s.metadata.labels?.owner === 'helm' && s.metadata.labels.name === name).forEach((s) => C.store.remove(s));
        if (p.has('keep-history')) rel.revisions.at(-1).status = 'uninstalled'; else state.releases.delete(releaseKey(rel.ns, name));
        return `release "${name}" uninstalled`;
      });
    },
    template: (args) => {
      const p = parseArgs(args, flagSpec('debug include-crds', 'namespace:n values:f set set-string show-only:s version'), { command: 'helm template' });
      const [name, chartRef] = p.pos.length > 1 ? p.pos : ['release-name', p.pos[0]];
      const out = render(loadChart(chartRef), name, nsOf(p), userValues(p));
      return out.rendered.filter((r) => !p.get('show-only') || r.source.endsWith(p.get('show-only'))).flatMap((r) => ['---', `# Source: ${r.source}`, ...r.text.trim().split('\n')]);
    },
    show: (args) => {
      const [what, ref] = args;
      const chart = loadChart(ref || '');
      const SHOW = { values: () => (chart['values.yaml'] || '').trimEnd().split('\n'), chart: () => chart['Chart.yaml'].trimEnd().split('\n'), readme: () => [`# ${parseYaml(chart['Chart.yaml']).name}`, '', parseYaml(chart['Chart.yaml']).description], all: () => [...SHOW.chart(), '---', ...SHOW.values()] };
      if (!SHOW[what]) throw new CommandError(`Error: unknown command "${what}" for "helm show"`, 'HELM');
      return SHOW[what]();
    },
    get: (args) => {
      const [what, ...rest] = args;
      const p = parseArgs(rest, flagSpec('all:a', 'namespace:n revision output:o'), { command: `helm get ${what}` });
      const rel = findRelease(p, p.pos[0]);
      const rev = p.get('revision') ? rel.revisions.find((v) => v.revision === Number(p.get('revision'))) : rel.revisions.at(-1);
      const GET = {
        values: () => (p.has('all') ? ['COMPUTED VALUES:', ...toYaml(deepMerge(parseYaml(loadChart(rev.chartRef)['values.yaml'] || '') || {}, rev.values)).split('\n')] : ['USER-SUPPLIED VALUES:', ...(Object.keys(rev.values).length ? toYaml(rev.values).split('\n') : ['null'])]),
        manifest: () => rev.docs.flatMap((d) => ['---', ...toYaml(d).split('\n')]),
        notes: () => ['NOTES:', ...rev.notes.split('\n')],
        all: () => [...statusLines(rel, rev), ...GET.values(), 'MANIFEST:', ...GET.manifest()],
      };
      if (!GET[what]) throw new CommandError(`Error: unknown command "${what}" for "helm get"`, 'HELM');
      return GET[what]();
    },
    create: (args) => {
      const name = args[0];
      if (!name) throw new CommandError('Error: "helm create" requires 1 argument', 'HELM');
      const files = {
        [`${name}/Chart.yaml`]: `apiVersion: v2\nname: ${name}\ndescription: A Helm chart for Kubernetes\ntype: application\nversion: 0.1.0\nappVersion: "1.16.0"\n`,
        [`${name}/values.yaml`]: 'replicaCount: 1\nimage:\n  repository: nginx\n  tag: "1.27"\nservice:\n  type: ClusterIP\n  port: 80\n',
        [`${name}/templates/deployment.yaml`]: E.files.read('charts/web/templates/deployment.yaml').replace(/-web/g, `-${name}`).replace(/containerPort: 8080/, 'containerPort: 80'),
        [`${name}/templates/service.yaml`]: E.files.read('charts/web/templates/service.yaml').replace(/-web/g, `-${name}`).replace(/targetPort: 8080/, 'targetPort: 80'),
        [`${name}/templates/NOTES.txt`]: `1. Get the application URL by running:\n  kubectl port-forward svc/{{ .Release.Name }}-${name} 8080:80\n`,
      };
      Object.entries(files).forEach(([f, c]) => E.files.write(f, c));
      return [`Creating ${name}`];
    },
    lint: (args) => {
      const ref = args.find((a) => !a.startsWith('-')) || '.';
      loadChart(ref);
      return [`==> Linting ${ref}`, '[INFO] Chart.yaml: icon is recommended', '', '1 chart(s) linted, 0 chart(s) failed'];
    },
    env: () => ['HELM_BIN="helm"', 'HELM_NAMESPACE="default"', 'HELM_REPOSITORY_CONFIG="/home/you/.config/helm/repositories.yaml"'],
  };
  COMMANDS.ls = COMMANDS.list;
  COMMANDS.delete = COMMANDS.uninstall;
  COMMANDS.un = COMMANDS.uninstall;

  return (args) => {
    const [sub, ...rest] = args;
    if (!sub || sub === 'help' || sub === '--help') return ['The Kubernetes package manager', '', 'Usage:', '  helm [command]', '', 'Available Commands:', '  create      create a new chart with the given name', '  get         download extended information of a named release', '  history     fetch release history', '  install     install a chart', '  lint        examine a chart for possible issues', '  list        list releases', '  repo        add, list, remove, update, and index chart repositories', '  rollback    roll back a release to a previous revision', '  search      search for a keyword in charts', '  show        show information of a chart', '  status      display the status of the named release', '  template    locally render templates', '  uninstall   uninstall a release', '  upgrade     upgrade a release', '  version     print the client version information'];
    if (!COMMANDS[sub]) throw new CommandError(`Error: unknown command "${sub}" for "helm"\nRun 'helm --help' for usage.`, 'HELM');
    return COMMANDS[sub](rest);
  };
};
