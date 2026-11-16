// Animations for the advanced lessons. Each registers itself on ANIMATIONS.
import { ANIMATIONS as A, helpers } from '../animations.js';
import { h, wait, fly, flash, escapeHtml } from '../dom.js';
import { scene } from '../components.js';

const { mkTerm, out, typed, zone, mkBar, setBar, podEl, nodeBox, controlPlane, yamlCard, ping, shortHash } = helpers;

// ---------- local helpers ----------
const esc = escapeHtml;
/** Pads rows into aligned columns like kubectl's table output. */
const columns = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i] + 3)).join('').trimEnd()).join('\n');
};
const table = (term, rows) => out(term, esc(columns(rows)));
const say = (term, text, cls = '') => out(term, cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text));
const startPod = async (pod, ms = 700) => { pod.setStatus('creating'); await wait(ms); pod.setStatus('ready'); };
const podName = (app) => `${app}-${shortHash()}`;
// Buttons labelled with a real command also appear as "Try typing" hints.
const sceneWithHints = (root, opts) => {
  root.classList.add('adv-scene');
  const s = scene(root, opts);
  const btn = s.btn;
  s.btn = (label, fn, o = {}) => btn(label, fn, /^(kubectl|helm|sudo|kubeadm) /.test(label) && !o.example ? { ...o, example: label } : o);
  return s;
};
const resetButton = (s, fn) => s.btn('↺ Reset', async () => { fn(); s.say('Reset. Start again from the beginning.'); });

// =====================================================================
// Scheduling: filter, then score — plus preemption
// =====================================================================
A.schedFilterScore = (root) => {
  const s = sceneWithHints(root, { title: 'The scheduler: filter, then score', hint: 'Choose the pod\'s rules below, then run <b>kubectl apply -f web-2.yaml</b> and watch every node being checked.' });
  const CAPACITY = 4;
  const term = mkTerm({ height: '140px' });
  const sched = h('div', { class: 'adv-sched' }, '🧭 kube-scheduler');
  const queue = h('div', { class: 'chips adv-queue' });
  const specEl = h('div', { class: 'adv-spec' });
  const nodesEl = h('div', { class: 'k-nodes adv-sched-nodes' });
  s.stage.append(h('div', { class: 'adv-sched-scene' },
    h('div', { class: 'adv-col' }, zone('Scheduling queue (unscheduled pods)', queue), specEl, sched, term),
    nodesEl));

  const freshState = () => ({
      nodes: [
        { name: 'node-1', labels: { zone: 'a' }, taint: null, pods: [{ name: 'cache-0', cpu: 1, prio: 0, app: 'cache' }, { name: 'batch-1', cpu: 2, prio: -100, app: 'batch' }] },
        { name: 'node-2', labels: { zone: 'b', disktype: 'ssd' }, taint: null, pods: [{ name: 'web-1', cpu: 1, prio: 0, app: 'web' }, { name: 'batch-2', cpu: 2, prio: -100, app: 'batch' }] },
        { name: 'node-3', labels: { zone: 'c', gpu: 'true' }, taint: 'gpu=true:NoSchedule', pods: [] },
      ],
      web: { nodeSelector: false, tolerate: false, antiAffinity: false, cpu: 1, state: 'none', card: null },
      critical: 'none',
    });
  let st = freshState();
  const used = (n) => n.pods.reduce((sum, p) => sum + p.cpu, 0);
  const labelText = (n) => Object.entries(n.labels).map(([k, v]) => `${k}=${v}`).join(' ');

  const drawPod = (n, p) => {
    p.el = podEl(p.name, { status: p.status || 'ready', labels: { app: p.app }, image: `req ${p.cpu} CPU${p.prio > 0 ? ' · critical' : p.prio < 0 ? ' · low prio' : ''}` });
    n.ui.box.pods.append(p.el);
  };
  const drawNode = (n) => {
    const box = nodeBox(n.name, { capacity: `${CAPACITY} CPU · ${labelText(n)}` });
    const bar = mkBar(), cpu = h('small', {}), taint = h('span', { class: 'chip warn adv-taint' }), verdict = h('div', { class: 'adv-verdict' });
    box.el.insertBefore(h('div', { class: 'adv-node-extra' }, h('div', { class: 'adv-cpu' }, bar, cpu), taint, verdict), box.pods);
    n.ui = { box, bar, cpu, taint, verdict, cap: box.el.querySelector('.k-node-cap') };
    n.pods.forEach((p) => drawPod(n, p));
    nodesEl.append(box.el);
    updateNode(n);
  };
  const updateNode = (n) => {
    const u = used(n);
    setBar(n.ui.bar, (u / CAPACITY) * 100);
    n.ui.bar.className = `bar ${u >= CAPACITY ? 'bad' : ''}`;
    n.ui.cpu.textContent = `${u}/${CAPACITY} CPU requested`;
    n.ui.taint.textContent = n.taint ? `taint ${n.taint}` : '';
    n.ui.taint.style.display = n.taint ? '' : 'none';
    n.ui.cap.textContent = `${CAPACITY} CPU · ${labelText(n)}`;
  };
  const setVerdict = (n, text, cls) => { n.ui.verdict.textContent = text; n.ui.verdict.className = `adv-verdict ${cls}`; };
  const clearVerdicts = () => st.nodes.forEach((n) => setVerdict(n, '', ''));

  const drawSpec = () => {
    const w = st.web;
    specEl.replaceChildren(yamlCard([
      'kind: Pod  # web-2',
      'metadata: { labels: { app: web } }',
      'spec:',
      w.nodeSelector ? '  nodeSelector: { disktype: ssd }' : '  # no nodeSelector',
      w.tolerate ? '  tolerations: [{ key: gpu, operator: Exists }]' : '  # no tolerations',
      w.antiAffinity ? '  affinity: { podAntiAffinity: app=web per hostname }' : '  # no anti-affinity',
      `  containers: [{ name: web, resources: { requests: { cpu: "${w.cpu}" } } }]`,
    ].join('\n'), { name: 'web-2.yaml' }));
  };

  const reset = () => {
    st = freshState();
    nodesEl.replaceChildren();
    queue.replaceChildren();
    term.replaceChildren();
    st.nodes.forEach(drawNode);
    drawSpec();
    out(term, '<span class="dim"># three nodes, 4 CPU each. node-3 is reserved for GPU work.</span>');
    syncToggles();
  };

  const filterReason = (n, pod) => {
    if (pod.nodeSelector && n.labels.disktype !== 'ssd') return 'didn\'t match Pod\'s node affinity/selector';
    if (n.taint && !pod.tolerate) return 'had untolerated taint {gpu: true}';
    if (pod.antiAffinity && n.pods.some((p) => p.app === pod.app)) return 'didn\'t match pod anti-affinity rules';
    if (CAPACITY - used(n) < pod.cpu) return 'Insufficient cpu';
    return '';
  };
  const scoreOf = (n, pod) => {
    const free = Math.round(((CAPACITY - used(n) - pod.cpu) / CAPACITY) * 100);
    const image = n.pods.some((p) => p.app === pod.app) ? 20 : 0;
    return { total: free + image, text: image ? `${free} free CPU + ${image} image cached` : `${free} free CPU` };
  };
  const pendingMessage = (reasons) => {
    const counts = {};
    reasons.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
    return `0/${st.nodes.length} nodes are available: ${Object.entries(counts).map(([r, c]) => `${c} node(s) ${r}`).join(', ')}.`;
  };

  const bind = async (pod, node) => {
    await fly(s.stage, sched, node.ui.box.el, { label: `bind → ${node.name}` });
    pod.card.remove();
    const p = { name: pod.name, cpu: pod.cpu, prio: pod.prio, app: pod.app, status: 'creating' };
    node.pods.push(p);
    drawPod(node, p);
    updateNode(node);
    out(term, `<span class="dim">Successfully assigned default/${pod.name} to ${node.name}</span>`);
    await wait(700);
    p.el.setStatus('ready');
  };

  // Finds the node where evicting the fewest lowest-priority pods makes room.
  const planPreemption = (pod) => st.nodes.map((n) => {
    if (filterReason({ ...n, pods: [] }, pod)) return null; // a non-resource rule fails
    const victims = [];
    let free = CAPACITY - used(n);
    for (const p of [...n.pods].filter((x) => x.prio < pod.prio).sort((a, b) => a.prio - b.prio)) {
      if (free >= pod.cpu) break;
      victims.push(p); free += p.cpu;
    }
    return free >= pod.cpu ? { node: n, victims, worst: Math.max(...victims.map((v) => v.prio)) } : null;
  }).filter(Boolean).sort((a, b) => a.worst - b.worst || a.victims.length - b.victims.length)[0];

  const schedule = async (pod) => {
    clearVerdicts();
    await fly(s.stage, pod.card, sched, { label: 'watch: unscheduled pod' });
    ping(sched);
    s.say(`<b>Filter phase.</b> The scheduler checks <code>${pod.name}</code> against every node and throws away those that cannot run it.`);
    const reasons = [];
    for (const n of st.nodes) {
      await fly(s.stage, sched, n.ui.box.el, { label: 'filter', cls: 'white', ms: 600 });
      const reason = filterReason(n, pod);
      setVerdict(n, reason ? `✗ ${reason}` : '✓ passes filter', reason ? 'fail' : 'pass');
      if (reason) reasons.push(reason);
      await wait(250);
    }
    const fits = st.nodes.filter((n) => !filterReason(n, pod));
    if (fits.length) {
      s.say(`<b>Score phase.</b> ${fits.length} node${fits.length > 1 ? 's' : ''} left. Each gets points: more free CPU after placing the pod, plus a bonus if the image is already there.`);
      await wait(500);
      const scored = fits.map((n) => ({ n, ...scoreOf(n, pod) })).sort((a, b) => b.total - a.total);
      for (const { n, total, text } of scored) { setVerdict(n, `★ score ${total} (${text})`, 'pass'); flash(n.ui.verdict); await wait(350); }
      const best = scored[0].n;
      setVerdict(best, `🏆 ${best.ui.verdict.textContent.slice(2)} — winner`, 'win');
      await bind(pod, best);
      return true;
    }
    if (pod.prio > 0) return preempt(pod, reasons);
    const msg = pendingMessage(reasons);
    pod.card.setStatus('pending');
    out(term, `<span class="y">Warning  FailedScheduling  ${esc(msg)}</span>`);
    s.say(`No node passed the filter, so <code>${pod.name}</code> stays <b>Pending</b>. The scheduler retries whenever the cluster changes — remove the taint, label a node or relax a rule and watch.`);
    return false;
  };

  const preempt = async (pod, reasons) => {
    out(term, `<span class="y">${esc(pendingMessage(reasons))} preemption: looking for victims…</span>`);
    const plan = planPreemption(pod);
    if (!plan) { s.say('Even preemption cannot help: no node would fit after evicting lower-priority pods.'); return false; }
    s.say(`<b>Preemption.</b> <code>${pod.name}</code> has priority 1000000. On <b>${plan.node.name}</b>, evicting <b>${plan.victims.map((v) => v.name).join(', ')}</b> (priority ${plan.worst}) frees enough CPU. The scheduler records <code>nominatedNodeName: ${plan.node.name}</code>.`);
    setVerdict(plan.node, `⚔ preempt ${plan.victims.map((v) => v.name).join(', ')}`, 'win');
    for (const v of plan.victims) {
      v.el.setStatus('terminating');
      out(term, `<span class="dim">Preempted ${v.name} on ${plan.node.name} by default/${pod.name}</span>`);
    }
    await wait(1100);
    plan.node.pods = plan.node.pods.filter((p) => !plan.victims.includes(p));
    plan.victims.forEach((v) => v.el.remove());
    updateNode(plan.node);
    await bind(pod, plan.node);
    plan.victims.forEach((v) => queue.append(podEl(`${v.app}-${shortHash()}`, { status: 'pending', labels: { app: v.app }, image: `req ${v.cpu} CPU · low prio` })));
    s.say(`<code>${pod.name}</code> runs. The evicted batch pod\'s Job recreated it, and the replacement now waits <b>Pending</b> in the queue until there is room — low priority means it goes last.`);
    return true;
  };

  const webPod = () => ({ name: 'web-2', app: 'web', prio: 0, ...st.web });
  const retryWeb = async () => {
    if (st.web.state !== 'pending') return;
    out(term, '<span class="dim"># cluster changed — the scheduler retries web-2</span>');
    if (await schedule({ ...webPod(), card: st.web.card })) st.web.state = 'placed';
  };

  s.btn('kubectl apply -f web-2.yaml', async () => {
    typed(term, 'kubectl apply -f web-2.yaml');
    out(term, 'pod/web-2 created');
    st.web.card = podEl('web-2', { status: 'pending', labels: { app: 'web' }, image: `req ${st.web.cpu} CPU` });
    queue.append(st.web.card);
    st.web.state = 'pending';
    if (await schedule({ ...webPod(), card: st.web.card })) st.web.state = 'placed';
  }, { primary: true, cmd: [/^kubectl (apply|create) -f web-2\.yaml$/], example: 'kubectl apply -f web-2.yaml', enabled: () => st.web.state === 'none', why: 'web-2 already exists. Delete it first: kubectl delete pod web-2' });

  s.btn('kubectl describe pod web-2', async () => {
    typed(term, 'kubectl describe pod web-2');
    const reasons = st.nodes.map((n) => filterReason(n, webPod())).filter(Boolean);
    out(term, 'Status:  Pending\nEvents:\n  Type     Reason            From               Message');
    out(term, `<span class="y">  Warning  FailedScheduling  default-scheduler  ${esc(pendingMessage(reasons))}</span>`);
    s.say('Read the message as a tally: how many nodes failed for which reason. Each reason points at a fix.');
  }, { cmd: [/^kubectl describe (pod|po|pods) web-2$/], enabled: () => st.web.state === 'pending', why: 'web-2 is not Pending right now.' });

  s.btn('kubectl delete pod web-2', async () => {
    typed(term, 'kubectl delete pod web-2');
    const host = st.nodes.find((n) => n.pods.some((p) => p.name === 'web-2'));
    if (host) {
      const p = host.pods.find((x) => x.name === 'web-2');
      p.el.setStatus('terminating'); await wait(600); p.el.remove();
      host.pods = host.pods.filter((x) => x !== p); updateNode(host);
    } else st.web.card?.remove();
    out(term, 'pod "web-2" deleted');
    st.web.state = 'none'; clearVerdicts(); syncToggles();
    s.say('Gone. Change the rules and apply again.');
  }, { cmd: [/^kubectl delete (pod|po) web-2$/], enabled: () => st.web.state !== 'none', why: 'There is no web-2 pod yet.' });
  s.sep();

  // Pod-spec toggles: only while web-2 does not exist, like editing the YAML before applying it.
  const toggles = {};
  const TOGGLES = [
    ['nodeSelector', 'nodeSelector: disktype=ssd'],
    ['tolerate', 'toleration: gpu'],
    ['antiAffinity', 'anti-affinity: app=web'],
  ];
  const syncToggles = () => {
    TOGGLES.forEach(([key, text]) => { if (toggles[key]) toggles[key].textContent = `${st.web[key] ? '☑' : '☐'} ${text}`; });
    if (toggles.cpu) toggles.cpu.textContent = `CPU request: ${st.web.cpu}`;
    drawSpec();
  };
  const editable = { enabled: () => st.web.state === 'none', why: 'Delete web-2 before changing its spec.' };
  TOGGLES.forEach(([key]) => { toggles[key] = s.btn('', async () => { st.web[key] = !st.web[key]; syncToggles(); }, editable); });
  toggles.cpu = s.btn('', async () => { st.web.cpu = st.web.cpu === 1 ? 2 : 1; syncToggles(); }, editable);
  s.sep();

  s.btn('kubectl taint nodes node-3 gpu=true:NoSchedule-', async () => {
    typed(term, 'kubectl taint nodes node-3 gpu=true:NoSchedule-');
    st.nodes[2].taint = null; updateNode(st.nodes[2]);
    out(term, 'node/node-3 untainted');
    s.say('The taint is gone: node-3 now accepts any pod. Nothing <i>attracts</i> pods to it, though — it simply wins on free CPU.');
    await retryWeb();
  }, { cmd: [/^kubectl taint (nodes|node|no) node-3 gpu(=true)?(:noschedule)?-$/], enabled: () => !!st.nodes[2].taint, why: 'node-3 has no taint.' });
  s.btn('kubectl taint nodes node-3 gpu=true:NoSchedule', async () => {
    typed(term, 'kubectl taint nodes node-3 gpu=true:NoSchedule');
    st.nodes[2].taint = 'gpu=true:NoSchedule'; updateNode(st.nodes[2]);
    out(term, 'node/node-3 tainted');
    s.say('node-3 is reserved again. Pods already running there stay — <code>NoSchedule</code> only affects new pods.');
  }, { cmd: [/^kubectl taint (nodes|node|no) node-3 gpu=true:noschedule$/], enabled: () => !st.nodes[2].taint, why: 'node-3 is already tainted.' });
  s.btn('kubectl label nodes node-1 disktype=ssd', async () => {
    typed(term, 'kubectl label nodes node-1 disktype=ssd');
    st.nodes[0].labels.disktype = 'ssd'; updateNode(st.nodes[0]);
    out(term, 'node/node-1 labeled');
    s.say('node-1 now matches <code>nodeSelector: disktype=ssd</code> too.');
    await retryWeb();
  }, { cmd: [/^kubectl label (nodes|node|no) node-1 disktype=ssd$/], enabled: () => !st.nodes[0].labels.disktype, why: 'node-1 already has disktype=ssd.' });
  s.sep();

  s.btn('kubectl apply -f critical-pod.yaml', async () => {
    typed(term, 'kubectl apply -f critical-pod.yaml');
    out(term, 'pod/payments created   <span class="dim"># priorityClassName: critical (1000000), requests 2 CPU</span>');
    const card = podEl('payments', { status: 'pending', labels: { app: 'payments' }, image: 'req 2 CPU · critical' });
    queue.append(card);
    st.critical = 'pending';
    const ok = await schedule({ name: 'payments', app: 'payments', cpu: 2, prio: 1000000, card });
    st.critical = ok ? 'placed' : 'pending';
  }, { cmd: [/^kubectl (apply|create) -f critical-pod\.yaml$/], enabled: () => st.critical === 'none', why: 'The payments pod already exists. Reset to try again.' });
  resetButton(s, reset);
  reset();
};

// =====================================================================
// Autoscaling: HPA + cluster autoscaler
// =====================================================================
A.hpaScale = (root) => {
  const s = sceneWithHints(root, { title: 'HPA and cluster autoscaler at work', hint: 'Create the HPA, push the traffic slider up, then run <b>kubectl get hpa -w</b> to watch several 15-second cycles.' });
  const REQUEST_M = 500, TARGET = 60, MIN = 2, MAX = 10, PODS_PER_NODE = 4, MAX_NODES = 4, STABILIZE = 4;
  const term = mkTerm({ height: '150px' });
  const nodesEl = h('div', { class: 'k-nodes' });
  const pendingEl = h('div', { class: 'chips' });
  const formula = h('div', { class: 'adv-formula' });
  const loadVal = h('b', {});
  const slider = h('input', { type: 'range', min: '0', max: '5000', step: '100', 'aria-label': 'Incoming traffic' });
  s.stage.append(h('div', { class: 'adv-hpa-scene' },
    h('div', { class: 'adv-col' }, zone('📈 HPA controller (every 15 s)', formula), term),
    h('div', { class: 'adv-col' }, nodesEl, zone('⏳ Pending — no node has room', pendingEl))));

  const freshState = () => ({ load: 600, pods: [], nodes: [], hpa: false, history: [], lastMath: '', nodeSeq: 3 });
  let st = freshState();
  const util = () => (st.pods.length ? Math.round((st.load / st.pods.length / REQUEST_M) * 100) : 0);

  const addNode = (name, ready = true) => {
    const box = nodeBox(name, { capacity: `room for ${PODS_PER_NODE} pods (2 CPU)` });
    const node = { name, box, ready, emptyFor: 0, pods: [] };
    if (!ready) box.setState('joining…', 'warn');
    nodesEl.append(box.el);
    st.nodes.push(node);
    return node;
  };
  const place = (pod) => {
    const node = st.nodes.find((n) => n.ready && n.pods.length < PODS_PER_NODE);
    if (!node) { pod.node = null; pendingEl.append(pod.el); pod.el.setStatus('pending'); return false; }
    pod.node = node; node.pods.push(pod); node.box.pods.append(pod.el);
    startPod(pod.el, 600);
    return true;
  };
  const addPod = () => {
    const pod = { name: podName('web'), el: null, node: null };
    pod.el = podEl(pod.name, { status: 'pending', labels: { app: 'web' } });
    st.pods.push(pod);
    place(pod);
  };
  const removePod = (pod) => {
    st.pods = st.pods.filter((p) => p !== pod);
    if (pod.node) pod.node.pods = pod.node.pods.filter((p) => p !== pod);
    pod.el.setStatus('terminating');
    setTimeout(() => pod.el.remove(), 500);
  };
  const drawLoad = () => {
    loadVal.textContent = `${(st.load / 1000).toFixed(1)} CPU of traffic`;
    const u = util();
    formula.innerHTML = st.hpa
      ? `<div>replicas <b>${st.pods.length}</b> · avg CPU <b class="${u > TARGET ? 'adv-hot' : ''}">${u}%</b> of request · target <b>${TARGET}%</b></div><div class="adv-math">${st.lastMath || 'waiting for the next cycle…'}</div>`
      : '<div class="adv-math">No HPA yet — replicas stay fixed however busy the pods are.</div>';
  };

  const reset = () => {
    st = freshState();
    nodesEl.replaceChildren(); pendingEl.replaceChildren(); term.replaceChildren();
    addNode('node-1'); addNode('node-2');
    addPod(); addPod();
    slider.value = String(st.load);
    out(term, '<span class="dim"># deployment web: 2 replicas, each requests 500m CPU</span>');
    drawLoad();
  };

  // One HPA sync plus one cluster-autoscaler pass.
  const cycle = async () => {
    const u = util(), current = st.pods.length;
    const raw = Math.ceil((current * u) / TARGET);
    const within = Math.abs(u / TARGET - 1) <= 0.1;
    const wanted = within ? current : Math.min(MAX, Math.max(MIN, raw));
    st.history = [...st.history, wanted].slice(-STABILIZE);
    const desired = wanted < current ? Math.max(...st.history) : wanted; // scale-down stabilization window
    st.lastMath = within
      ? `|${u}/${TARGET} − 1| ≤ 10% tolerance → keep ${current}`
      : `ceil(${current} × ${u}% ÷ ${TARGET}%) = ${raw} → clamp [${MIN}, ${MAX}] = ${wanted}${desired !== wanted ? ` · stabilization window keeps ${desired}` : ''}`;
    const lines = columns([['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS'], ['web', 'Deployment/web', `cpu: ${u}%/${TARGET}%`, MIN, MAX, current]]).split('\n');
    out(term, esc(st.printedHead ? lines[1] : lines.join('\n')));
    st.printedHead = true;
    for (let i = current; i < desired; i++) addPod();
    for (let i = current; i > desired; i--) removePod([...st.pods].reverse().find((p) => !p.node) || st.pods.at(-1));
    drawLoad();
    await wait(700);
    await autoscaleNodes();
    st.pods.filter((p) => !p.node).forEach(place);
    drawLoad();
  };
  const autoscaleNodes = async () => {
    const pending = st.pods.filter((p) => !p.node);
    st.nodes.filter((n) => !n.ready).forEach((n) => { n.ready = true; n.box.setState('Ready'); out(term, `<span class="ok">node/${n.name} Ready — pending pods can schedule</span>`); });
    if (pending.length && st.nodes.length < MAX_NODES) {
      const node = addNode(`node-${st.nodeSeq++}`, false);
      out(term, `<span class="y">cluster-autoscaler: ${pending.length} unschedulable pod(s) → scale node group to ${st.nodes.length} (${node.name} booting)</span>`);
      s.say(`Pods are <b>Pending</b> with <code>Insufficient cpu</code>. The <b>cluster autoscaler</b> asks the cloud for one more node; it needs a little time to boot and join.`);
      return;
    }
    st.nodes.filter((n) => n.pods.length).forEach((n) => { n.emptyFor = 0; });
    for (const n of st.nodes.filter((x) => x.ready && !x.pods.length)) {
      if (st.nodes.length <= 2) break;
      n.emptyFor++;
      if (n.emptyFor < 2) continue;
      out(term, `<span class="dim">cluster-autoscaler: ${n.name} unneeded → drained and removed</span>`);
      n.box.setState('removing', 'bad');
      await wait(500);
      n.box.el.remove();
      st.nodes = st.nodes.filter((x) => x !== n);
    }
  };

  slider.addEventListener('input', () => { st.load = Number(slider.value); drawLoad(); });
  s.add(h('label', { class: 'inline adv-slider' }, '🌐 traffic', slider, loadVal));
  s.btn('🔥 lunch rush', async () => { st.load = 4200; slider.value = '4200'; drawLoad(); s.say('Traffic jumps to 4.2 CPU worth of work. Without an HPA every pod just gets hotter.'); });
  s.btn('🌙 night', async () => { st.load = 300; slider.value = '300'; drawLoad(); s.say('Traffic drops. Watch how slowly the HPA scales down — that is the stabilization window protecting you from a short dip.'); });
  s.sep();
  s.btn('kubectl autoscale deployment web --cpu-percent=60 --min=2 --max=10', async () => {
    typed(term, 'kubectl autoscale deployment web --cpu-percent=60 --min=2 --max=10');
    out(term, 'horizontalpodautoscaler.autoscaling/web autoscaled');
    st.hpa = true; drawLoad();
    s.say('The HPA exists. Every 15 seconds it reads average CPU from metrics-server and applies <code>ceil(replicas × current ÷ target)</code>.');
  }, { primary: true, cmd: [/^kubectl autoscale (deployment|deploy) web( --cpu-percent=60| --min=2| --max=10)*$/, /^kubectl apply -f hpa\.yaml$/], example: 'kubectl autoscale deployment web --cpu-percent=60 --min=2 --max=10', enabled: () => !st.hpa, why: 'The HPA already exists.' });
  s.btn('kubectl get hpa -w', async () => {
    typed(term, 'kubectl get hpa -w');
    st.printedHead = false;
    s.say('Watching 8 HPA cycles. <b>Move the traffic slider while it runs.</b>');
    for (let i = 0; i < 8 && root.isConnected; i++) { await cycle(); await wait(900); }
    out(term, '<span class="dim">^C</span>');
    s.say(`Now ${st.pods.length} replicas on ${st.nodes.length} nodes. Run the watch again after changing the traffic.`);
  }, { cmd: [/^kubectl get (hpa|horizontalpodautoscalers?)( web)? (-w|--watch)$/], enabled: () => st.hpa, why: 'Create the HPA first with kubectl autoscale.' });
  s.btn('kubectl top pods -l app=web', async () => {
    typed(term, 'kubectl top pods -l app=web');
    const per = st.pods.length ? Math.round(st.load / st.pods.length) : 0;
    table(term, [['NAME', 'CPU(cores)', 'MEMORY(bytes)'], ...st.pods.map((p) => [p.name, p.node ? `${per}m` : '—', p.node ? '41Mi' : '—'])]);
    s.say(`Each running pod uses about <b>${per}m</b> of its <b>500m</b> request = <b>${util()}%</b> utilisation.`);
  }, { cmd: [/^kubectl top (pods|pod|po)( -l app=web)?$/] });
  resetButton(s, reset);
  reset();
};

// =====================================================================
// RBAC: authentication → authorization → admission → etcd
// =====================================================================
A.rbacRequest = (root) => {
  const s = sceneWithHints(root, { title: 'Three gates for every API request', hint: 'Send requests as the <b>deployer</b> ServiceAccount, then create the Role and RoleBinding and try again.' });
  const SA = 'system:serviceaccount:shop:deployer';
  const term = mkTerm({ height: '160px' });
  const gate = (icon, name, sub) => h('div', { class: 'adv-gate' }, h('b', {}, `${icon} ${name}`), h('small', {}, sub));
  const gates = { authn: gate('🪪', 'Authentication', 'who are you?'), authz: gate('🔐', 'Authorization', 'may you? (RBAC)'), admit: gate('🚦', 'Admission', 'is it acceptable?'), etcd: gate('🗄', 'etcd', 'stored') };
  const client = h('div', { class: 'adv-client' }, '💻 kubectl');
  const rbacEl = h('div', { class: 'adv-rbac-objs' });
  s.stage.append(h('div', { class: 'adv-rbac-scene' },
    h('div', { class: 'adv-pipeline' }, client, ...Object.values(gates)),
    h('div', { class: 'adv-rbac-bottom' }, zone('RBAC objects in namespace shop', rbacEl), term)));

  const freshState = () => ({ role: false, binding: false });
  let st = freshState();
  const drawRbac = () => rbacEl.replaceChildren(
    h('div', { class: `adv-obj ${st.role ? 'on' : ''}` }, h('b', {}, 'Role pod-reader'), h('small', {}, 'get, list, watch · pods, pods/log')),
    h('div', { class: `adv-obj ${st.binding ? 'on' : ''}` }, h('b', {}, 'RoleBinding deployer-reads-pods'), h('small', {}, 'pod-reader → SA shop/deployer')),
    h('div', { class: 'adv-obj on' }, h('b', {}, 'RoleBinding devs-edit'), h('small', {}, 'ClusterRole edit → Group devs (jane)')));
  const reset = () => {
    st = freshState();
    term.replaceChildren();
    Object.values(gates).forEach((g) => { g.className = 'adv-gate'; });
    out(term, '<span class="dim"># deployer is a brand-new ServiceAccount with no permissions</span>');
    drawRbac();
  };

  const IDENTITIES = { [SA]: { user: SA, groups: ['system:serviceaccounts', 'system:serviceaccounts:shop', 'system:authenticated'] }, jane: { user: 'jane', groups: ['devs', 'system:authenticated'] } };
  const EDIT_VERBS = new Set(['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']);
  const allowed = (who, verb, resource) => {
    if (who === 'jane') return EDIT_VERBS.has(verb) && !['roles', 'rolebindings'].includes(resource);
    return st.role && st.binding && ['get', 'list', 'watch'].includes(verb) && ['pods', 'pods/log'].includes(resource);
  };
  const API_VERB = { get: 'list', delete: 'delete', create: 'create', logs: 'get' };

  const light = (key, ok) => { gates[key].className = `adv-gate ${ok ? 'ok' : 'bad'}`; };
  const travel = async (req) => {
    Object.values(gates).forEach((g) => { g.className = 'adv-gate'; });
    await fly(s.stage, client, gates.authn, { label: `${req.verb} ${req.resource}` });
    if (req.badToken) {
      light('authn', false);
      out(term, '<span class="bad">error: You must be logged in to the server (Unauthorized)</span>');
      return s.say('<b>401 Unauthorized.</b> The token could not be verified, so the request never reaches authorization.');
    }
    light('authn', true);
    await fly(s.stage, gates.authn, gates.authz, { label: req.who === 'jane' ? 'user=jane groups=[devs]' : 'user=…:shop:deployer', cls: 'white' });
    if (!allowed(req.who, req.verb, req.resource)) {
      light('authz', false);
      out(term, `<span class="bad">Error from server (Forbidden): ${esc(req.resource.split('/')[0])} is forbidden: User "${esc(IDENTITIES[req.who].user)}" cannot ${req.verb} resource "${esc(req.resource.split('/')[0])}"${req.resource.includes('/') ? ` subresource "${req.resource.split('/')[1]}"` : ''} in API group "" in the namespace "shop"</span>`);
      return s.say(`<b>403 Forbidden.</b> The identity is known, but no binding grants <code>${req.verb}</code> on <code>${req.resource}</code> in <code>shop</code>. RBAC has no deny rules — it is simply not allowed.`);
    }
    light('authz', true);
    await fly(s.stage, gates.authz, gates.admit, { label: 'allowed', cls: 'ok' });
    if (req.privileged) {
      light('admit', false);
      out(term, '<span class="bad">Error from server (Forbidden): error when creating "privileged-pod.yaml": pods "debug" is forbidden: violates PodSecurity "baseline:latest": privileged (container "debug" must not set securityContext.privileged=true)</span>');
      return s.say('<b>Rejected by admission.</b> jane <i>may</i> create pods (RBAC said yes), but Pod Security Admission refuses this <i>particular</i> pod.');
    }
    light('admit', true);
    if (req.verb !== 'list' && req.verb !== 'get') await fly(s.stage, gates.admit, gates.etcd, { label: 'write', cls: 'ok' });
    light('etcd', true);
    req.onSuccess();
    s.say('Passed all three gates.');
  };
  const parseAs = (m) => (m?.input?.includes('--as=jane') ? 'jane' : SA);

  s.btn(`kubectl get pods -n shop --as=${SA}`, async (_, m) => {
    const who = parseAs(m);
    typed(term, m?.input || `kubectl get pods -n shop --as=${SA}`);
    await travel({ who, verb: 'list', resource: 'pods', onSuccess: () => table(term, [['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'], ['web-5c9d7b8f4-x2x7q', '1/1', 'Running', '0', '3d'], ['db-0', '1/1', 'Running', '0', '3d']]) });
  }, { primary: true, cmd: [/^kubectl get (pods|pod|po) -n shop --as=(system:serviceaccount:shop:deployer|jane)$/], example: `kubectl get pods -n shop --as=${SA}` });
  s.btn(`kubectl delete pod web-5c9d7b8f4-x2x7q -n shop --as=${SA}`, async (_, m) => {
    typed(term, m?.input || `kubectl delete pod web-5c9d7b8f4-x2x7q -n shop --as=${SA}`);
    await travel({ who: parseAs(m), verb: 'delete', resource: 'pods', onSuccess: () => out(term, 'pod "web-5c9d7b8f4-x2x7q" deleted') });
  }, { cmd: [/^kubectl delete (pod|po) web-5c9d7b8f4-x2x7q -n shop --as=(system:serviceaccount:shop:deployer|jane)$/] });
  s.btn(`kubectl auth can-i list pods -n shop --as=${SA}`, async (_, m) => {
    const input = m?.input || `kubectl auth can-i list pods -n shop --as=${SA}`;
    typed(term, input);
    const [, verb, resource] = input.match(/can-i (\w+) ([\w/]+)/);
    const ok = allowed(parseAs(m), verb, resource === 'pod' ? 'pods' : resource);
    await fly(s.stage, client, gates.authz, { label: 'SelfSubjectAccessReview' });
    light('authz', ok);
    out(term, ok ? '<span class="ok">yes</span>' : '<span class="bad">no</span>');
    s.say(`<code>auth can-i</code> asks only the <b>authorization</b> gate — nothing is created. Answer: <b>${ok ? 'yes' : 'no'}</b>.`);
  }, { cmd: [/^kubectl auth can-i (get|list|watch|create|delete|update|patch) (pods|pod|pods\/log|secrets|deployments) -n shop --as=(system:serviceaccount:shop:deployer|jane)$/], example: `kubectl auth can-i delete pods -n shop --as=${SA}` });
  s.btn('kubectl get pods -n shop --token=expired', async () => {
    typed(term, 'kubectl get pods -n shop --token=expired');
    await travel({ who: SA, verb: 'list', resource: 'pods', badToken: true });
  }, { cmd: [/^kubectl get (pods|pod|po) -n shop --token=\S+$/] });
  s.sep();
  s.btn('kubectl apply -f rbac.yaml', async () => {
    typed(term, 'kubectl apply -f rbac.yaml');
    out(term, 'role.rbac.authorization.k8s.io/pod-reader created\nrolebinding.rbac.authorization.k8s.io/deployer-reads-pods created');
    st.role = true; st.binding = true; drawRbac();
    s.say('A <b>Role</b> (what) and a <b>RoleBinding</b> (to whom) now exist. Retry the same requests — <code>get pods</code> works, <code>delete</code> still does not.');
  }, { cmd: [/^kubectl (apply|create) -f rbac\.yaml$/], enabled: () => !st.binding, why: 'The Role and RoleBinding already exist.' });
  s.btn('kubectl delete rolebinding deployer-reads-pods -n shop', async () => {
    typed(term, 'kubectl delete rolebinding deployer-reads-pods -n shop');
    out(term, 'rolebinding.rbac.authorization.k8s.io "deployer-reads-pods" deleted');
    st.binding = false; drawRbac();
    s.say('The Role still exists but nobody is bound to it, so it grants nothing.');
  }, { cmd: [/^kubectl delete rolebinding deployer-reads-pods( -n shop)?$/], enabled: () => st.binding, why: 'There is no binding to delete.' });
  s.btn('kubectl apply -f privileged-pod.yaml -n shop --as=jane', async () => {
    typed(term, 'kubectl apply -f privileged-pod.yaml -n shop --as=jane');
    await travel({ who: 'jane', verb: 'create', resource: 'pods', privileged: true });
  }, { cmd: [/^kubectl (apply|create) -f privileged-pod\.yaml -n shop --as=jane$/] });
  s.btn('kubectl auth whoami', async () => {
    typed(term, 'kubectl auth whoami');
    table(term, [['ATTRIBUTE', 'VALUE'], ['Username', 'jane'], ['Groups', '[devs system:authenticated]']]);
    s.say('<code>auth whoami</code> shows the identity the API server sees after authentication — handy when an OIDC login gives you unexpected groups.');
  });
  resetButton(s, reset);
  reset();
};

// =====================================================================
// Network policies: default deny, then allow paths one by one
// =====================================================================
A.netpolTraffic = (root) => {
  const s = sceneWithHints(root, { title: 'Firewall rules made of labels', hint: 'Test the connections, apply <b>default-deny</b>, then open the paths you need one policy at a time.' });
  const term = mkTerm({ height: '120px' });
  const NAMESPACE_OF = { frontend: 'shop', api: 'shop', db: 'shop', coredns: 'kube-system', reports: 'analytics' };
  const FLOWS = [
    { id: 'fe-api', from: 'frontend', to: 'api', text: 'frontend → api :8080', want: true },
    { id: 'api-db', from: 'api', to: 'db', text: 'api → db :5432 (by name)', want: true, needsDns: true },
    { id: 'api-dns', from: 'api', to: 'coredns', text: 'api → kube-dns :53', want: true },
    { id: 'fe-db', from: 'frontend', to: 'db', text: 'frontend → db :5432', want: false },
    { id: 'rep-db', from: 'reports', to: 'db', text: 'analytics/reports → db :5432', want: false },
  ];
  const pods = Object.fromEntries(Object.keys(NAMESPACE_OF).map((app) => [app, podEl(app === 'coredns' ? 'coredns' : app, { status: 'ready', labels: { app: app === 'coredns' ? 'kube-dns' : app } })]));
  const shopZone = h('div', { class: 'adv-ns shop' }, h('div', { class: 'zone-title' }, 'namespace: shop'), h('div', { class: 'adv-ns-pods' }, pods.frontend, pods.api, pods.db));
  const rows = Object.fromEntries(FLOWS.map((f) => [f.id, h('div', { class: 'adv-flow' }, h('span', {}, f.text), h('b', {}, '—'))]));
  const policyEl = h('div', { class: 'chips' });
  s.stage.append(h('div', { class: 'adv-netpol-scene' },
    h('div', { class: 'adv-col' }, shopZone,
      h('div', { class: 'adv-ns-row' },
        h('div', { class: 'adv-ns' }, h('div', { class: 'zone-title' }, 'kube-system'), pods.coredns),
        h('div', { class: 'adv-ns' }, h('div', { class: 'zone-title' }, 'analytics'), pods.reports))),
    h('div', { class: 'adv-col' }, zone('Connections', h('div', { class: 'adv-flows' }, ...Object.values(rows))), zone('Policies in shop', policyEl), term)));

  const freshState = () => ({ deny: false, dns: false, feApi: false, apiDb: false });
  let st = freshState();
  const POLICY_NAMES = { deny: 'default-deny-all', dns: 'allow-dns', feApi: 'frontend-to-api', apiDb: 'db-from-api' };
  const drawPolicies = () => {
    const names = Object.keys(POLICY_NAMES).filter((k) => st[k]).map((k) => POLICY_NAMES[k]);
    policyEl.replaceChildren(...(names.length ? names.map((n) => h('span', { class: `chip ${n.startsWith('default') ? 'bad' : 'ok'}` }, `🛡 ${n}`)) : [h('span', { class: 'chip ghost' }, 'none — everything is open')]));
    shopZone.classList.toggle('isolated', st.deny);
  };
  const reset = () => {
    st = freshState();
    term.replaceChildren();
    FLOWS.forEach((f) => { rows[f.id].className = 'adv-flow'; rows[f.id].lastChild.textContent = '—'; });
    out(term, '<span class="dim"># no NetworkPolicies yet</span>');
    drawPolicies();
  };

  const inShop = (app) => NAMESPACE_OF[app] === 'shop';
  const egressOk = (f) => !inShop(f.from) || !st.deny || (f.to === 'coredns' && st.dns) || (f.id === 'fe-api' && st.feApi) || (f.id === 'api-db' && st.apiDb);
  const ingressOk = (f) => !inShop(f.to) || !st.deny || (f.id === 'fe-api' && st.feApi) || (f.id === 'api-db' && st.apiDb);
  const verdict = (f) => {
    if (f.needsDns && !verdict(FLOWS.find((x) => x.id === 'api-dns')).ok) return { ok: false, why: 'DNS lookup timed out' };
    if (!egressOk(f)) return { ok: false, why: `egress from ${f.from} denied` };
    if (!ingressOk(f)) return { ok: false, why: `ingress to ${f.to} denied` };
    return { ok: true, why: 'connected' };
  };

  const testAll = async () => {
    for (const f of FLOWS) {
      const v = verdict(f);
      await fly(s.stage, pods[f.from], pods[f.to], { label: f.id === 'api-dns' ? 'DNS?' : 'SYN', cls: v.ok ? 'ok' : 'bad', ms: 650 });
      const good = v.ok === f.want;
      rows[f.id].className = `adv-flow ${v.ok ? 'ok' : 'bad'} ${good ? '' : 'wrong'}`;
      rows[f.id].lastChild.textContent = v.ok ? '✅ allowed' : `⛔ ${v.why}`;
    }
    const wrong = FLOWS.filter((f) => verdict(f).ok !== f.want);
    return wrong;
  };

  const applyPolicy = async (key, file, lines, caption) => {
    typed(term, `kubectl apply -f ${file}`);
    lines.forEach((l) => out(term, l));
    st[key] = true; drawPolicies();
    s.say(caption);
    await wait(400);
    await testAll();
  };

  s.btn('🧪 test connections', async () => {
    out(term, '<span class="dim"># kubectl exec into each pod and try to connect…</span>');
    const wrong = await testAll();
    s.say(wrong.length ? `Red-bordered rows are not what we want: ${wrong.map((f) => `<code>${f.text}</code>`).join(', ')}.` : '🎉 Exactly the paths you need are open, and nothing else.');
  }, { primary: true, cmd: [/^(test|kubectl exec .+)$/], example: 'kubectl exec -n shop deploy/api -- nc -zv db 5432' });
  s.sep();
  s.btn('kubectl apply -f default-deny.yaml', () => applyPolicy('deny', 'default-deny.yaml', ['networkpolicy.networking.k8s.io/default-deny-all created'],
    '<code>podSelector: {}</code> selects every pod in <b>shop</b> for ingress <i>and</i> egress. Every pod there is now isolated — including its DNS lookups. Pods in other namespaces are unaffected.'),
  { cmd: [/^kubectl apply -f default-deny\.yaml( -n shop)?$/], enabled: () => !st.deny, why: 'default-deny is already applied.' });
  s.btn('kubectl apply -f networkpolicy.yaml', () => applyPolicy('apiDb', 'networkpolicy.yaml', ['networkpolicy.networking.k8s.io/db-from-api created', 'networkpolicy.networking.k8s.io/api-egress-to-db created'],
    'db now accepts api on 5432, and api may send to db. Yet <code>api → db</code> still fails: api cannot <b>resolve</b> the name <code>db</code>, because egress to DNS is blocked. The classic gotcha.'),
  { cmd: [/^kubectl apply -f networkpolicy\.yaml( -n shop)?$/], enabled: () => st.deny && !st.apiDb, why: () => (st.apiDb ? 'Already applied.' : 'Apply default-deny.yaml first to see why this matters.') });
  s.btn('kubectl apply -f allow-dns.yaml', () => applyPolicy('dns', 'allow-dns.yaml', ['networkpolicy.networking.k8s.io/allow-dns created'],
    'Every pod in shop may now reach CoreDNS on UDP/TCP 53. Name resolution works, so <code>api → db</code> connects.'),
  { cmd: [/^kubectl apply -f allow-dns\.yaml( -n shop)?$/], enabled: () => st.deny && !st.dns, why: () => (st.dns ? 'Already applied.' : 'Apply default-deny.yaml first.') });
  s.btn('kubectl apply -f allow-frontend-to-api.yaml', () => applyPolicy('feApi', 'allow-frontend-to-api.yaml', ['networkpolicy.networking.k8s.io/frontend-to-api created'],
    'frontend may reach api on 8080. Notice <code>frontend → db</code> stays blocked: policies only ever <b>add</b> exactly what they list.'),
  { cmd: [/^kubectl apply -f allow-frontend-to-api\.yaml( -n shop)?$/], enabled: () => st.deny && !st.feApi, why: () => (st.feApi ? 'Already applied.' : 'Apply default-deny.yaml first.') });
  s.sep();
  s.btn('kubectl get networkpolicy -n shop', async () => {
    typed(term, 'kubectl get networkpolicy -n shop');
    const names = Object.keys(POLICY_NAMES).filter((k) => st[k]).map((k) => POLICY_NAMES[k]);
    if (!names.length) return out(term, 'No resources found in shop namespace.');
    table(term, [['NAME', 'POD-SELECTOR', 'AGE'], ...names.map((n) => [n, { 'default-deny-all': '<none>', 'allow-dns': '<none>', 'frontend-to-api': 'app=api', 'db-from-api': 'app=db' }[n], '5s'])]);
    s.say('POD-SELECTOR <code>&lt;none&gt;</code> means the empty selector — every pod in the namespace.');
  }, { cmd: [/^kubectl get (networkpolicy|networkpolicies|netpol)( -n shop)?$/] });
  s.btn('kubectl delete networkpolicy --all -n shop', async () => {
    typed(term, 'kubectl delete networkpolicy --all -n shop');
    Object.keys(POLICY_NAMES).filter((k) => st[k]).forEach((k) => out(term, `networkpolicy.networking.k8s.io "${POLICY_NAMES[k]}" deleted`));
    reset();
    s.say('No policies selects the pods any more, so they are no longer isolated — everything is open again.');
  }, { cmd: [/^kubectl delete (networkpolicy|networkpolicies|netpol) --all( -n shop)?$/], enabled: () => st.deny || st.dns || st.feApi || st.apiDb, why: 'There are no policies to delete.' });
  reset();
};

// =====================================================================
// Pod Security Admission: baseline vs restricted
// =====================================================================
A.psaAdmission = (root) => {
  const s = sceneWithHints(root, { title: 'Pod Security Admission checks your pod', hint: 'Toggle the pod\'s security settings, then <b>kubectl apply -f pod.yaml -n shop</b>. Change the namespace labels to tighten the rules.' });
  const term = mkTerm({ height: '170px' });
  const yamlSlot = h('div', {});
  const gate = h('div', { class: 'adv-psa-gate' });
  const checklist = h('div', { class: 'adv-checklist' });
  s.stage.append(h('div', { class: 'adv-psa-scene' },
    h('div', { class: 'adv-col' }, yamlSlot),
    h('div', { class: 'adv-col' }, gate, checklist),
    h('div', { class: 'adv-col adv-psa-out' }, term)));

  const LEVELS = ['privileged', 'baseline', 'restricted'];
  // [setting key, label, level it violates, violation when the setting is in its "bad" state]
  const CHECKS = [
    { key: 'privileged', text: 'privileged: true', bad: (p) => p.privileged, level: 'baseline', msg: 'privileged (container "web" must not set securityContext.privileged=true)' },
    { key: 'hostNetwork', text: 'hostNetwork: true', bad: (p) => p.hostNetwork, level: 'baseline', msg: 'host namespaces (hostNetwork=true)' },
    { key: 'hostPath', text: 'hostPath volume', bad: (p) => p.hostPath, level: 'baseline', msg: 'hostPath volumes (volume "host-logs")' },
    { key: 'noEscalation', text: 'allowPrivilegeEscalation: false', bad: (p) => !p.noEscalation, level: 'restricted', msg: 'allowPrivilegeEscalation != false (container "web" must set securityContext.allowPrivilegeEscalation=false)' },
    { key: 'dropAll', text: 'capabilities: drop [ALL]', bad: (p) => !p.dropAll, level: 'restricted', msg: 'unrestricted capabilities (container "web" must set securityContext.capabilities.drop=["ALL"])' },
    { key: 'nonRoot', text: 'runAsNonRoot: true', bad: (p) => !p.nonRoot, level: 'restricted', msg: 'runAsNonRoot != true (pod or container "web" must set securityContext.runAsNonRoot=true)' },
    { key: 'seccomp', text: 'seccompProfile: RuntimeDefault', bad: (p) => !p.seccomp, level: 'restricted', msg: 'seccompProfile (pod or container "web" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")' },
  ];
  const rank = (level) => LEVELS.indexOf(level);
  const violations = (level) => CHECKS.filter((c) => c.bad(st.pod) && rank(level) >= rank(c.level));

  const freshState = () => ({ pod: { privileged: false, hostNetwork: false, hostPath: false, noEscalation: false, dropAll: false, nonRoot: false, seccomp: false }, ns: { enforce: 'baseline', warn: 'restricted', audit: 'restricted' }, exists: false });
  let st = freshState();
  const drawYaml = () => {
    const p = st.pod;
    yamlSlot.replaceChildren(yamlCard([
      'apiVersion: v1', 'kind: Pod', 'metadata: { name: web }', 'spec:',
      p.hostNetwork ? '  hostNetwork: true' : null,
      p.nonRoot || p.seccomp ? '  securityContext:' : null,
      p.nonRoot ? '    runAsNonRoot: true' : null,
      p.seccomp ? '    seccompProfile: { type: RuntimeDefault }' : null,
      '  containers:', '    - name: web', '      image: nginx:1.27',
      p.privileged || p.noEscalation || p.dropAll ? '      securityContext:' : null,
      p.privileged ? '        privileged: true' : null,
      p.noEscalation ? '        allowPrivilegeEscalation: false' : null,
      p.dropAll ? '        capabilities: { drop: [ALL] }' : null,
      p.hostPath ? '  volumes: [{ name: host-logs, hostPath: { path: /var/log } }]' : null,
    ].filter(Boolean).join('\n'), { name: 'pod.yaml' }));
  };
  const drawGate = () => {
    gate.replaceChildren(h('b', {}, '🚦 PodSecurity admission'), h('small', {}, 'namespace shop labels:'),
      ...['enforce', 'warn', 'audit'].map((mode) => h('span', { class: `chip ${mode === 'enforce' ? 'blue' : 'light'}` }, `${mode}=${st.ns[mode]}`)));
    checklist.replaceChildren(...CHECKS.map((c) => {
      const broken = c.bad(st.pod);
      return h('div', { class: `adv-check ${broken ? 'bad' : 'ok'}` }, h('span', {}, broken ? '✗' : '✓'), h('span', {}, c.text), h('small', {}, broken ? `breaks ${c.level}` : 'ok'));
    }));
  };
  const draw = () => { drawYaml(); drawGate(); syncToggles(); };
  const reset = () => {
    st = freshState();
    term.replaceChildren();
    out(term, '<span class="dim"># namespace shop: enforce=baseline, warn=restricted, audit=restricted</span>');
    draw();
  };

  const formatList = (list) => list.map((c) => c.msg).join(', ');
  s.btn('kubectl apply -f pod.yaml -n shop', async () => {
    typed(term, 'kubectl apply -f pod.yaml -n shop');
    if (st.exists) out(term, '<span class="dim">pod "web" deleted   # pod security fields cannot be changed in place</span>');
    await fly(s.stage, yamlSlot, gate, { label: 'CREATE pod/web' });
    ping(gate);
    const enforced = violations(st.ns.enforce), warned = violations(st.ns.warn), audited = violations(st.ns.audit);
    if (warned.length) out(term, `<span class="y">Warning: would violate PodSecurity "${st.ns.warn}:latest": ${esc(formatList(warned))}</span>`);
    if (enforced.length) {
      out(term, `<span class="bad">Error from server (Forbidden): error when creating "pod.yaml": pods "web" is forbidden: violates PodSecurity "${st.ns.enforce}:latest": ${esc(formatList(enforced))}</span>`);
      st.exists = false;
      return s.say(`<b>Rejected.</b> The pod breaks the <b>${st.ns.enforce}</b> level that this namespace <b>enforces</b>. Fix the red items, or (for system components only) use a namespace with <code>enforce=privileged</code>.`);
    }
    out(term, 'pod/web created');
    if (audited.length) out(term, `<span class="dim"># audit log: pod-security.kubernetes.io/audit-violations: would violate PodSecurity "${st.ns.audit}:latest"</span>`);
    st.exists = true;
    s.say(warned.length
      ? `<b>Admitted with a warning.</b> The pod passes <b>${st.ns.enforce}</b> (enforced) but not <b>${st.ns.warn}</b> (warn only). This is how you prepare a namespace for a stricter level.`
      : `<b>Admitted cleanly.</b> The pod meets <b>${st.ns.warn}</b> — nothing to warn about.`);
  }, { primary: true, cmd: [/^kubectl (apply|create) -f pod\.yaml( -n shop)?$/] });
  s.btn('kubectl label ns shop pod-security.kubernetes.io/enforce=restricted --overwrite', async (_, m) => {
    const mode = m?.[1] || 'enforce', level = m?.[2] || 'restricted';
    typed(term, `kubectl label ns shop pod-security.kubernetes.io/${mode}=${level} --overwrite`);
    st.ns[mode] = level;
    out(term, 'namespace/shop labeled');
    if (mode === 'enforce' && st.exists && violations(level).length) out(term, `<span class="y">Warning: existing pods in namespace "shop" violate the new PodSecurity enforce level "${level}:latest"\nWarning: web: ${esc(violations(level).map((c) => c.msg.split(' (')[0]).join(', '))}</span>`);
    drawGate();
    s.say(`<code>${mode}</code> is now <b>${level}</b>. Running pods are not touched — PSA only checks new pods — but the API server warns about existing ones that would fail.`);
  }, { cmd: [/^kubectl label (?:ns|namespace) shop pod-security\.kubernetes\.io\/(enforce|warn|audit)=(privileged|baseline|restricted)(?: --overwrite)?$/] });
  s.sep();
  const toggles = {};
  const syncToggles = () => CHECKS.forEach((c) => { if (toggles[c.key]) toggles[c.key].textContent = `${st.pod[c.key] ? '☑' : '☐'} ${c.text}`; });
  CHECKS.forEach((c) => { toggles[c.key] = s.btn('', async () => { st.pod[c.key] = !st.pod[c.key]; draw(); s.say(`Edited <code>pod.yaml</code>. Apply it again to see the verdict.`); }); });
  s.btn('🔒 harden for restricted', async () => {
    Object.assign(st.pod, { privileged: false, hostNetwork: false, hostPath: false, noEscalation: true, dropAll: true, nonRoot: true, seccomp: true });
    draw();
    s.say('All four restricted settings on, all host access off. Apply it.');
  });
  resetButton(s, reset);
  reset();
};

// =====================================================================
// Maintenance: drain with a PodDisruptionBudget, then a rolling upgrade
// =====================================================================
A.drainPdb = (root) => {
  const s = sceneWithHints(root, { title: 'Drain a node without downtime', hint: 'Run <b>kubectl drain node-1</b> and watch the PodDisruptionBudget hold back an eviction until a replacement is Ready.' });
  const MIN_AVAILABLE = 2;
  const term = mkTerm({ height: '170px' });
  const cp = controlPlane({ compact: true });
  const cpVersion = h('span', { class: 'chip light' });
  const meter = h('div', { class: 'adv-meter' });
  const nodesEl = h('div', { class: 'k-nodes' });
  s.stage.append(h('div', { class: 'adv-drain-scene' },
    h('div', { class: 'adv-col' }, cp.el, h('div', { class: 'adv-row' }, cpVersion, meter), nodesEl),
    term));

  const freshState = () => ({ pods: [], nodes: [], pdb: true, upgraded: false });
  let st = freshState();
  const webReady = () => st.pods.filter((p) => p.app === 'web' && p.ready).length;
  const drawMeter = () => {
    const ready = webReady();
    meter.className = `adv-meter ${ready < MIN_AVAILABLE ? 'bad' : 'ok'}`;
    meter.textContent = `web Ready ${ready}/3 · PDB ${st.pdb ? `minAvailable ${MIN_AVAILABLE}` : 'none'}`;
  };
  const setVersion = (node, v) => { node.version = v; node.box.el.querySelector('.k-node-cap').textContent = `kubelet ${v}`; };
  const addPod = (node, app, { ready = true } = {}) => {
    const pod = { name: app === 'log-agent' ? `log-agent-${shortHash()}` : podName(app), app, node, ready, el: null };
    pod.el = podEl(pod.name, { status: ready ? 'ready' : 'creating', labels: { app } });
    node.box.pods.append(pod.el);
    st.pods.push(pod);
    return pod;
  };
  const reset = () => {
    st = freshState();
    nodesEl.replaceChildren(); term.replaceChildren();
    ['node-1', 'node-2', 'node-3'].forEach((name) => {
      const node = { name, box: nodeBox(name, { capacity: 'kubelet v1.33.4' }), cordoned: false, version: 'v1.33.4' };
      st.nodes.push(node); nodesEl.append(node.box.el);
    });
    const [n1, n2, n3] = st.nodes;
    addPod(n1, 'web'); addPod(n1, 'web'); addPod(n1, 'api'); addPod(n2, 'web');
    st.nodes.forEach((n) => addPod(n, 'log-agent'));
    addPod(n3, 'cache');
    cpVersion.textContent = 'control plane v1.33.4';
    out(term, '<span class="dim"># web has 3 replicas; two of them sit on node-1</span>');
    drawMeter();
  };

  const target = (except) => st.nodes.filter((n) => n !== except && !n.cordoned)
    .sort((a, b) => st.pods.filter((p) => p.node === a).length - st.pods.filter((p) => p.node === b).length)[0];
  const replace = (app, except, startMs) => {
    const node = target(except);
    const pod = addPod(node, app, { ready: false });
    drawMeter();
    void (async () => { await wait(startMs); pod.el.setStatus('ready'); pod.ready = true; drawMeter(); })();
  };
  const evict = async (pod, startMs) => {
    pod.ready = false; pod.el.setStatus('terminating'); drawMeter();
    out(term, `pod/${pod.name} evicted`);
    replace(pod.app, pod.node, startMs);
    await wait(500);
    pod.el.remove();
    st.pods = st.pods.filter((p) => p !== pod);
  };
  const cordon = (node) => { node.cordoned = true; node.box.setState('SchedulingDisabled', 'warn'); };
  const uncordon = (node) => { node.cordoned = false; node.box.setState('Ready'); };

  const drain = async (node, { startMs = 2200 } = {}) => {
    cordon(node);
    out(term, `node/${node.name} cordoned`);
    const agents = st.pods.filter((p) => p.node === node && p.app === 'log-agent');
    if (agents.length) out(term, `<span class="y">Warning: ignoring DaemonSet-managed Pods: kube-system/${agents.map((a) => a.name).join(', kube-system/')}</span>`);
    const victims = st.pods.filter((p) => p.node === node && p.app !== 'log-agent');
    victims.forEach((p) => out(term, `<span class="dim">evicting pod shop/${p.name}</span>`));
    if (!st.pdb) {
      await Promise.all(victims.map((p) => evict(p, startMs)));
    } else {
      for (const pod of victims) {
        for (let tries = 0; pod.app === 'web' && st.pdb && webReady() - 1 < MIN_AVAILABLE && tries < 20; tries++) {
          if (tries === 0) {
            out(term, `<span class="bad">error when evicting pods/"${pod.name}" -n "shop" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.</span>`);
            s.say(`<b>429 Too Many Requests.</b> Evicting <code>${pod.name}</code> would leave only ${webReady() - 1} Ready web pod${webReady() - 1 === 1 ? '' : 's'}, below <code>minAvailable: ${MIN_AVAILABLE}</code>. Drain waits until the replacement is <b>Ready</b> elsewhere.`);
            flash(meter);
          }
          await wait(400);
        }
        await evict(pod, startMs);
      }
    }
    await wait(startMs + 300);
    out(term, `node/${node.name} drained`);
  };

  s.btn('kubectl drain node-1 --ignore-daemonsets', async () => {
    typed(term, 'kubectl drain node-1 --ignore-daemonsets');
    s.say('Cordon first, then evict through the eviction API — DaemonSet pods are skipped because their controller would put them straight back.');
    await drain(st.nodes[0]);
    s.say(st.pdb
      ? `node-1 is empty except for its DaemonSet pod, and web never dropped below <b>${MIN_AVAILABLE}</b> Ready pods. Do the maintenance, then uncordon.`
      : '<b>Without a PDB</b> both web pods on node-1 were evicted at once: for a moment only <b>one</b> replica served all traffic. That is the outage a PDB prevents.');
  }, { primary: true, cmd: [/^kubectl drain node-1( --ignore-daemonsets| --delete-emptydir-data| --timeout=\S+)*$/], enabled: () => !st.nodes[0]?.cordoned, why: 'node-1 is already cordoned. Uncordon it first.' });
  s.btn('kubectl uncordon node-1', async () => {
    typed(term, 'kubectl uncordon node-1');
    uncordon(st.nodes[0]);
    out(term, 'node/node-1 uncordoned');
    s.say('node-1 accepts new pods again. The evicted pods do <b>not</b> move back by themselves — new pods (or the next rollout) will use it.');
  }, { cmd: [/^kubectl uncordon node-1$/], enabled: () => !!st.nodes[0]?.cordoned, why: 'node-1 is not cordoned.' });
  s.btn('kubectl get pdb', async () => {
    typed(term, 'kubectl get pdb');
    if (!st.pdb) return out(term, 'No resources found in shop namespace.');
    table(term, [['NAME', 'MIN AVAILABLE', 'MAX UNAVAILABLE', 'ALLOWED DISRUPTIONS', 'AGE'], ['web', MIN_AVAILABLE, 'N/A', Math.max(0, webReady() - MIN_AVAILABLE), '12d']]);
    s.say('ALLOWED DISRUPTIONS is how many web pods may be evicted <i>right now</i>.');
  }, { cmd: [/^kubectl get (pdb|poddisruptionbudgets?)( -n shop)?$/] });
  s.btn('kubectl delete pdb web', async () => {
    typed(term, 'kubectl delete pdb web');
    st.pdb = false; drawMeter();
    out(term, 'poddisruptionbudget.policy "web" deleted');
    s.say('No budget any more. Uncordon node-1 if needed, Reset, and drain again to compare.');
  }, { cmd: [/^kubectl delete (pdb|poddisruptionbudget) web( -n shop)?$/], enabled: () => st.pdb, why: 'The PDB is already deleted.' });
  s.btn('kubectl apply -f pdb.yaml', async () => {
    typed(term, 'kubectl apply -f pdb.yaml');
    st.pdb = true; drawMeter();
    out(term, 'poddisruptionbudget.policy/web created');
  }, { cmd: [/^kubectl apply -f pdb\.yaml( -n shop)?$/], enabled: () => !st.pdb, why: 'The PDB already exists.' });
  s.sep();
  s.btn('sudo kubeadm upgrade apply v1.34.2', async () => {
    typed(term, 'sudo kubeadm upgrade apply v1.34.2');
    s.say('<b>Control plane first.</b> kubeadm upgrades the API server, controller manager, scheduler and etcd. Kubelets on v1.33 keep working — they may be up to three minor versions older.');
    for (const part of Object.values(cp.parts)) { ping(part); await wait(350); }
    cpVersion.textContent = 'control plane v1.34.2';
    out(term, '<span class="ok">[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.34.2". Enjoy!</span>');
    for (const node of st.nodes) {
      s.say(`<b>Then nodes, one at a time:</b> drain ${node.name}, upgrade its kubelet, uncordon.`);
      typed(term, `kubectl drain ${node.name} --ignore-daemonsets`);
      await drain(node, { startMs: 900 });
      setVersion(node, 'v1.34.2');
      out(term, `<span class="dim"># on ${node.name}: upgrade kubeadm + kubelet, systemctl restart kubelet</span>`);
      typed(term, `kubectl uncordon ${node.name}`);
      uncordon(node);
      await wait(300);
    }
    st.upgraded = true;
    s.say('🎉 Every node runs v1.34.2, and the PDB kept at least two web pods serving the whole time.');
  }, { cmd: [/^(sudo )?kubeadm upgrade apply v1\.34(\.\d+)?$/], enabled: () => !st.upgraded && !st.nodes.some((n) => n.cordoned), why: () => (st.upgraded ? 'Already on v1.34.2. Reset to replay.' : 'Uncordon node-1 first.') });
  resetButton(s, reset);
  reset();
};

// =====================================================================
// Debugging: an incident board with three broken pods
// =====================================================================
A.debugIncident = (root) => {
  const s = sceneWithHints(root, { title: 'Incident board: three broken pods', hint: 'Find each cause with real commands — <b>kubectl get pods</b>, <b>kubectl describe pod …</b>, <b>kubectl logs … --previous</b>, <b>kubectl get events</b> — then apply the fix.' });
  const term = mkTerm({ height: '240px' });
  const board = h('div', { class: 'adv-board' });
  s.stage.append(h('div', { class: 'adv-debug-scene' }, board, term));

  const CASES = [
    {
      key: 'cache', name: 'cache-6d5f8-xk2p9', container: 'redis', reason: 'ImagePullBackOff', look: 'failed', ready: '0/1', restarts: 0, revealedBy: ['describe', 'events'],
      cause: 'Typo in the image tag: <code>redis:7.4-alpne</code> does not exist.',
      describe: ['Name:         cache-6d5f8-xk2p9', 'Namespace:    shop', 'Status:       Pending', 'Containers:', '  redis:', '    Image:          redis:7.4-alpne', '    State:          Waiting', '      Reason:       ImagePullBackOff', 'Events:', '  Type     Reason   From     Message', '  Normal   Pulling  kubelet  Pulling image "redis:7.4-alpne"', '! Warning  Failed   kubelet  Failed to pull image "redis:7.4-alpne": rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/redis:7.4-alpne": not found', '  Warning  Failed   kubelet  Error: ErrImagePull', '  Normal   BackOff  kubelet  Back-off pulling image "redis:7.4-alpne"'],
      logs: 'Error from server (BadRequest): container "redis" in pod "cache-6d5f8-xk2p9" is waiting to start: trying and failing to pull image',
      event: 'Warning  Failed     pod/cache-6d5f8-xk2p9   Failed to pull image "redis:7.4-alpne": not found',
      fix: 'kubectl set image deployment/cache redis=redis:7.4-alpine', fixRe: /^kubectl set image (deployment|deploy)\/cache redis=redis:7\.4-alpine$/,
      fixOut: 'deployment.apps/cache image updated',
    },
    {
      key: 'api', name: 'api-7f9c4-m2q8w', container: 'api', reason: 'CrashLoopBackOff', look: 'crash', ready: '0/1', restarts: 6, revealedBy: ['describe', 'logs'],
      cause: 'OOMKilled: the 128Mi memory limit is too small for this Node.js app.',
      describe: ['Name:         api-7f9c4-m2q8w', 'Namespace:    shop', 'Status:       Running', 'Containers:', '  api:', '    Image:          shop/api:2.3.1', '    State:          Waiting', '      Reason:       CrashLoopBackOff', '!    Last State:     Terminated', '!      Reason:       OOMKilled', '!      Exit Code:    137', '    Restart Count:  6', '    Limits:', '      memory:  128Mi', 'Events:', '  Warning  BackOff  kubelet  Back-off restarting failed container api in pod api-7f9c4-m2q8w_shop'],
      logs: '<--- Last few GCs --->\n[1:0x5e1f2a0]  8421 ms: Mark-Compact 121.3 (126.0) -> 120.9 (126.2) MB\n!FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      event: 'Warning  BackOff    pod/api-7f9c4-m2q8w     Back-off restarting failed container api',
      fix: 'kubectl set resources deployment api --limits=memory=512Mi', fixRe: /^kubectl set resources (deployment|deploy)[ /]api (--limits|-c api --limits)=memory=512mi$/,
      fixOut: 'deployment.apps/api resource requirements updated',
    },
    {
      key: 'worker', name: 'worker-5b8d7-qq7tz', container: 'worker', reason: 'CreateContainerConfigError', look: 'failed', ready: '0/1', restarts: 0, revealedBy: ['describe', 'events'],
      cause: 'The Secret <code>worker-env</code> it loads with <code>envFrom</code> does not exist.',
      describe: ['Name:         worker-5b8d7-qq7tz', 'Namespace:    shop', 'Status:       Pending', 'Containers:', '  worker:', '    State:          Waiting', '      Reason:       CreateContainerConfigError', '    Environment Variables from:', '      worker-env  Secret  Optional: false', 'Events:', '! Warning  Failed  kubelet  Error: secret "worker-env" not found'],
      logs: 'Error from server (BadRequest): container "worker" in pod "worker-5b8d7-qq7tz" is waiting to start: CreateContainerConfigError',
      event: 'Warning  Failed     pod/worker-5b8d7-qq7tz  Error: secret "worker-env" not found',
      fix: 'kubectl create secret generic worker-env --from-literal=QUEUE_URL=redis://cache:6379', fixRe: /^kubectl create secret generic worker-env --from-literal=\S+$/,
      fixOut: 'secret/worker-env created',
    },
  ];

  const freshState = () => ({ cases: {}, fixedCount: 0 });
  let st = freshState();
  const setText = (el, text) => { el.querySelector('.k-pod-status').textContent = text; };
  const drawCard = (c) => {
    const view = st.cases[c.key];
    view.card.replaceChildren(
      view.pod,
      h('div', { class: 'adv-clue', html: view.fixed ? `✅ fixed — ${c.cause}` : view.found ? `🔎 ${c.cause}` : '🔎 cause: <i>not found yet</i>' }));
    view.card.className = `adv-case ${view.fixed ? 'ok' : view.found ? 'found' : ''}`;
  };
  const reset = () => {
    st = freshState();
    board.replaceChildren(); term.replaceChildren();
    CASES.forEach((c) => {
      const pod = podEl(c.name, { status: c.look, labels: { app: c.key } });
      setText(pod, c.reason);
      st.cases[c.key] = { card: h('div', { class: 'adv-case' }), pod, found: false, fixed: false, name: c.name };
      board.append(st.cases[c.key].card);
      drawCard(c);
    });
    out(term, '<span class="dim"># 🚨 pager: "shop is down". Start with kubectl get pods.</span>');
  };
  const findCase = (arg) => CASES.find((c) => arg && (st.cases[c.key].name.startsWith(arg) || c.key === arg));
  const reveal = (c, via) => {
    if (!c.revealedBy.includes(via) || st.cases[c.key].found) return;
    st.cases[c.key].found = true; drawCard(c); flash(st.cases[c.key].card);
  };
  const printLines = (lines) => lines.forEach((l) => out(term, l.startsWith('!') ? `<span class="y">${esc(l.slice(1))}</span>` : esc(l)));

  s.btn('kubectl get pods', async () => {
    typed(term, 'kubectl get pods');
    table(term, [['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'], ...CASES.map((c) => {
      const v = st.cases[c.key];
      return v.fixed ? [v.name, '1/1', 'Running', 0, '20s'] : [v.name, c.ready, c.reason, c.restarts ? `${c.restarts} (31s ago)` : 0, '6m'];
    })]);
    s.say('Three different states. Each one points to a different place to look — run <code>kubectl describe pod</code> on each.');
  }, { primary: true, cmd: [/^kubectl get (pods|pod|po)( -n shop)?( -o wide)?$/] });
  s.btn('kubectl get events --sort-by=.lastTimestamp', async () => {
    typed(term, 'kubectl get events --sort-by=.lastTimestamp');
    out(term, esc('LAST SEEN   TYPE      REASON     OBJECT                  MESSAGE'));
    CASES.filter((c) => !st.cases[c.key].fixed).forEach((c) => { out(term, `<span class="y">${esc(`2m          ${c.event}`)}</span>`); reveal(c, 'events'); });
    s.say('Events are the cluster\'s diary. Two causes are right there; the crash loop only says "Back-off" — its reason lives in describe and the logs.');
  }, { cmd: [/^kubectl get events( -n shop)?( --sort-by=\.?lasttimestamp)?$/, /^kubectl events( -n shop)?$/] });
  const describe = async (arg, input) => {
    const c = findCase(arg);
    typed(term, input);
    if (!c) return out(term, `<span class="bad">Error from server (NotFound): pods "${esc(arg)}" not found</span>`);
    printLines(c.describe);
    reveal(c, 'describe');
    s.say(st.cases[c.key].fixed ? 'That pod was replaced already.' : `Found it in <b>describe</b>: ${c.cause}`);
  };
  const logs = async (arg, previous, input) => {
    const c = findCase(arg);
    typed(term, input);
    if (!c) return out(term, `<span class="bad">Error from server (NotFound): pods "${esc(arg)}" not found</span>`);
    if (c.key === 'api' && !previous) {
      out(term, '<span class="dim">(empty — the container just restarted)</span>');
      return s.say('The current container is brand new. Add <code>--previous</code> to read the one that crashed.');
    }
    printLines(c.logs.split('\n'));
    reveal(c, 'logs');
    s.say(c.key === 'api' ? 'The previous container ran out of memory. Combined with Exit Code 137, the limit is too low.' : 'No logs: the container never started. The cause is in <b>describe</b> or the events.');
  };
  s.command(/^kubectl describe (?:pods?|po) (?:pod\/)?(\S+)$/, (_, m) => describe(m[1], m.input), {});
  s.command(/^kubectl logs (?:pod\/)?(\S+)( --previous| -p)?( -c \S+)?$/, (_, m) => logs(m[1], !!m[2], m.input), {});
  CASES.forEach((c) => s.btn(`kubectl describe pod ${c.name}`, () => describe(c.name, `kubectl describe pod ${c.name}`), { cmd: [] }));
  s.btn('kubectl logs api-7f9c4-m2q8w --previous', () => logs('api-7f9c4-m2q8w', true, 'kubectl logs api-7f9c4-m2q8w --previous'), { cmd: [] });
  s.sep();
  CASES.forEach((c) => s.btn(c.fix, async () => {
    typed(term, c.fix);
    out(term, c.fixOut);
    const view = st.cases[c.key];
    view.fixed = true;
    view.pod.setStatus('terminating');
    await wait(500);
    view.name = podName(c.key);
    view.pod = podEl(view.name, { status: 'creating', labels: { app: c.key } });
    drawCard(c);
    await wait(900);
    view.pod.setStatus('ready');
    st.fixedCount++;
    s.say(st.fixedCount === CASES.length ? '🎉 All three fixed. <code>kubectl get pods</code> shows everything Running and Ready. Write the post-mortem!' : `Fixed <b>${c.key}</b>: the controller rolled out a new pod. ${CASES.length - st.fixedCount} to go.`);
  }, { cmd: [c.fixRe], enabled: () => !!st.cases[c.key]?.found && !st.cases[c.key].fixed, why: () => (st.cases[c.key]?.fixed ? 'Already fixed.' : `Find the cause first: kubectl describe pod ${c.name}`) }));
  resetButton(s, reset);
  reset();
};

// =====================================================================
// Helm: values + templates → manifests, releases, upgrade and rollback
// =====================================================================
A.helmRelease = (root) => {
  const s = sceneWithHints(root, { title: 'Helm: values in, manifests out', hint: 'Change the values and watch <b>helm template</b> re-render. Then install, upgrade with <code>--set</code>, and roll back.' });
  const term = mkTerm({ height: '150px' });
  const TEMPLATE = [
    '# templates/deployment.yaml',
    'kind: Deployment',
    'metadata: { name: {{ include "web.fullname" . }} }',
    'spec:',
    '  replicas: {{ .Values.replicaCount }}',
    '  template: { spec: { containers: [{',
    '    name: web,',
    '    image: "nginx:{{ .Values.image.tag }}" }] } }',
    '---',
    '# templates/service.yaml',
    'kind: Service',
    'spec: { type: {{ .Values.service.type }} }',
    '{{- if .Values.ingress.enabled }}',
    '---',
    '# templates/ingress.yaml',
    'kind: Ingress',
    'spec: { rules: [{ host: {{ .Values.ingress.host }} }] }',
    '{{- end }}',
  ].join('\n');
  const inputs = {
    replicaCount: h('input', { type: 'number', min: '1', max: '6', 'aria-label': 'replicaCount' }),
    tag: h('select', { 'aria-label': 'image.tag' }, ...['1.27', '1.28'].map((v) => h('option', { value: v }, v))),
    serviceType: h('select', { 'aria-label': 'service.type' }, ...['ClusterIP', 'NodePort', 'LoadBalancer'].map((v) => h('option', { value: v }, v))),
    ingress: h('input', { type: 'checkbox', 'aria-label': 'ingress.enabled' }),
  };
  const valuesEl = h('div', { class: 'adv-values' },
    h('div', { class: 'k-yaml-name' }, '📄 values.yaml'),
    h('label', {}, h('code', {}, 'replicaCount'), inputs.replicaCount),
    h('label', {}, h('code', {}, 'image.tag'), inputs.tag),
    h('label', {}, h('code', {}, 'service.type'), inputs.serviceType),
    h('label', {}, h('code', {}, 'ingress.enabled'), inputs.ingress));
  const renderedSlot = h('div', {});
  const releaseEl = h('div', { class: 'adv-release' });
  const podsEl = h('div', { class: 'chips adv-helm-pods' });
  s.stage.append(h('div', { class: 'adv-helm-scene' },
    h('div', { class: 'adv-col' }, valuesEl, yamlCard(TEMPLATE, { name: 'web-chart/templates/*' })),
    h('div', { class: 'adv-col' }, renderedSlot, zone('Release in namespace shop', releaseEl), podsEl),
    h('div', { class: 'adv-col adv-span' }, term)));

  const freshState = () => ({ history: [], pods: [], uninstalled: false });
  let st = freshState();
  const readInputs = () => ({ replicaCount: Number(inputs.replicaCount.value) || 1, tag: inputs.tag.value, serviceType: inputs.serviceType.value, ingress: inputs.ingress.checked });
  const writeInputs = (v) => { inputs.replicaCount.value = String(v.replicaCount); inputs.tag.value = v.tag; inputs.serviceType.value = v.serviceType; inputs.ingress.checked = v.ingress; };
  const render = (v) => [
    '# Source: web-chart/templates/deployment.yaml',
    'kind: Deployment', 'metadata: { name: web }', 'spec:', `  replicas: ${v.replicaCount}`, `  template: { spec: { containers: [{ name: web, image: "nginx:${v.tag}" }] } }`,
    '---', '# Source: web-chart/templates/service.yaml', 'kind: Service', `spec: { type: ${v.serviceType} }`,
    ...(v.ingress ? ['---', '# Source: web-chart/templates/ingress.yaml', 'kind: Ingress', 'spec: { rules: [{ host: shop.example.com }] }'] : []),
  ].join('\n');
  const drawRendered = () => renderedSlot.replaceChildren(yamlCard(render(readInputs()), { name: 'helm template web ./web-chart' }));
  const drawRelease = () => {
    if (!st.history.length || st.uninstalled) { releaseEl.replaceChildren(h('span', { class: 'chip ghost' }, 'no release yet')); return; }
    releaseEl.replaceChildren(...st.history.slice().reverse().map((r) => h('div', { class: `adv-rev ${r.status}` },
      h('b', {}, `rev ${r.rev}`), h('span', {}, r.status), h('small', {}, `nginx:${r.values.tag} · ${r.values.replicaCount} replicas · ${r.desc}`))));
  };
  // Converge the "cluster" to a set of values: replace pods on a tag change, add/remove on a replica change.
  const syncPods = async (v) => {
    const old = st.pods.filter((p) => p.tag !== v.tag);
    for (const p of old) { p.el.setStatus('terminating'); }
    if (old.length) await wait(500);
    old.forEach((p) => p.el.remove());
    st.pods = st.pods.filter((p) => p.tag === v.tag);
    while (st.pods.length > v.replicaCount) { const p = st.pods.pop(); p.el.setStatus('terminating'); setTimeout(() => p.el.remove(), 450); }
    const fresh = [];
    while (st.pods.length < v.replicaCount) {
      const pod = { tag: v.tag, el: podEl(podName('web'), { status: 'creating', image: `nginx:${v.tag}` }) };
      st.pods.push(pod); fresh.push(pod); podsEl.append(pod.el);
    }
    await wait(700);
    fresh.forEach((p) => p.el.setStatus('ready'));
  };
  const reset = () => {
    st = freshState();
    writeInputs({ replicaCount: 2, tag: '1.27', serviceType: 'ClusterIP', ingress: false });
    podsEl.replaceChildren(); term.replaceChildren();
    out(term, '<span class="dim"># web-chart is a local chart folder: Chart.yaml, values.yaml, templates/</span>');
    drawRendered(); drawRelease();
  };
  Object.values(inputs).forEach((el) => el.addEventListener('input', drawRendered));
  Object.values(inputs).forEach((el) => el.addEventListener('change', drawRendered));

  const SET_KEYS = { replicacount: (v, x) => { v.replicaCount = Math.max(1, Math.min(6, Number(x) || 1)); }, 'image.tag': (v, x) => { v.tag = ['1.27', '1.28'].includes(x) ? x : v.tag; }, 'service.type': (v, x) => { v.serviceType = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer' }[x] || v.serviceType; }, 'ingress.enabled': (v, x) => { v.ingress = x === 'true'; } };
  const applySets = (input) => [...input.matchAll(/--set[ =](\S+)/g)].flatMap((m) => m[1].split(',')).forEach((pair) => { const [k, x] = pair.split('='); SET_KEYS[k]?.(st.draft, x); });
  const deployed = () => st.history.find((r) => r.status === 'deployed');
  const record = (values, desc) => {
    st.history.forEach((r) => { if (r.status === 'deployed') r.status = 'superseded'; });
    st.history.push({ rev: st.history.length + 1, status: 'deployed', values: { ...values }, desc });
  };
  const releaseOut = (rev) => out(term, `Release "web" has been ${rev === 1 ? 'installed' : 'upgraded'}. Happy Helming!\nNAME: web\nNAMESPACE: shop\nSTATUS: deployed\nREVISION: ${rev}`);

  s.btn('helm template web ./web-chart', async () => {
    typed(term, 'helm template web ./web-chart');
    out(term, `<span class="dim">${esc(render(readInputs()).split('\n').slice(0, 6).join('\n'))}\n…</span>`);
    s.say('<code>helm template</code> renders locally and prints YAML — nothing reaches the cluster. Great for reviewing changes in CI.');
  }, { cmd: [/^helm template web \.\/web-chart( -f \S+)?$/] });
  s.btn('helm install web ./web-chart -n shop', async () => {
    typed(term, 'helm install web ./web-chart -n shop');
    const v = readInputs();
    record(v, 'Install complete'); st.uninstalled = false;
    releaseOut(1); drawRelease();
    s.say('Helm rendered the templates with your values and applied them. The release record (revision 1) is stored as a Secret in <code>shop</code>.');
    await syncPods(v);
  }, { primary: true, cmd: [/^helm install web \.\/web-chart( -n shop| --namespace shop| --create-namespace)*$/], enabled: () => !deployed(), why: 'Error: INSTALLATION FAILED: cannot re-use a name that is still in use. Use helm upgrade.' });
  s.btn('helm upgrade web ./web-chart -n shop --set image.tag=1.28', async (_, m) => {
    const input = m?.input || 'helm upgrade web ./web-chart -n shop --set image.tag=1.28';
    typed(term, input);
    if (!deployed() && !input.includes('--install')) {
      out(term, '<span class="bad">Error: UPGRADE FAILED: "web" has no deployed releases</span>');
      return s.say('There is nothing to upgrade yet. Install first — or use <code>helm upgrade --install</code>, which does either.');
    }
    st.draft = readInputs();
    applySets(input);
    writeInputs(st.draft); drawRendered();
    record(st.draft, st.history.length ? 'Upgrade complete' : 'Install complete');
    st.uninstalled = false;
    releaseOut(st.history.length); drawRelease();
    s.say(`Revision ${st.history.length} is <b>deployed</b>; the previous one is <b>superseded</b>. <code>--set</code> values override values.yaml for this release.`);
    await syncPods(st.draft);
  }, { cmd: [/^helm upgrade( --install)? web \.\/web-chart( -n shop| --namespace shop| --install| --set[ =]\S+| -f \S+)*$/], example: 'helm upgrade web ./web-chart -n shop --set replicaCount=4' });
  s.btn('helm history web -n shop', async () => {
    typed(term, 'helm history web -n shop');
    table(term, [['REVISION', 'STATUS', 'CHART', 'APP VERSION', 'DESCRIPTION'], ...st.history.map((r) => [r.rev, r.status, 'web-chart-0.1.0', r.values.tag, r.desc])]);
  }, { cmd: [/^helm history web( -n shop)?$/], enabled: () => st.history.length > 0, why: 'No release yet.' });
  s.btn('helm rollback web 1 -n shop', async (_, m) => {
    const rev = Number(m?.[1] || 1);
    typed(term, `helm rollback web ${rev} -n shop`);
    const target = st.history.find((r) => r.rev === rev);
    if (!target) return out(term, `<span class="bad">Error: release: not found (revision ${rev})</span>`);
    record(target.values, `Rollback to ${rev}`);
    writeInputs(target.values); drawRendered(); drawRelease();
    out(term, 'Rollback was a success! Happy Helming!');
    s.say(`Rolling back did not delete history — it created revision <b>${st.history.length}</b> with revision ${rev}'s values.`);
    await syncPods(target.values);
  }, { cmd: [/^helm rollback web (\d+)( -n shop)?$/], enabled: () => st.history.length > 1 && !!deployed(), why: 'You need at least one upgrade to roll back.' });
  s.btn('helm list -n shop', async () => {
    typed(term, 'helm list -n shop');
    const d = deployed();
    table(term, [['NAME', 'NAMESPACE', 'REVISION', 'STATUS', 'CHART', 'APP VERSION'], ...(d ? [['web', 'shop', st.history.length, 'deployed', 'web-chart-0.1.0', d.values.tag]] : [])]);
  }, { cmd: [/^helm (list|ls)( -n shop| -a| --all-namespaces| -A)*$/] });
  s.btn('helm uninstall web -n shop', async () => {
    typed(term, 'helm uninstall web -n shop');
    out(term, 'release "web" uninstalled');
    st.pods.forEach((p) => p.el.setStatus('terminating'));
    await wait(500);
    podsEl.replaceChildren(); st.pods = []; st.history = []; st.uninstalled = true; drawRelease();
    s.say('Every object the release created is deleted, and so is its history.');
  }, { cmd: [/^helm (uninstall|delete) web( -n shop)?$/], enabled: () => !!deployed(), why: 'No release to uninstall.' });
  resetButton(s, reset);
  reset();
};

// =====================================================================
// Kustomize: one base, two overlays
// =====================================================================
A.kustomizeOverlays = (root) => {
  const s = sceneWithHints(root, { title: 'Kustomize: base + overlays', hint: 'Build each overlay and compare. Highlighted lines are what the overlay changed.' });
  const term = mkTerm({ height: '130px' });
  const outSlot = h('div', { class: 'adv-kz-out' });
  const BASE = 'resources: [deployment.yaml]\nconfigMapGenerator:\n  - name: web-config\n    literals: [LOG_LEVEL=info]\n# deployment.yaml: replicas 2, nginx:1.27';
  const DEV = 'resources: [../../base]\nnamePrefix: dev-\nnamespace: shop-dev\nreplicas: [{ name: web, count: 1 }]\nconfigMapGenerator:\n  - name: web-config\n    behavior: merge\n    literals: [LOG_LEVEL=debug]';
  const prodYaml = () => `resources: [../../base]\nnamespace: shop\nimages: [{ name: nginx, newTag: "1.27.3" }]\npatches: [{ path: replicas.yaml }]  # 5\nconfigMapGenerator:\n  - name: web-config\n    behavior: merge\n    literals: [LOG_LEVEL=${st.prodLevel}]`;
  const prodSlot = h('div', {});
  s.stage.append(h('div', { class: 'adv-kz-scene' },
    h('div', { class: 'adv-col' }, yamlCard(BASE, { name: 'base/kustomization.yaml' }), yamlCard(DEV, { name: 'overlays/dev/kustomization.yaml' }), prodSlot),
    h('div', { class: 'adv-col' }, outSlot, term)));

  const freshState = () => ({ prodLevel: 'warn', applied: null });
  let st = freshState();
  const ALPHABET = 'bcdfghkmt256789';
  const hashOf = (text) => {
    let x = 2166136261;
    for (const ch of text) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
    return Array.from({ length: 10 }, (_, i) => ALPHABET[((x >>> (i * 3)) + i * 7) % ALPHABET.length]).join('');
  };
  const ENVS = {
    base: () => ({ prefix: '', ns: 'default', replicas: 2, tag: '1.27', level: 'info' }),
    dev: () => ({ prefix: 'dev-', ns: 'shop-dev', replicas: 1, tag: '1.27', level: 'debug' }),
    prod: () => ({ prefix: '', ns: 'shop', replicas: 5, tag: '1.27.3', level: st.prodLevel }),
  };
  const build = (env) => {
    const e = ENVS[env](), b = ENVS.base();
    const cm = `${e.prefix}web-config-${hashOf(`LOG_LEVEL=${e.level}`)}`;
    return { cm, lines: [
      ['apiVersion: v1', false], ['kind: ConfigMap', false], [`metadata: { name: ${cm}, namespace: ${e.ns} }`, env !== 'base'], [`data: { LOG_LEVEL: ${e.level} }`, e.level !== b.level],
      ['---', false], ['apiVersion: apps/v1', false], ['kind: Deployment', false], [`metadata: { name: ${e.prefix}web, namespace: ${e.ns} }`, env !== 'base'],
      ['spec:', false], [`  replicas: ${e.replicas}`, e.replicas !== b.replicas], [`  image: nginx:${e.tag}`, e.tag !== b.tag], [`  envFrom: [{ configMapRef: { name: ${cm} } }]`, env !== 'base'],
    ] };
  };
  const show = (env) => {
    const { lines } = build(env);
    outSlot.replaceChildren(h('div', { class: 'k-yaml' }, h('div', { class: 'k-yaml-name' }, `📤 kubectl kustomize ${env === 'base' ? 'kustomize/base' : `kustomize/overlays/${env}`}`),
      h('pre', { html: lines.map(([l, changed]) => (changed ? `<span class="adv-chg">${esc(l)}</span>` : esc(l))).join('\n') })));
  };
  const drawProd = () => prodSlot.replaceChildren(yamlCard(prodYaml(), { name: 'overlays/prod/kustomization.yaml' }));
  const reset = () => {
    st = freshState();
    term.replaceChildren();
    out(term, '<span class="dim"># kustomize/base + overlays/dev + overlays/prod</span>');
    drawProd(); show('base');
  };

  ['base', 'dev', 'prod'].forEach((env) => {
    const dir = env === 'base' ? 'kustomize/base' : `kustomize/overlays/${env}`;
    s.btn(`kubectl kustomize ${dir}`, async () => {
      typed(term, `kubectl kustomize ${dir}`);
      out(term, '<span class="dim">(rendered on the right — nothing sent to the cluster)</span>');
      show(env);
      s.say({ base: 'The base: shared defaults, valid YAML on its own.', dev: '<b>dev</b> adds a <code>dev-</code> name prefix, its own namespace, 1 replica and debug logging. The ConfigMap name carries a content hash.', prod: '<b>prod</b> pins the image tag, scales to 5 and logs at warn — the base files were never copied or edited.' }[env]);
    }, { cmd: [new RegExp(`^kubectl kustomize ${dir.replace(/\//g, '\\/')}\\/?$`)] });
  });
  s.sep();
  s.btn('kubectl apply -k kustomize/overlays/prod', async () => {
    typed(term, 'kubectl apply -k kustomize/overlays/prod');
    const { cm } = build('prod');
    show('prod');
    if (!st.applied) out(term, `configmap/${cm} created\ndeployment.apps/web created`);
    else if (st.applied === cm) out(term, `configmap/${cm} unchanged\ndeployment.apps/web unchanged`);
    else out(term, `configmap/${cm} created\n<span class="y">deployment.apps/web configured</span>`);
    s.say(!st.applied ? 'Created in <code>shop</code>.' : st.applied === cm ? 'Nothing changed, so nothing happened — apply is idempotent.' : 'New config content → new ConfigMap <b>name</b> → the Deployment\'s pod template changed → a <b>rolling update</b> picks up the new setting. That is why the hash suffix exists.');
    st.applied = cm;
  }, { primary: true, cmd: [/^kubectl apply -k kustomize\/overlays\/prod\/?$/] });
  s.btn('✏️ prod: LOG_LEVEL=error', async () => {
    st.prodLevel = st.prodLevel === 'warn' ? 'error' : 'warn';
    drawProd(); show('prod');
    s.say(`Edited the prod overlay. The generated ConfigMap name changes with its content. Apply again.`);
  });
  resetButton(s, reset);
  reset();
};

// =====================================================================
// Operators: a custom resource reconciled into real objects
// =====================================================================
A.operatorReconcile = (root) => {
  const s = sceneWithHints(root, { title: 'An operator reconciles a PostgresCluster', hint: 'Install the CRD, create the custom resource, then scale it, kill the primary and delete it.' });
  const term = mkTerm({ height: '150px' });
  const operator = h('div', { class: 'adv-operator' }, h('b', {}, '🤖 postgres-operator'), h('small', {}, 'watches PostgresCluster, Pods'));
  const logEl = h('div', { class: 'adv-oplog' });
  const childrenEl = h('div', { class: 'chips' });
  const podsEl = h('div', { class: 'chips' });
  const statusEl = h('div', { class: 'adv-crstatus' });
  const crSlot = h('div', {});
  s.stage.append(h('div', { class: 'adv-op-scene' },
    h('div', { class: 'adv-col' }, crSlot, term),
    h('div', { class: 'adv-col' }, operator, logEl),
    h('div', { class: 'adv-col' }, zone('Owned objects (ownerReferences → orders)', childrenEl), zone('Pods', podsEl), statusEl)));

  const freshState = () => ({ crd: false, cr: null, pods: [], children: [] });
  let st = freshState();
  const CHILDREN = [['🔐', 'Secret', 'orders-app'], ['🌐', 'Service', 'orders-rw'], ['🌐', 'Service', 'orders-ro'], ['📦', 'StatefulSet', 'orders'], ['🛡', 'PodDisruptionBudget', 'orders'], ['⏱', 'CronJob', 'orders-backup']];
  const log = (text, cls = '') => { logEl.append(h('div', { class: cls }, text)); while (logEl.children.length > 7) logEl.firstChild.remove(); };
  const drawCr = () => crSlot.replaceChildren(yamlCard(st.cr
    ? `apiVersion: db.example.com/v1\nkind: PostgresCluster\nmetadata:\n  name: orders\n${st.cr.deleting ? '  deletionTimestamp: "now"\n' : ''}  finalizers: [db.example.com/final-backup]\nspec:\n  instances: ${st.cr.instances}\n  version: "17"\nstatus:\n  phase: ${st.cr.phase}\n  primary: ${st.cr.primary || '—'}`
    : '# kind: PostgresCluster\n# not created yet', { name: 'my-db.yaml' }));
  const drawStatus = () => {
    statusEl.textContent = st.cr ? `status.phase: ${st.cr.phase} · ready ${st.pods.filter((p) => p.ready).length}/${st.cr.instances}` : `CRD ${st.crd ? 'installed' : 'missing'} · no PostgresCluster`;
    statusEl.className = `adv-crstatus ${st.cr?.phase === 'Ready' ? 'ok' : ''}`;
  };
  const reset = () => {
    st = freshState();
    term.replaceChildren(); logEl.replaceChildren(); childrenEl.replaceChildren(); podsEl.replaceChildren();
    out(term, '<span class="dim"># the operator is installed but the API does not know PostgresCluster yet</span>');
    drawCr(); drawStatus();
  };
  const addPod = async (index, role) => {
    const pod = { name: `orders-${index}`, role, ready: false, el: podEl(`orders-${index}`, { status: 'creating', labels: { role } }) };
    st.pods.push(pod); podsEl.append(pod.el);
    await wait(600);
    pod.el.setStatus('ready'); pod.ready = true; drawStatus();
  };
  const reconcile = async (why) => {
    await ping(operator);
    log(`↻ reconcile orders (${why})`, 'adv-op-head');
    for (const [icon, kind, name] of CHILDREN) {
      if (st.children.some((c) => c.kind === kind && c.name === name)) continue;
      const chip = h('span', { class: 'chip light pop' }, `${icon} ${kind}/${name}`);
      await fly(s.stage, operator, childrenEl, { label: `create ${kind}`, ms: 550 });
      childrenEl.append(chip); st.children.push({ kind, name, chip });
      log(`+ ${kind}/${name}`);
    }
    st.pods.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < st.cr.instances; i++) {
      if (st.pods.some((p) => p.name === `orders-${i}`)) continue;
      log(`+ Pod orders-${i} (${i === 0 && !st.cr.primary ? 'primary' : 'replica'})`);
      await addPod(i, i === 0 && !st.cr.primary ? 'primary' : 'replica');
    }
    st.cr.primary ||= 'orders-0';
    st.cr.phase = 'Ready'; drawCr(); drawStatus();
    log('✓ status.phase = Ready', 'ok');
  };

  s.btn('kubectl apply -f postgrescluster-crd.yaml', async () => {
    typed(term, 'kubectl apply -f postgrescluster-crd.yaml');
    out(term, 'customresourcedefinition.apiextensions.k8s.io/postgresclusters.db.example.com created');
    st.crd = true; drawStatus();
    s.say('The API server now serves <code>/apis/db.example.com/v1/namespaces/*/postgresclusters</code>. A new table, no behaviour yet — that is the operator\'s job.');
  }, { cmd: [/^kubectl (apply|create) -f postgrescluster-crd\.yaml$/], enabled: () => !st.crd, why: 'The CRD is already installed.' });
  s.btn('kubectl apply -f my-db.yaml', async () => {
    typed(term, 'kubectl apply -f my-db.yaml');
    if (!st.crd) {
      out(term, '<span class="bad">error: resource mapping not found for name: "orders" namespace: "shop" from "my-db.yaml": no matches for kind "PostgresCluster" in version "db.example.com/v1"\nensure CRDs are installed first</span>');
      return s.say('The API server has never heard of <code>PostgresCluster</code>. Install the CRD first.');
    }
    out(term, 'postgrescluster.db.example.com/orders created');
    st.cr = { instances: 3, phase: 'Creating', primary: '', deleting: false };
    drawCr(); drawStatus();
    s.say('You wrote 10 lines of intent. The operator gets a <b>watch event</b> and starts reconciling: Secret, Services, StatefulSet, PDB, backup CronJob — each with an ownerReference back to <code>orders</code>.');
    await fly(s.stage, crSlot, operator, { label: 'watch: ADDED' });
    await reconcile('ADDED');
  }, { primary: true, cmd: [/^kubectl (apply|create) -f my-db\.yaml( -n shop)?$/], enabled: () => !st.cr, why: 'orders already exists.' });
  s.btn('kubectl apply -f my-db-9.yaml', async () => {
    typed(term, 'kubectl apply -f my-db-9.yaml');
    if (!st.crd) return out(term, '<span class="bad">error: resource mapping not found … ensure CRDs are installed first</span>');
    out(term, '<span class="bad">The PostgresCluster "orders" is invalid: spec.instances: Invalid value: 9: spec.instances in body should be less than or equal to 5</span>');
    s.say('The CRD\'s <b>OpenAPI schema</b> rejected it inside the API server. The operator never saw the bad object.');
  }, { cmd: [/^kubectl (apply|create) -f my-db-9\.yaml( -n shop)?$/] });
  s.btn('kubectl patch pgc orders --type=merge -p {"spec":{"instances":5}}', async (_, m) => {
    const n = Number(m?.[1] || 5);
    typed(term, `kubectl patch pgc orders --type=merge -p '{"spec":{"instances":${n}}}'`);
    if (n > 5) return out(term, `<span class="bad">The PostgresCluster "orders" is invalid: spec.instances: Invalid value: ${n}: spec.instances in body should be less than or equal to 5</span>`);
    out(term, 'postgrescluster.db.example.com/orders patched');
    st.cr.instances = n; st.cr.phase = 'Scaling'; drawCr();
    await fly(s.stage, crSlot, operator, { label: 'watch: MODIFIED' });
    await reconcile('spec changed');
    s.say(`The operator compared desired (${n}) with actual and created only what was missing. That is reconcile: observe, diff, act.`);
  }, { cmd: [/^kubectl patch (?:pgc|postgrescluster) orders .*instances"?:\s*(\d+).*$/], enabled: () => !!st.cr && !st.cr.deleting && st.cr.instances < 5, why: () => (st.cr ? 'Already at the maximum of 5 instances.' : 'Create orders first.') });
  s.btn('kubectl delete pod orders-0', async () => {
    typed(term, 'kubectl delete pod orders-0');
    const victim = st.pods.find((p) => p.name === 'orders-0');
    victim.el.setStatus('terminating'); victim.ready = false;
    out(term, 'pod "orders-0" deleted');
    await wait(500);
    victim.el.remove(); st.pods = st.pods.filter((p) => p !== victim);
    await fly(s.stage, podsEl, operator, { label: 'watch: Pod DELETED', cls: 'bad' });
    const promoted = st.pods.find((p) => p.ready);
    if (victim.role === 'primary' && promoted) {
      log(`⚠ primary orders-0 lost → promote ${promoted.name}`, 'warn');
      promoted.role = 'primary'; promoted.el.setLabels({ role: 'primary' }); flash(promoted.el);
      st.cr.primary = promoted.name; drawCr();
      out(term, `<span class="dim"># service orders-rw now points at ${promoted.name}</span>`);
    }
    await reconcile('pod missing');
    s.say(`A plain StatefulSet would just restart orders-0. The operator knows Postgres: it <b>promoted</b> ${st.cr.primary} so writes keep working, then brought orders-0 back as a replica.`);
  }, { cmd: [/^kubectl delete (pod|po) orders-0( -n shop)?$/], enabled: () => st.pods.some((p) => p.name === 'orders-0' && p.ready) && !st.cr?.deleting, why: 'orders-0 is not running right now.' });
  s.btn('kubectl get pgc', async () => {
    typed(term, 'kubectl get pgc');
    if (!st.crd) return out(term, '<span class="bad">error: the server doesn\'t have a resource type "pgc"</span>');
    if (!st.cr) return out(term, 'No resources found in shop namespace.');
    table(term, [['NAME', 'INSTANCES', 'VERSION', 'PRIMARY', 'PHASE', 'AGE'], ['orders', st.cr.instances, '17', st.cr.primary || '<none>', st.cr.phase, '2m']]);
  }, { cmd: [/^kubectl get (pgc|postgresclusters?)( -n shop)?$/] });
  s.btn('kubectl delete pgc orders', async () => {
    typed(term, 'kubectl delete pgc orders');
    st.cr.deleting = true; st.cr.phase = 'Terminating'; drawCr(); drawStatus();
    s.say('A <b>finalizer</b> is present, so the API server only sets <code>deletionTimestamp</code>. The object stays until the operator finishes its cleanup.');
    await fly(s.stage, crSlot, operator, { label: 'watch: deletionTimestamp', cls: 'bad' });
    log('⌛ finalizer db.example.com/final-backup → run final backup', 'warn');
    const job = podEl('orders-final-backup', { status: 'creating', labels: { job: 'backup' } });
    podsEl.append(job);
    await wait(900); job.setStatus('succeeded');
    log('✓ backup uploaded → remove finalizer', 'ok');
    await wait(500);
    out(term, 'postgrescluster.db.example.com "orders" deleted');
    log('🗑 garbage collector deletes owned objects');
    for (const c of [...st.children].reverse()) { c.chip.classList.add('fade-out'); await wait(180); c.chip.remove(); }
    st.pods.forEach((p) => p.el.setStatus('terminating'));
    await wait(500);
    podsEl.replaceChildren(); st.children = []; st.pods = []; st.cr = null;
    drawCr(); drawStatus();
    s.say('Finalizer done → object gone → the <b>garbage collector</b> followed the ownerReferences and removed every child. No orphans, and a backup exists.');
  }, { cmd: [/^kubectl delete (pgc|postgrescluster) orders( -n shop)?$/], enabled: () => !!st.cr && !st.cr.deleting && st.cr.phase === 'Ready', why: 'Create orders and wait until it is Ready.' });
  resetButton(s, reset);
  reset();
};
