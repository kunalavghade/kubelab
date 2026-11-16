// Animations for the intermediate lessons (part b). Each registers itself on ANIMATIONS.
import { ANIMATIONS as A, helpers } from '../animations.js';
import { h, wait, fly, flash, escapeHtml } from '../dom.js';
import { scene } from '../components.js';

const { mkTerm, out, typed, zone, mkBar, setBar, podEl, nodeBox, shortHash } = helpers;

// ---------- local helpers ----------
const print = (term, text, cls = '') => out(term, cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));

const printTable = (term, rows) => {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => String(r[col]).length)));
  rows.forEach((r, i) => print(term, r.map((c, col) => String(c).padEnd(widths[col] + 3)).join('').trimEnd(), i === 0 ? 'dim' : ''));
};

/** podEl.setStatus with a custom status word (OOMKilled, Evicted…). */
const setPodText = (pod, status, text) => {
  pod.setStatus(status);
  if (text) pod.querySelector('.k-pod-status').textContent = text;
};

const meter = (label) => {
  const bar = mkBar();
  const val = h('b', {});
  return { row: h('div', { class: 'metric ib-meter' }, h('span', {}, label), bar, val), bar, val };
};

const objCard = (icon, name) => {
  const state = h('small', { class: 'ib-obj-state' }, 'not created');
  const el = h('div', { class: 'ib-obj ghost' }, h('b', {}, `${icon} ${name}`), state);
  el.set = (text, cls = '') => { state.textContent = text; el.className = `ib-obj ${cls}`; flash(el); };
  el.clear = () => { state.textContent = 'not created'; el.className = 'ib-obj ghost'; };
  return el;
};

const podIp = () => `10.244.${1 + Math.floor(Math.random() * 3)}.${10 + Math.floor(Math.random() * 200)}`;
const DEPLOY_REF = String.raw`(?:deploy(?:ment)?s?[/ ]web)`;

// =====================================================================
// Storage: PVC → StorageClass → PV, data survives the pod; emptyDir doesn't
// =====================================================================
A.storagePvc = (root) => {
  const s = scene(root, { title: 'A claim, a disk, and data that outlives the pod', hint: 'Apply the claim, write a few lines, then delete the pod and see where the data goes.' });
  const nodes = { a: nodeBox('node-a', { capacity: 'zone eu-west-1a' }), b: nodeBox('node-b', { capacity: 'zone eu-west-1a' }) };
  const sc = h('div', { class: 'ib-sc' }, h('b', {}, '🏭 StorageClass standard'), h('small', {}, 'CSI driver · WaitForFirstConsumer'));
  const pvc = objCard('🎫', 'PVC data');
  const pv = objCard('💽', 'PV');
  const diskLines = h('div', { class: 'ib-disk-lines' });
  const diskAt = h('small', {}, 'not attached');
  const disk = h('div', { class: 'ib-disk ghost' }, h('b', {}, '☁ cloud disk 1Gi'), diskAt, diskLines);
  const term = mkTerm({ height: '150px' });
  s.stage.append(h('div', { class: 'ib-storage' },
    h('div', { class: 'k-nodes' }, nodes.a.el, nodes.b.el),
    h('div', { class: 'ib-storage-side' }, sc, h('div', { class: 'ib-chain' }, pvc, h('span', { class: 'k-arrow' }, '⇄'), pv), disk)),
  term);

  let st = { claimed: false, bound: false, pod: null, node: null, lines: [], cache: [] };

  const renderData = () => {
    diskLines.replaceChildren(...st.lines.map((l) => h('span', { class: 'ib-line' }, l)));
    if (!st.pod) return;
    st.pod.cacheEl.textContent = st.cache.length ? `${st.cache.length} line(s)` : 'empty';
    st.pod.dataEl.textContent = st.lines.length ? `${st.lines.length} line(s)` : 'empty';
  };
  const makePod = (key) => {
    const pod = podEl('notes', { status: 'pending', image: 'busybox' });
    const mount = (path, cls) => h('div', { class: `ib-mount ${cls}` }, h('small', {}, path), h('span', {}, 'empty'));
    const cacheRow = mount('/cache · emptyDir', '');
    const dataRow = mount('/data · PVC', 'pvc');
    pod.append(cacheRow, dataRow);
    pod.cacheEl = cacheRow.lastChild;
    pod.dataEl = dataRow.lastChild;
    nodes[key].pods.append(pod);
    return pod;
  };
  const write = (target = 'both') => {
    const line = `line ${st.lines.length + st.cache.length + 1} @ ${st.node}`;
    if (target !== 'cache') st.lines.push(line);
    if (target !== 'data') st.cache.push(line);
    renderData();
  };

  s.btn('kubectl apply -f pvc.yaml', async () => {
    typed(term, 'kubectl apply -f pvc.yaml');
    print(term, `persistentvolumeclaim/data ${st.claimed ? 'unchanged' : 'created'}`);
    print(term, 'pod/notes created');
    if (!st.claimed) {
      st.claimed = true;
      pvc.set('Pending · waiting for first consumer', 'warn');
      s.say('The claim is <b>Pending</b>. With <code>WaitForFirstConsumer</code>, no disk is made until a pod that uses the claim is scheduled.');
      await wait(1300);
    }
    const key = st.node === 'node-a' ? 'b' : 'a';
    st.node = `node-${key}`;
    st.pod = makePod(key);
    renderData();
    s.say(`The scheduler picks <b>${st.node}</b> for pod <b>notes</b>.`);
    await wait(900);
    if (!st.bound) {
      s.say('Now the StorageClass’s CSI provisioner creates a disk in that node’s zone, a PV for it, and the PV controller binds PV ⇄ PVC.');
      await fly(s.stage, sc, disk, { label: 'CreateVolume' });
      disk.classList.remove('ghost');
      pv.set('Bound → default/data', 'ok');
      pvc.set('Bound · 1Gi · RWO', 'ok');
      st.bound = true;
      await wait(500);
    }
    await fly(s.stage, disk, st.pod, { label: 'attach + mount' });
    diskAt.textContent = `attached to ${st.node}`;
    st.pod.setStatus('creating');
    await wait(700);
    st.pod.setStatus('ready');
    write('both');
    s.say(st.lines.length > 1
      ? `New pod on <b>${st.node}</b>: <b>/cache is empty</b> (the emptyDir died with the old pod) but <b>/data still has ${st.lines.length} lines</b> — the disk followed the pod.`
      : 'The pod is Running and wrote its first line to both <b>/cache</b> (emptyDir) and <b>/data</b> (the PVC). Write a few more.');
  }, { primary: true, cmd: /^kubectl (?:apply|create) -f pvc\.yaml$/, enabled: () => !st.pod, why: 'Pod notes already exists — delete it first with <code>kubectl delete pod notes</code>.' });

  s.btn('✍ Write a line', async (_, m) => {
    const cmd = m?.input || 'kubectl exec notes -- sh -c "date | tee -a /data/notes.txt /cache/notes.txt"';
    typed(term, cmd);
    const target = /\/data/.test(cmd) && !/\/cache/.test(cmd) ? 'data' : /\/cache/.test(cmd) && !/\/data/.test(cmd) ? 'cache' : 'both';
    write(target);
    flash(st.pod);
    s.say(`Written to ${target === 'both' ? '<b>/cache</b> and <b>/data</b>' : `<b>/${target}</b>`}. Only <b>/data</b> lives on the cloud disk.`);
  }, { cmd: /^kubectl exec (?:-it )?notes -- .*(?:>>|tee).*$/, example: 'kubectl exec notes -- sh -c "date >> /data/notes.txt"', enabled: () => Boolean(st.pod), why: 'There is no pod to write from. Run <code>kubectl apply -f pvc.yaml</code>.' });

  s.btn('kubectl exec notes -- cat /data/notes.txt', async (_, m) => {
    const cmd = m?.input || 'kubectl exec notes -- cat /data/notes.txt';
    typed(term, cmd);
    const lines = /\/cache/.test(cmd) ? st.cache : st.lines;
    if (!lines.length) print(term, 'cat: can\'t open: No such file or directory', 'bad');
    lines.forEach((l) => print(term, l));
  }, { cmd: /^kubectl exec (?:-it )?notes -- cat \/(?:data|cache)\/notes\.txt$/, enabled: () => Boolean(st.pod), why: 'There is no pod. Run <code>kubectl apply -f pvc.yaml</code>.' });

  s.btn('kubectl delete pod notes', async () => {
    typed(term, 'kubectl delete pod notes');
    print(term, 'pod "notes" deleted');
    st.pod.setStatus('terminating');
    s.say('The pod is terminating. Its <b>emptyDir</b> is wiped with it; the disk is unmounted and detached, but the PV and PVC stay <b>Bound</b>.');
    await wait(900);
    await fly(s.stage, st.pod, disk, { label: 'detach', cls: 'white' });
    diskAt.textContent = 'not attached';
    st.pod.vanish();
    st.pod = null;
    st.cache = [];
    await wait(400);
    s.say('Pod gone, emptyDir gone. The cloud disk still holds every line. Apply again to start a new pod — it will land on the other node.');
  }, { enabled: () => Boolean(st.pod), why: 'There is no pod to delete.' });

  s.btn('kubectl get pv,pvc', async () => {
    typed(term, 'kubectl get pv,pvc');
    if (!st.claimed) return print(term, 'No resources found in default namespace.');
    if (st.bound) printTable(term, [['NAME', 'CAPACITY', 'ACCESS MODES', 'RECLAIM POLICY', 'STATUS', 'CLAIM'], ['persistentvolume/pvc-3f9c1a', '1Gi', 'RWO', 'Delete', 'Bound', 'default/data']]);
    printTable(term, [['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS'], ['persistentvolumeclaim/data', st.bound ? 'Bound' : 'Pending', st.bound ? 'pvc-3f9c1a' : '', st.bound ? '1Gi' : '', st.bound ? 'RWO' : '', 'standard']]);
  }, { cmd: /^kubectl get (?:pv,pvc|pvc,pv|pvc|pv)(?:,(?:storageclass|sc))?$/ });

  s.sep();
  s.btn('↺ Reset', async () => {
    Object.values(nodes).forEach((n) => n.pods.replaceChildren());
    st = { claimed: false, bound: false, pod: null, node: null, lines: [], cache: [] };
    pvc.clear(); pv.clear();
    disk.classList.add('ghost');
    diskAt.textContent = 'not attached';
    renderData();
    term.replaceChildren();
    s.say('Reset. Apply the claim to begin.');
  });
};

// =====================================================================
// Probes: liveness restarts a hung pod, readiness drains a warming one
// =====================================================================
A.probesHealth = (root) => {
  const s = scene(root, { title: 'Liveness vs readiness, tick by tick', hint: 'Make a pod hang or warm up, and watch the probes, the endpoints and the traffic.' });
  const NAMES = ['web-1', 'web-2', 'web-3'];
  const endpointChips = h('div', { class: 'chips' });
  const clock = h('b', { class: 'ib-clock' }, 't = 0s');
  const svc = h('div', { class: 'k-svc' }, '🔀 Service web');
  const row = h('div', { class: 'ib-probe-pods' });
  const term = mkTerm({ height: '140px' });
  s.stage.append(h('div', { class: 'ib-probe-top' }, svc, h('div', { class: 'ib-endpoints' }, h('small', {}, 'EndpointSlice (ready pods):'), endpointChips), clock), row, term);

  let st = { t: 0, rr: 0, pods: {} };

  const dots = (results) => results.slice(-3).map((ok) => h('i', { class: ok ? 'ok' : 'bad' }));
  const renderPod = (p) => {
    p.liveEl.replaceChildren(h('small', {}, `♥ liveness ${p.liveFails}/3`), ...dots(p.liveHist));
    p.readyEl.replaceChildren(h('small', {}, `✓ readiness ${p.ready ? 'Ready' : 'NotReady'}`), ...dots(p.readyHist));
    p.restartEl.textContent = `restarts: ${p.restarts}`;
    p.el.setStatus(p.restarting ? 'terminating' : p.ready ? 'ready' : 'running');
  };
  const renderEndpoints = () => {
    const ready = NAMES.filter((n) => st.pods[n].ready);
    endpointChips.replaceChildren(...NAMES.map((n) => h('span', { class: `chip ${st.pods[n].ready ? 'ok' : 'ghost'}` }, `${n} ${st.pods[n].ready ? '✓' : '✗'}`)));
    return ready;
  };
  const build = () => {
    row.replaceChildren();
    NAMES.forEach((name) => {
      const el = podEl(name, { status: 'ready', image: 'nginx', ip: podIp() });
      const liveEl = h('div', { class: 'ib-probe' });
      const readyEl = h('div', { class: 'ib-probe' });
      const restartEl = h('small', {});
      el.append(liveEl, readyEl, restartEl);
      row.append(el);
      st.pods[name] = { el, liveEl, readyEl, restartEl, hang: false, warm: 0, liveFails: 0, readyFails: 0, liveHist: [], readyHist: [], ready: true, restarts: 0, restarting: false };
      renderPod(st.pods[name]);
    });
    renderEndpoints();
  };

  const sendTraffic = async () => {
    const ready = NAMES.filter((n) => st.pods[n].ready);
    if (!ready.length) return print(term, 'curl: (7) no ready endpoints for service "web"', 'bad');
    const target = st.pods[ready[st.rr++ % ready.length]];
    await fly(s.stage, svc, target.el, { label: 'GET /', ms: 600 });
  };

  const restart = async (p, name) => {
    p.restarting = true;
    renderPod(p);
    print(term, `Warning  Unhealthy  Liveness probe failed: Get "http://${name}/healthz": context deadline exceeded`, 'y');
    print(term, `Normal   Killing    Container web failed liveness probe, will be restarted`, 'y');
    s.say(`<b>${name}</b> failed liveness <b>3 times in a row</b> (~30 s). The kubelet kills the container and starts a fresh one — same pod, same IP, restart count +1.`);
    await wait(1100);
    Object.assign(p, { hang: false, liveFails: 0, readyFails: 0, restarting: false, ready: false, restarts: p.restarts + 1, liveHist: [], readyHist: [] });
    p.el.setStatus('creating');
    await wait(700);
    renderPod(p);
  };

  // One tick = 5 s: readiness runs every tick, liveness every second tick (period 10 s).
  const tick = async () => {
    st.t += 5;
    clock.textContent = `t = ${st.t}s`;
    for (const name of NAMES) {
      const p = st.pods[name];
      if (p.restarting) continue;
      const readyOk = !p.hang && p.warm === 0;
      p.readyHist.push(readyOk);
      p.readyFails = readyOk ? 0 : p.readyFails + 1;
      p.ready = readyOk || (p.ready && p.readyFails < 2);
      if (p.warm > 0) p.warm--;
      if (st.t % 10 === 0) {
        p.liveHist.push(!p.hang);
        p.liveFails = p.hang ? p.liveFails + 1 : 0;
      }
      renderPod(p);
      if (p.liveFails >= 3) await restart(p, name);
    }
    renderEndpoints();
    await sendTraffic();
  };
  const runTicks = async (count) => { for (let i = 0; i < count; i++) { await tick(); await wait(450); } };

  s.btn('💥 Make web-2 hang', async () => {
    st.pods['web-2'].hang = true;
    s.say('web-2’s process is still alive but stuck: every probe times out. Watch readiness drop it from the endpoints first, then liveness restart it.');
    await runTicks(8);
    s.say('Recovered: readiness took web-2 out of traffic after 2 misses (~10 s); liveness restarted it after 3 misses (~30 s). Users only hit healthy pods.');
  }, { primary: true, enabled: () => !st.pods['web-2']?.hang });

  s.btn('🐢 web-3 warms its cache', async () => {
    st.pods['web-3'].warm = 4;
    s.say('web-3 is alive but busy loading its cache, so <code>/ready</code> returns 503. Readiness fails, liveness still passes: <b>no restart</b>, just no traffic.');
    await runTicks(6);
    s.say('Cache warm: readiness passes again and web-3 is back in the EndpointSlice. Its restart count never changed.');
  });

  s.btn('▶ Send traffic', async () => {
    for (let i = 0; i < 4; i++) { await sendTraffic(); await wait(150); }
    s.say('The Service only sends requests to pods listed as <b>ready</b> in its EndpointSlice.');
  });

  s.sep();
  s.btn('kubectl get endpointslices -l kubernetes.io/service-name=web', async () => {
    typed(term, 'kubectl get endpointslices -l kubernetes.io/service-name=web');
    const ready = NAMES.filter((n) => st.pods[n].ready);
    printTable(term, [['NAME', 'ADDRESSTYPE', 'PORTS', 'ENDPOINTS'], ['web-x8k2p', 'IPv4', '80', ready.length ? ready.map((n) => st.pods[n].el.querySelector('.k-pod-ip').textContent).join(',') : '<unset>']]);
  }, { cmd: /^kubectl get (?:endpointslices?|endpoints|ep)(?: web| -l kubernetes\.io\/service-name=web)?$/, example: 'kubectl get endpoints web' });

  s.btn('kubectl get pods', async () => {
    typed(term, 'kubectl get pods');
    printTable(term, [['NAME', 'READY', 'STATUS', 'RESTARTS'], ...NAMES.map((n) => [n, st.pods[n].ready ? '1/1' : '0/1', 'Running', st.pods[n].restarts])]);
  }, { cmd: /^kubectl get (?:pods?|po)(?: -l app=web)?$/ });

  s.btn('kubectl describe pod web-2', async () => {
    typed(term, 'kubectl describe pod web-2');
    const p = st.pods['web-2'];
    print(term, `Restart Count:  ${p.restarts}`);
    print(term, 'Liveness:   http-get http://:80/healthz delay=0s timeout=2s period=10s #success=1 #failure=3', 'dim');
    print(term, 'Readiness:  http-get http://:80/ready delay=0s timeout=1s period=5s #success=1 #failure=2', 'dim');
    if (!p.restarts && !p.hang) print(term, 'Events:  <none>');
    else print(term, 'Events:  Warning Unhealthy … Liveness probe failed · Normal Killing … will be restarted', 'y');
  }, { cmd: /^kubectl describe (?:pods?|po)[ /]web-2$/ });

  s.btn('↺ Reset', async () => {
    st = { t: 0, rr: 0, pods: {} };
    clock.textContent = 't = 0s';
    term.replaceChildren();
    build();
    s.say('Reset. Three healthy pods behind one Service.');
  });
  build();
};

// =====================================================================
// Probes: a slow starter with and without a startup probe
// =====================================================================
A.probesStartup = (root) => {
  const s = scene(root, { title: 'A slow starter: killed by liveness, or saved by a startup probe', hint: 'Both pods need 60 s to boot. Liveness: period 10 s, failureThreshold 3.' });
  const clock = h('b', { class: 'ib-clock' }, 't = 0s');
  const BOOT_SECONDS = 60;
  const lane = (name, label) => {
    const pod = podEl(name, { status: 'pending', image: 'java-app' });
    const boot = meter('booting');
    const log = h('div', { class: 'ib-lane-log' });
    const el = h('div', { class: 'ib-lane' }, h('div', { class: 'ib-lane-head' }, label), pod, boot.row, log);
    return { el, pod, boot, log, startedAt: 0, fails: 0, restarts: 0, up: false, checks: 0 };
  };
  const term = mkTerm({ height: '110px' });
  const lanesEl = h('div', { class: 'ib-lanes' });
  s.stage.append(h('div', { class: 'ib-startup-top' }, clock), lanesEl, term);

  let st = { t: 0, running: false, done: false, a: null, b: null };

  const logLine = (L, text, cls = '') => {
    L.log.prepend(h('div', { class: cls }, `${st.t}s · ${text}`));
    while (L.log.childElementCount > 4) L.log.lastChild.remove();
  };
  const build = () => {
    st.a = lane('slow-a', '❌ no startupProbe');
    st.b = lane('slow-b', '✅ startupProbe: 30 × 10 s');
    lanesEl.replaceChildren(st.a.el, st.b.el);
    [st.a, st.b].forEach((L) => { setBar(L.boot.bar, 0); L.boot.val.textContent = '0%'; });
  };
  const progress = (L) => Math.min(100, ((st.t - L.startedAt) / BOOT_SECONDS) * 100);
  const showBoot = (L) => {
    const pct = progress(L);
    setBar(L.boot.bar, pct);
    L.boot.val.textContent = `${Math.round(pct)}%`;
    L.up = pct >= 100;
  };

  const stepWithoutStartup = (L) => {
    showBoot(L);
    if (L.up) return L.pod.setStatus('ready');
    if ((st.t - L.startedAt) % 10 || st.t === L.startedAt) return;
    L.fails++;
    logLine(L, `liveness failed (${L.fails}/3)`, 'bad');
    if (L.fails < 3) return;
    L.restarts++;
    L.fails = 0;
    L.startedAt = st.t;
    logLine(L, `killed → restart #${L.restarts}`, 'bad');
    setPodText(L.pod, L.restarts >= 2 ? 'crash' : 'creating', L.restarts >= 2 ? 'CrashLoopBackOff' : 'Restarting');
  };
  const stepWithStartup = (L) => {
    showBoot(L);
    if (st.t % 10 || L.checks < 0) return;
    if (L.up) {
      logLine(L, 'startup probe passed → liveness & readiness take over', 'ok');
      L.pod.setStatus('ready');
      L.checks = -1;
      return;
    }
    L.checks++;
    logLine(L, `startup probe failed (${L.checks}/30) — liveness paused`);
  };

  s.btn('▶ Start both pods', async () => {
    st.running = true;
    st.a.pod.setStatus('running');
    st.b.pod.setStatus('running');
    s.say('Both containers start booting. The left pod’s liveness probe starts checking straight away…');
    while (st.t < 90) {
      st.t += 5;
      clock.textContent = `t = ${st.t}s`;
      stepWithoutStartup(st.a);
      stepWithStartup(st.b);
      await wait(380);
    }
    st.running = false;
    st.done = true;
    s.say(`Left: killed every ~30 s before it ever finished booting — <b>${st.a.restarts} restarts</b> and heading for CrashLoopBackOff. Right: the startup probe gave it up to 300 s, so it became Ready at 60 s and liveness only started then.`);
  }, { primary: true, enabled: () => !st.running && !st.done, why: 'Already run — press Reset to try again.' });

  s.btn('kubectl get pods', async () => {
    typed(term, 'kubectl get pods');
    printTable(term, [['NAME', 'READY', 'STATUS', 'RESTARTS'],
      ['slow-a', st.a.up ? '1/1' : '0/1', st.a.restarts >= 2 ? 'CrashLoopBackOff' : 'Running', st.a.restarts],
      ['slow-b', st.b.checks < 0 ? '1/1' : '0/1', 'Running', 0]]);
  }, { cmd: /^kubectl get (?:pods?|po)$/ });

  s.btn('↺ Reset', async () => {
    st = { t: 0, running: false, done: false, a: null, b: null };
    clock.textContent = 't = 0s';
    term.replaceChildren();
    build();
    s.say('Reset. Press Start.');
  });
  build();
};

// =====================================================================
// Resources: the scheduler packs pods by requests; Pending when nothing fits
// =====================================================================
A.resourcesFit = (root) => {
  const s = scene(root, { title: 'The scheduler fits pods by their requests', hint: 'Each node has 2 CPU and 4Gi allocatable. Scale up and watch the bars fill.' });
  const NODE_CPU = 2000;
  const NODE_MEM = 4096;
  const MAX_REPLICAS = 9;
  const sched = h('span', { class: 'chip blue' }, '🧭 scheduler');
  const pendingZone = h('div', { class: 'chips' });
  const nodes = ['node-1', 'node-2'].map((name) => {
    const box = nodeBox(name, { capacity: 'allocatable: 2 CPU · 4Gi' });
    const cpu = meter('cpu req');
    const mem = meter('mem req');
    box.el.insertBefore(h('div', {}, cpu.row, mem.row), box.pods);
    return { name, box, cpu, mem };
  });
  const term = mkTerm({ height: '140px' });
  s.stage.append(h('div', { class: 'ib-fit-top' }, sched, h('small', {}, 'Deployment web · requests per pod: '), h('b', { class: 'ib-req' })),
    h('div', { class: 'k-nodes' }, ...nodes.map((n) => n.box.el)),
    zone('⏳ Pending — no node fits', pendingZone), term);
  const reqLabel = s.stage.querySelector('.ib-req');

  let st = { replicas: 0, cpu: 600, mem: 1024, pods: [] };

  const used = (node) => st.pods.filter((p) => p.node === node.name);
  const renderBars = () => {
    reqLabel.textContent = `cpu ${st.cpu}m · memory ${st.mem}Mi`;
    nodes.forEach((n) => {
      const cpu = used(n).length * st.cpu;
      const mem = used(n).length * st.mem;
      setBar(n.cpu.bar, (cpu / NODE_CPU) * 100); n.cpu.val.textContent = `${cpu}/${NODE_CPU}m`;
      setBar(n.mem.bar, (mem / NODE_MEM) * 100); n.mem.val.textContent = `${mem}/${NODE_MEM}Mi`;
      n.cpu.bar.className = `bar ${cpu / NODE_CPU > 0.85 ? 'bad' : ''}`;
    });
  };
  const fits = (n) => (used(n).length + 1) * st.cpu <= NODE_CPU && (used(n).length + 1) * st.mem <= NODE_MEM;
  const pickNode = () => nodes.filter(fits).sort((a, b) => used(a).length - used(b).length)[0] || null;

  const addPod = async () => {
    const pod = { name: `web-${shortHash()}`, node: null, el: null };
    const target = pickNode();
    pod.node = target?.name || null;
    pod.el = podEl(pod.name, { status: target ? 'creating' : 'pending', image: 'nginx' });
    st.pods.push(pod);
    (target ? target.box.pods : pendingZone).append(pod.el);
    await fly(s.stage, sched, pod.el, { label: target ? `bind → ${target.name}` : 'no fit', cls: target ? '' : 'bad', ms: 650 });
    if (target) pod.el.setStatus('ready');
    renderBars();
  };
  const removePod = async () => {
    const pod = st.pods.find((p) => !p.node) || st.pods[st.pods.length - 1];
    st.pods = st.pods.filter((p) => p !== pod);
    pod.el.setStatus('terminating');
    await wait(350);
    pod.el.vanish();
    renderBars();
  };
  const scaleTo = async (n) => {
    const target = Math.max(0, Math.min(MAX_REPLICAS, n));
    st.replicas = target;
    while (st.pods.length < target) await addPod();
    while (st.pods.length > target) await removePod();
    const pending = st.pods.filter((p) => !p.node).length;
    s.say(pending
      ? `<b>${pending} pod(s) Pending</b>: each needs ${st.cpu}m CPU, and no node has that much <i>unrequested</i> CPU left — even if real usage is low. Event: <code>0/2 nodes are available: 2 Insufficient cpu.</code>`
      : `All ${target} pods placed. The bars show <b>requests</b> reserved on each node, not real usage.`);
  };

  s.btn('kubectl scale deployment web --replicas=4', async (_, m) => {
    const n = Number(m?.[1] ?? 4);
    typed(term, m?.input || 'kubectl scale deployment web --replicas=4');
    print(term, 'deployment.apps/web scaled');
    await scaleTo(n);
  }, { primary: true, cmd: new RegExp(`^kubectl scale ${DEPLOY_REF} --replicas[= ]?(\\d+)$`), example: 'kubectl scale deployment web --replicas=7' });

  s.btn('kubectl scale deployment web --replicas=7', async () => {
    typed(term, 'kubectl scale deployment web --replicas=7');
    print(term, 'deployment.apps/web scaled');
    await scaleTo(7);
  });

  s.btn('kubectl set resources deployment web --requests=cpu=300m,memory=512Mi', async (_, m) => {
    typed(term, m?.input || 'kubectl set resources deployment web --requests=cpu=300m,memory=512Mi');
    print(term, 'deployment.apps/web resource requirements updated');
    st.cpu = Number(m?.[1] ?? 300);
    st.mem = Number(m?.[2] ?? (m ? st.mem : 512));
    s.say('Changing the pod template rolls out <b>new pods</b> with the new requests. The scheduler places each one again.');
    const count = st.replicas;
    for (const p of st.pods) { p.el.setStatus('terminating'); }
    await wait(500);
    st.pods.forEach((p) => p.el.remove());
    st.pods = [];
    renderBars();
    await scaleTo(count);
  }, { cmd: new RegExp(`^kubectl set resources ${DEPLOY_REF} --requests=cpu=(\\d+)m(?:,memory=(\\d+)mi)?$`), enabled: () => st.replicas > 0, why: 'Scale the Deployment up first so there are pods to update.' });

  s.sep();
  s.btn('kubectl get pods -o wide', async () => {
    typed(term, 'kubectl get pods -o wide');
    if (!st.pods.length) return print(term, 'No resources found in default namespace.');
    printTable(term, [['NAME', 'READY', 'STATUS', 'NODE'], ...st.pods.map((p) => [p.name, p.node ? '1/1' : '0/1', p.node ? 'Running' : 'Pending', p.node || '<none>'])]);
  }, { cmd: /^kubectl get (?:pods?|po)(?: -o wide)?$/ });

  s.btn('kubectl describe nodes', async () => {
    typed(term, 'kubectl describe nodes');
    nodes.forEach((n) => {
      print(term, `Name: ${n.name}   Allocated resources:`, 'dim');
      print(term, `  cpu     ${used(n).length * st.cpu}m (${Math.round((used(n).length * st.cpu / NODE_CPU) * 100)}%)`);
      print(term, `  memory  ${used(n).length * st.mem}Mi (${Math.round((used(n).length * st.mem / NODE_MEM) * 100)}%)`);
    });
  }, { cmd: /^kubectl describe (?:nodes?|no)(?: node-[12])?$/ });

  s.command(/^kubectl describe (?:pods?|po)[ /](web-\w+)$/, async (_, m) => {
    typed(term, m.input);
    const pod = st.pods.find((p) => p.name === m[1]);
    if (!pod) return print(term, `Error from server (NotFound): pods "${m[1]}" not found`, 'bad');
    print(term, `Status: ${pod.node ? 'Running' : 'Pending'}   Node: ${pod.node || '<none>'}`);
    if (!pod.node) print(term, 'Warning  FailedScheduling  0/2 nodes are available: 2 Insufficient cpu. preemption: 0/2 nodes are available: 2 No preemption victims found for incoming pod.', 'y');
  }, { example: () => `kubectl describe pod ${(st.pods.find((p) => !p.node) || st.pods[0])?.name}`, enabled: () => st.pods.length > 0, why: 'There are no pods yet — scale the Deployment first.' });

  s.btn('↺ Reset', async () => {
    st = { replicas: 0, cpu: 600, mem: 1024, pods: [] };
    nodes.forEach((n) => n.box.pods.replaceChildren());
    pendingZone.replaceChildren();
    term.replaceChildren();
    renderBars();
    s.say('Reset. Requests: 600m CPU and 1Gi memory per pod.');
  });
  renderBars();
};

// =====================================================================
// Resources: OOMKilled at the limit, eviction order under node pressure
// =====================================================================
A.resourcesOom = (root) => {
  const s = scene(root, { title: 'Memory limits and node pressure', hint: 'Leak memory in one pod, then squeeze the whole node and see who gets evicted first.' });
  const NODE_MEM = 4096;
  const PRESSURE_AT = 0.9;
  const QOS_RANK = { BestEffort: 0, Burstable: 1, Guaranteed: 2 };
  const SPECS = [
    { name: 'api', qos: 'Guaranteed', request: 512, limit: 512, use: 420 },
    { name: 'web', qos: 'Burstable', request: 256, limit: 512, use: 300 },
    { name: 'leaky', qos: 'Burstable', request: 128, limit: 256, use: 100 },
    { name: 'cache', qos: 'BestEffort', request: 0, limit: 0, use: 700 },
  ];
  const node = nodeBox('node-1', { capacity: 'allocatable memory: 4Gi' });
  const nodeMem = meter('node mem');
  node.el.insertBefore(nodeMem.row, node.pods);
  const term = mkTerm({ height: '140px' });
  s.stage.append(node.el, term);

  let st = { other: 1500, pods: [] };

  const renderNode = () => {
    const total = st.other + st.pods.filter((p) => !p.gone).reduce((sum, p) => sum + p.use, 0);
    setBar(nodeMem.bar, (total / NODE_MEM) * 100);
    nodeMem.bar.className = `bar ${total / NODE_MEM >= PRESSURE_AT ? 'bad' : ''}`;
    nodeMem.val.textContent = `${total}/${NODE_MEM}Mi`;
    node.setState(total / NODE_MEM >= PRESSURE_AT ? 'MemoryPressure' : 'Ready', total / NODE_MEM >= PRESSURE_AT ? 'warn' : '');
    return total;
  };
  const renderPod = (p) => {
    const cap = p.limit || NODE_MEM;
    setBar(p.mem.bar, (p.use / cap) * 100);
    p.mem.val.textContent = p.limit ? `${p.use}/${p.limit}Mi` : `${p.use}Mi (no limit)`;
  };
  const build = () => {
    node.pods.replaceChildren();
    st.pods = SPECS.map((spec) => {
      const el = podEl(spec.name, { status: 'ready' });
      const mem = meter('mem');
      el.append(h('span', { class: `ib-qos ${spec.qos}` }, spec.qos), mem.row);
      node.pods.append(el);
      const p = { ...spec, el, mem, restarts: 0, gone: false, lastState: '' };
      renderPod(p);
      return p;
    });
    renderNode();
  };
  const pod = (name) => st.pods.find((p) => p.name === name);

  s.btn('💧 Leak memory in leaky', async () => {
    const p = pod('leaky');
    s.say('leaky (request 128Mi, <b>limit 256Mi</b>) keeps allocating memory…');
    while (p.use < p.limit) {
      p.use = Math.min(p.limit + 8, p.use + 30);
      renderPod(p); renderNode();
      await wait(260);
    }
    setPodText(p.el, 'crash', 'OOMKilled');
    p.restarts++;
    p.lastState = 'OOMKilled (exit code 137)';
    s.say('It crossed its memory limit. The kernel’s OOM killer ends the container: <b>OOMKilled, exit code 137</b>. Memory can’t be throttled, only reclaimed by killing.');
    await wait(1300);
    p.use = 100;
    p.el.setStatus('creating');
    renderPod(p); renderNode();
    await wait(600);
    p.el.setStatus('ready');
    s.say(`The kubelet restarted the container (restarts: ${p.restarts}). If it keeps leaking it will end up in CrashLoopBackOff. Fix the leak or raise the limit.`);
  }, { primary: true, enabled: () => !pod('leaky')?.gone });

  s.btn('🔥 Squeeze the node', async () => {
    s.say('Something outside these pods (system daemons, page cache) grabs memory on the node…');
    while (renderNode() / NODE_MEM < PRESSURE_AT) { st.other += 150; await wait(220); }
    const victim = st.pods.filter((p) => !p.gone)
      .sort((a, b) => QOS_RANK[a.qos] - QOS_RANK[b.qos] || (b.use - b.request) - (a.use - a.request))[0];
    if (!victim) return;
    s.say(`<b>MemoryPressure!</b> The kubelet must free memory. It evicts <b>${victim.name}</b> (${victim.qos}) — lowest QoS first, then whoever uses most above its request.`);
    await wait(900);
    setPodText(victim.el, 'failed', 'Evicted');
    victim.gone = true;
    victim.lastState = 'Evicted';
    renderNode();
    await wait(700);
    st.other -= 300;
    renderNode();
    s.say(`${victim.name} was evicted and the pressure is gone. Guaranteed pods like <b>api</b> are the last to go. Squeeze again to see the next victim.`);
  }, { enabled: () => st.pods.some((p) => !p.gone && p.qos !== 'Guaranteed'), why: 'Only the Guaranteed pod is left — press Reset.' });

  s.sep();
  s.btn('kubectl get pods', async () => {
    typed(term, 'kubectl get pods');
    printTable(term, [['NAME', 'READY', 'STATUS', 'RESTARTS'], ...st.pods.map((p) => [p.name, p.gone ? '0/1' : '1/1', p.gone ? 'Evicted' : 'Running', p.restarts])]);
  }, { cmd: /^kubectl get (?:pods?|po)$/ });

  s.btn('kubectl describe pod leaky', async () => {
    typed(term, 'kubectl describe pod leaky');
    const p = pod('leaky');
    print(term, 'QoS Class:       Burstable');
    print(term, 'Limits:   memory: 256Mi    Requests:   memory: 128Mi', 'dim');
    print(term, p.lastState ? `Last State:      Terminated  Reason: ${p.lastState}` : 'Last State:      <none>', p.lastState ? 'y' : '');
    print(term, `Restart Count:   ${p.restarts}`);
  }, { cmd: /^kubectl describe (?:pods?|po)[ /]leaky$/ });

  s.btn("kubectl get pod api -o jsonpath='{.status.qosClass}'", async (_, m) => {
    const name = m?.[1] || 'api';
    typed(term, m?.input || "kubectl get pod api -o jsonpath='{.status.qosClass}'");
    const p = pod(name);
    print(term, p ? p.qos : `Error from server (NotFound): pods "${name}" not found`, p ? '' : 'bad');
  }, { cmd: /^kubectl get pods? (\w+) -o jsonpath=['"]?\{\.status\.qosclass\}['"]?$/ });

  s.btn('↺ Reset', async () => {
    st = { other: 1500, pods: [] };
    term.replaceChildren();
    build();
    s.say('Reset. Four pods, three QoS classes.');
  });
  build();
};

// =====================================================================
// Jobs: completions and parallelism, a failure retried within backoffLimit
// =====================================================================
A.jobsWaves = (root) => {
  const s = scene(root, { title: 'A Job runs pods until enough succeed', hint: 'job/pi: completions 6, backoffLimit 4. Pick the parallelism and apply.' });
  const COMPLETIONS = 6;
  const BACKOFF_LIMIT = 4;
  const slots = h('div', { class: 'ib-slots' });
  const status = h('b', {}, 'not created');
  const failures = h('small', {}, `failures 0/${BACKOFF_LIMIT}`);
  const workers = [nodeBox('worker-1'), nodeBox('worker-2')];
  const failedZone = h('div', { class: 'chips' });
  const term = mkTerm({ height: '130px' });
  const parSel = h('select', { 'aria-label': 'parallelism' }, ...[1, 2, 3].map((n) => h('option', { value: n, selected: n === 2 }, `parallelism ${n}`)));
  const failBox = h('input', { type: 'checkbox', checked: true });
  s.stage.append(h('div', { class: 'ib-job-card' }, h('b', {}, '⏱ job/pi'), status, failures, slots),
    h('div', { class: 'k-nodes' }, ...workers.map((w) => w.el)),
    zone('Failed pods (restartPolicy: Never keeps them for logs)', failedZone), term);

  let st = { started: false, done: false, succeeded: 0, failed: 0, created: 0 };

  const renderJob = () => {
    slots.replaceChildren(...Array.from({ length: COMPLETIONS }, (_, i) => h('i', { class: i < st.succeeded ? 'ok' : '' })));
    failures.textContent = `failures ${st.failed}/${BACKOFF_LIMIT}`;
    status.textContent = st.done ? 'Complete ✓' : st.started ? `Running · ${st.succeeded}/${COMPLETIONS}` : 'not created';
  };

  const runPod = async (failThis) => {
    st.created++;
    const worker = workers[st.created % workers.length];
    const el = podEl(`pi-${shortHash()}`, { status: 'creating', image: 'perl' });
    worker.pods.append(el);
    await wait(500);
    el.setStatus('running');
    await wait(1200 + Math.random() * 900);
    if (failThis) {
      setPodText(el, 'failed', 'Error (exit 1)');
      st.failed++;
      renderJob();
      s.say(`A pod failed (exit code 1). That is failure ${st.failed} of the backoffLimit ${BACKOFF_LIMIT}: the Job controller waits a back-off delay and creates a <b>new</b> pod.`);
      await wait(700);
      failedZone.append(el);
      await wait(900);
      return false;
    }
    el.setStatus('succeeded');
    st.succeeded++;
    renderJob();
    return true;
  };

  s.btn('kubectl apply -f job.yaml', async () => {
    const parallelism = (Number(parSel.value) || 2);
    typed(term, 'kubectl apply -f job.yaml');
    print(term, 'job.batch/pi created');
    st.started = true;
    renderJob();
    s.say(`The Job controller starts up to <b>${parallelism}</b> pod(s) at a time and keeps going until <b>${COMPLETIONS}</b> have succeeded.`);
    let failNext = failBox.checked;
    const inFlight = new Set();
    let launched = 0;
    while (st.succeeded < COMPLETIONS) {
      while (inFlight.size < parallelism && st.succeeded + inFlight.size < COMPLETIONS) {
        const shouldFail = failNext && launched === 2;
        if (shouldFail) failNext = false;
        launched++;
        const run = runPod(shouldFail).finally(() => inFlight.delete(run));
        inFlight.add(run);
        await wait(150);
      }
      await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    st.done = true;
    renderJob();
    print(term, 'job.batch/pi condition met', 'ok');
    s.say(`<b>Complete:</b> ${COMPLETIONS} successes with ${st.failed} retried failure(s). Finished pods stay so you can read logs, until <code>ttlSecondsAfterFinished</code> cleans them up.`);
  }, { primary: true, cmd: /^kubectl (?:apply|create) -f job\.yaml$/, enabled: () => !st.started, why: 'The Job already exists. Delete it with <code>kubectl delete job pi</code> or press Reset.' });
  s.add(h('label', { class: 'inline' }, parSel), h('label', { class: 'inline' }, failBox, 'one pod fails'));

  s.sep();
  s.btn('kubectl get jobs', async () => {
    typed(term, 'kubectl get jobs');
    if (!st.started) return print(term, 'No resources found in default namespace.');
    printTable(term, [['NAME', 'STATUS', 'COMPLETIONS', 'DURATION'], ['pi', st.done ? 'Complete' : 'Running', `${st.succeeded}/${COMPLETIONS}`, st.done ? '14s' : '6s']]);
  }, { cmd: /^kubectl get (?:jobs?|job\.batch)(?: pi)?$/ });

  s.btn('kubectl logs job/pi', async () => {
    typed(term, 'kubectl logs job/pi');
    if (!st.succeeded) return print(term, 'error: timed out waiting for the condition', 'bad');
    print(term, '3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679…');
  }, { cmd: /^kubectl logs (?:job\/pi|jobs?\/pi)$/ });

  s.btn('kubectl delete job pi', async () => {
    typed(term, 'kubectl delete job pi');
    print(term, 'job.batch "pi" deleted');
    workers.forEach((w) => w.pods.replaceChildren());
    failedZone.replaceChildren();
    st = { started: false, done: false, succeeded: 0, failed: 0, created: 0 };
    renderJob();
    s.say('Deleting the Job also deletes its pods (they are owned by it). Apply again to re-run.');
  }, { enabled: () => st.done, why: 'Wait until the Job has finished.' });
  renderJob();
};

// =====================================================================
// CronJobs: the schedule fires, concurrencyPolicy decides about overlaps
// =====================================================================
A.jobsCron = (root) => {
  const s = scene(root, { title: 'A CronJob and its concurrency policy', hint: 'Schedule: every minute. Each run takes 90 s — longer than the interval. Pick a policy and let time pass.' });
  const RUN_SECONDS = 90;
  const STEP_SECONDS = 15;
  const clock = h('b', { class: 'ib-clock' }, '02:00:00');
  const policySel = h('select', { 'aria-label': 'concurrencyPolicy' }, ...['Allow', 'Forbid', 'Replace'].map((p) => h('option', { value: p }, `concurrencyPolicy: ${p}`)));
  const timeline = h('div', { class: 'ib-timeline' });
  const jobsZone = h('div', { class: 'ib-cron-jobs' });
  const cronCard = h('div', { class: 'ib-obj ok' }, h('b', {}, '⏰ cronjob/backup'), h('small', {}, 'schedule "*/1 * * * *"'));
  const term = mkTerm({ height: '130px' });
  s.stage.append(h('div', { class: 'ib-cron-top' }, cronCard, clock), timeline, zone('Jobs created by the CronJob', jobsZone), term);

  let st = { seconds: 0, jobs: [], suspended: false, running: false };

  const fmtClock = () => {
    const m = Math.floor(st.seconds / 60), sec = st.seconds % 60;
    clock.textContent = `02:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  const active = () => st.jobs.filter((j) => j.state === 'Running');
  const mark = (text, cls) => timeline.append(h('span', { class: `ib-mark ${cls}` }, h('small', {}, `02:${String(Math.floor(st.seconds / 60)).padStart(2, '0')}`), text));

  const startJob = (name) => {
    const bar = mkBar();
    const label = h('small', {}, 'Running');
    const el = h('div', { class: 'ib-cron-job pop' }, h('b', {}, name), bar, label);
    jobsZone.append(el);
    const job = { name, started: st.seconds, state: 'Running', el, bar, label };
    st.jobs.push(job);
    return job;
  };
  const finishJob = (job, state) => {
    job.state = state;
    job.label.textContent = state;
    job.el.classList.add(state === 'Complete' ? 'ok' : 'bad');
  };

  const fire = () => {
    if (st.suspended) return mark('suspended', 'dim');
    const policy = policySel.value;
    const running = active();
    if (running.length && policy === 'Forbid') {
      print(term, `Warning  JobAlreadyActive  Not starting job because prior execution is running and concurrency policy is Forbid`, 'y');
      return mark('⏭ skipped', 'warn');
    }
    if (running.length && policy === 'Replace') {
      running.forEach((j) => finishJob(j, 'Replaced (deleted)'));
      mark('↻ replaced', 'bad');
    } else mark(running.length ? '⧉ overlap' : '▶ run', running.length ? 'warn' : 'ok');
    startJob(`backup-${29000000 + st.seconds / 60}`);
  };

  const advance = () => {
    st.seconds += STEP_SECONDS;
    fmtClock();
    active().forEach((j) => {
      const pct = ((st.seconds - j.started) / RUN_SECONDS) * 100;
      setBar(j.bar, pct);
      if (pct >= 100) finishJob(j, 'Complete');
    });
    if (st.seconds % 60 === 0) fire();
  };

  s.btn('▶ Let 4 minutes pass', async () => {
    st.running = true;
    const policy = policySel.value;
    s.say(`Policy <b>${policy}</b>: ${{ Allow: 'every minute a new Job starts, even if the last one is still running — runs overlap.', Forbid: 'if the previous Job is still running, the new run is skipped.', Replace: 'the running Job is deleted and replaced by the new one.' }[policy]}`);
    if (!st.seconds) fire();
    for (let i = 0; i < (4 * 60) / STEP_SECONDS; i++) { advance(); await wait(330); }
    st.running = false;
    s.say(`Done. With <b>${policy}</b>, ${st.jobs.filter((j) => j.state === 'Complete').length} Job(s) completed. Reset and try another policy.`);
  }, { primary: true, enabled: () => !st.running });
  s.add(h('label', { class: 'inline' }, policySel));

  s.sep();
  s.btn('kubectl create job manual-1 --from=cronjob/backup', async (_, m) => {
    const name = m?.[1] || 'manual-1';
    typed(term, m?.input || 'kubectl create job manual-1 --from=cronjob/backup');
    if (st.jobs.some((j) => j.name === name)) return print(term, `error: failed to create job: jobs.batch "${name}" already exists`, 'bad');
    print(term, `job.batch/${name} created`);
    startJob(name);
    s.say('A one-off Job made from the CronJob’s template. It ignores the schedule and the concurrency policy — handy for testing.');
  }, { cmd: /^kubectl create job ([a-z0-9-]+) --from=cronjobs?\/backup$/ });

  s.btn('kubectl get cronjobs', async () => {
    typed(term, 'kubectl get cronjobs');
    printTable(term, [['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'LAST SCHEDULE'], ['backup', '*/1 * * * *', '<none>', String(st.suspended).replace(/^./, (c) => c.toUpperCase()), active().length, st.seconds >= 60 ? `${st.seconds % 60 || 60}s` : '<none>']]);
  }, { cmd: /^kubectl get (?:cronjobs?|cj)(?: backup)?$/ });

  s.btn('kubectl get jobs', async () => {
    typed(term, 'kubectl get jobs');
    if (!st.jobs.length) return print(term, 'No resources found in default namespace.');
    printTable(term, [['NAME', 'STATUS', 'COMPLETIONS'], ...st.jobs.map((j) => [j.name, j.state.split(' ')[0], j.state === 'Complete' ? '1/1' : '0/1'])]);
  }, { cmd: /^kubectl get jobs?$/ });

  s.btn('kubectl patch cronjob backup -p \'{"spec":{"suspend":true}}\'', async (_, m) => {
    st.suspended = m ? m[1] === 'true' : true;
    typed(term, m?.input || 'kubectl patch cronjob backup -p \'{"spec":{"suspend":true}}\'');
    print(term, 'cronjob.batch/backup patched');
    s.say(st.suspended ? 'Suspended: the schedule keeps ticking but no new Jobs are created. Running Jobs are not stopped.' : 'Resumed: Jobs are created on schedule again.');
  }, { cmd: /^kubectl patch (?:cronjobs?|cj)[ /]backup -p .*"suspend":\s*(true|false).*$/ });

  s.btn('↺ Reset', async () => {
    st = { seconds: 0, jobs: [], suspended: false, running: false };
    timeline.replaceChildren();
    jobsZone.replaceChildren();
    term.replaceChildren();
    fmtClock();
    s.say('Reset to 02:00.');
  });
};

// =====================================================================
// DaemonSets: one pod per matching node, following nodes as they come and go
// =====================================================================
A.daemonsetNodes = (root) => {
  const s = scene(root, { title: 'One agent per node, automatically', hint: 'Apply the DaemonSet, then add and remove nodes, label a GPU node, and tolerate the control-plane taint.' });
  const controller = h('span', { class: 'chip blue' }, '🔁 DaemonSet controller');
  const dsChips = h('div', { class: 'chips' });
  const nodesEl = h('div', { class: 'k-nodes' });
  const term = mkTerm({ height: '130px' });
  s.stage.append(h('div', { class: 'ib-ds-top' }, controller, dsChips), nodesEl, term);

  const freshNodes = () => [
    { name: 'control-plane', role: 'control-plane', taint: true, gpu: false },
    { name: 'worker-1', role: 'worker', taint: false, gpu: false },
    { name: 'worker-2', role: 'worker', taint: false, gpu: false },
  ];
  let st = { applied: false, tolerate: false, gpuDs: false, nodes: freshNodes(), nextWorker: 3 };

  const wantsAgent = (n) => st.applied && (!n.taint || st.tolerate);
  const wantsGpu = (n) => st.gpuDs && n.gpu;
  const count = (fn) => st.nodes.filter(fn).length;
  const renderChips = () => dsChips.replaceChildren(
    st.applied ? h('span', { class: 'chip ok' }, `ds/log-agent desired ${count(wantsAgent)}`) : h('span', { class: 'chip ghost' }, 'no DaemonSets yet'),
    st.gpuDs ? h('span', { class: 'chip warn' }, `ds/gpu-driver desired ${count(wantsGpu)} (nodeSelector gpu=true)`) : null);

  const drawNode = (n) => {
    n.box = nodeBox(n.name, { role: n.role });
    n.badges = h('div', { class: 'ib-badges' });
    n.box.el.insertBefore(n.badges, n.box.pods);
    n.agent = null;
    n.gpuPod = null;
    nodesEl.append(n.box.el);
    renderBadges(n);
  };
  const renderBadges = (n) => n.badges.replaceChildren(
    n.taint ? h('span', { class: 'ib-taint' }, 'taint: control-plane:NoSchedule') : null,
    n.gpu ? h('span', { class: 'k-label' }, 'gpu=true') : null);

  const ensurePod = async (n, key, want, name, image) => {
    if (want && !n[key]) {
      n[key] = podEl(`${name}-${shortHash()}`, { status: 'creating', image });
      n.box.pods.append(n[key]);
      await fly(s.stage, controller, n[key], { label: `create on ${n.name}`, ms: 650 });
      n[key].setStatus('ready');
    } else if (!want && n[key]) {
      n[key].setStatus('terminating');
      await wait(400);
      n[key].vanish();
      n[key] = null;
    }
  };
  const reconcile = async () => {
    for (const n of st.nodes) {
      await ensurePod(n, 'agent', wantsAgent(n), 'log-agent', 'fluent-bit');
      await ensurePod(n, 'gpuPod', wantsGpu(n), 'gpu-driver', 'nvidia-driver');
    }
    renderChips();
  };

  s.btn('kubectl apply -f daemonset.yaml', async () => {
    typed(term, 'kubectl apply -f daemonset.yaml');
    print(term, 'daemonset.apps/log-agent created');
    st.applied = true;
    s.say('The controller creates one log-agent pod per node. The <b>control-plane</b> node is tainted <code>NoSchedule</code> and this version has no toleration, so it is skipped.');
    await reconcile();
  }, { primary: true, cmd: /^kubectl (?:apply|create) -f daemonset\.ya?ml$/, enabled: () => !st.applied, why: 'The DaemonSet already exists.' });

  s.btn('＋ Add a worker node', async () => {
    const n = { name: `worker-${st.nextWorker++}`, role: 'worker', taint: false, gpu: false };
    st.nodes.push(n);
    drawNode(n);
    print(term, `# ${n.name} joined the cluster (kubeadm join …)`, 'dim');
    s.say(`<b>${n.name}</b> joined. Nobody scaled anything — the DaemonSet controller saw a new matching node and created its pod.`);
    await wait(500);
    await reconcile();
  }, { enabled: () => st.nodes.length < 5, why: 'That’s enough nodes for this demo.' });

  s.btn('− Remove the newest worker', async (_, m) => {
    const name = m?.[1] || st.nodes.filter((n) => n.role === 'worker').at(-1).name;
    typed(term, m?.input || `kubectl delete node ${name}`);
    const n = st.nodes.find((x) => x.name === name);
    if (!n) return print(term, `Error from server (NotFound): nodes "${name}" not found`, 'bad');
    print(term, `node "${name}" deleted`);
    n.box.setState('Deleting', 'bad');
    await wait(600);
    n.box.el.remove();
    st.nodes = st.nodes.filter((x) => x !== n);
    renderChips();
    s.say(`${name} is gone, and its DaemonSet pods were garbage-collected with it. DESIRED dropped by one.`);
  }, { cmd: /^kubectl delete (?:nodes?|no) (worker-\d+)$/, example: 'kubectl delete node worker-2', enabled: () => st.nodes.filter((n) => n.role === 'worker').length > 1, why: 'Keep at least one worker.' });

  s.btn('✓ Add a control-plane toleration', async () => {
    typed(term, 'kubectl apply -f daemonset.yaml   # now with tolerations:');
    print(term, 'daemonset.apps/log-agent configured');
    st.tolerate = true;
    s.say('The pod template now <b>tolerates</b> <code>node-role.kubernetes.io/control-plane:NoSchedule</code>, so the agent also runs on the control-plane node and collects its logs.');
    await reconcile();
  }, { enabled: () => st.applied && !st.tolerate, why: () => (st.applied ? 'Already tolerated.' : 'Apply the DaemonSet first.') });

  s.sep();
  s.btn('kubectl apply -f gpu-driver.yaml', async () => {
    typed(term, 'kubectl apply -f gpu-driver.yaml');
    print(term, 'daemonset.apps/gpu-driver created');
    st.gpuDs = true;
    renderChips();
    s.say('gpu-driver has <code>nodeSelector: {gpu: "true"}</code>. No node has that label yet, so DESIRED is 0. Label one!');
    await reconcile();
  }, { enabled: () => !st.gpuDs, why: 'gpu-driver already exists.' });

  s.btn('kubectl label node worker-2 gpu=true', async (_, m) => {
    const name = m?.[1] || 'worker-2';
    const remove = m ? m[2] === '-' : false;
    typed(term, m?.input || 'kubectl label node worker-2 gpu=true');
    const n = st.nodes.find((x) => x.name === name);
    if (!n) return print(term, `Error from server (NotFound): nodes "${name}" not found`, 'bad');
    n.gpu = !remove;
    renderBadges(n);
    print(term, `node/${name} ${remove ? 'unlabeled' : 'labeled'}`);
    s.say(remove ? `Label removed: ${name} no longer matches, so its gpu-driver pod is removed.` : `${name} now matches <code>gpu=true</code>${st.gpuDs ? ', so gpu-driver starts there.' : '. Apply gpu-driver.yaml to see a selective DaemonSet.'}`);
    await reconcile();
  }, { cmd: /^kubectl label (?:nodes?|no) (worker-\d+|control-plane) gpu(=true|-)(?: --overwrite)?$/, example: 'kubectl label node worker-2 gpu-' });

  s.btn('kubectl get ds -A', async () => {
    typed(term, 'kubectl get ds -A');
    const rows = [['NAMESPACE', 'NAME', 'DESIRED', 'CURRENT', 'READY', 'NODE SELECTOR'], ['kube-system', 'kube-proxy', st.nodes.length, st.nodes.length, st.nodes.length, 'kubernetes.io/os=linux']];
    if (st.applied) rows.push(['kube-system', 'log-agent', count(wantsAgent), count(wantsAgent), count(wantsAgent), '<none>']);
    if (st.gpuDs) rows.push(['kube-system', 'gpu-driver', count(wantsGpu), count(wantsGpu), count(wantsGpu), 'gpu=true']);
    printTable(term, rows);
  }, { cmd: /^kubectl get (?:ds|daemonsets?)(?: -a| --all-namespaces| -n kube-system)?$/ });

  s.btn('↺ Reset', async () => {
    st = { applied: false, tolerate: false, gpuDs: false, nodes: freshNodes(), nextWorker: 3 };
    nodesEl.replaceChildren();
    st.nodes.forEach(drawNode);
    renderChips();
    term.replaceChildren();
    s.say('Reset. Three nodes, no DaemonSet.');
  });
  st.nodes.forEach(drawNode);
  renderChips();
};

// =====================================================================
// StatefulSets: ordered start, stable names, one PVC per replica
// =====================================================================
A.statefulsetOrder = (root) => {
  const s = scene(root, { title: 'StatefulSet db: names, order and disks that stick', hint: 'Apply, then delete db-1 and scale up and down. Watch the names, the order and the PVCs.' });
  const MAX_REPLICAS = 5;
  const nodes = [nodeBox('node-a'), nodeBox('node-b')];
  const svc = h('div', { class: 'k-svc' }, '🔀 Service db · clusterIP: None');
  const pvcZone = h('div', { class: 'ib-pvcs' });
  const dnsList = h('div', { class: 'ib-dns' });
  const term = mkTerm({ height: '130px' });
  s.stage.append(h('div', { class: 'ib-sts-top' }, svc),
    h('div', { class: 'k-nodes' }, ...nodes.map((n) => n.el)),
    h('div', { class: 'ib-sts-bottom' }, zone('PersistentVolumeClaims (volumeClaimTemplates)', pvcZone), zone('Per-pod DNS (namespace shop)', dnsList)),
    term);

  let st = { applied: false, replicas: 0, pods: new Map(), pvcs: new Map() };

  const renderDns = () => dnsList.replaceChildren(...[...st.pods.entries()].sort(([a], [b]) => a - b)
    .map(([i, p]) => h('div', { class: 'ib-dns-row' }, h('code', {}, `db-${i}.db.shop.svc.cluster.local`), h('small', {}, `→ ${p.ip}`))));

  const ensurePvc = (i) => {
    const existing = st.pvcs.get(i);
    if (existing) {
      existing.el.className = 'ib-pvc reused';
      flash(existing.el);
      return existing;
    }
    const el = h('div', { class: 'ib-pvc pop' }, h('b', {}, `data-db-${i}`), h('small', {}, 'Bound · 10Gi'));
    pvcZone.append(el);
    const pvc = { el };
    st.pvcs.set(i, pvc);
    return pvc;
  };
  const startPod = async (i, nodeIndex = i % nodes.length) => {
    const pvc = ensurePvc(i);
    const ip = podIp();
    const el = podEl(`db-${i}`, { status: 'creating', image: 'postgres:16', ip });
    nodes[nodeIndex].pods.append(el);
    st.pods.set(i, { el, ip, node: nodeIndex });
    await fly(s.stage, pvc.el, el, { label: `mount data-db-${i}`, ms: 650 });
    await wait(500);
    el.setStatus('ready');
    pvc.el.className = 'ib-pvc';
    renderDns();
  };
  const stopPod = async (i) => {
    const p = st.pods.get(i);
    p.el.setStatus('terminating');
    await wait(600);
    p.el.vanish();
    st.pods.delete(i);
    st.pvcs.get(i).el.className = 'ib-pvc retained';
    renderDns();
  };
  const scaleTo = async (target) => {
    const n = Math.max(0, Math.min(MAX_REPLICAS, target));
    st.replicas = n;
    for (let i = st.pods.size; i < n; i++) {
      s.say(`Creating <b>db-${i}</b>${i ? ` — only now, because db-${i - 1} is Running and Ready` : ''}. It gets its own claim <b>data-db-${i}</b>${st.pvcs.has(i) ? ' (the old one, data intact)' : ''}.`);
      await startPod(i);
    }
    for (let i = st.pods.size - 1; i >= n; i--) {
      s.say(`Scaling down removes the <b>highest ordinal first</b>: db-${i}. Its PVC <b>data-db-${i}</b> is kept.`);
      await stopPod(i);
    }
  };

  s.btn('kubectl apply -f statefulset.yaml', async () => {
    typed(term, 'kubectl apply -f statefulset.yaml');
    print(term, 'service/db created');
    print(term, 'statefulset.apps/db created');
    st.applied = true;
    await scaleTo(3);
    s.say('Three replicas with <b>stable names</b>, each with <b>its own disk</b> and <b>its own DNS name</b>, created strictly in order.');
  }, { primary: true, cmd: /^kubectl (?:apply|create) -f statefulset\.ya?ml$/, enabled: () => !st.applied, why: 'Already applied — scale it, or press Reset.' });

  s.btn('kubectl delete pod db-1', async (_, m) => {
    const i = Number(m?.[1] ?? 1);
    typed(term, m?.input || 'kubectl delete pod db-1');
    const p = st.pods.get(i);
    if (!p) return print(term, `Error from server (NotFound): pods "db-${i}" not found`, 'bad');
    print(term, `pod "db-${i}" deleted`);
    const otherNode = (p.node + 1) % nodes.length;
    await stopPod(i);
    s.say(`The StatefulSet controller recreates <b>db-${i}</b> — same name, maybe another node, new IP, and the <b>same claim data-db-${i}</b>.`);
    await wait(400);
    await startPod(i, otherNode);
    s.say(`db-${i} is back on node-${otherNode ? 'b' : 'a'} with its old data. Its DNS name never changed — only the IP behind it.`);
  }, { cmd: /^kubectl delete (?:pods?|po)[ /]db-(\d)$/, enabled: () => st.pods.has(1), why: 'db-1 doesn’t exist right now — scale to at least 2 replicas.' });

  s.btn('kubectl scale statefulset db --replicas=5', async (_, m) => {
    const n = Number(m?.[1] ?? 5);
    typed(term, m?.input || 'kubectl scale statefulset db --replicas=5');
    print(term, 'statefulset.apps/db scaled');
    await scaleTo(n);
  }, { cmd: /^kubectl scale (?:sts|statefulsets?)[ /]db --replicas[= ]?(\d)$/, enabled: () => st.applied, why: 'Apply statefulset.yaml first.' });

  s.btn('kubectl scale statefulset db --replicas=2', async () => {
    typed(term, 'kubectl scale statefulset db --replicas=2');
    print(term, 'statefulset.apps/db scaled');
    await scaleTo(2);
    s.say('db-2 (and any higher) were removed, highest first. Their PVCs stay <b>Retained</b> — scale up again and they get their data back.');
  }, { enabled: () => st.applied && st.replicas > 2, why: 'Already at 2 or fewer replicas.' });

  s.sep();
  s.btn('kubectl get pods -l app=db', async () => {
    typed(term, 'kubectl get pods -l app=db');
    if (!st.pods.size) return print(term, 'No resources found in shop namespace.');
    printTable(term, [['NAME', 'READY', 'STATUS', 'NODE'], ...[...st.pods.entries()].sort(([a], [b]) => a - b).map(([i, p]) => [`db-${i}`, '1/1', 'Running', `node-${p.node ? 'b' : 'a'}`])]);
  }, { cmd: /^kubectl get (?:pods?|po)(?: -l app=db)?(?: -o wide)?$/ });

  s.btn('kubectl get pvc', async () => {
    typed(term, 'kubectl get pvc');
    if (!st.pvcs.size) return print(term, 'No resources found in shop namespace.');
    printTable(term, [['NAME', 'STATUS', 'CAPACITY', 'ACCESS MODES', 'USED BY'], ...[...st.pvcs.keys()].sort().map((i) => [`data-db-${i}`, 'Bound', '10Gi', 'RWO', st.pods.has(i) ? `db-${i}` : '<none>'])]);
  }, { cmd: /^kubectl get (?:pvc|persistentvolumeclaims?)(?: -l app=db)?$/ });

  s.btn('↺ Reset', async () => {
    st = { applied: false, replicas: 0, pods: new Map(), pvcs: new Map() };
    nodes.forEach((n) => n.pods.replaceChildren());
    pvcZone.replaceChildren();
    dnsList.replaceChildren();
    term.replaceChildren();
    s.say('Reset. Apply statefulset.yaml to begin.');
  });
};
