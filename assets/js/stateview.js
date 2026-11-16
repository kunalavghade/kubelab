// A live picture of the simulated cluster next to every terminal: nodes with their pods,
// workloads, Services, config and storage. Things that appear since the last render pop in.
import { h } from './dom.js';

const STATUS_CLASS = (p) => {
  if (p.status === 'Terminating') return 'terminating';
  if (p.status === 'Completed') return 'succeeded';
  if (/BackOff|Err|Error|OOMKilled|CreateContainerConfigError|Failed|Evicted/.test(p.status)) return 'crash';
  if (p.status === 'Running') return p.ready ? 'ready' : 'running';
  if (p.status === 'Pending') return 'pending';
  return 'creating';
};
const short = (name, n = 22) => (name.length > n ? `${name.slice(0, n - 1)}…` : name);

/** Returns { el, render(state) }. compact=true (command labs) keeps system pods folded away. */
export const createStateView = ({ compact = false } = {}) => {
  const seen = new Set();
  let showSystem = false;
  let last = null;
  const el = h('div', { class: 'pg-vis sv' });
  const panel = (label, count, body, cls = '') => h('div', { class: `pg-panel ${cls}` }, h('h4', {}, label, h('small', {}, count)), body);
  const empty = (text) => h('div', { class: 'pg-empty' }, text);

  const render = (S) => {
    last = S;
    const known = new Set(seen);
    const mark = (key) => { const cls = known.size && !known.has(key) ? 'pop' : ''; seen.add(key); return cls; };
    const userNs = (ns) => !['kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx', 'local-path-storage'].includes(ns);
    const nsTag = (ns) => (ns !== S.namespace ? h('span', { class: 'sv-ns' }, ns) : null);
    const podChip = (p) => h('span', { class: `sv-pod ${STATUS_CLASS(p)} ${p.system ? 'sys' : ''} ${mark(`p:${p.ns}/${p.name}:${p.status}`)}`, title: `${p.ns}/${p.name} — ${p.status}${p.restarts ? ` (${p.restarts} restarts)` : ''}` },
      h('i', { class: 'k-dot' }), short(p.name), p.restarts ? h('b', {}, `↻${p.restarts}`) : null);

    const systemCount = S.pods.filter((p) => p.system).length;
    const nodes = S.nodes.map((n) => {
      const pods = n.pods.filter((p) => showSystem || !p.system);
      const hidden = n.pods.length - pods.length;
      return h('div', { class: `sv-node ${n.ready ? '' : 'down'} ${n.cordoned ? 'cordoned' : ''} ${n.controlPlane ? 'cp' : ''}` },
        h('div', { class: 'sv-node-head' }, h('b', {}, `${n.controlPlane ? '🧠' : '🖥'} ${n.name}`), h('span', { class: `sv-state ${n.ready ? (n.cordoned ? 'warn' : 'ok') : 'bad'}` }, n.ready ? (n.cordoned ? 'cordoned' : 'Ready') : 'NotReady')),
        n.taints.length || n.labels.length ? h('div', { class: 'sv-tags' }, ...n.taints.map((t) => h('span', { class: 'sv-taint', title: `taint ${t}` }, `⛔ ${t.replace(/^node-role\.kubernetes\.io\//, '')}`)), ...n.labels.filter((l) => !l.startsWith('zone=') || !compact).map((l) => h('span', { class: 'sv-label' }, l))) : null,
        h('div', { class: 'sv-pods' }, ...(pods.length ? pods.map(podChip) : [h('span', { class: 'pg-empty' }, 'no pods')]), hidden ? h('span', { class: 'sv-hidden' }, `+${hidden} system`) : null));
    });
    const toggle = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { showSystem = !showSystem; render(last); } }, showSystem ? 'Hide system pods' : `Show ${systemCount} system pods`);

    const panels = [
      panel(`☸ ${S.context}`, `namespace: ${S.namespace}${S.inShell ? ` · inside ${S.shellPod}` : ''}`, h('div', {}, h('div', { class: 'sv-nodes' }, ...nodes), h('div', { class: 'sv-row' }, toggle)), 'sv-cluster'),
    ];
    if (S.pending.length) panels.push(panel('⏳ Not scheduled yet', `${S.pending.length}`, h('div', { class: 'sv-pods' }, ...S.pending.map(podChip)), 'warn'));

    const workloads = [
      ...S.deployments.filter((d) => userNs(d.ns)).map((d) => h('span', { class: `chip ${d.ready === d.replicas ? 'ok' : 'warn'} ${mark(`d:${d.ns}/${d.name}`)}`, title: d.image }, `🚀 ${d.name} ${d.ready}/${d.replicas}`, nsTag(d.ns))),
      ...S.statefulsets.filter((s) => userNs(s.ns)).map((s) => h('span', { class: `chip ${s.ready === s.replicas ? 'ok' : 'warn'} ${mark(`s:${s.ns}/${s.name}`)}` }, `🗃 ${s.name} ${s.ready}/${s.replicas}`, nsTag(s.ns))),
      ...S.daemonsets.filter((d) => userNs(d.ns)).map((d) => h('span', { class: `chip ${d.ready === d.desired ? 'ok' : 'warn'} ${mark(`ds:${d.ns}/${d.name}`)}` }, `🛰 ${d.name} ${d.ready}/${d.desired}`, nsTag(d.ns))),
      ...S.jobs.filter((j) => userNs(j.ns)).map((j) => h('span', { class: `chip ${j.done ? 'light' : 'warn'} ${mark(`j:${j.ns}/${j.name}`)}` }, `⏱ ${j.name} ${j.succeeded}/${j.completions}`, nsTag(j.ns))),
      ...S.cronjobs.filter((c) => userNs(c.ns)).map((c) => h('span', { class: `chip light ${mark(`cj:${c.ns}/${c.name}`)}` }, `🗓 ${c.name}`, nsTag(c.ns))),
      ...S.hpas.map((x) => h('span', { class: `chip blue ${mark(`h:${x.ns}/${x.name}`)}` }, `📈 ${x.name} ${x.utilization ?? '?'}%/${x.target}% → ${x.current}`)),
    ];
    const services = [
      ...S.services.filter((s) => !s.system).map((s) => h('span', { class: `chip ${s.endpoints ? 'blue' : 'warn'} ${mark(`svc:${s.ns}/${s.name}`)}`, title: `${s.type} ${s.clusterIP}` }, `🌐 ${s.name} · ${s.type}${s.nodePort ? ` :${s.nodePort}` : ''}${s.external ? ` · ${s.external}` : ''} · ${s.endpoints} ep`, nsTag(s.ns))),
      ...S.ingresses.map((i) => h('span', { class: `chip light ${mark(`ing:${i.ns}/${i.name}`)}` }, `🚪 ${i.name} → ${i.hosts.join(', ')}`)),
      ...S.netpols.map((n) => h('span', { class: `chip warn ${mark(`np:${n.ns}/${n.name}`)}` }, `🧱 ${n.name}`)),
      ...S.forwards.map((f) => h('span', { class: 'chip ok' }, `🔌 localhost:${f.local} → ${short(f.pod, 16)}`)),
    ];
    const config = [
      ...S.configmaps.map((c) => h('span', { class: `chip ${mark(`cm:${c.ns}/${c.name}`)}` }, `📄 ${c.name}`, nsTag(c.ns))),
      ...S.secrets.map((s) => h('span', { class: `chip warn ${mark(`sec:${s.ns}/${s.name}`)}` }, `🔐 ${s.name}`, nsTag(s.ns))),
      ...S.pvcs.map((p) => h('span', { class: `chip ${p.phase === 'Bound' ? 'ok' : 'warn'} ${mark(`pvc:${p.ns}/${p.name}`)}` }, `💾 ${p.name} · ${p.phase}`, nsTag(p.ns))),
      ...S.serviceaccounts.map((s) => h('span', { class: `chip light ${mark(`sa:${s.ns}/${s.name}`)}` }, `🪪 ${s.name}`)),
      ...S.roles.map((r) => h('span', { class: `chip light ${mark(`r:${r.kind}/${r.ns}/${r.name}`)}` }, `${r.kind === 'Role' ? '🛡' : '🔗'} ${r.name}`)),
    ];
    panels.push(h('div', { class: 'pg-2col' },
      panel('🚀 Workloads', `${workloads.length}`, h('div', { class: 'chips' }, ...(workloads.length ? workloads : [empty('none yet — try kubectl apply -f deployment.yaml')]))),
      panel('🌐 Networking', `${services.length}`, h('div', { class: 'chips' }, ...(services.length ? services : [empty('no Services yet')])))));
    if (config.length) panels.push(panel('🔐 Config, storage & access', `${config.length}`, h('div', { class: 'chips' }, ...config)));
    const extras = [];
    const userNamespaces = S.namespaces.filter(userNs).filter((n) => n !== 'default');
    if (userNamespaces.length) extras.push(h('div', {}, h('b', {}, 'Namespaces '), ...userNamespaces.map((n) => h('span', { class: `chip ${n === S.namespace ? 'blue' : ''}` }, n))));
    if (S.releases.length) extras.push(h('div', {}, h('b', {}, 'Helm '), ...S.releases.map((r) => h('span', { class: `chip blue ${mark(`rel:${r.ns}/${r.name}:${r.revision}`)}` }, `⎈ ${r.name} · ${r.chart} · rev ${r.revision}`))));
    if (S.crds.length) extras.push(h('div', {}, h('b', {}, 'CRDs '), ...S.crds.map((c) => h('span', { class: 'chip light' }, c))));
    if (S.warnings.length) extras.push(h('div', {}, h('b', {}, '⚠ Recent warnings '), ...S.warnings.map((w) => h('span', { class: 'chip bad' }, short(w, 40)))));
    if (extras.length) panels.push(h('div', { class: 'pg-panel extras' }, ...extras));
    el.replaceChildren(...panels);
  };
  if (compact) showSystem = false;
  return { el, render };
};
