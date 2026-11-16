// Animations for the beginner lessons. Each registers itself on ANIMATIONS.
import { ANIMATIONS as A, helpers } from '../animations.js';
import { h, wait, fly, flash, moveTo, escapeHtml } from '../dom.js';
import { scene } from '../components.js';

const { mkTerm, out, typed, title, zone, podEl, nodeBox, controlPlane, yamlCard, ping, shortHash } = helpers;

// ---------- local helpers ----------
// kubectl-style columns: each column padded to its widest cell plus three spaces.
const columns = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i] + 3))).join('')).join('\n');
};
const printTable = (term, rows) => out(term, escapeHtml(columns(rows)));
const fail = (term, text) => out(term, `<span class="bad">${escapeHtml(text)}</span>`);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const setPodText = (pod, text) => { pod.querySelector('.k-pod-status').textContent = text; };
const replicasIn = (line) => Number(line.match(/--replicas[= ]?(\d+)/)?.[1] ?? 3);

// A button whose label is a real command: clicking runs the label, typing runs the typed line.
const cmdBtn = (s, label, handler, opts = {}) => s.btn(label, (_, m) => handler(m?.input ?? label, m), opts);

// The three beats of every Kubernetes controller.
const loopIndicator = () => {
  const el = h('div', { class: 'b-loop' }, ...['observe', 'diff', 'act'].map((step) => h('span', { 'data-step': step }, step)));
  el.light = async (step) => {
    el.querySelectorAll('span').forEach((x) => x.classList.toggle('on', x.dataset.step === step));
    if (step) await wait(450);
  };
  return el;
};

// Parses "-n shop", "--namespace=shop", "-A" (typed input is lower-cased, so -A arrives as -a).
const namespaceFlags = (words, fallback) => {
  const opts = { ns: fallback, all: false, rest: [] };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '-n' || w === '--namespace') opts.ns = words[++i];
    else if (w.startsWith('--namespace=')) opts.ns = w.slice('--namespace='.length);
    else if (w === '-a' || w === '--all-namespaces') opts.all = true;
    else opts.rest.push(w);
  }
  return opts;
};

// =====================================================================
// 1. Why Kubernetes — doing it by hand vs reconciling desired state
// =====================================================================
A.whyK8sReconcile = (root) => {
  const s = scene(root, { title: 'Doing it by hand vs desired state', hint: 'Break things in <b>Manual</b> mode first. Then switch to <b>Kubernetes</b> mode and break them again.' });
  const NODE_NAMES = ['server-1', 'server-2', 'server-3'];
  const MOOD = {
    calm: '🧑‍💻 You, the ops person: everything is fine… for now.',
    paged: '📟 3 a.m. — you get paged. Users are seeing errors.',
    fixing: '🛠 You ssh into servers and start containers by hand…',
    done: '😮‍💨 Fixed by hand. Until the next incident.',
  };
  const term = mkTerm({ height: '150px' });
  const desiredEl = h('b'), healthyEl = h('b');
  const nodesWrap = h('div', { class: 'k-nodes' });
  const brain = h('div', { class: 'b-brain' });
  const opsEl = h('div', { class: 'b-ops' });
  const loop = loopIndicator();
  s.stage.append(h('div', { class: 'b-why' },
    h('div', { class: 'b-col' },
      h('div', { class: 'b-goal' }, '🎯 Desired: ', desiredEl, ' copies of web · ✅ healthy: ', healthyEl),
      brain, term),
    nodesWrap));

  let st = { mode: 'manual', desired: 3, nodes: [], pods: [] };

  const isHealthy = (p) => p.el.dataset.status === 'ready';
  const upNodes = () => st.nodes.filter((n) => n.up);
  const podsOn = (node) => st.pods.filter((p) => p.node === node).length;
  const emptiestNode = () => upNodes().sort((a, b) => podsOn(a) - podsOn(b))[0];
  const hasDamage = () => st.pods.some((p) => !isHealthy(p)) || st.pods.length < st.desired;
  const setMood = (key) => { opsEl.textContent = MOOD[key]; };
  const renderBrain = () => brain.replaceChildren(st.mode === 'manual' ? opsEl : h('div', { class: 'b-k8s' }, h('b', {}, '☸ Kubernetes control loop'), loop));
  const syncGoal = () => {
    const healthy = st.pods.filter(isHealthy).length;
    desiredEl.textContent = st.desired;
    healthyEl.textContent = healthy;
    healthyEl.className = healthy >= st.desired ? 'b-ok' : 'b-bad';
  };

  const addPod = (node, status) => {
    const name = `web-${shortHash()}`;
    const pod = { name, node, el: podEl(name, { status, image: 'web:1.0' }) };
    st.pods.push(pod);
    node.box.pods.append(pod.el);
    return pod;
  };
  const startPod = async (node) => {
    const pod = addPod(node, 'creating');
    await wait(650);
    pod.el.setStatus('ready');
    syncGoal();
  };
  const removePod = async (pod) => {
    st.pods = st.pods.filter((p) => p !== pod);
    pod.el.setStatus('terminating');
    await pod.el.vanish();
    syncGoal();
  };

  const reconcile = async () => {
    await loop.light('observe');
    const broken = st.pods.filter((p) => !isHealthy(p));
    const missing = st.desired - (st.pods.length - broken.length);
    await loop.light('diff');
    if (!broken.length && missing <= 0 && st.pods.length <= st.desired) return loop.light(null);
    await loop.light('act');
    await Promise.all(broken.map(removePod));
    for (let i = 0; i < missing; i++) {
      const node = emptiestNode();
      if (!node) { s.say('No healthy server left. Kubernetes keeps trying until one comes back.'); break; }
      await startPod(node);
    }
    await Promise.all(st.pods.filter(isHealthy).slice(st.desired).map(removePod));
    await loop.light(null);
  };

  const crashOne = async () => {
    const pod = pick(st.pods.filter(isHealthy));
    pod.el.setStatus('crash');
    syncGoal();
    if (st.mode === 'manual') {
      setMood('paged');
      return s.say('A container crashed. Nothing restarts it: <b>one copy is gone</b> until a human notices.');
    }
    s.say('A container crashed. The <b>kubelet</b> on that server restarts it on its own…');
    await wait(900);
    pod.el.setStatus('creating');
    await wait(600);
    pod.el.setStatus('ready');
    syncGoal();
    s.say('Restarted in place. Nobody was woken up.');
  };

  const killServer = async () => {
    const node = st.nodes.find((n) => n.up && podsOn(n));
    node.up = false;
    node.box.setState('NotReady', 'bad');
    st.pods.filter((p) => p.node === node).forEach((p) => p.el.setStatus('failed'));
    syncGoal();
    if (st.mode === 'manual') {
      setMood('paged');
      return s.say(`<b>${node.name}</b> died with its containers. Your deploy script ran once, last week — it has no idea.`);
    }
    s.say(`<b>${node.name}</b> stopped answering. Kubernetes marks it <b>NotReady</b> and moves its work to healthy servers…`);
    await wait(800);
    await reconcile();
    s.say(`Back to <b>${st.desired}</b> healthy copies. The desired state wins, every time.`);
  };

  const repairServers = async () => {
    st.nodes.filter((n) => !n.up).forEach((n) => { n.up = true; n.box.setState('Ready'); });
    s.say('Servers are back. Kubernetes does <b>not</b> move running pods back — they stay where they are until something changes.');
  };

  const fixByHand = async () => {
    setMood('fixing');
    for (const pod of st.pods.filter((p) => !isHealthy(p))) {
      typed(term, `ssh ${pod.node.name}`);
      await wait(700);
      if (!pod.node.up) {
        fail(term, `ssh: connect to host ${pod.node.name} port 22: Connection timed out`);
        await wait(500);
      }
      await removePod(pod);
    }
    while (st.pods.length < st.desired) {
      const node = emptiestNode();
      if (!node) break;
      typed(term, `ssh ${node.name} docker run -d web:1.0`);
      await wait(900);
      out(term, `<span class="dim">${shortHash()}${shortHash()}${shortHash()}…</span>`);
      await startPod(node);
    }
    setMood('done');
    s.say('Fixed — after you woke up, found the problem and typed every command yourself. Now imagine 200 services on 50 servers.');
  };

  const POD_ROW = { ready: ['1/1', 'Running'], crash: ['0/1', 'CrashLoopBackOff'], failed: ['1/1', 'Unknown'], creating: ['0/1', 'ContainerCreating'], terminating: ['1/1', 'Terminating'] };
  const getPods = (line) => {
    typed(term, line);
    if (st.mode === 'manual') {
      fail(term, 'The connection to the server localhost:8080 was refused - did you specify the right host or port?');
      return s.say('In manual mode there is no cluster to ask — only servers and ssh.');
    }
    const wide = line.includes('-o wide');
    printTable(term, [['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['NODE'] : [])],
      ...st.pods.map((p) => [p.name, ...(POD_ROW[p.el.dataset.status] || ['0/1', 'Pending']), '0', '4m', ...(wide ? [p.node.name] : [])])]);
  };

  const scale = async (line) => {
    const replicas = Math.min(8, replicasIn(line));
    typed(term, line);
    out(term, 'deployment.apps/web scaled');
    st.desired = replicas;
    syncGoal();
    s.say(`You changed one number: desired = <b>${replicas}</b>. You did not say <i>where</i> or <i>how</i> — Kubernetes works that out.`);
    await reconcile();
  };

  const reset = () => {
    nodesWrap.replaceChildren();
    term.replaceChildren();
    st = { mode: st.mode, desired: 3, nodes: NODE_NAMES.map((name) => ({ name, up: true, box: nodeBox(name) })), pods: [] };
    st.nodes.forEach((n) => { nodesWrap.append(n.box.el); addPod(n, 'ready'); });
    out(term, '<span class="dim"># your terminal</span>');
    setMood('calm');
    renderBrain();
    syncGoal();
  };

  s.btn('🧑‍💻 Manual mode', async () => {
    st.mode = 'manual';
    setMood(hasDamage() ? 'paged' : 'calm');
    renderBrain();
    s.say('Manual mode: you run containers yourself with scripts and ssh. Try crashing a container or killing a server.');
  }, { enabled: () => st.mode !== 'manual' });
  s.btn('☸ Kubernetes mode', async () => {
    st.mode = 'k8s';
    renderBrain();
    s.say('You give Kubernetes the <b>desired state</b> — “3 copies of web” — and it compares reality to it, over and over.');
    await reconcile();
  }, { primary: true, enabled: () => st.mode !== 'k8s' });
  s.sep();
  s.btn('💥 Crash a container', crashOne, { enabled: () => st.pods.some(isHealthy) });
  s.btn('🔥 Kill a server', killServer, { enabled: () => upNodes().length > 1 && st.nodes.some((n) => n.up && podsOn(n)) });
  s.btn('🔧 Repair servers', repairServers, { enabled: () => st.nodes.some((n) => !n.up) });
  s.btn('🛠 Fix it by hand', fixByHand, { enabled: () => st.mode === 'manual' && hasDamage() });
  s.sep();
  cmdBtn(s, 'kubectl get pods -o wide', getPods, { cmd: /^kubectl get (?:pods?|po)(?: -o wide)?$/ });
  cmdBtn(s, 'kubectl scale deployment web --replicas=5', scale, {
    cmd: /^kubectl scale (?:deployment|deploy)(?:\/| )web --replicas[= ]?(\d+)$/,
    enabled: () => st.mode === 'k8s',
    why: 'Manual mode has no Kubernetes API. Switch to <b>Kubernetes mode</b> first.',
  });
  s.btn('↺ Reset', async () => { reset(); s.say('Fresh start: 3 servers, 3 copies of web.'); });
  reset();
};

// =====================================================================
// 2. Architecture — follow one command through every component
// =====================================================================
A.archTrace = (root) => {
  const s = scene(root, { title: 'Follow one command through the cluster', hint: 'Press <b>Next step ▶</b> to walk through it slowly, or run the whole command at once.' });
  const CMD = 'kubectl create deployment web --image=nginx --replicas=3';
  const term = mkTerm({ height: '120px' });
  const cp = controlPlane();
  const { api, etcd, sched, cm } = cp.parts;
  const etcdStore = h('div', { class: 'b-etcd-store' });
  etcd.append(etcdStore);
  const unscheduled = h('div', { class: 'k-node-pods b-unsched' });
  const makeWorker = (name) => {
    const box = nodeBox(name);
    const kubelet = h('span', { class: 'chip light' }, 'kubelet');
    const runtime = h('span', { class: 'chip' }, 'containerd');
    box.el.insertBefore(h('div', { class: 'chips b-agents' }, kubelet, runtime, h('span', { class: 'chip ghost' }, 'kube-proxy')), box.pods);
    return { name, box, kubelet, runtime };
  };
  const workers = ['node-1', 'node-2'].map(makeWorker);
  const send = (from, to, label, cls = '') => fly(s.stage, from, to, { label, cls });
  const remember = (text) => etcdStore.append(h('span', { class: 'chip light pop' }, text));

  let st = { step: 0, pods: [], rsHash: '7d4b9c6f5' };

  const STEPS = [
    { text: '<b>kubectl</b> reads your kubeconfig and sends an HTTPS <b>POST</b> to the API server.', run: async () => {
      typed(term, CMD);
      await send(term, api, 'POST /apis/apps/v1/…/deployments');
    } },
    { text: 'The <b>API server</b> checks who you are (authentication), whether you may do this (authorization), runs admission checks, validates the object and saves it in <b>etcd</b>.', run: async () => {
      await ping(api);
      await send(api, etcd, 'save Deployment');
      remember('deployment/web');
      await send(api, term, '201 Created', 'ok');
      out(term, 'deployment.apps/web created');
    } },
    { text: 'The <b>Deployment controller</b> (inside kube-controller-manager) is <b>watching</b> Deployments. It sees the new one and creates a <b>ReplicaSet</b>.', run: async () => {
      await send(api, cm, 'watch: Deployment added', 'white');
      await ping(cm);
      await send(cm, api, 'create ReplicaSet');
      await send(api, etcd, 'save');
      remember(`replicaset/web-${st.rsHash}`);
    } },
    { text: 'The <b>ReplicaSet controller</b> sees “want 3, have 0” and creates 3 <b>Pods</b>. They have no node yet — they are <b>Pending</b>.', run: async () => {
      await send(api, cm, 'watch: ReplicaSet added', 'white');
      await send(cm, api, 'create 3 Pods');
      await send(api, etcd, 'save');
      for (let i = 0; i < 3; i++) {
        const pod = podEl(`web-${st.rsHash}-${shortHash()}`, { status: 'pending', image: 'nginx' });
        st.pods.push(pod);
        unscheduled.append(pod);
      }
      remember('pod/web-… ×3');
    } },
    { text: 'The <b>scheduler</b> watches for pods with no node. It filters out nodes that cannot fit them, scores the rest and writes a <b>binding</b>: pod → node.', run: async () => {
      await send(api, sched, 'watch: 3 unscheduled', 'white');
      await ping(sched);
      for (const [i, pod] of st.pods.entries()) {
        const worker = workers[i % workers.length];
        await send(sched, api, `bind → ${worker.name}`);
        await moveTo(pod, worker.box.pods);
      }
    } },
    { text: 'Each <b>kubelet</b> watches for pods bound to <i>its</i> node. It tells the container runtime (<b>containerd</b>, through the CRI) to pull the image and start the containers.', run: async () => {
      const busyWorkers = workers.filter((w) => w.box.pods.children.length);
      await Promise.all(busyWorkers.map(async (w) => {
        await send(api, w.kubelet, 'watch: pod for me', 'white');
        await send(w.kubelet, w.runtime, 'CRI: pull + start');
      }));
      st.pods.forEach((p) => p.setStatus('creating'));
      await wait(900);
    } },
    { text: 'The containers are up. Each kubelet <b>reports status</b> to the API server, which saves it in etcd. <code>kubectl get pods</code> now shows <b>Running</b>.', run: async () => {
      st.pods.forEach((p) => p.setStatus('ready'));
      await Promise.all(workers.map((w) => send(w.kubelet, api, 'status: Running', 'ok')));
      await send(api, etcd, 'save status');
    } },
  ];
  const stepList = h('ol', { class: 'b-steps' }, STEPS.map((x) => h('li', { html: x.text })));
  s.stage.append(h('div', { class: 'b-arch' },
    h('div', { class: 'b-col' }, title('💻 Your laptop', 'kubectl'), term, stepList),
    h('div', { class: 'b-col' }, cp.el, zone('Pods waiting for a node', unscheduled)),
    h('div', { class: 'b-col b-workers' }, ...workers.map((w) => w.box.el))));

  const highlight = () => [...stepList.children].forEach((li, i) => {
    li.classList.toggle('on', i === st.step - 1);
    li.classList.toggle('done', i < st.step - 1 || st.step === STEPS.length);
  });
  const nextStep = async () => {
    const step = STEPS[st.step];
    st.step++;
    highlight();
    s.say(`<b>Step ${st.step}/${STEPS.length}.</b> ${step.text}`);
    await step.run();
    if (st.step === STEPS.length) {
      highlight();
      s.say('Done in 7 hand-offs. Notice that no component called another directly: they all <b>watch the API server</b> and do their own small job.');
    }
  };
  const runAll = async () => { while (st.step < STEPS.length) await nextStep(); };
  const nodeOf = (pod) => workers.find((w) => w.box.pods.contains(pod))?.name || '<none>';
  const STATUS = { pending: 'Pending', creating: 'ContainerCreating', ready: 'Running', terminating: 'Terminating' };
  const getPods = (line) => {
    typed(term, line);
    if (!st.pods.length) return out(term, 'No resources found in default namespace.');
    printTable(term, [['NAME', 'READY', 'STATUS', 'NODE'], ...st.pods.map((p) => [p.title, p.dataset.status === 'ready' ? '1/1' : '0/1', STATUS[p.dataset.status], nodeOf(p)])]);
  };
  const deleteDeployment = async (line) => {
    typed(term, line);
    await send(term, api, 'DELETE deployment');
    out(term, 'deployment.apps "web" deleted');
    s.say('The <b>garbage collector</b> follows <code>ownerReferences</code> — Deployment → ReplicaSet → Pods — and deletes the whole chain.');
    await send(api, cm, 'GC: delete dependents', 'white');
    st.pods.forEach((p) => p.setStatus('terminating'));
    await wait(700);
    await Promise.all(st.pods.map((p) => p.vanish()));
    etcdStore.replaceChildren();
    st = { ...st, step: 0, pods: [] };
    highlight();
  };
  const reset = () => {
    st.pods.forEach((p) => p.remove());
    etcdStore.replaceChildren();
    term.replaceChildren();
    out(term, '<span class="dim"># kubeconfig → https://127.0.0.1:6443</span>');
    st = { step: 0, pods: [], rsHash: '7d4b9c6f5' };
    highlight();
  };

  cmdBtn(s, CMD, runAll, { primary: true, enabled: () => st.step === 0, why: 'This trace is already running or done. Press <b>↺ Reset</b> to start again.' });
  s.btn('Next step ▶', nextStep, { enabled: () => st.step < STEPS.length });
  s.sep();
  cmdBtn(s, 'kubectl get pods -o wide', getPods, { cmd: /^kubectl get (?:pods?|po)(?: -o wide)?$/ });
  cmdBtn(s, 'kubectl delete deployment web', deleteDeployment, {
    cmd: /^kubectl delete (?:deployment|deploy)(?:\/| )web$/,
    enabled: () => st.step === STEPS.length,
    why: 'Create the Deployment first — run all 7 steps.',
  });
  s.btn('↺ Reset', async () => { reset(); s.say('Reset. Nothing exists in the cluster yet.'); });
  reset();
};

// =====================================================================
// 3. kubectl basics — every command is an HTTPS request; contexts pick the cluster
// =====================================================================
const API_RESOURCES = {
  pods: { prefix: '/api/v1', namespaced: true, kind: 'pod', group: '' },
  services: { prefix: '/api/v1', namespaced: true, kind: 'service', group: '' },
  nodes: { prefix: '/api/v1', namespaced: false, kind: 'node', group: '' },
  namespaces: { prefix: '/api/v1', namespaced: false, kind: 'namespace', group: '' },
  deployments: { prefix: '/apis/apps/v1', namespaced: true, kind: 'deployment.apps', group: 'apps' },
};
const RESOURCE_ALIASES = { po: 'pods', pod: 'pods', svc: 'services', service: 'services', no: 'nodes', node: 'nodes', ns: 'namespaces', namespace: 'namespaces', deploy: 'deployments', deployment: 'deployments' };
const HTTP_VERB = { get: 'GET', delete: 'DELETE', create: 'POST' };

const seedClusters = () => ({
  'kind-dev': {
    server: 'https://127.0.0.1:6443', user: 'kind-dev', canWrite: true,
    nodes: ['dev-control-plane', 'dev-worker'],
    namespaces: ['default', 'kube-node-lease', 'kube-public', 'kube-system'],
    pods: { default: ['web-7d4b9c6f5-x2k8p', 'web-7d4b9c6f5-m4n7q', 'api-5f6d8b7c4-q9w2e'], 'kube-system': ['coredns-668d6bf9bc-4xk2p', 'etcd-dev-control-plane', 'kube-apiserver-dev-control-plane', 'kube-proxy-8vz5t', 'kube-scheduler-dev-control-plane'] },
    deployments: { default: ['api', 'web'], 'kube-system': ['coredns'] },
    services: { default: ['kubernetes', 'web'], 'kube-system': ['kube-dns'] },
  },
  prod: {
    server: 'https://k8s.prod.example.com', user: 'dev@example.com', canWrite: false,
    nodes: ['ip-10-0-1-12', 'ip-10-0-2-34', 'ip-10-0-3-56'],
    namespaces: ['default', 'kube-node-lease', 'kube-public', 'kube-system', 'shop'],
    pods: { default: [], shop: ['checkout-6c9f7d8b5-2kq8w', 'checkout-6c9f7d8b5-7xm4p', 'shop-84d5c9f6b-h2l9v', 'shop-84d5c9f6b-r8t3n', 'shop-84d5c9f6b-z5c1k'], 'kube-system': ['aws-node-6tq2x', 'coredns-5b8f7d9c4-p7f2m', 'kube-proxy-k2l8d'] },
    deployments: { shop: ['checkout', 'shop'], 'kube-system': ['coredns'] },
    services: { default: ['kubernetes'], shop: ['checkout', 'shop'], 'kube-system': ['kube-dns'] },
  },
});

const parseRequest = (line) => {
  const [, verb, ...words] = line.split(' ');
  const verbose = words.some((w) => /^--?v=?\d+$/.test(w));
  const { ns, all, rest } = namespaceFlags(words.filter((w) => !/^--?v=?\d+$/.test(w)), 'default');
  let [resourceWord, name] = rest;
  if (resourceWord?.includes('/')) [resourceWord, name] = resourceWord.split('/');
  return { verb, resource: RESOURCE_ALIASES[resourceWord] || resourceWord, name, ns, all, verbose };
};

A.kubectlRest = (root) => {
  const s = scene(root, { title: 'What kubectl really sends', hint: 'Every kubectl command becomes an HTTPS request to the API server of your <b>current context</b>.' });
  const term = mkTerm({ height: '210px' });
  const methodEl = h('span', { class: 'b-method' }, '—');
  const urlEl = h('code', { class: 'b-url' }, 'run a command…');
  const authEl = h('small', { class: 'b-auth' });
  const statusEl = h('span', { class: 'b-status' });
  const reqCard = h('div', { class: 'b-req' },
    h('div', { class: 'zone-title' }, 'HTTP request'), h('div', { class: 'b-req-line' }, methodEl, urlEl), authEl,
    h('div', { class: 'zone-title', style: { marginTop: '8px' } }, 'Response'), statusEl);
  const clusterEls = {};
  const clustersWrap = h('div', { class: 'b-clusters' });
  s.stage.append(h('div', { class: 'b-rest' }, term, reqCard, clustersWrap));

  let st = { context: 'kind-dev', clusters: seedClusters() };

  const renderClusters = () => {
    clustersWrap.replaceChildren(...Object.entries(st.clusters).map(([name, c]) => {
      clusterEls[name] = h('div', { class: `node b-cluster ${name === st.context ? 'active' : ''}` },
        title(`☸ ${name}`, name === st.context ? '● current context' : ''),
        h('small', { class: 'b-server' }, c.server),
        h('div', { class: 'chips' }, c.nodes.map((n) => h('span', { class: 'chip light' }, `🖥 ${n}`))));
      return clusterEls[name];
    }));
  };
  const showRequest = (method, url, cluster) => {
    methodEl.textContent = method;
    methodEl.className = `b-method ${method.toLowerCase()}`;
    urlEl.textContent = url;
    authEl.textContent = cluster ? `credentials of user “${cluster.user}” from ~/.kube/config` : 'nothing sent — kubectl config only reads/edits ~/.kube/config';
    statusEl.textContent = '…';
    statusEl.className = 'b-status';
  };

  const listRows = (cluster, req) => {
    const meta = API_RESOURCES[req.resource];
    const source = cluster[req.resource];
    if (!meta.namespaced) return source.map((name) => ({ name }));
    const namespaces = req.all ? Object.keys(source) : [req.ns];
    return namespaces.flatMap((ns) => (source[ns] || []).map((name) => ({ ns, name })));
  };
  const formatList = (req, rows) => {
    const isPods = req.resource === 'pods';
    const head = [...(req.all ? ['NAMESPACE'] : []), 'NAME', ...(isPods ? ['READY', 'STATUS', 'RESTARTS'] : []), 'AGE'];
    return escapeHtml(columns([head, ...rows.map((r) => [...(req.all ? [r.ns] : []), r.name, ...(isPods ? ['1/1', 'Running', '0'] : []), '3d'])]));
  };

  const respond = (req, cluster) => {
    const meta = API_RESOURCES[req.resource];
    const where = meta.namespaced ? ` in the namespace "${req.ns}"` : ' at the cluster scope';
    const bucket = meta.namespaced ? (cluster[req.resource][req.ns] ||= []) : cluster[req.resource];
    const forbidden = { code: '403 Forbidden', text: `Error from server (Forbidden): ${req.resource}${req.name ? ` "${req.name}"` : ''} is forbidden: User "${cluster.user}" cannot ${req.verb} resource "${req.resource}" in API group "${meta.group}"${where}` };
    const notFound = { code: '404 Not Found', text: `Error from server (NotFound): ${req.resource} "${req.name}" not found` };
    if (req.verb === 'create') {
      if (!cluster.canWrite) return forbidden;
      if (bucket.includes(req.name)) return { code: '409 Conflict', text: `Error from server (AlreadyExists): ${req.resource} "${req.name}" already exists` };
      bucket.push(req.name);
      if (req.resource === 'namespaces') cluster.pods[req.name] = [];
      return { code: '201 Created', text: `${meta.kind}/${req.name} created` };
    }
    if (req.verb === 'delete') {
      if (!cluster.canWrite) return forbidden;
      if (!bucket.includes(req.name)) return notFound;
      bucket.splice(bucket.indexOf(req.name), 1);
      return { code: '200 OK', text: `${meta.kind} "${req.name}" deleted` };
    }
    if (req.name) return bucket.includes(req.name) ? { code: '200 OK', html: formatList(req, [{ ns: req.ns, name: req.name }]) } : notFound;
    const rows = listRows(cluster, req);
    if (!rows.length) return { code: '200 OK', text: `No resources found in ${req.ns} namespace.` };
    return { code: '200 OK', html: formatList(req, rows) };
  };

  const urlFor = (req, server) => {
    const meta = API_RESOURCES[req.resource];
    const nsPart = meta.namespaced && !req.all ? `/namespaces/${req.ns}` : '';
    const namePart = req.name && req.verb !== 'create' ? `/${req.name}` : '';
    const query = req.verb === 'get' && !req.name ? '?limit=500' : '';
    return `${server}${meta.prefix}${nsPart}/${req.resource}${namePart}${query}`;
  };

  const configCmd = (line) => {
    showRequest('—', 'no HTTP request', null);
    const [, , sub, arg] = line.split(' ');
    const contexts = Object.keys(st.clusters);
    switch (sub) {
      case 'get-contexts':
        printTable(term, [['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ...contexts.map((c) => [c === st.context ? '*' : '', c, c, st.clusters[c].user, ''])]);
        break;
      case 'current-context':
        out(term, st.context);
        break;
      case 'use-context':
        if (!contexts.includes(arg)) return fail(term, `error: no context exists with the name: "${arg}"`);
        st.context = arg;
        renderClusters();
        out(term, `Switched to context "${arg}".`);
        s.say(`Now every command goes to <b>${arg}</b>. ${arg === 'prod' ? 'Careful — this is production. Your user here may only read.' : 'Back on your laptop cluster.'}`);
        return;
      default:
        return fail(term, `error: unknown command "${sub}" for "kubectl config"`);
    }
    s.say('<code>kubectl config</code> commands only read or edit your local <b>kubeconfig</b> file. Nothing is sent to any cluster.');
  };

  const handle = async (line) => {
    typed(term, line);
    if (line.startsWith('kubectl config ')) return configCmd(line);
    const req = parseRequest(line);
    const meta = API_RESOURCES[req.resource];
    if (!HTTP_VERB[req.verb]) return fail(term, `error: unknown command "${req.verb}" for "kubectl"`);
    if (!meta) return fail(term, `error: the server doesn't have a resource type "${req.resource || ''}"`);
    if (req.verb !== 'get' && !req.name) return fail(term, `error: resource(s) were provided, but no name was specified`);
    const cluster = st.clusters[st.context];
    const method = HTTP_VERB[req.verb];
    const url = urlFor(req, cluster.server);
    showRequest(method, url, cluster);
    await fly(s.stage, term, clusterEls[st.context], { label: `${method} ${url.replace(cluster.server, '').split('?')[0]}` });
    const res = respond(req, cluster);
    const ok = res.code.startsWith('2');
    statusEl.textContent = res.code;
    statusEl.className = `b-status ${ok ? 'ok' : 'bad'}`;
    await fly(s.stage, clusterEls[st.context], term, { label: res.code, cls: ok ? 'ok' : 'bad' });
    if (req.verbose) out(term, `<span class="dim">I1116 09:41:07.512  round_trippers.go:553] ${method} ${escapeHtml(url)} ${res.code} in 11 milliseconds</span>`);
    if (res.html) out(term, res.html);
    else if (ok) out(term, escapeHtml(res.text));
    else fail(term, res.text);
    s.say(ok
      ? `<code>${method}</code> on <code>${escapeHtml(url.replace(cluster.server, ''))}</code>. kubectl turned the reply (JSON) into this table.`
      : `The API server answered <b>${res.code}</b>. kubectl only shows what the server decided.`);
  };

  cmdBtn(s, 'kubectl get pods', handle, { primary: true });
  cmdBtn(s, 'kubectl get pods -n kube-system -v=6', handle);
  cmdBtn(s, 'kubectl get deployments', handle);
  cmdBtn(s, 'kubectl get nodes', handle);
  cmdBtn(s, 'kubectl delete pod web-7d4b9c6f5-x2k8p', handle);
  s.sep();
  cmdBtn(s, 'kubectl config get-contexts', handle);
  cmdBtn(s, 'kubectl config use-context prod', handle, { enabled: () => st.context !== 'prod' });
  cmdBtn(s, 'kubectl config use-context kind-dev', handle, { enabled: () => st.context !== 'kind-dev' });
  s.command([/^kubectl (?:get|delete|create|config) .+$/], (_, m) => handle(m.input), { example: 'kubectl get pods -A' });
  s.btn('↺ Reset', async () => {
    st = { context: 'kind-dev', clusters: seedClusters() };
    term.replaceChildren();
    renderClusters();
    showRequest('—', 'run a command…', null);
    s.say('Reset. Current context: <b>kind-dev</b>.');
  });
  renderClusters();
  out(term, '<span class="dim"># ~/.kube/config has two contexts: kind-dev and prod</span>');
};

// =====================================================================
// 4a. Pods — a pod's life, including crash loops and image pull errors
// =====================================================================
A.podsLifecycle = (root) => {
  const s = scene(root, { title: 'A pod’s life', hint: 'Run a pod, make it crash, read its logs, then delete it.' });
  const PHASES = ['Pending', 'ContainerCreating', 'Running', 'CrashLoopBackOff', 'Terminating'];
  const BACKOFF_SECONDS = [10, 20, 40, 80, 160, 300];
  const KNOWN_IMAGE = /^(nginx|busybox|redis|postgres|httpd|alpine|node|python)(:[\w.-]+)?$/;
  const RUN_POD = /^kubectl run ([a-z0-9-]+) --image[= ](\S+)(?: --restart=never)?$/;
  const START_LOG = ['/docker-entrypoint.sh: Configuration complete; ready for start up', '2025/11/16 09:41:07 [notice] 1#1: nginx/1.27.5', '2025/11/16 09:41:07 [notice] 1#1: start worker processes'];
  const CRASH_LOG = ['/docker-entrypoint.sh: Configuration complete; ready for start up', '2025/11/16 09:42:13 [emerg] 1#1: host not found in upstream "api" in /etc/nginx/conf.d/default.conf:14', 'nginx: [emerg] host not found in upstream "api" in /etc/nginx/conf.d/default.conf:14'];
  const strip = h('div', { class: 'b-phases' }, PHASES.map((p) => h('span', { 'data-phase': p }, p)));
  const queue = h('div', { class: 'k-node-pods b-queue' });
  const node = nodeBox('node-1', { capacity: 'containerd · 4 CPU · 8 GiB' });
  const backoffEl = h('div', { class: 'b-backoff' });
  const term = mkTerm({ height: '200px' });
  s.stage.append(h('div', { class: 'b-life' },
    h('div', { class: 'b-col' }, strip, zone('API server: pods without a node', queue), node.el, backoffEl),
    term));

  const fresh = () => ({ pod: null, name: '', image: '', restarts: 0, crashing: false, events: [], logs: [], previousLogs: [], waitingReason: '' });
  let st = fresh();

  const setPhase = (phase) => strip.querySelectorAll('span').forEach((x) => x.classList.toggle('on', x.dataset.phase === phase));
  const event = (type, reason, from, message) => st.events.push([type, reason, from, message]);
  const exists = (name) => st.pod && st.name === name;
  const notFound = (name) => fail(term, `Error from server (NotFound): pods "${name}" not found`);

  const runPod = async (line) => {
    const [, name, image] = line.match(RUN_POD) ?? [null, 'web', 'nginx'];
    typed(term, line);
    if (st.pod) return fail(term, `Error from server (AlreadyExists): pods "${name}" already exists`);
    st = { ...fresh(), name, image };
    out(term, `pod/${name} created`);
    st.pod = podEl(name, { status: 'pending', image });
    queue.append(st.pod);
    setPhase('Pending');
    s.say('<b>Pending</b>: the pod is saved in the API, but no node has been chosen yet. The scheduler is looking for one.');
    await wait(1000);
    event('Normal', 'Scheduled', 'default-scheduler', `Successfully assigned default/${name} to node-1`);
    await moveTo(st.pod, node.pods);
    st.pod.setStatus('creating');
    setPhase('ContainerCreating');
    s.say(`<b>ContainerCreating</b>: the kubelet on node-1 asks containerd to pull <code>${escapeHtml(image)}</code>. The pod <i>phase</i> is still Pending until a container starts.`);
    event('Normal', 'Pulling', 'kubelet', `Pulling image "${image}"`);
    await wait(1100);
    if (!KNOWN_IMAGE.test(image)) return imagePullFails();
    event('Normal', 'Pulled', 'kubelet', `Successfully pulled image "${image}" in 1.2s`);
    event('Normal', 'Created', 'kubelet', `Created container: ${name}`);
    event('Normal', 'Started', 'kubelet', `Started container ${name}`);
    st.pod.setStatus('ready');
    setPhase('Running');
    st.logs = START_LOG;
    s.say('<b>Running</b> and <b>Ready (1/1)</b>: the container started and the pod can receive traffic.');
  };

  const imagePullFails = async () => {
    st.pod.setStatus('failed');
    st.waitingReason = 'ErrImagePull';
    setPodText(st.pod, 'ErrImagePull');
    setPhase(null);
    event('Warning', 'Failed', 'kubelet', `Failed to pull image "${st.image}": pull access denied, repository does not exist or may require authorization`);
    s.say(`<b>ErrImagePull</b>: there is no image called <code>${escapeHtml(st.image)}</code> (typo?). The kubelet will retry with growing delays…`);
    await wait(1400);
    st.waitingReason = 'ImagePullBackOff';
    setPodText(st.pod, 'ImagePullBackOff');
    event('Normal', 'BackOff', 'kubelet', `Back-off pulling image "${st.image}"`);
    s.say('<b>ImagePullBackOff</b>: still failing, now waiting longer between tries. Fix the image name, then delete and re-create the pod.');
  };

  const crashLoop = async () => {
    st.crashing = true;
    for (let i = 0; i < 3; i++) {
      st.pod.setStatus('crash');
      setPodText(st.pod, 'Error');
      setPhase('CrashLoopBackOff');
      st.previousLogs = CRASH_LOG;
      st.logs = [];
      st.restarts++;
      const delay = BACKOFF_SECONDS[i];
      event('Warning', 'BackOff', 'kubelet', `Back-off restarting failed container ${st.name} in pod ${st.name}_default`);
      backoffEl.replaceChildren(h('b', {}, `Restart #${st.restarts}`), ` — waiting ${delay}s before the next try (sped up here)`);
      setPodText(st.pod, 'CrashLoopBackOff');
      s.say(`The container exited with an error. The kubelet restarts it, but waits <b>${delay}s</b> first — the delay doubles each time, up to 5 minutes.`);
      await wait(900 + i * 500);
      st.pod.setStatus('creating');
      await wait(400);
      st.pod.setStatus('running');
      await wait(500);
    }
    st.pod.setStatus('crash');
    setPodText(st.pod, 'CrashLoopBackOff');
    setPhase('CrashLoopBackOff');
    st.restarts++;
    backoffEl.replaceChildren(h('b', {}, `Restart #${st.restarts}`), ' — waiting 80s… The pod is stuck in a crash loop.');
    s.say('Stuck in <b>CrashLoopBackOff</b>. The pod is not deleted — it keeps restarting. Read <code>kubectl logs web --previous</code> to see why the last run died.');
  };

  const fixUpstream = async () => {
    s.say('You create the missing <code>api</code> Service. On the next restart nginx can resolve it…');
    await wait(1000);
    st.crashing = false;
    st.pod.setStatus('creating');
    await wait(500);
    st.pod.setStatus('ready');
    setPhase('Running');
    st.logs = START_LOG;
    backoffEl.replaceChildren();
    s.say(`Running again. The <b>RESTARTS</b> column still says ${st.restarts} — a clue that something went wrong earlier.`);
  };

  const STATUS_TEXT = { pending: 'Pending', creating: 'ContainerCreating', ready: 'Running', running: 'Running', crash: 'CrashLoopBackOff', terminating: 'Terminating' };
  const getPods = (line) => {
    typed(term, line);
    if (!st.pod) return out(term, 'No resources found in default namespace.');
    const status = st.pod.dataset.status;
    const restarts = st.restarts ? `${st.restarts} (12s ago)` : '0';
    printTable(term, [['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'], [st.name, status === 'ready' ? '1/1' : '0/1', STATUS_TEXT[status] || st.waitingReason, restarts, '2m']]);
  };
  const describe = (line, m) => {
    typed(term, line);
    if (!exists(m?.[1] ?? 'web')) return notFound(m?.[1] ?? 'web');
    const crashed = st.restarts > 0;
    const lines = [
      `Name:         ${st.name}`, 'Namespace:    default', 'Node:         node-1/172.18.0.3', `Status:       ${st.pod.dataset.status === 'pending' ? 'Pending' : 'Running'}`, 'IP:           10.244.1.7',
      'Containers:', `  ${st.name}:`, `    Image:          ${st.image}`,
      `    State:          ${st.pod.dataset.status === 'crash' ? 'Waiting\n      Reason:       CrashLoopBackOff' : 'Running'}`,
      ...(crashed ? ['    Last State:     Terminated', '      Reason:       Error', '      Exit Code:    1'] : []),
      `    Restart Count:  ${st.restarts}`, 'Events:', columns([['  Type', 'Reason', 'From', 'Message'], ...st.events.slice(-6).map(([t, r, f, msg]) => [`  ${t}`, r, f, msg])]),
    ];
    out(term, escapeHtml(lines.join('\n')));
    s.say('<code>kubectl describe</code> shows the pod’s state, the <b>last state</b> of each container and the <b>Events</b> — usually the fastest way to see what went wrong.');
  };
  const logs = (line, m) => {
    typed(term, line);
    const name = m?.[1] ?? 'web';
    const previous = Boolean(m?.[2]) || line.includes('--previous');
    if (!exists(name)) return notFound(name);
    if (previous && !st.restarts) return fail(term, `Error from server (BadRequest): previous terminated container "${name}" in pod "${name}" not found`);
    const text = previous ? st.previousLogs : st.logs;
    out(term, escapeHtml(text.join('\n')) || '<span class="dim">(no output yet)</span>');
    s.say(previous ? 'Logs of the <b>previous</b> (crashed) container: nginx cannot find the host <code>api</code>.' : 'Logs of the <b>current</b> container (what it printed to stdout/stderr).');
  };
  const deletePod = async (line, m) => {
    typed(term, line);
    const name = m?.[1] ?? 'web';
    if (!exists(name)) return notFound(name);
    out(term, `pod "${name}" deleted`);
    st.pod.setStatus('terminating');
    setPhase('Terminating');
    s.say('<b>Terminating</b>: the kubelet sends <b>SIGTERM</b> and waits up to 30 s (the grace period) for the app to shut down cleanly, then SIGKILL.');
    await wait(1200);
    await st.pod.vanish();
    st = fresh();
    setPhase(null);
    backoffEl.replaceChildren();
    s.say('Gone for good. A bare pod is <b>not</b> re-created — that is what Deployments are for.');
  };

  const hasPod = () => Boolean(st.pod);
  const noPodWhy = 'There is no pod yet. Run <code>kubectl run web --image=nginx</code> first.';
  cmdBtn(s, 'kubectl run web --image=nginx', runPod, { primary: true, cmd: RUN_POD, enabled: () => !hasPod(), why: 'A pod with that name already exists. Delete it first.' });
  cmdBtn(s, 'kubectl run oops --image=ngnix', runPod, { enabled: () => !hasPod(), why: 'Delete the current pod first.' });
  cmdBtn(s, 'kubectl get pods', getPods, { cmd: /^kubectl get (?:pods?|po)(?: -o wide)?$/ });
  s.sep();
  s.btn('💥 Make the app crash', crashLoop, { enabled: () => st.pod?.dataset.status === 'ready', why: 'The pod must be Running first.' });
  s.btn('🩹 Create the missing api Service', fixUpstream, { enabled: () => st.crashing });
  cmdBtn(s, 'kubectl logs web --previous', logs, { cmd: /^kubectl logs (?:pods?\/)?([a-z0-9-]+)( --previous| -p)?$/, enabled: hasPod, why: noPodWhy });
  cmdBtn(s, 'kubectl describe pod web', describe, { cmd: /^kubectl describe (?:pods?|po)(?:\/| )([a-z0-9-]+)$/, enabled: hasPod, why: noPodWhy });
  cmdBtn(s, 'kubectl delete pod web', deletePod, { cmd: /^kubectl delete (?:pods?|po)(?:\/| )([a-z0-9-]+)$/, enabled: hasPod, why: noPodWhy });
  s.btn('↺ Reset', async () => {
    st.pod?.remove();
    st = fresh();
    setPhase(null);
    backoffEl.replaceChildren();
    term.replaceChildren();
    s.say('Reset. No pods.');
  });
};

// =====================================================================
// 4b. Pods — two containers share one IP (localhost) and a volume
// =====================================================================
A.podsSharedNetwork = (root) => {
  const s = scene(root, { title: 'Inside one pod: shared network and storage', hint: 'Two containers, one IP address. They talk over <code>localhost</code> and share a volume.' });
  const term = mkTerm({ height: '130px' });
  const container = (name, image, note) => {
    const el = h('div', { class: 'b-ctr' }, h('b', {}, `📦 ${name}`), h('small', {}, image), h('small', {}, note));
    return el;
  };
  const appBox = container('app', 'nginx:1.27', 'listens on port 80');
  const sideBox = container('log-shipper', 'busybox', 'reads /var/log/nginx');
  const files = h('div', { class: 'chips' });
  const volume = h('div', { class: 'b-volume' }, h('b', {}, '🗂 volume “logs” (emptyDir)'), h('small', {}, 'mounted in both containers at /var/log/nginx'), files);
  const ipBadge = h('span', { class: 'chip blue' }, 'Pod IP 10.244.1.7');
  const podShell = h('div', { class: 'b-pod-shell' },
    h('div', { class: 'b-pod-head' }, h('b', {}, '🫛 Pod web'), ipBadge),
    h('div', { class: 'b-pod-inner' }, appBox, h('div', { class: 'b-localhost' }, '⇄ localhost'), sideBox),
    volume);
  const otherPod = podEl('api-5f6d8b7c4-q9w2e', { status: 'ready', ip: '10.244.2.4' });
  const storeChips = h('div', { class: 'chips' });
  const logStore = h('div', { class: 'node b-store' }, title('☁ Log store'), storeChips);
  s.stage.append(h('div', { class: 'b-shared' }, podShell, h('div', { class: 'b-col' }, zone('another pod', otherPod), logStore), term));

  let st = { lines: 0, shipped: 0 };

  const renderFiles = () => files.replaceChildren(
    h('span', { class: 'chip light' }, `access.log · ${st.lines} line${st.lines === 1 ? '' : 's'}`),
    h('span', { class: 'chip light' }, 'error.log · 0 lines'));
  const appendLog = async () => {
    await fly(s.stage, appBox, volume, { label: '+1 line → access.log', cls: 'white', ms: 700 });
    st.lines++;
    renderFiles();
    flash(volume);
  };

  const curlLocalhost = async (line) => {
    typed(term, line);
    await fly(s.stage, sideBox, appBox, { label: 'GET localhost:80' });
    await fly(s.stage, appBox, sideBox, { label: '200 OK', cls: 'ok' });
    out(term, escapeHtml('<!DOCTYPE html>\n<html><head><title>Welcome to nginx!</title>…'));
    s.say('Both containers share one <b>network namespace</b>, so <code>localhost:80</code> from the sidecar reaches nginx directly.');
    await appendLog();
  };
  const fromOtherPod = async () => {
    await fly(s.stage, otherPod, ipBadge, { label: 'GET 10.244.1.7:80' });
    await fly(s.stage, ipBadge, appBox, { label: ':80 → app', ms: 600 });
    await fly(s.stage, appBox, otherPod, { label: '200 OK', cls: 'ok' });
    s.say('Other pods use the <b>pod IP</b>. One IP for the whole pod: the <b>port</b> decides which container answers.');
    await appendLog();
  };
  const shipLogs = async (line) => {
    typed(term, line);
    if (!st.lines) {
      out(term, 'watching /var/log/nginx/access.log …');
      return s.say('Nothing to ship yet. Send a request first so nginx writes a log line.');
    }
    await fly(s.stage, volume, sideBox, { label: `read ${st.lines - st.shipped} new`, cls: 'white' });
    await fly(s.stage, sideBox, logStore, { label: 'ship →' });
    storeChips.append(h('span', { class: 'chip ok pop' }, `${st.lines - st.shipped} line${st.lines - st.shipped === 1 ? '' : 's'}`));
    out(term, `shipped ${st.lines - st.shipped} line(s) from /var/log/nginx/access.log`);
    st.shipped = st.lines;
    s.say('The sidecar reads the file the app wrote, through the <b>shared volume</b>. Each container has its own filesystem — only mounted volumes are shared.');
  };
  const listFiles = (line) => {
    typed(term, line);
    out(term, 'access.log\nerror.log');
  };
  const portClash = async () => {
    sideBox.classList.add('b-broken');
    out(term, '<span class="bad">nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)</span>');
    s.say('A second container tried to listen on port <b>80</b> too. Same network namespace → <b>port conflict</b>, exactly like two programs on one laptop.');
    await wait(1800);
    sideBox.classList.remove('b-broken');
    s.say('Rule: containers in one pod must use <b>different ports</b>.');
  };

  cmdBtn(s, 'kubectl exec web -c log-shipper -- wget -qO- localhost:80', curlLocalhost, { primary: true, cmd: /^kubectl exec (?:-it )?web -c log-shipper -- (?:wget -qo- |curl -s )?(?:http:\/\/)?localhost(?::80)?\/?$/ });
  s.btn('🌐 Request from another pod', fromOtherPod);
  cmdBtn(s, 'kubectl logs web -c log-shipper', shipLogs);
  cmdBtn(s, 'kubectl exec web -c app -- ls /var/log/nginx', listFiles);
  s.btn('⚠️ Second container also uses :80', portClash);
  s.btn('↺ Reset', async () => {
    st = { lines: 0, shipped: 0 };
    renderFiles();
    storeChips.replaceChildren();
    term.replaceChildren();
    s.say('Reset.');
  });
  renderFiles();
};

// =====================================================================
// 5. Manifests — desired state in a file, apply, diff, drift
// =====================================================================
A.manifestsApply = (root) => {
  const s = scene(root, { title: 'Desired state in a file, actual state in the cluster', hint: 'Edit the file with the buttons, then <b>diff</b> and <b>apply</b> it.' });
  const IMAGES = ['nginx:1.27', 'nginx:1.28'];
  const RS_HASH = { 'nginx:1.27': '7d4b9c6f5', 'nginx:1.28': '5c8f7b9d2' };
  const fileSlot = h('div', { class: 'b-file-slot' });
  const liveSlot = h('div');
  const podsWrap = h('div', { class: 'k-node-pods' });
  const term = mkTerm({ height: '160px' });
  s.stage.append(h('div', { class: 'b-manifest' },
    h('div', { class: 'b-col' }, h('div', { class: 'zone-title' }, '📁 Git repo — desired state'), fileSlot),
    h('div', { class: 'b-col' }, h('div', { class: 'zone-title' }, '☸ Cluster — actual state'), podsWrap, liveSlot),
    h('div', { class: 'b-span' }, term)));

  let st = { file: { replicas: 2, image: IMAGES[0] }, live: null, generation: 0, pods: [] };

  const fileYaml = ({ replicas, image }) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: ${replicas}\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n      - name: web\n        image: ${image}`;
  const changes = () => (st.live ? ['replicas', 'image'].filter((k) => st.live[k] !== st.file[k]) : ['replicas', 'image']);
  const readyCount = () => st.pods.filter((p) => p.el.dataset.status === 'ready').length;
  const renderFile = () => {
    const dirty = changes().length > 0;
    fileSlot.replaceChildren(yamlCard(fileYaml(st.file), { name: 'deployment.yaml' }),
      h('small', { class: `b-dirty ${dirty ? 'on' : ''}` }, dirty ? '✏️ differs from the cluster — not applied yet' : '✓ matches the cluster'));
  };
  const renderLive = () => {
    if (!st.live) return liveSlot.replaceChildren(h('p', { class: 'b-empty' }, 'No Deployment “web” in the cluster.'));
    const ready = readyCount();
    liveSlot.replaceChildren(yamlCard(`metadata:\n  generation: ${st.generation}\nspec:\n  replicas: ${st.live.replicas}\n  …image: ${st.live.image}\nstatus:            # written by the controller\n  observedGeneration: ${st.generation}\n  replicas: ${st.pods.length}\n  readyReplicas: ${ready}`, { name: 'kubectl get deploy web -o yaml' }));
  };
  const addPod = async (image) => {
    const pod = { image, el: podEl(`web-${RS_HASH[image]}-${shortHash()}`, { status: 'creating', image }) };
    st.pods.push(pod);
    podsWrap.append(pod.el);
    await wait(600);
    pod.el.setStatus('ready');
    renderLive();
  };
  const removePod = async (pod) => {
    st.pods = st.pods.filter((p) => p !== pod);
    pod.el.setStatus('terminating');
    await pod.el.vanish();
    renderLive();
  };
  const converge = async () => {
    for (const old of st.pods.filter((p) => p.image !== st.live.image)) {
      await addPod(st.live.image);
      await removePod(old);
    }
    while (st.pods.length < st.live.replicas) await addPod(st.live.image);
    while (st.pods.length > st.live.replicas) await removePod(st.pods.at(-1));
    renderLive();
  };

  const diff = (line) => {
    typed(term, line);
    const changed = changes();
    if (!changed.length) {
      out(term, '<span class="dim">(no output — nothing would change)</span>');
      return s.say('<code>kubectl diff</code> printed nothing: the cluster already matches the file.');
    }
    const lines = st.live
      ? ['--- /tmp/LIVE-1873/apps.v1.Deployment.default.web', '+++ /tmp/MERGED-2210/apps.v1.Deployment.default.web',
        `<span class="bad">-  generation: ${st.generation}</span>`, `<span class="ok">+  generation: ${st.generation + 1}</span>`,
        ...changed.flatMap((k) => [`<span class="bad">-  ${k}: ${st.live[k]}</span>`, `<span class="ok">+  ${k}: ${st.file[k]}</span>`])]
      : fileYaml(st.file).split('\n').map((l) => `<span class="ok">+${escapeHtml(l)}</span>`);
    out(term, lines.join('\n'));
    s.say('<code>kubectl diff</code> asks the API server what <i>would</i> change, without changing anything. Review it before every apply.');
  };
  const apply = async (line) => {
    typed(term, line);
    const changed = changes();
    if (st.live && !changed.length) {
      out(term, 'deployment.apps/web unchanged');
      return s.say('Nothing to do: <b>apply</b> is safe to run again and again (it is <b>idempotent</b>).');
    }
    out(term, `deployment.apps/web ${st.live ? 'configured' : 'created'}`);
    st.live = { ...st.file };
    st.generation++;
    renderFile();
    renderLive();
    s.say(`The API server stored the new <b>spec</b> (generation ${st.generation}). Now the controllers make reality match it…`);
    await converge();
    s.say(`Converged: ${st.live.replicas} × <code>${st.live.image}</code>. The controller filled in <b>status</b> — you never write status yourself.`);
  };
  const drift = async (line) => {
    typed(term, line);
    st.live.replicas = replicasIn(line);
    st.generation++;
    out(term, 'deployment.apps/web scaled');
    renderFile();
    s.say('Someone changed the cluster <b>by hand</b>. Now Git and the cluster disagree — this is <b>drift</b>. Run <code>kubectl diff</code> to spot it.');
    await converge();
  };
  const getYaml = (line) => {
    typed(term, line);
    if (!st.live) return fail(term, 'Error from server (NotFound): deployments.apps "web" not found');
    out(term, escapeHtml(`${fileYaml(st.live).replace('metadata:\n  name: web', `metadata:\n  generation: ${st.generation}\n  name: web`)}\nstatus:\n  observedGeneration: ${st.generation}\n  readyReplicas: ${readyCount()}\n  replicas: ${st.pods.length}`));
  };
  const remove = async (line) => {
    typed(term, line);
    out(term, 'deployment.apps "web" deleted');
    st.live = null;
    await Promise.all(st.pods.map((p) => removePod(p)));
    renderFile();
    renderLive();
    s.say('<code>kubectl delete -f</code> deletes exactly the objects described in the file.');
  };

  s.btn('➖ replicas', async () => { st.file.replicas--; renderFile(); s.say('You edited the file. The cluster does not know yet.'); }, { enabled: () => st.file.replicas > 1 });
  s.btn('➕ replicas', async () => { st.file.replicas++; renderFile(); s.say('You edited the file. The cluster does not know yet.'); }, { enabled: () => st.file.replicas < 6 });
  s.btn('✏️ Change image', async () => {
    st.file.image = IMAGES.find((i) => i !== st.file.image);
    renderFile();
    s.say(`Image changed to <code>${st.file.image}</code> in the file only.`);
  });
  s.sep();
  cmdBtn(s, 'kubectl diff -f deployment.yaml', diff);
  cmdBtn(s, 'kubectl apply -f deployment.yaml', apply, { primary: true });
  cmdBtn(s, 'kubectl get deployment web -o yaml', getYaml, { cmd: /^kubectl get (?:deployments?|deploy)(?:\/| )web -o yaml$/ });
  cmdBtn(s, 'kubectl scale deployment web --replicas=5', drift, {
    cmd: /^kubectl scale (?:deployment|deploy)(?:\/| )web --replicas[= ]?(\d+)$/,
    enabled: () => Boolean(st.live), why: 'Apply the file first so the Deployment exists.',
  });
  cmdBtn(s, 'kubectl delete -f deployment.yaml', remove, { enabled: () => Boolean(st.live), why: 'Nothing to delete — apply the file first.' });
  s.btn('↺ Reset', async () => {
    st.pods.forEach((p) => p.el.remove());
    st = { file: { replicas: 2, image: IMAGES[0] }, live: null, generation: 0, pods: [] };
    term.replaceChildren();
    renderFile();
    renderLive();
    s.say('Reset: the file exists, the cluster is empty.');
  });
  renderFile();
  renderLive();
};

// =====================================================================
// 6. Labels & selectors — filter pods, relabel, watch a Service react
// =====================================================================
const LABELLED_PODS = [
  ['web-1', { app: 'web', env: 'prod', tier: 'frontend' }, '10.244.1.4'],
  ['web-2', { app: 'web', env: 'prod', tier: 'frontend' }, '10.244.2.7'],
  ['web-3', { app: 'web', env: 'staging', tier: 'frontend' }, '10.244.1.9'],
  ['api-1', { app: 'api', env: 'prod', tier: 'backend' }, '10.244.2.3'],
  ['api-2', { app: 'api', env: 'staging', tier: 'backend' }, '10.244.1.6'],
  ['db-0', { app: 'db', env: 'prod', tier: 'db' }, '10.244.2.11'],
];

// Splits "a=b,env in (x,y)" on commas that are not inside parentheses.
const splitRequirements = (text) => {
  const parts = [];
  let depth = 0, current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && !depth) { parts.push(current); current = ''; } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
};
const KEY = '([\\w./-]+)';
const REQUIREMENTS = [
  [new RegExp(`^${KEY}\\s+(in|notin)\\s*\\(([^)]*)\\)$`), (m) => {
    const values = m[3].split(',').map((v) => v.trim());
    return (labels) => (m[2] === 'in' ? values.includes(labels[m[1]]) : !values.includes(labels[m[1]]));
  }],
  [new RegExp(`^${KEY}\\s*!=\\s*([\\w.-]*)$`), (m) => (labels) => labels[m[1]] !== m[2]],
  [new RegExp(`^${KEY}\\s*==?\\s*([\\w.-]*)$`), (m) => (labels) => labels[m[1]] === m[2]],
  [new RegExp(`^!${KEY}$`), (m) => (labels) => !(m[1] in labels)],
  [new RegExp(`^${KEY}$`), (m) => (labels) => m[1] in labels],
];
/** Returns a predicate for a label selector, or throws with kubectl's wording. */
const parseSelector = (text) => {
  const tests = splitRequirements(text).map((req) => {
    for (const [pattern, make] of REQUIREMENTS) {
      const m = req.match(pattern);
      if (m) return make(m);
    }
    throw new Error(`unable to parse requirement: ${req}`);
  });
  return (labels) => tests.every((test) => test(labels));
};
const labelString = (labels) => Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(',') || '<none>';

A.labelsSelector = (root) => {
  const s = scene(root, { title: 'Labels pick pods — for you and for Services', hint: 'Filter pods with <code>-l</code>, then relabel a pod and watch the Service drop or pick it up.' });
  const SERVICE_SELECTOR = 'app=web,env=prod';
  const podsWrap = h('div', { class: 'k-node-pods b-label-pods' });
  const selectorEl = h('code', { class: 'b-selector' }, 'all pods');
  const endpoints = h('div', { class: 'chips' });
  const svcCard = h('div', { class: 'node b-svc-card' }, title('🌐 Service web-prod', 'type: ClusterIP'), h('small', {}, 'selector: ', h('code', {}, SERVICE_SELECTOR)), h('div', { class: 'zone-title', style: { marginTop: '6px' } }, 'endpoints (pods that get traffic)'), endpoints);
  const term = mkTerm({ height: '170px' });
  s.stage.append(h('div', { class: 'b-labels' },
    h('div', { class: 'b-col' }, h('div', { class: 'b-filter' }, '🔎 showing: ', selectorEl), podsWrap),
    h('div', { class: 'b-col' }, svcCard, term)));

  let st = { pods: [] };

  const svcMatches = parseSelector(SERVICE_SELECTOR);
  const findPod = (name) => st.pods.find((p) => p.name === name);
  const renderEndpoints = () => {
    const before = endpoints.textContent;
    endpoints.replaceChildren(...st.pods.filter((p) => svcMatches(p.labels)).map((p) => h('span', { class: 'chip ok' }, `${p.ip}:80 (${p.name})`)));
    if (before && before !== endpoints.textContent) flash(svcCard);
  };
  const highlight = (predicate) => st.pods.forEach((p) => p.el.classList.toggle('b-dim', !predicate(p.labels)));

  const getPods = (line) => {
    const showLabels = line.includes('--show-labels');
    const m = line.match(/(?:^|\s)(?:-l|--selector)(?:=|\s+)(?:'([^']*)'|"([^"]*)"|(\S+))/);
    const selector = m ? (m[1] ?? m[2] ?? m[3]) : '';
    let predicate = () => true;
    try {
      if (selector) predicate = parseSelector(selector);
    } catch (err) {
      return fail(term, `error: ${err.message}`);
    }
    highlight(predicate);
    selectorEl.textContent = selector || 'all pods';
    const rows = st.pods.filter((p) => predicate(p.labels));
    if (!rows.length) {
      out(term, 'No resources found in default namespace.');
      return s.say('No pod has labels that satisfy every part of that selector.');
    }
    printTable(term, [['NAME', 'READY', 'STATUS', 'AGE', ...(showLabels ? ['LABELS'] : [])], ...rows.map((p) => [p.name, '1/1', 'Running', '9m', ...(showLabels ? [labelString(p.labels)] : [])])]);
    s.say(selector ? `Selector <code>${escapeHtml(selector)}</code> matched <b>${rows.length}</b> pod(s). Every requirement must be true (comma = AND).` : 'All pods. Add <code>-l</code> to filter by labels.');
  };

  const labelPod = (line, m) => {
    const [name, args] = [m[1], m[2].split(' ')];
    const pod = findPod(name);
    if (!pod) return fail(term, `Error from server (NotFound): pods "${name}" not found`);
    const overwrite = args.includes('--overwrite');
    const edits = args.filter((a) => a !== '--overwrite');
    for (const edit of edits) {
      const [key, value] = edit.split('=');
      if (value === undefined && key.endsWith('-')) continue;
      if (value !== undefined && key in pod.labels && pod.labels[key] !== value && !overwrite) {
        return fail(term, `error: '${key}' already has a value (${pod.labels[key]}), and --overwrite is false`);
      }
    }
    edits.forEach((edit) => {
      const [key, value] = edit.split('=');
      if (value === undefined) delete pod.labels[key.replace(/-$/, '')];
      else pod.labels[key] = value;
    });
    pod.el.setLabels(pod.labels);
    flash(pod.el);
    out(term, `pod/${name} ${edits.every((e) => !e.includes('=')) ? 'unlabeled' : 'labeled'}`);
    const inService = svcMatches(pod.labels);
    renderEndpoints();
    s.say(inService
      ? `<b>${name}</b> now matches <code>${SERVICE_SELECTOR}</code>, so the Service sends it traffic.`
      : `<b>${name}</b> no longer matches the Service selector, so it gets <b>no traffic</b> — the pod itself keeps running.`);
  };

  const annotatePod = (line, m) => {
    const pod = findPod(m[1]);
    if (!pod) return fail(term, `Error from server (NotFound): pods "${m[1]}" not found`);
    pod.el.append(h('small', { class: 'b-anno' }, `📝 ${m[2]}=${m[3]}`));
    out(term, `pod/${m[1]} annotated`);
    s.say('Annotations are notes for people and tools. Selectors ignore them, so the Service did not change.');
  };

  const describeService = () => {
    const eps = st.pods.filter((p) => svcMatches(p.labels)).map((p) => `${p.ip}:80`);
    out(term, escapeHtml(`Name:              web-prod\nNamespace:         default\nSelector:          ${SERVICE_SELECTOR}\nType:              ClusterIP\nIP:                10.96.142.18\nPort:              http  80/TCP\nTargetPort:        80/TCP\nEndpoints:         ${eps.join(',') || '<none>'}`));
  };

  const handle = (line) => {
    typed(term, line);
    const routes = [
      [/^kubectl get (?:pods?|po)\b(.*)$/, getPods],
      [/^kubectl label (?:pods?|po)(?:\/| )([a-z0-9-]+) (.+)$/, labelPod],
      [/^kubectl annotate (?:pods?|po)(?:\/| )([a-z0-9-]+) ([\w./-]+)=(\S+)$/, annotatePod],
      [/^kubectl describe (?:services?|svc)(?:\/| )web-prod$/, describeService],
    ];
    for (const [pattern, run] of routes) {
      const m = line.match(pattern);
      if (m) return run(line, m);
    }
    fail(term, 'This scene understands kubectl get pods, label, annotate and describe svc web-prod.');
  };

  cmdBtn(s, 'kubectl get pods --show-labels', handle, { primary: true });
  cmdBtn(s, 'kubectl get pods -l app=web', handle);
  cmdBtn(s, 'kubectl get pods -l env=prod,tier!=db', handle);
  cmdBtn(s, "kubectl get pods -l 'env in (prod,staging)'", handle);
  s.sep();
  cmdBtn(s, 'kubectl label pod web-2 env=staging --overwrite', handle);
  cmdBtn(s, 'kubectl label pod web-2 env=prod --overwrite', handle);
  cmdBtn(s, 'kubectl annotate pod web-1 owner=team-a', handle);
  cmdBtn(s, 'kubectl describe svc web-prod', handle);
  s.command([/^kubectl (?:get|label|annotate|describe) .+$/], (_, m) => handle(m.input), { example: 'kubectl get pods -l tier=backend' });
  s.btn('↺ Reset', async () => { reset(); s.say('Reset: six pods, original labels.'); });

  const reset = () => {
    st = { pods: LABELLED_PODS.map(([name, labels, ip]) => ({ name, ip, labels: { ...labels }, el: podEl(name, { status: 'ready', labels, ip }) })) };
    podsWrap.replaceChildren(...st.pods.map((p) => p.el));
    selectorEl.textContent = 'all pods';
    term.replaceChildren();
    endpoints.replaceChildren();
    renderEndpoints();
  };
  reset();
};

// =====================================================================
// 7. Namespaces — rooms in one house
// =====================================================================
A.nsRooms = (root) => {
  const s = scene(root, { title: 'Namespaces: rooms in one cluster', hint: 'Create a namespace, run the same pod name in two rooms and switch your current namespace.' });
  const PROTECTED = ['default', 'kube-system', 'kube-public', 'kube-node-lease'];
  const SYSTEM_PODS = ['coredns-668d6bf9bc-4xk2p', 'coredns-668d6bf9bc-9ztl8', 'etcd-control-plane', 'kube-apiserver-control-plane', 'kube-proxy-7xk2c'];
  const roomsWrap = h('div', { class: 'b-rooms' });
  const ctxEl = h('code');
  const term = mkTerm({ height: '170px' });
  s.stage.append(h('div', { class: 'b-ns' }, h('div', { class: 'b-ctx' }, '📍 context kind-dev · current namespace: ', ctxEl), roomsWrap, term));

  let st = { current: 'default', namespaces: new Map() };

  const addRoom = (name) => {
    const pods = h('div', { class: 'k-node-pods' });
    const status = h('span', { class: 'k-node-state' }, 'Active');
    const el = h('div', { class: 'b-room pop' }, h('div', { class: 'b-room-head' }, h('b', {}, `🚪 ${name}`), status), pods);
    st.namespaces.set(name, { name, el, pods, status, podNames: new Map(), terminating: false });
    roomsWrap.append(el);
  };
  const addPod = (ns, name, status = 'ready') => {
    const room = st.namespaces.get(ns);
    const el = podEl(name, { status, image: name.startsWith('web') ? 'nginx' : '' });
    room.podNames.set(name, el);
    room.pods.append(el);
    return el;
  };
  const markCurrent = () => {
    ctxEl.textContent = st.current;
    st.namespaces.forEach((room) => room.el.classList.toggle('current', room.name === st.current));
  };

  const getNamespaces = () => printTable(term, [['NAME', 'STATUS', 'AGE'], ...[...st.namespaces.values()].map((r) => [r.name, r.terminating ? 'Terminating' : 'Active', PROTECTED.includes(r.name) ? '12d' : '1m'])]);
  const getPods = (opts) => {
    if (opts.all) {
      const rows = [...st.namespaces.values()].flatMap((r) => [...r.podNames.keys()].map((p) => [r.name, p, '1/1', 'Running', '0']));
      return printTable(term, [['NAMESPACE', 'NAME', 'READY', 'STATUS', 'RESTARTS'], ...rows]);
    }
    const room = st.namespaces.get(opts.ns);
    if (!room?.podNames.size) return out(term, `No resources found in ${opts.ns} namespace.`);
    flash(room.el);
    printTable(term, [['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'], ...[...room.podNames.keys()].map((p) => [p, '1/1', 'Running', '0', '1m'])]);
  };
  const createNamespace = (name) => {
    if (st.namespaces.has(name)) return fail(term, `Error from server (AlreadyExists): namespaces "${name}" already exists`);
    addRoom(name);
    out(term, `namespace/${name} created`);
    s.say(`A new room: <b>${name}</b>. Names only need to be unique <i>inside</i> a namespace.`);
  };
  const runPod = async (name, ns) => {
    const room = st.namespaces.get(ns);
    if (!room) return fail(term, `Error from server (NotFound): namespaces "${ns}" not found`);
    if (room.podNames.has(name)) return fail(term, `Error from server (AlreadyExists): pods "${name}" already exists`);
    out(term, `pod/${name} created`);
    const el = addPod(ns, name, 'creating');
    await wait(600);
    el.setStatus('ready');
    const twins = [...st.namespaces.values()].filter((r) => r.podNames.has(name)).length;
    const where = ns === st.current ? ' (your current namespace)' : '';
    s.say(twins > 1 ? `Two pods called <b>${name}</b> — fine, because they live in different namespaces. Their full identity is <code>namespace/name</code>.` : `Pod <b>${name}</b> created in <b>${ns}</b>${where}.`);
  };
  const setNamespace = (ns) => {
    st.current = ns;
    markCurrent();
    out(term, 'Context "kind-dev" modified.');
    s.say(`Every command without <code>-n</code> now uses <b>${ns}</b>.${st.namespaces.has(ns) ? '' : ' (kubectl does not check that it exists!)'}`);
  };
  const deleteNamespace = async (name) => {
    if (PROTECTED.slice(0, 3).includes(name)) return fail(term, `Error from server (Forbidden): namespaces "${name}" is forbidden: this namespace may not be deleted`);
    const room = st.namespaces.get(name);
    if (!room) return fail(term, `Error from server (NotFound): namespaces "${name}" not found`);
    out(term, `namespace "${name}" deleted`);
    room.terminating = true;
    room.status.textContent = 'Terminating';
    room.status.className = 'k-node-state warn';
    room.podNames.forEach((el) => el.setStatus('terminating'));
    s.say(`Deleting a namespace deletes <b>everything inside it</b>. It stays <b>Terminating</b> until all its objects are gone.`);
    await wait(1200);
    room.el.classList.add('fade-out');
    await wait(400);
    room.el.remove();
    st.namespaces.delete(name);
  };

  const handle = async (line) => {
    typed(term, line);
    const setContext = line.match(/^kubectl config set-context --current --namespace[= ]([a-z0-9-]+)$/);
    if (setContext) return setNamespace(setContext[1]);
    const words = line.split(' ');
    const opts = namespaceFlags(words.slice(1), st.current);
    const [verb, kind, name] = opts.rest;
    const isNs = (k) => ['namespace', 'namespaces', 'ns'].includes(k);
    if (verb === 'get' && isNs(kind)) return getNamespaces();
    if (verb === 'get' && /^(pods?|po)$/.test(kind)) return getPods(opts);
    if (verb === 'create' && isNs(kind) && name) return createNamespace(name);
    if (verb === 'delete' && isNs(kind) && name) return deleteNamespace(name);
    if (verb === 'run' && kind && /^--image[= ]?/.test(name || '')) return runPod(kind, opts.ns);
    if (verb === 'config' && kind === 'get-contexts') return printTable(term, [['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ['*', 'kind-dev', 'kind-dev', 'kind-dev', st.current]]);
    fail(term, 'This scene understands get ns|pods, create/delete namespace, run, and config set-context / get-contexts.');
  };

  cmdBtn(s, 'kubectl get namespaces', handle);
  cmdBtn(s, 'kubectl create namespace shop', handle, { primary: true });
  cmdBtn(s, 'kubectl run web --image=nginx', handle);
  cmdBtn(s, 'kubectl run web --image=nginx -n shop', handle);
  cmdBtn(s, 'kubectl get pods -A', handle);
  s.sep();
  cmdBtn(s, 'kubectl config set-context --current --namespace=shop', handle);
  cmdBtn(s, 'kubectl get pods', handle);
  cmdBtn(s, 'kubectl delete namespace shop', handle);
  s.command([/^kubectl (?:get|create|delete|run|config) .+$/], (_, m) => handle(m.input), { example: 'kubectl get pods -n kube-system' });
  s.btn('↺ Reset', async () => { reset(); s.say('Reset: the four namespaces every cluster starts with.'); });

  const reset = () => {
    roomsWrap.replaceChildren();
    term.replaceChildren();
    st = { current: 'default', namespaces: new Map() };
    PROTECTED.forEach(addRoom);
    SYSTEM_PODS.forEach((p) => addPod('kube-system', p));
    markCurrent();
  };
  reset();
};

// =====================================================================
// 8. ReplicaSets — the control loop keeps N pods alive
// =====================================================================
A.rsControlLoop = (root) => {
  const s = scene(root, { title: 'A ReplicaSet keeps the count right', hint: 'Delete pods, scale, power off a node or sneak in a pod with the same label. Watch the loop fix it.' });
  const NODE_NAMES = ['node-1', 'node-2', 'node-3'];
  const loop = loopIndicator();
  const countEl = h('div', { class: 'b-rs-count' });
  const rsCard = h('div', { class: 'node b-rs' }, title('🔁 ReplicaSet web', 'selector app=web'), countEl, loop);
  const nodesWrap = h('div', { class: 'k-nodes' });
  const term = mkTerm({ height: '150px' });
  s.stage.append(h('div', { class: 'b-rsgrid' }, h('div', { class: 'b-col' }, rsCard, term), nodesWrap));

  let st = { exists: true, desired: 3, nodes: [], pods: [] };

  const live = () => st.pods.filter((p) => p.el.dataset.status !== 'terminating');
  const owned = () => live().filter((p) => p.owned);
  const ready = () => owned().filter((p) => p.el.dataset.status === 'ready');
  const upNodes = () => st.nodes.filter((n) => n.up);
  const podsOn = (node) => live().filter((p) => p.node === node).length;
  const emptiestNode = () => upNodes().sort((a, b) => podsOn(a) - podsOn(b))[0];
  const renderCount = () => countEl.replaceChildren(
    ...(st.exists ? [['desired', st.desired], ['current', owned().length], ['ready', ready().length]] : [['deleted', '—']])
      .map(([label, value]) => h('span', {}, h('b', {}, value), h('small', {}, label))));

  const addPod = (node, { name = `web-${shortHash()}`, status = 'ready', labels = { app: 'web' }, owner = true } = {}) => {
    const pod = { name, node, labels, owned: owner, el: podEl(name, { status, labels }) };
    st.pods.push(pod);
    node.box.pods.append(pod.el);
    return pod;
  };
  const removePod = async (pod) => {
    pod.el.setStatus('terminating');
    renderCount();
    await pod.el.vanish();
    st.pods = st.pods.filter((p) => p !== pod);
    renderCount();
  };
  const createPod = async () => {
    const node = emptiestNode();
    if (!node) return false;
    const pod = addPod(node, { status: 'creating' });
    renderCount();
    await wait(600);
    pod.el.setStatus('ready');
    renderCount();
    return true;
  };
  // Newest and not-ready pods are removed first, like the real ReplicaSet controller.
  const deletionOrder = (pods) => [...pods].sort((a, b) => Number(a.el.dataset.status === 'ready') - Number(b.el.dataset.status === 'ready') || st.pods.indexOf(b) - st.pods.indexOf(a));

  const reconcile = async () => {
    if (!st.exists) return;
    await loop.light('observe');
    const orphans = live().filter((p) => !p.owned && p.labels.app === 'web');
    orphans.forEach((p) => { p.owned = true; flash(p.el); });
    if (orphans.length) s.say(`The ReplicaSet found <b>${orphans.length}</b> pod(s) with <code>app=web</code> and no owner, and <b>adopted</b> them.`);
    await loop.light('diff');
    const diff = st.desired - owned().length;
    if (!diff) return loop.light(null);
    await loop.light('act');
    if (diff > 0) {
      for (let i = 0; i < diff; i++) if (!(await createPod())) break;
    } else {
      await Promise.all(deletionOrder(owned()).slice(0, -diff).map(removePod));
    }
    await loop.light(null);
  };

  const getRs = (line) => {
    typed(term, line);
    if (!st.exists) return out(term, 'No resources found in default namespace.');
    printTable(term, [['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'], ['web', st.desired, owned().length, ready().length, '6m']]);
  };
  const STATUS_TEXT = { ready: 'Running', creating: 'ContainerCreating', failed: 'Unknown', terminating: 'Terminating' };
  const getPods = (line) => {
    typed(term, line);
    if (!st.pods.length) return out(term, 'No resources found in default namespace.');
    printTable(term, [['NAME', 'READY', 'STATUS', 'NODE'], ...st.pods.map((p) => [p.name, p.el.dataset.status === 'ready' ? '1/1' : '0/1', STATUS_TEXT[p.el.dataset.status], p.node.name])]);
  };
  const deletePod = async (line, m) => {
    const name = m?.[1] ?? pickVictim()?.name;
    typed(term, m ? line : `kubectl delete pod ${name}`);
    const pod = live().find((p) => p.name === name);
    if (!pod) return fail(term, `Error from server (NotFound): pods "${name}" not found`);
    out(term, `pod "${name}" deleted`);
    await removePod(pod);
    s.say(pod.owned && st.exists ? 'One pod fewer than desired. The loop notices…' : 'That pod had no owner, so nothing replaces it.');
    await reconcile();
  };
  const pickVictim = () => pick(live().filter((p) => p.el.dataset.status === 'ready'));
  const scale = async (line) => {
    typed(term, line);
    if (!st.exists) return fail(term, 'Error from server (NotFound): replicasets.apps "web" not found');
    st.desired = Math.min(9, replicasIn(line));
    out(term, 'replicaset.apps/web scaled');
    renderCount();
    s.say(`Desired is now <b>${st.desired}</b>. You only changed a number; the loop does the rest.`);
    await reconcile();
  };
  const powerOff = async () => {
    const node = st.nodes[1];
    node.up = false;
    node.box.setState('NotReady', 'bad');
    const stranded = live().filter((p) => p.node === node);
    stranded.forEach((p) => p.el.setStatus('failed'));
    renderCount();
    s.say(`<b>${node.name}</b> stopped reporting. After ~40 s it is <b>NotReady</b>; after 5 more minutes its pods are <b>evicted</b> (sped up here).`);
    await wait(1500);
    await Promise.all(stranded.map(removePod));
    await reconcile();
    s.say('Replacement pods now run on the healthy nodes.');
  };
  const powerOn = async () => {
    st.nodes.filter((n) => !n.up).forEach((n) => { n.up = true; n.box.setState('Ready'); });
    s.say('The node is back, but empty: Kubernetes does not move running pods back to rebalance.');
  };
  const runStray = async (line, m) => {
    typed(term, line);
    const name = m?.[1] ?? 'stray';
    const labels = Object.fromEntries((m?.[3] ?? 'app=web').split(',').map((kv) => kv.split('=')));
    if (live().some((p) => p.name === name)) return fail(term, `Error from server (AlreadyExists): pods "${name}" already exists`);
    out(term, `pod/${name} created`);
    const pod = addPod(emptiestNode(), { name, status: 'creating', labels, owner: false });
    await wait(600);
    pod.el.setStatus('ready');
    s.say(labels.app === 'web' ? 'A hand-made pod with <code>app=web</code> appeared. The ReplicaSet looks only at <b>labels</b>…' : 'This pod does not match <code>app=web</code>, so the ReplicaSet ignores it.');
    await reconcile();
    if (labels.app === 'web' && st.exists) s.say('It adopted the stray pod, counted one too many and deleted the newest one. <b>Never reuse a controller’s labels on other pods.</b>');
  };
  const deleteRs = async (line, m) => {
    typed(term, line);
    if (!st.exists) return fail(term, 'Error from server (NotFound): replicasets.apps "web" not found');
    const orphan = Boolean(m?.[1]);
    out(term, 'replicaset.apps "web" deleted');
    st.exists = false;
    renderCount();
    if (orphan) {
      st.pods.forEach((p) => { p.owned = false; });
      return s.say('<code>--cascade=orphan</code>: the ReplicaSet is gone but its pods keep running, now with no owner. Nobody will replace them.');
    }
    s.say('The garbage collector deletes the pods the ReplicaSet owned (their <code>ownerReferences</code> point to it).');
    await Promise.all(live().filter((p) => p.owned).map(removePod));
  };

  cmdBtn(s, 'kubectl get rs', getRs, { cmd: /^kubectl get (?:rs|replicasets?)(?: web)?$/ });
  cmdBtn(s, 'kubectl get pods -o wide', getPods, { cmd: /^kubectl get (?:pods?|po)(?: -o wide)?$/ });
  s.btn('🗑 Delete a random pod', () => deletePod('', null), { primary: true, enabled: () => Boolean(pickVictim()) });
  s.command([/^kubectl delete (?:pods?|po)(?:\/| )([a-z0-9-]+)$/], (_, m) => deletePod(m.input, m), { example: 'kubectl delete pod web-xxxxx' });
  cmdBtn(s, 'kubectl scale rs web --replicas=5', scale, { cmd: /^kubectl scale (?:rs|replicasets?)(?:\/| )web --replicas[= ]?(\d+)$/ });
  cmdBtn(s, 'kubectl scale rs web --replicas=2', scale, { cmd: [] });
  s.sep();
  s.btn('🔥 Power off node-2', powerOff, { enabled: () => st.nodes[1]?.up && upNodes().length > 1 });
  s.btn('🔌 Power on node-2', powerOn, { enabled: () => st.nodes.some((n) => !n.up) });
  cmdBtn(s, 'kubectl run stray --image=nginx --labels=app=web', runStray, { cmd: /^kubectl run ([a-z0-9-]+) --image[= ](\S+) --labels[= ](\S+)$/ });
  cmdBtn(s, 'kubectl delete rs web', deleteRs, { cmd: /^kubectl delete (?:rs|replicasets?)(?:\/| )web( --cascade=orphan)?$/, enabled: () => st.exists, why: 'The ReplicaSet is already deleted. Press ↺ Reset.' });
  s.btn('↺ Reset', async () => { reset(); s.say('Reset: a ReplicaSet with 3 replicas.'); });

  const reset = () => {
    nodesWrap.replaceChildren();
    term.replaceChildren();
    st = { exists: true, desired: 3, nodes: NODE_NAMES.map((name) => ({ name, up: true, box: nodeBox(name) })), pods: [] };
    st.nodes.forEach((n) => { nodesWrap.append(n.box.el); addPod(n); });
    renderCount();
  };
  reset();
};
