// Animations for the intermediate lessons (part A). Each registers itself on ANIMATIONS.
import { ANIMATIONS as A, helpers } from '../animations.js';
import { h, wait, fly, flash, escapeHtml } from '../dom.js';
import { scene } from '../components.js';

const { mkTerm, out, typed, title, zone, podEl, nodeBox, ping, shortHash } = helpers;

// ---------- small shared helpers ----------
/** Formats rows as aligned columns, like kubectl's table output. */
const columns = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)) + 3);
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('').trimEnd()).map(escapeHtml).join('\n');
};
const print = (term, text, cls = '') => out(term, cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));
const setPodText = (pod, text) => { pod.querySelector('.k-pod-status').textContent = text; };
const box = (cls, ...kids) => h('div', { class: cls }, ...kids);
const RS_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';

/** A stable pod-template-hash-looking string for an image, so the same template reuses its ReplicaSet. */
const templateHash = (image) => {
  let seed = 7;
  for (const ch of image) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: 9 }, (_, i) => RS_ALPHABET[(seed >>> (i * 3)) % RS_ALPHABET.length] ?? 'b').join('');
};

// =====================================================================
// Deployments: a real rolling update with maxSurge / maxUnavailable
// =====================================================================
A.deployRolling = (root) => {
  const s = scene(root, {
    title: 'Rolling update: two ReplicaSets trading places',
    hint: 'Set <b>maxSurge</b> and <b>maxUnavailable</b>, then press <code>kubectl set image …</code> and watch the old ReplicaSet shrink while the new one grows.',
  });
  const VALID_IMAGE = /^nginx:1\.\d+(\.\d+)?$/;
  const START_IMAGE = 'nginx:1.26';
  let st = { replicas: 4, surge: 1, unavail: 1, image: START_IMAGE, nextMinor: 27, revisions: [], pods: [], rolling: false, stalled: false };

  const deployInfo = h('div', { class: 'ia-deploy-info' });
  const bounds = h('div', { class: 'ia-bounds' });
  const rsRow = h('div', { class: 'ia-rs-row' });
  const term = mkTerm({ height: '150px' });
  const rsCards = new Map();
  s.stage.append(
    box('ia-deploy', title('🚀 Deployment web', 'apps/v1'), deployInfo, bounds),
    rsRow,
    term,
  );

  // ---- strategy sliders ----
  const slider = (label, key) => {
    const value = h('b', {}, String(st[key]));
    const input = h('input', { type: 'range', min: 0, max: 2, step: 1, value: st[key], 'aria-label': label });
    input.addEventListener('input', () => {
      st[key] = Number(input.value);
      const other = key === 'surge' ? 'unavail' : 'surge';
      if (!st.surge && !st.unavail) {
        st[other] = 1;
        sliders[other].sync();
        s.say('Kubernetes rejects <b>maxSurge: 0</b> together with <b>maxUnavailable: 0</b> — the rollout could never make a move. The other value was set back to 1.');
      }
      value.textContent = String(st[key]);
      render();
    });
    return { el: h('label', { class: 'inline' }, label, input, value), input, sync: () => { input.value = st[key]; value.textContent = String(st[key]); } };
  };
  const sliders = { surge: slider('maxSurge', 'surge'), unavail: slider('maxUnavailable', 'unavail') };
  const lockSliders = (locked) => Object.values(sliders).forEach((x) => { x.input.disabled = locked; });

  // ---- model ----
  const live = () => st.pods.filter((p) => p.state !== 'terminating');
  const isReady = (p) => p.state === 'ready';
  const revisionOf = (image) => st.revisions.find((r) => r.image === image);

  const ensureCard = (hash, image) => {
    if (rsCards.has(hash)) return rsCards.get(hash);
    const pods = h('div', { class: 'ia-rs-pods' });
    const meta = h('small', {});
    const card = box('ia-rs pop', h('div', { class: 'ia-rs-head' }, h('b', {}, `ReplicaSet web-${hash}`), h('small', {}, `📦 ${image}`)), meta, pods);
    const entry = { card, pods, meta, image };
    rsCards.set(hash, entry);
    rsRow.append(card);
    return entry;
  };

  const render = () => {
    const pods = live();
    const avail = pods.filter(isReady).length;
    const current = templateHash(st.image);
    deployInfo.innerHTML = `replicas <b>${st.replicas}</b> · image <code>${escapeHtml(st.image)}</code> · strategy RollingUpdate (maxSurge <b>${st.surge}</b>, maxUnavailable <b>${st.unavail}</b>)`;
    bounds.innerHTML = `<span class="${pods.length > st.replicas ? 'ia-hot' : ''}">pods <b>${pods.length}</b> / max ${st.replicas + st.surge}</span><span class="${avail < st.replicas ? 'ia-hot' : ''}">available <b>${avail}</b> / min ${st.replicas - st.unavail}</span>`;
    rsCards.forEach((entry, hash) => {
      const mine = pods.filter((p) => p.hash === hash);
      entry.meta.textContent = `pods ${mine.length} · ready ${mine.filter(isReady).length}${hash === current ? ' · ★ current template' : mine.length ? '' : ' · kept for rollback'}`;
      entry.card.classList.toggle('ia-rs-idle', mine.length === 0);
      entry.card.classList.toggle('ia-rs-current', hash === current);
    });
  };

  const addPod = (image, state) => {
    const hash = templateHash(image);
    const el = podEl(`web-${hash}-${shortHash()}`, { status: state === 'ready' ? 'ready' : 'creating', image });
    const pod = { hash, image, el, state };
    st.pods.push(pod);
    ensureCard(hash, image).pods.append(el);
    return pod;
  };
  const dropPod = async (pod) => {
    pod.state = 'terminating';
    pod.el.setStatus('terminating');
    render();
    await wait(450);
    await pod.el.vanish();
    st.pods = st.pods.filter((p) => p !== pod);
    render();
  };
  // Creating pods become Ready — or fail to pull a missing image.
  const settleNewPods = async () => {
    const starting = st.pods.filter((p) => p.state === 'creating');
    if (!starting.length) return false;
    await wait(1100);
    starting.forEach((p) => {
      if (VALID_IMAGE.test(p.image)) { p.state = 'ready'; p.el.setStatus('ready'); return; }
      p.state = 'bad';
      p.el.setStatus('failed');
      setPodText(p.el, 'ImagePullBackOff');
    });
    render();
    return starting.some((p) => p.state === 'ready');
  };

  /** One reconcile of the Deployment controller: scale the new ReplicaSet up and the old ones down. */
  const reconcileOnce = async () => {
    const target = templateHash(st.image);
    const unhealthyOld = live().filter((p) => p.hash !== target && !isReady(p));
    await Promise.all(unhealthyOld.map(dropPod)); // they serve no traffic, so removing them costs nothing

    const pods = live();
    const fresh = pods.filter((p) => p.hash === target);
    const scaleUp = Math.max(0, Math.min(st.replicas + st.surge - pods.length, st.replicas - fresh.length));
    for (let i = 0; i < scaleUp; i++) addPod(st.image, 'creating');

    const oldReady = live().filter((p) => p.hash !== target && isReady(p));
    const avail = live().filter(isReady).length;
    const scaleDown = Math.max(0, Math.min(avail - (st.replicas - st.unavail), oldReady.length));
    render();
    if (scaleUp || scaleDown) s.say(`Controller step: new ReplicaSet <b>+${scaleUp}</b>, old ReplicaSet <b>−${scaleDown}</b>. Total stays ≤ ${st.replicas + st.surge}; available stays ≥ ${st.replicas - st.unavail}.`);
    await Promise.all(oldReady.slice(0, scaleDown).map(dropPod));
    const becameReady = await settleNewPods();
    return scaleUp > 0 || scaleDown > 0 || unhealthyOld.length > 0 || becameReady;
  };

  const isComplete = () => {
    const target = templateHash(st.image);
    const pods = live();
    return pods.length === st.replicas && pods.every((p) => p.hash === target && isReady(p));
  };

  const recordRevision = (image, cause) => {
    const nextRev = Math.max(0, ...st.revisions.map((r) => r.rev)) + 1;
    st.revisions = st.revisions.filter((r) => r.image !== image); // a reused template moves to the newest revision
    st.revisions.push({ rev: nextRev, image, cause });
  };

  const rollTo = async (image, cause) => {
    st.image = image;
    st.rolling = true;
    st.stalled = false;
    recordRevision(image, cause);
    ensureCard(templateHash(image), image);
    lockSliders(true);
    render();
    for (let guard = 0; guard < 20 && !isComplete(); guard++) {
      const progressed = await reconcileOnce();
      if (progressed) continue;
      st.stalled = true;
      break;
    }
    lockSliders(false);
    if (st.stalled) {
      const updated = live().filter((p) => p.hash === templateHash(image)).length;
      print(term, `Waiting for deployment "web" rollout to finish: ${updated} out of ${st.replicas} new replicas have been updated...`, 'y');
      print(term, 'error: deployment "web" exceeded its progress deadline', 'bad');
      s.say(`<b>Stalled.</b> The new pods can’t pull <code>${escapeHtml(image)}</code>, so they never become Ready and the controller is not allowed to remove more old pods. Users are still served by the old version — that is the point of maxUnavailable. Fix it with <code>kubectl rollout undo deployment/web</code>.`);
      return;
    }
    st.rolling = false;
    print(term, 'deployment "web" successfully rolled out', 'ok');
    s.say(`Done: ${st.replicas} pods on <code>${escapeHtml(image)}</code>. The old ReplicaSet is kept at <b>0 replicas</b> for rollback (see <code>kubectl get rs</code>).`);
    render();
  };

  const setImage = async (image) => {
    typed(term, `kubectl set image deployment/web web=${image}`);
    if (image === st.image) { print(term, 'deployment.apps/web image unchanged'); return s.say('Same image, same pod template — nothing to roll out.'); }
    print(term, 'deployment.apps/web image updated');
    print(term, `# kubectl annotate deployment/web kubernetes.io/change-cause="image ${image}"`, 'dim');
    await rollTo(image, `image ${image}`);
  };

  const undo = async (toRevision) => {
    const sorted = [...st.revisions].sort((a, b) => a.rev - b.rev);
    const target = toRevision ? sorted.find((r) => r.rev === toRevision) : sorted.at(-2);
    typed(term, `kubectl rollout undo deployment/web${toRevision ? ` --to-revision=${toRevision}` : ''}`);
    if (!target) { print(term, `error: unable to find specified revision ${toRevision} in history`, 'bad'); return; }
    print(term, 'deployment.apps/web rolled back');
    s.say(`Rolling back to revision ${target.rev} (<code>${escapeHtml(target.image)}</code>): its old ReplicaSet <b>web-${templateHash(target.image)}</b> is simply scaled up again. That revision is renumbered as the newest.`);
    await wait(600);
    await rollTo(target.image, target.cause);
  };

  const reset = () => {
    st = { replicas: 4, surge: 1, unavail: 1, image: START_IMAGE, nextMinor: 27, revisions: [], pods: [], rolling: false, stalled: false };
    rsCards.clear();
    rsRow.replaceChildren();
    term.replaceChildren();
    Object.values(sliders).forEach((x) => x.sync());
    lockSliders(false);
    recordRevision(START_IMAGE, 'initial deploy');
    for (let i = 0; i < st.replicas; i++) addPod(START_IMAGE, 'ready');
    print(term, '# 4 pods of nginx:1.26 are serving traffic', 'dim');
    render();
  };

  s.add(sliders.surge.el, sliders.unavail.el);
  s.sep();
  const setImageLabel = () => `kubectl set image deployment/web web=nginx:1.${st.nextMinor}`;
  const setImageBtn = s.btn(setImageLabel(), async (_, m) => {
    const image = m?.[1] ?? `nginx:1.${st.nextMinor}`;
    if (!m) st.nextMinor++;
    setImageBtn.textContent = setImageLabel();
    await setImage(image);
  }, {
    primary: true,
    cmd: /^kubectl set image (?:deployment|deploy|deployments)[/ ]web web=(\S+)$/,
    example: 'kubectl set image deployment/web web=nginx:1.27',
    enabled: () => !st.stalled,
    why: 'A rollout is stuck. Undo it first with <code>kubectl rollout undo deployment/web</code>.',
  });
  s.btn('💥 Ship a typo: web=nginx:1.27-typo', () => setImage('nginx:1.27-typo'), { enabled: () => !st.stalled });
  s.btn('kubectl rollout undo deployment/web', (_, m) => undo(m?.[1] ? Number(m[1]) : 0), {
    cmd: /^kubectl rollout undo (?:deployment|deploy|deployments)[/ ]web(?: --to-revision[= ](\d+))?$/,
    enabled: () => st.revisions.length > 1,
    why: 'There is no earlier revision to go back to yet. Ship a new image first.',
  });
  s.btn('kubectl rollout history deployment/web', () => {
    typed(term, 'kubectl rollout history deployment/web');
    print(term, 'deployment.apps/web');
    out(term, columns([['REVISION', 'CHANGE-CAUSE'], ...[...st.revisions].sort((a, b) => a.rev - b.rev).map((r) => [r.rev, r.cause])]));
    s.say('Each revision is an old ReplicaSet kept at 0 replicas. <code>--to-revision=N</code> picks one.');
  }, { cmd: /^kubectl rollout history (?:deployment|deploy|deployments)[/ ]web$/ });
  s.btn('kubectl get rs', () => {
    typed(term, 'kubectl get rs');
    const rows = [...rsCards.entries()].map(([hash]) => {
      const mine = live().filter((p) => p.hash === hash);
      return [`web-${hash}`, mine.length, mine.length, mine.filter(isReady).length, '6m'];
    });
    out(term, columns([['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'], ...rows]));
    s.say('Old ReplicaSets stay around with <b>DESIRED 0</b> — up to <code>revisionHistoryLimit</code> (default 10) of them.');
  }, { cmd: /^kubectl get (?:rs|replicasets?)(?: -l app=web)?(?: -o wide)?$/ });
  s.command(/^kubectl get (?:po|pods?)(?: -l app=web)?(?: -o wide)?$/, () => {
    typed(term, 'kubectl get pods');
    const rows = live().map((p) => [p.el.title, p.state === 'ready' ? '1/1' : '0/1', { ready: 'Running', creating: 'ContainerCreating', bad: 'ImagePullBackOff' }[p.state], 0, '1m']);
    out(term, columns([['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'], ...rows]));
  }, { example: 'kubectl get pods' });
  s.command(/^kubectl rollout status (?:deployment|deploy|deployments)[/ ]web(?: --timeout[= ]\S+)?$/, () => {
    typed(term, 'kubectl rollout status deployment/web');
    if (st.stalled) return print(term, 'error: deployment "web" exceeded its progress deadline', 'bad');
    print(term, 'deployment "web" successfully rolled out', 'ok');
  }, { example: 'kubectl rollout status deployment/web' });
  s.command(/^kubectl scale (?:deployment|deploy|deployments)[/ ]web --replicas[= ](\d+)$/, async (_, m) => {
    const wanted = Number(m[1]);
    typed(term, `kubectl scale deployment/web --replicas=${wanted}`);
    if (wanted < 1 || wanted > 8) { print(term, 'This scene allows 1–8 replicas.', 'y'); return; }
    print(term, 'deployment.apps/web scaled');
    const diff = wanted - st.replicas;
    st.replicas = wanted;
    if (diff > 0) { for (let i = 0; i < diff; i++) addPod(st.image, 'creating'); render(); await settleNewPods(); }
    else await Promise.all(live().slice(0, -diff).map(dropPod));
    render();
    s.say('Scaling only changes <code>replicas</code> on the current ReplicaSet. The pod template didn’t change, so there is <b>no new revision</b>.');
  }, { example: 'kubectl scale deployment/web --replicas=6', enabled: () => !st.rolling, why: 'Finish or undo the rollout first.' });
  s.sep();
  s.btn('↺ Reset', () => { reset(); setImageBtn.textContent = setImageLabel(); s.say('Back to 4 pods on <code>nginx:1.26</code>.'); });
  reset();
};

// =====================================================================
// Services: virtual IP, EndpointSlices and the three exposure types
// =====================================================================
A.svcTraffic = (root) => {
  const s = scene(root, {
    title: 'A Service spreads requests over Ready pods',
    hint: 'Send requests with <code>curl web</code>. Then break a pod’s readiness, delete a pod, or switch the Service type.',
  });
  const TYPES = {
    ClusterIP: { source: '🧑‍💻 frontend pod (inside the cluster)', target: 'web:80', ports: '80/TCP', external: '<none>' },
    NodePort: { source: '🌍 you, outside the cluster', target: '192.168.1.11:30080', ports: '80:30080/TCP', external: '<none>' },
    LoadBalancer: { source: '🌍 a user on the internet', target: '203.0.113.10:80', ports: '80:30080/TCP', external: '203.0.113.10' },
  };
  let st = { type: 'ClusterIP', pods: [], nextIp: 20, hits: new Map() };

  const sourceEl = box('ia-hop ia-source');
  const lbEl = box('ia-hop ia-lb', '☁ cloud load balancer', h('small', {}, '203.0.113.10:80'));
  const nodePortEl = box('ia-hop ia-np', '🖥 NodePort on every node', h('small', {}, ':30080'));
  const svcEl = box('ia-hop ia-svc', h('b', {}, '🔀 Service web'), h('small', {}, 'ClusterIP 10.96.12.40:80 → targetPort 80'));
  const epChips = h('div', { class: 'chips' });
  const nodes = { 'node-1': nodeBox('node-1'), 'node-2': nodeBox('node-2') };
  const term = mkTerm({ height: '130px' });
  const path = box('ia-path', sourceEl, lbEl, nodePortEl, svcEl);
  s.stage.append(path, zone('EndpointSlice web-x7k2p (Ready pod IPs)', epChips), box('k-nodes ia-svc-nodes', nodes['node-1'].el, nodes['node-2'].el), term);

  const readyPods = () => st.pods.filter((p) => p.ready && !p.gone);
  const renderType = () => {
    const t = TYPES[st.type];
    sourceEl.replaceChildren(h('b', {}, t.source), h('small', {}, `connects to ${t.target}`));
    lbEl.style.display = st.type === 'LoadBalancer' ? '' : 'none';
    nodePortEl.style.display = st.type === 'ClusterIP' ? 'none' : '';
  };
  const renderEndpoints = () => {
    const ready = readyPods();
    epChips.replaceChildren(...(ready.length ? ready.map((p) => h('span', { class: 'chip ok pop' }, `${p.ip}:80`)) : [h('span', { class: 'chip bad' }, 'no endpoints — nothing is Ready')]));
  };
  const hitLabel = (p) => `${p.ready ? 'Ready' : 'Running · NOT ready'} · ${st.hits.get(p.name) || 0} req`;
  const refreshPod = (p) => { p.el.setStatus(p.ready ? 'ready' : 'running'); setPodText(p.el, hitLabel(p)); };

  const addPod = (nodeName, state = 'ready') => {
    const ip = `10.244.${nodeName === 'node-1' ? 1 : 2}.${st.nextIp++}`;
    const name = `web-7d4b9c8f6-${shortHash()}`;
    const el = podEl(name, { status: state === 'ready' ? 'ready' : 'creating', ip, labels: { app: 'web' } });
    const pod = { name, ip, node: nodeName, el, ready: state === 'ready', gone: false };
    st.pods.push(pod);
    nodes[nodeName].pods.append(el);
    if (pod.ready) refreshPod(pod);
    return pod;
  };

  const sendRequest = async (index) => {
    const ready = readyPods();
    const hops = [sourceEl, ...(st.type === 'LoadBalancer' ? [lbEl] : []), ...(st.type === 'ClusterIP' ? [] : [nodePortEl]), svcEl];
    for (let i = 0; i < hops.length - 1; i++) await fly(s.stage, hops[i], hops[i + 1], { label: i ? '' : `GET #${index}`, ms: 520 });
    ping(svcEl);
    if (!ready.length) {
      await fly(s.stage, svcEl, sourceEl, { label: 'refused', cls: 'bad', ms: 600 });
      print(term, 'curl: (7) Failed to connect to web port 80: Connection refused', 'bad');
      return;
    }
    const pod = ready[Math.floor(Math.random() * ready.length)]; // iptables mode picks a random endpoint
    await fly(s.stage, svcEl, pod.el, { label: pod.ip, ms: 560 });
    st.hits.set(pod.name, (st.hits.get(pod.name) || 0) + 1);
    refreshPod(pod);
    flash(pod.el);
    print(term, `<h1>Welcome to nginx!</h1>   ← answered by ${pod.name} (${pod.ip})`);
  };

  const curl = async () => {
    typed(term, `curl ${TYPES[st.type].target}`);
    s.say(st.type === 'ClusterIP'
      ? 'The packet goes to the virtual IP. <b>kube-proxy</b>’s rules on the sending node rewrite it to a random Ready pod — maybe on another node.'
      : st.type === 'NodePort' ? 'Any node’s port <b>30080</b> accepts it, then the same ClusterIP rules pick a pod.' : 'The cloud load balancer forwards to a node’s NodePort, which forwards to a pod: <b>LoadBalancer = NodePort + ClusterIP + a cloud LB</b>.');
    for (let i = 1; i <= 4; i++) await sendRequest(i);
  };

  const setType = async (type) => {
    if (type === st.type) return s.say(`The Service is already <b>${type}</b>.`);
    typed(term, `kubectl patch svc web -p '{"spec":{"type":"${type}"}}'`);
    print(term, 'service/web patched');
    st.type = type;
    renderType();
    if (type === 'LoadBalancer') {
      print(term, 'NAME   TYPE           CLUSTER-IP    EXTERNAL-IP   PORT(S)', 'dim');
      print(term, 'web    LoadBalancer   10.96.12.40   <pending>     80:30080/TCP', 'y');
      s.say('The cloud controller is asking your provider for a load balancer… <code>EXTERNAL-IP</code> shows <b>&lt;pending&gt;</b> meanwhile.');
      await wait(1300);
    }
    s.say({ ClusterIP: 'Back to <b>ClusterIP</b>: reachable only from inside the cluster.', NodePort: '<b>NodePort</b> keeps the ClusterIP and opens port <b>30080</b> on every node.', LoadBalancer: '<b>LoadBalancer</b> got a public IP. It still has a NodePort and a ClusterIP underneath.' }[type]);
  };

  const toggleReadiness = async () => {
    const pod = st.pods.find((p) => !p.gone && p.node === 'node-2') || st.pods.find((p) => !p.gone);
    pod.ready = !pod.ready;
    refreshPod(pod);
    if (!pod.ready) setPodText(pod.el, 'Running · readiness probe failing');
    renderEndpoints();
    s.say(pod.ready
      ? `<b>${pod.name}</b> passes its readiness probe again and is added back to the EndpointSlice.`
      : `<b>${pod.name}</b> fails its readiness probe. It keeps <b>running</b> (no restart) but is removed from the EndpointSlice, so it gets no new traffic.`);
  };

  const deletePod = async () => {
    const pod = st.pods.find((p) => !p.gone);
    typed(term, `kubectl delete pod ${pod.name}`);
    print(term, `pod "${pod.name}" deleted`);
    pod.gone = true;
    pod.el.setStatus('terminating');
    renderEndpoints();
    s.say(`The pod is removed from the EndpointSlice <b>immediately</b> when it starts terminating. Its ReplicaSet creates a replacement with a <b>new IP</b>.`);
    await wait(700);
    await pod.el.vanish();
    st.pods = st.pods.filter((p) => p !== pod);
    const fresh = addPod(pod.node, 'creating');
    await wait(1200);
    fresh.ready = true;
    refreshPod(fresh);
    renderEndpoints();
    s.say(`Replacement <b>${fresh.name}</b> got IP <b>${fresh.ip}</b>. Clients never noticed: they still talk to <code>web</code> / 10.96.12.40.`);
  };

  const reset = () => {
    st = { type: 'ClusterIP', pods: [], nextIp: 20, hits: new Map() };
    Object.values(nodes).forEach((n) => n.pods.replaceChildren());
    term.replaceChildren();
    addPod('node-1'); addPod('node-2'); addPod('node-2');
    renderType();
    renderEndpoints();
    print(term, '# Service web selects app=web and has 3 Ready pods', 'dim');
  };

  s.btn('curl web', curl, { primary: true, cmd: /^curl (?:-s )?(?:http:\/\/)?(?:web|web\.shop|10\.96\.12\.40|192\.168\.1\.11:30080|203\.0\.113\.10|localhost:30080)(?::80)?\/?$/, example: 'curl web' });
  s.btn('🩺 Toggle readiness of one pod', toggleReadiness);
  s.btn('kubectl delete pod …', deletePod, { cmd: /^kubectl delete (?:po|pods?) (?:web-\S+|\S+)$/, example: () => `kubectl delete pod ${st.pods.find((p) => !p.gone)?.name || 'web-…'}`, enabled: () => st.pods.some((p) => !p.gone) });
  s.btn('kubectl get endpointslices', () => {
    typed(term, 'kubectl get endpointslices -l kubernetes.io/service-name=web');
    const ips = readyPods().map((p) => p.ip);
    const shown = ips.length ? `${ips.slice(0, 3).join(',')}${ips.length > 3 ? ` + ${ips.length - 3} more...` : ''}` : '<unset>';
    out(term, columns([['NAME', 'ADDRESSTYPE', 'PORTS', 'ENDPOINTS', 'AGE'], ['web-x7k2p', 'IPv4', 80, shown, '12m']]));
  }, { cmd: /^kubectl get (?:endpointslices?|endpoints|ep)(?: .*)?$/ });
  s.btn('kubectl get svc web', () => {
    typed(term, 'kubectl get svc web');
    const t = TYPES[st.type];
    out(term, columns([['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'], ['web', st.type, '10.96.12.40', t.external, t.ports, '12m']]));
  }, { cmd: /^kubectl get (?:svc|services?)(?: web)?(?: -o wide)?$/ });
  s.sep();
  Object.keys(TYPES).forEach((type) => s.btn(type, () => setType(type)));
  s.command(/^kubectl patch (?:svc|service)[/ ]web .*type"?\s*:\s*"?(clusterip|nodeport|loadbalancer)/, (_, m) => setType(Object.keys(TYPES).find((t) => t.toLowerCase() === m[1])), { example: 'kubectl patch svc web -p \'{"spec":{"type":"NodePort"}}\'' });
  s.btn('↺ Reset', () => { reset(); s.say('Three Ready pods, ClusterIP Service.'); });
  reset();
};

// =====================================================================
// DNS: search domains, ndots, headless answers
// =====================================================================
A.dnsLookup = (root) => {
  const s = scene(root, {
    title: 'How a pod turns “web” into an IP',
    hint: 'Run a lookup and watch the pod walk its search list. Compare <code>nslookup db</code> (headless) with <code>nslookup web</code>.',
  });
  const SEARCH = ['shop.svc.cluster.local', 'svc.cluster.local', 'cluster.local'];
  const RECORDS = {
    'web.shop.svc.cluster.local': { ips: ['10.96.12.40'], note: 'the ClusterIP of Service <b>web</b>' },
    'db.shop.svc.cluster.local': { ips: ['10.244.1.5', '10.244.2.8', '10.244.3.4'], note: 'a <b>headless</b> Service: one A record per Ready pod, no virtual IP' },
    'db-0.db.shop.svc.cluster.local': { ips: ['10.244.1.5'], note: 'the stable name of StatefulSet pod <b>db-0</b>' },
    'db-1.db.shop.svc.cluster.local': { ips: ['10.244.2.8'], note: 'the stable name of StatefulSet pod <b>db-1</b>' },
    'api.payments.svc.cluster.local': { ips: ['10.96.88.3'], note: 'Service <b>api</b> in namespace <b>payments</b>' },
    'kube-dns.kube-system.svc.cluster.local': { ips: ['10.96.0.10'], note: 'CoreDNS’s own Service' },
    'google.com': { ips: ['142.250.74.46'], note: 'an external name, forwarded upstream by CoreDNS' },
    'api.stripe.com': { ips: ['54.187.174.169'], note: 'an external name, forwarded upstream by CoreDNS' },
  };
  let st = { ndots: 5 };

  const resolvText = h('pre', { class: 'ia-resolv' });
  const pod = box('ia-dns-pod', title('🧪 pod tmp', 'namespace shop'), resolvText);
  const dnsEl = box('ia-dns-server', title('📒 CoreDNS', '10.96.0.10:53'), h('small', {}, 'Answers from the Services and pods it watches through the API server; forwards everything else upstream.'));
  const attempts = h('ol', { class: 'ia-attempts' });
  const term = mkTerm({ height: '130px' });
  s.stage.append(box('ia-dns-grid', pod, dnsEl, zone('Queries sent', attempts)), term);

  const renderResolv = () => {
    resolvText.textContent = `nameserver 10.96.0.10\nsearch ${SEARCH.join(' ')}\noptions ndots:${st.ndots}`;
  };
  const candidates = (name) => {
    if (name.endsWith('.')) return [name.slice(0, -1)];
    const asIs = name;
    const withSearch = SEARCH.map((d) => `${name}.${d}`);
    const dots = (name.match(/\./g) || []).length;
    return dots >= st.ndots ? [asIs, ...withSearch] : [...withSearch, asIs];
  };

  const lookup = async (name) => {
    typed(term, `nslookup ${name}`, '/ #');
    attempts.replaceChildren();
    const tries = candidates(name);
    const dots = (name.match(/\./g) || []).length;
    s.say(name.endsWith('.')
      ? 'A trailing dot means “this is already a full name” — the search list is skipped.'
      : `<code>${escapeHtml(name)}</code> has <b>${dots}</b> dot${dots === 1 ? '' : 's'}; ndots is <b>${st.ndots}</b>, so the ${dots >= st.ndots ? 'name is tried <b>as-is first</b>' : '<b>search list is tried first</b>'}.`);
    for (const fqdn of tries) {
      const row = h('li', {}, h('code', {}, `${fqdn}.`), h('span', { class: 'ia-dim' }, ' …'));
      attempts.append(row);
      await fly(s.stage, pod, dnsEl, { label: 'A?', ms: 500 });
      ping(dnsEl);
      const record = RECORDS[fqdn];
      await fly(s.stage, dnsEl, pod, { label: record ? record.ips[0] : 'NXDOMAIN', cls: record ? 'ok' : 'bad', ms: 500 });
      row.lastChild.replaceWith(h('span', { class: record ? 'ia-ok' : 'ia-bad' }, record ? ` → ${record.ips.join(', ')}` : ' → NXDOMAIN'));
      if (!record) continue;
      print(term, 'Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n');
      record.ips.forEach((ip) => print(term, `Name:\t${fqdn}\nAddress: ${ip}`));
      s.say(`Found after <b>${attempts.children.length}</b> quer${attempts.children.length === 1 ? 'y' : 'ies'}: ${record.note}.`);
      return;
    }
    print(term, `** server can't find ${name}: NXDOMAIN`, 'bad');
    s.say(`No candidate exists. If it is a Service in another namespace, use <code>${escapeHtml(name)}.&lt;namespace&gt;</code>.`);
  };

  const NAME = /^(?:kubectl exec (?:-it )?\S+ -- )?nslookup ([a-z0-9.-]+\.?)$/;
  s.btn('nslookup web', (_, m) => lookup(m?.[1] ?? 'web'), { primary: true, cmd: NAME, example: 'nslookup web' });
  s.btn('nslookup api', () => lookup('api'));
  s.btn('nslookup api.payments', () => lookup('api.payments'));
  s.btn('nslookup db', () => lookup('db'));
  s.btn('nslookup db-0.db', () => lookup('db-0.db'));
  s.btn('nslookup google.com', () => lookup('google.com'));
  s.sep();
  const ndotsBtn = s.btn('options ndots:5 → 1', () => {
    st.ndots = st.ndots === 5 ? 1 : 5;
    ndotsBtn.textContent = `options ndots:${st.ndots} → ${st.ndots === 5 ? 1 : 5}`;
    renderResolv();
    s.say(st.ndots === 1
      ? 'With <b>ndots:1</b>, any name with a dot is tried as-is first: <code>google.com</code> resolves in one query — but <code>api.payments</code> now wastes one query too. Pods can set this with <code>dnsConfig.options</code>.'
      : 'Back to the default <b>ndots:5</b>: short names are cheap, external names cost extra queries.');
  });
  s.command(/^cat \/etc\/resolv\.conf$/, () => { typed(term, 'cat /etc/resolv.conf', '/ #'); print(term, resolvText.textContent); }, { example: 'cat /etc/resolv.conf' });
  s.btn('↺ Reset', () => { st = { ndots: 5 }; ndotsBtn.textContent = 'options ndots:5 → 1'; attempts.replaceChildren(); term.replaceChildren(); renderResolv(); s.say('Fresh pod, default DNS settings.'); });
  renderResolv();
  print(term, '# kubectl run tmp --rm -it --image=busybox:1.36 -n shop -- sh', 'dim');
};

// =====================================================================
// Ingress & Gateway API: host/path routing, TLS, weighted canary
// =====================================================================
A.ingressRouting = (root) => {
  const s = scene(root, {
    title: 'One entry point, many Services',
    hint: 'Send requests and watch the controller read the <b>host</b> and <b>path</b>. Then add TLS, and switch to the Gateway API for a weighted canary.',
  });
  const HOST = 'shop.example.com';
  let st = { mode: 'ingress', tls: false, canaryWeight: 10, tally: { web: 0, 'web-canary': 0 } };

  const browser = box('ia-hop ia-source', h('b', {}, '🌍 browser'), h('small', {}, 'DNS: shop.example.com → 203.0.113.20'));
  const controller = box('ia-hop ia-ctrl', h('b', {}, '🚦 ingress controller'), h('small', {}, 'Service type LoadBalancer · 203.0.113.20'));
  const rulesEl = h('pre', { class: 'ia-rules' });
  const backends = {
    web: box('ia-backend', h('b', {}, '🔀 svc web'), h('small', {}, 'v1 · 2 pods')),
    api: box('ia-backend', h('b', {}, '🔀 svc api'), h('small', {}, '2 pods')),
    'web-canary': box('ia-backend ia-canary', h('b', {}, '🔀 svc web-canary'), h('small', {}, 'v2 · 1 pod')),
  };
  const tallyEl = h('div', { class: 'ia-tally' });
  const term = mkTerm({ height: '130px' });
  s.stage.append(box('ia-ing-grid', browser, box('ia-ing-mid', controller, rulesEl), box('ia-ing-backends', ...Object.values(backends), tallyEl)), term);

  const renderRules = () => {
    backends['web-canary'].style.opacity = st.mode === 'gateway' ? '1' : '0.35';
    tallyEl.textContent = st.mode === 'gateway' ? `last batch → web: ${st.tally.web} · web-canary: ${st.tally['web-canary']}` : '';
    if (st.mode === 'ingress') {
      rulesEl.textContent = `Ingress shop  (ingressClassName: nginx)\n${st.tls ? 'tls: shop.example.com → secret shop-tls\n' : ''}host shop.example.com\n  /api  Prefix → api:8080\n  /     Prefix → web:80`;
      return;
    }
    rulesEl.textContent = `HTTPRoute web  (parentRef: Gateway public)\nhostnames: [shop.example.com]\n  /api → api:8080\n  /    → web:80         weight ${100 - st.canaryWeight}\n         web-canary:80  weight ${st.canaryWeight}`;
  };

  // Prefix matching is per path segment: /api matches /api and /api/x but not /apis.
  const matchesApi = (path) => path === '/api' || path.startsWith('/api/');
  const pickWeb = () => (st.mode === 'gateway' && Math.random() * 100 < st.canaryWeight ? 'web-canary' : 'web');
  const route = (scheme, host, path) => {
    if (host !== HOST) return { status: 404, note: `no rule for host <b>${escapeHtml(host)}</b> — the controller’s default backend answers 404.` };
    if (scheme === 'https' && !st.tls) return { tlsError: true };
    if (matchesApi(path)) return { status: 200, backend: 'api', note: `<code>${escapeHtml(path)}</code> matches the <b>/api</b> Prefix rule (longest match wins).` };
    return { status: 200, backend: pickWeb(), note: path.startsWith('/api') ? `<code>${escapeHtml(path)}</code> does <b>not</b> match <code>/api</code> with Prefix — segments must match exactly — so <b>/</b> wins.` : '<code>/</code> catches everything else.' };
  };

  const request = async (url, { quiet = false } = {}) => {
    const [, scheme, host, rawPath] = url.match(/^(https?):\/\/([^/]+)(\/\S*)?$/);
    const path = rawPath || '/';
    if (!quiet) typed(term, `curl ${url}`);
    await fly(s.stage, browser, controller, { label: quiet ? '' : `${scheme === 'https' ? '🔒 ' : ''}Host: ${host}`, ms: quiet ? 380 : 650 });
    ping(controller);
    const result = route(scheme, host, path);
    if (result.tlsError) {
      await fly(s.stage, controller, browser, { label: 'fake cert', cls: 'bad', ms: 600 });
      print(term, 'curl: (60) SSL certificate problem: self-signed certificate', 'bad');
      return s.say('No TLS section for this host yet, so ingress-nginx presents its built-in <b>“Kubernetes Ingress Controller Fake Certificate”</b>. Add a TLS Secret.');
    }
    if (!result.backend) {
      await fly(s.stage, controller, browser, { label: '404', cls: 'bad', ms: 600 });
      print(term, '<html><head><title>404 Not Found</title></head>…', 'bad');
      return s.say(result.note);
    }
    await fly(s.stage, controller, backends[result.backend], { label: quiet ? '' : path, ms: quiet ? 380 : 600 });
    flash(backends[result.backend]);
    if (st.tally[result.backend] !== undefined) st.tally[result.backend]++;
    if (quiet) return;
    print(term, `HTTP/1.1 200 OK   ← ${result.backend}${scheme === 'https' ? '  (TLS terminated at the controller)' : ''}`, 'ok');
    s.say(result.note);
  };

  const URL = /^curl (?:-\S+ )*(https?:\/\/[a-z0-9.-]+(?:\/\S*)?)$/;
  s.btn(`curl http://${HOST}/`, (_, m) => request(m?.[1] ?? `http://${HOST}/`), { primary: true, cmd: URL, example: `curl http://${HOST}/api/orders` });
  s.btn(`curl http://${HOST}/api/orders`, () => request(`http://${HOST}/api/orders`));
  s.btn(`curl http://${HOST}/apis`, () => request(`http://${HOST}/apis`));
  s.btn('curl http://blog.example.com/', () => request('http://blog.example.com/'));
  s.btn(`curl https://${HOST}/`, () => request(`https://${HOST}/`));
  s.sep();
  s.btn('kubectl create secret tls shop-tls --cert=shop.crt --key=shop.key', async () => {
    typed(term, 'kubectl create secret tls shop-tls --cert=shop.crt --key=shop.key -n shop');
    print(term, 'secret/shop-tls created');
    st.tls = true;
    renderRules();
    flash(rulesEl);
    s.say('The Ingress’s <code>tls</code> section names <b>shop-tls</b>; the controller loads it and serves the real certificate for shop.example.com. TLS ends at the controller — traffic to the pods is plain HTTP unless you add more.');
  }, { cmd: /^kubectl create secret tls shop-tls .*$/, enabled: () => !st.tls, why: 'The TLS secret already exists.' });
  const modeBtn = s.btn('Switch to Gateway API', () => {
    st.mode = st.mode === 'ingress' ? 'gateway' : 'ingress';
    modeBtn.textContent = st.mode === 'ingress' ? 'Switch to Gateway API' : 'Switch back to Ingress';
    controller.firstChild.textContent = st.mode === 'ingress' ? '🚦 ingress controller' : '🚦 Gateway “public”';
    renderRules();
    s.say(st.mode === 'gateway'
      ? 'Same entry point, richer rules: the app team’s <b>HTTPRoute</b> attaches to the platform team’s <b>Gateway</b> and splits traffic by <b>weight</b>. Move the slider, then send a batch.'
      : 'Back to the classic Ingress rules.');
  });
  const weight = h('input', { type: 'range', min: 0, max: 100, step: 10, value: st.canaryWeight, 'aria-label': 'Canary weight' });
  const weightVal = h('b', {}, `${st.canaryWeight}%`);
  weight.addEventListener('input', () => { st.canaryWeight = Number(weight.value); weightVal.textContent = `${st.canaryWeight}%`; renderRules(); });
  s.add(h('label', { class: 'inline' }, 'canary weight', weight, weightVal));
  s.btn('Send 20 requests', async () => {
    st.tally = { web: 0, 'web-canary': 0 };
    typed(term, `for i in $(seq 20); do curl -s http://${HOST}/; done`);
    await Promise.all(Array.from({ length: 20 }, (_, i) => wait(i * 120).then(() => request(`http://${HOST}/`, { quiet: true }))));
    renderRules();
    print(term, `web: ${st.tally.web}   web-canary: ${st.tally['web-canary']}`, 'ok');
    s.say(`Roughly <b>${100 - st.canaryWeight}/${st.canaryWeight}</b>. Weights are per request, independent of how many pods each version has.`);
  }, { enabled: () => st.mode === 'gateway', why: 'Weighted routing is a Gateway API feature. Switch to the Gateway API first.' });
  s.btn('↺ Reset', () => {
    st = { mode: 'ingress', tls: false, canaryWeight: 10, tally: { web: 0, 'web-canary': 0 } };
    weight.value = 10; weightVal.textContent = '10%';
    modeBtn.textContent = 'Switch to Gateway API';
    controller.firstChild.textContent = '🚦 ingress controller';
    term.replaceChildren();
    renderRules();
    s.say('Plain Ingress, no TLS yet.');
  });
  renderRules();
};

// =====================================================================
// ConfigMaps: env vars freeze, mounted files follow, subPath doesn't
// =====================================================================
A.configmapFlow = (root) => {
  const s = scene(root, {
    title: 'One ConfigMap, three ways to read it',
    hint: 'Edit the ConfigMap and watch which copies update by themselves. Then fix the stale ones.',
  });
  const LEVELS = ['debug', 'warn', 'info'];
  let st = { value: 'info', nextLevel: 0, pods: [] };

  const cmText = h('pre', { class: 'ia-cm' });
  const cmCard = box('ia-cm-card', title('🗂 ConfigMap app-config', 'v1'), cmText);
  const syncBar = h('div', { class: 'bar' }, h('i'));
  const syncLabel = h('small', {}, 'kubelet sync: idle');
  const podsEl = h('div', { class: 'ia-cm-pods' });
  const term = mkTerm({ height: '120px' });
  s.stage.append(box('ia-cm-grid', box('ia-cm-left', cmCard, box('ia-sync', syncLabel, syncBar)), podsEl), term);

  const renderCm = () => { cmText.textContent = `data:\n  LOG_LEVEL: "${st.value}"`; };
  const row = (label, value) => h('div', { class: `ia-cm-row ${value === st.value ? 'ia-fresh' : 'ia-stale'}` }, h('span', {}, label), h('code', {}, value));
  const renderPods = () => {
    podsEl.replaceChildren(...st.pods.map((p) => box(`ia-cm-pod ${p.restarting ? 'ia-restarting' : ''}`,
      h('div', { class: 'ia-cm-pod-head' }, h('b', {}, p.name), h('small', {}, p.owner === 'web' ? 'Deployment web' : 'Deployment worker · subPath')),
      row('env LOG_LEVEL', p.env),
      p.owner === 'web' ? row('file /etc/app/LOG_LEVEL', p.file) : row('subPath /etc/app/LOG_LEVEL', p.file))));
  };
  const newPod = (owner) => ({ name: `${owner}-${owner === 'web' ? '6f8d9b7c4' : '58c7d4f9b'}-${shortHash()}`, owner, env: st.value, file: st.value, restarting: false });

  const edit = async (value) => {
    const next = value ?? LEVELS[st.nextLevel++ % LEVELS.length];
    typed(term, value ? `kubectl patch configmap app-config -p '{"data":{"LOG_LEVEL":"${next}"}}'` : 'kubectl edit configmap app-config');
    print(term, `configmap/app-config ${value ? 'patched' : 'edited'}`);
    st.value = next;
    renderCm();
    flash(cmCard);
    renderPods();
    s.say(`The ConfigMap now says <b>${next}</b>. Nothing in the pods has changed yet: env vars were copied at start, and the kubelet only refreshes mounted files on its next sync.`);
    syncLabel.textContent = 'kubelet sync: waiting (up to ~1 min in real clusters)…';
    syncBar.firstChild.style.transition = 'none';
    syncBar.firstChild.style.width = '0%';
    void syncBar.offsetWidth;
    syncBar.firstChild.style.transition = 'width 2.2s linear';
    syncBar.firstChild.style.width = '100%';
    await wait(2200);
    st.pods.filter((p) => p.owner === 'web').forEach((p) => { p.file = st.value; });
    syncLabel.textContent = 'kubelet sync: files updated (atomic symlink swap)';
    renderPods();
    s.say('Mounted files on the <b>web</b> pods are updated. The <b>env vars</b> are still stale everywhere, and the <b>subPath</b> file in <b>worker</b> never follows updates. A restart fixes both.');
  };

  const restart = async (owner) => {
    typed(term, `kubectl rollout restart deployment/${owner}`);
    print(term, `deployment.apps/${owner} restarted`);
    for (const pod of st.pods.filter((p) => p.owner === owner)) {
      pod.restarting = true;
      renderPods();
      await wait(600);
      Object.assign(pod, newPod(owner));
      renderPods();
    }
    s.say(`New <b>${owner}</b> pods read the ConfigMap at start: env and files are current. <code>rollout restart</code> stamps a <code>restartedAt</code> annotation into the pod template, which triggers a normal rolling update.`);
  };

  const exec = (kind) => {
    const pod = st.pods.find((p) => p.owner === 'web');
    typed(term, kind === 'env' ? 'kubectl exec deploy/web -- printenv LOG_LEVEL' : 'kubectl exec deploy/web -- cat /etc/app/LOG_LEVEL');
    print(term, kind === 'env' ? pod.env : pod.file, (kind === 'env' ? pod.env : pod.file) === st.value ? 'ok' : 'y');
  };

  s.btn('kubectl edit configmap app-config', (_, m) => edit(m?.[1]), {
    primary: true,
    cmd: [/^kubectl edit (?:cm|configmaps?) app-config$/, /^kubectl patch (?:cm|configmaps?) app-config .*log_level"?\s*:\s*"?(\w+)/],
    example: 'kubectl edit configmap app-config',
  });
  s.btn('kubectl exec deploy/web -- printenv LOG_LEVEL', () => exec('env'), { cmd: /^kubectl exec (?:-it )?(?:deploy\/web|web-\S+) -- (?:printenv log_level|env)$/ });
  s.btn('kubectl exec deploy/web -- cat /etc/app/LOG_LEVEL', () => exec('file'), { cmd: /^kubectl exec (?:-it )?(?:deploy\/web|web-\S+) -- cat \/etc\/app\/log_level$/ });
  s.sep();
  s.btn('kubectl rollout restart deployment/web', () => restart('web'), { cmd: /^kubectl rollout restart (?:deployment|deploy)[/ ]web$/ });
  s.btn('kubectl rollout restart deployment/worker', () => restart('worker'), { cmd: /^kubectl rollout restart (?:deployment|deploy)[/ ]worker$/ });
  s.btn('↺ Reset', () => {
    st = { value: 'info', nextLevel: 0, pods: [] };
    st.pods = [newPod('web'), newPod('web'), newPod('worker')];
    syncBar.firstChild.style.width = '0%';
    syncLabel.textContent = 'kubelet sync: idle';
    term.replaceChildren();
    renderCm();
    renderPods();
    s.say('Everything reads <b>info</b>.');
  });
  st.pods = [newPod('web'), newPod('web'), newPod('worker')];
  renderCm();
  renderPods();
};

// =====================================================================
// Secrets: base64 vs encryption at rest, node scoping, RBAC
// =====================================================================
A.secretsFlow = (root) => {
  const s = scene(root, {
    title: 'Where a Secret travels — and who can read it',
    hint: 'Create the secret, look at what etcd stores, mount it into one pod, then try reading it as a user without permission.',
  });
  const PASSWORD = 'S3cr3t!';
  const ENCODED = 'UzNjcjN0IQ==';
  let st = { created: false, encryptionOn: false, storedEncrypted: false, mounted: false };

  const you = box('ia-user', h('b', {}, '👩‍💻 you'), h('small', {}, 'role: admin'));
  const intern = box('ia-user ia-intern', h('b', {}, '🧑‍🎓 intern'), h('small', {}, 'role: view (no secrets)'));
  const apiServer = box('ia-hop ia-svc', h('b', {}, '🚪 kube-apiserver'), h('small', {}, 'authn → RBAC → admission'));
  const etcdText = h('pre', { class: 'ia-etcd' });
  const etcd = box('ia-etcd-box', title('🗄 etcd', '/registry/secrets/shop/'), etcdText);
  const nodes = { 'node-1': nodeBox('node-1'), 'node-2': nodeBox('node-2') };
  const apiPod = podEl('api-5c8f7d9b6-q2x7m', { status: 'ready', image: 'shop/api:3.1' });
  const webPod = podEl('web-7d4b9c8f6-k2x4p', { status: 'ready', image: 'nginx:1.27' });
  const tmpfs = h('div', { class: 'ia-tmpfs' });
  const term = mkTerm({ height: '130px' });
  nodes['node-1'].pods.append(apiPod, tmpfs);
  nodes['node-2'].pods.append(webPod);
  s.stage.append(
    box('ia-sec-top', box('ia-users', you, intern), apiServer, etcd),
    box('k-nodes', nodes['node-1'].el, nodes['node-2'].el),
    term,
  );

  const storedValue = () => (st.storedEncrypted
    ? 'k8s:enc:kms:v2:cloud-kms:\n\\x0a\\x8f\\x1a\\xd3…(ciphertext)'
    : `{"kind":"Secret","data":{"password":"${ENCODED}"}…}`);
  const renderEtcd = () => {
    etcdText.textContent = st.created ? `db-secret →\n${storedValue()}` : '(empty)';
    etcd.classList.toggle('ia-encrypted', st.created && st.storedEncrypted);
    tmpfs.replaceChildren(...(st.mounted ? [h('span', { class: 'chip warn pop' }, '🔐 tmpfs: /var/run/secrets/db/password')] : []));
  };

  const create = async () => {
    typed(term, `kubectl create secret generic db-secret --from-literal=password=${PASSWORD}`);
    await fly(s.stage, you, apiServer, { label: 'POST secret', ms: 650 });
    ping(apiServer);
    await fly(s.stage, apiServer, etcd, { label: st.encryptionOn ? 'encrypt + write' : 'write', ms: 650 });
    st.created = true;
    st.storedEncrypted = st.encryptionOn;
    renderEtcd();
    print(term, 'secret/db-secret created');
    s.say(st.storedEncrypted
      ? 'Encryption at rest is on: the API server encrypted the Secret with a key from your KMS <b>before</b> writing it. A stolen etcd backup is useless.'
      : 'Look at etcd: the password is only <b>base64</b>. Anyone with a copy of etcd or its backups can read every Secret.');
  };

  const decode = () => {
    typed(term, `echo ${ENCODED} | base64 -d`);
    print(term, PASSWORD, 'y');
    s.say('Base64 is <b>encoding</b>, not encryption — no key needed.');
  };

  const toggleEncryption = () => {
    st.encryptionOn = !st.encryptionOn;
    encBtn.textContent = `Encryption at rest: ${st.encryptionOn ? 'ON' : 'OFF'}`;
    s.say(st.encryptionOn
      ? 'The API server now has an <b>EncryptionConfiguration</b> with a KMS v2 provider. New writes are encrypted — but existing Secrets stay as they are until they are rewritten.'
      : 'Encryption at rest is off (the default on self-managed clusters).');
  };

  const rewriteAll = async () => {
    typed(term, 'kubectl get secrets -A -o json | kubectl replace -f -');
    await fly(s.stage, apiServer, etcd, { label: 're-encrypt', ms: 650 });
    st.storedEncrypted = true;
    renderEtcd();
    print(term, 'secret/db-secret replaced');
    s.say('Rewriting every Secret makes the API server store it again — this time encrypted.');
  };

  const mount = async () => {
    typed(term, 'kubectl apply -f api-deployment.yaml   # volumes: secret: db-secret');
    await fly(s.stage, apiServer, nodes['node-1'].el, { label: 'db-secret', ms: 700 });
    st.mounted = true;
    renderEtcd();
    flash(apiPod);
    print(term, 'deployment.apps/api configured');
    s.say('Only the kubelet on <b>node-1</b> receives the Secret, because only it runs a pod that references it (the <b>Node authorizer</b> enforces this). It is written to <b>tmpfs</b> — RAM, never the node’s disk. <b>node-2</b> never sees it.');
  };

  const readInPod = () => {
    typed(term, 'kubectl exec deploy/api -- cat /var/run/secrets/db/password');
    print(term, PASSWORD, 'y');
    s.say('The app reads a normal file. No Kubernetes API calls, no base64.');
  };

  const internGet = async () => {
    typed(term, 'kubectl get secret db-secret --as=intern');
    await fly(s.stage, intern, apiServer, { label: 'GET secret', ms: 600 });
    ping(apiServer);
    await fly(s.stage, apiServer, intern, { label: '403', cls: 'bad', ms: 600 });
    print(term, 'Error from server (Forbidden): secrets "db-secret" is forbidden: User "intern" cannot get resource "secrets" in API group "" in the namespace "shop"', 'bad');
    s.say('<b>RBAC</b> stops the request before it reaches etcd. This is the control that matters most day to day.');
  };

  const canI = () => {
    typed(term, 'kubectl auth can-i get secrets --as=intern -n shop');
    print(term, 'no', 'bad');
  };

  s.btn(`kubectl create secret generic db-secret --from-literal=password=${PASSWORD}`, create, {
    primary: true,
    cmd: /^kubectl create secret generic db-secret .*$/,
    enabled: () => !st.created,
    why: 'db-secret already exists. Reset to start over.',
  });
  s.btn('kubectl get secret db-secret -o yaml', () => {
    typed(term, 'kubectl get secret db-secret -o yaml');
    print(term, `apiVersion: v1\ndata:\n  password: ${ENCODED}\nkind: Secret\nmetadata:\n  name: db-secret\n  namespace: shop\ntype: Opaque`);
    s.say('The API returns base64 — whether or not etcd encrypts it. Encryption at rest protects the <b>storage</b>, not API readers.');
  }, { cmd: /^kubectl get secrets? db-secret(?: -o (?:yaml|json))?$/, enabled: () => st.created, why: 'Create the secret first.' });
  s.command(/^echo \S+ \| base64 (?:-d|--decode)$/, decode, { example: `echo ${ENCODED} | base64 -d`, enabled: () => st.created, why: 'Create the secret first.' });
  s.btn('etcdctl get /registry/secrets/shop/db-secret', () => {
    typed(term, 'etcdctl get /registry/secrets/shop/db-secret');
    print(term, st.created ? storedValue() : '', st.storedEncrypted ? 'ok' : 'y');
  }, { enabled: () => st.created, why: 'Create the secret first.' });
  s.sep();
  const encBtn = s.btn('Encryption at rest: OFF', toggleEncryption);
  s.btn('kubectl get secrets -A -o json | kubectl replace -f -', rewriteAll, {
    enabled: () => st.encryptionOn && st.created && !st.storedEncrypted,
    why: 'Turn encryption at rest on first — and have a Secret stored unencrypted.',
  });
  s.sep();
  s.btn('kubectl apply -f api-deployment.yaml', mount, { cmd: /^kubectl apply -f (?:api-)?deployment\.yaml$/, enabled: () => st.created && !st.mounted, why: 'Create the secret first (or it is already mounted).' });
  s.btn('kubectl exec deploy/api -- cat /var/run/secrets/db/password', readInPod, {
    cmd: /^kubectl exec (?:-it )?(?:deploy\/api|api-\S+) -- cat \/var\/run\/secrets\/db\/password$/,
    enabled: () => st.mounted,
    why: 'Mount the secret into the api pod first.',
  });
  s.btn('kubectl get secret db-secret --as=intern', internGet, { cmd: /^kubectl get secrets? db-secret .*--as[= ]intern.*$/, enabled: () => st.created, why: 'Create the secret first.' });
  s.command(/^kubectl auth can-i get secrets .*--as[= ]intern.*$/, canI, { example: 'kubectl auth can-i get secrets --as=intern -n shop' });
  s.btn('↺ Reset', () => {
    st = { created: false, encryptionOn: false, storedEncrypted: false, mounted: false };
    encBtn.textContent = 'Encryption at rest: OFF';
    term.replaceChildren();
    renderEtcd();
    s.say('No secret yet.');
  });
  renderEtcd();
};

// =====================================================================
// Pod networking: one IP per pod, routes between nodes, new IPs on replacement
// =====================================================================
A.netPodToPod = (root) => {
  const s = scene(root, {
    title: 'Pod to pod across nodes',
    hint: 'Send a packet on the same node, then across nodes. Then delete a pod and watch its replacement get a <b>new IP</b>.',
  });
  const NODES = {
    'node-1': { ip: '172.18.0.3', cidr: '10.244.1.0/24', octet: 1 },
    'node-2': { ip: '172.18.0.4', cidr: '10.244.2.0/24', octet: 2 },
  };
  const START = [['web', 'node-1', 5], ['api', 'node-1', 6], ['cache', 'node-2', 7], ['db', 'node-2', 8]];
  let st = { pods: [], next: { 'node-1': 9, 'node-2': 9 }, overlay: true, busyPacket: false };

  const nodes = Object.fromEntries(Object.entries(NODES).map(([name, n]) => [name, nodeBox(name, { capacity: `node IP ${n.ip} · podCIDR ${n.cidr}` })]));
  const routes = Object.fromEntries(Object.entries(NODES).map(([name]) => {
    const other = Object.entries(NODES).find(([o]) => o !== name)[1];
    return [name, h('small', { class: 'ia-route' }, `route: ${other.cidr} → ${other.ip}`)];
  }));
  Object.entries(nodes).forEach(([name, n]) => n.el.insertBefore(routes[name], n.pods));
  const wire = box('ia-wire', h('b', {}, '🔌 machine network'), h('small', {}, '172.18.0.0/16 — only knows node IPs'));
  const modeSel = h('select', { 'aria-label': 'how packets cross nodes', onchange: () => { st.overlay = modeSel.value === 'overlay'; renderMode(); } },
    h('option', { value: 'overlay', selected: true }, 'overlay (VXLAN)'), h('option', { value: 'native' }, 'native routing'));
  const term = mkTerm({ height: '150px' });
  s.stage.append(box('ia-net', nodes['node-1'].el, wire, nodes['node-2'].el), term);
  s.add(h('label', { class: 'inline' }, 'Crossing nodes:', modeSel));
  s.sep();

  const live = () => st.pods.filter((p) => !p.gone);
  const byName = (name) => live().find((p) => p.name === name || p.app === name);
  const renderMode = () => wire.querySelector('small').replaceChildren(st.overlay ? 'overlay: pod packets travel wrapped in node-to-node packets' : 'native routing: the network knows each podCIDR');

  const addPod = (app, node, last, status = 'ready') => {
    const ip = `10.244.${NODES[node].octet}.${last}`;
    const name = `${app}-${shortHash()}`;
    const el = podEl(name, { status, ip, labels: { app } });
    const pod = { app, name, node, ip, el, gone: false };
    st.pods.push(pod);
    nodes[node].pods.append(el);
    return pod;
  };
  const reset = () => {
    Object.values(nodes).forEach((n) => n.pods.replaceChildren());
    st = { pods: [], next: { 'node-1': 9, 'node-2': 9 }, overlay: modeSel.value === 'overlay', busyPacket: false };
    START.forEach(([app, node, last]) => addPod(app, node, last));
    renderMode();
    term.replaceChildren();
    out(term, '<span class="dim"># every pod has its own IP from its node’s podCIDR</span>');
  };

  const send = async (fromApp, toApp) => {
    const a = byName(fromApp), b = byName(toApp);
    if (!a || !b) return s.say('One of those pods is gone. Press ↺ Reset.');
    typed(term, `kubectl exec ${a.name} -- wget -qO- http://${b.ip}:8080`);
    if (a.node === b.node) {
      s.say(`<b>Same node.</b> The packet leaves <code>${a.ip}</code> through its virtual cable (veth) and the node hands it straight to <code>${b.ip}</code>. No routing between machines needed.`);
      await fly(s.stage, a.el, nodes[a.node].el.querySelector('.k-node-head'), { label: `${a.ip} → ${b.ip}`, ms: 700 });
      await fly(s.stage, nodes[a.node].el.querySelector('.k-node-head'), b.el, { label: `${a.ip} → ${b.ip}`, ms: 700 });
    } else {
      const route = routes[a.node];
      s.say(`<b>Different nodes.</b> ${a.node} checks its routes: <code>${NODES[b.node].cidr}</code> lives on ${b.node} (<code>${NODES[b.node].ip}</code>).`);
      await fly(s.stage, a.el, route, { label: `${a.ip} → ${b.ip}`, ms: 700 });
      ping(route);
      const onWire = st.overlay ? `[${NODES[a.node].ip} → ${NODES[b.node].ip}] ⟨${a.ip} → ${b.ip}⟩` : `${a.ip} → ${b.ip}`;
      s.say(st.overlay
        ? 'Overlay: the pod packet is <b>wrapped</b> inside a packet from node to node, because the machine network only knows node IPs. node-2 unwraps it.'
        : 'Native routing: the packet keeps its pod addresses. The network (or cloud route table) knows which node owns each podCIDR.');
      await fly(s.stage, route, wire, { label: onWire, ms: 900 });
      ping(wire);
      await fly(s.stage, wire, nodes[b.node].el.querySelector('.k-node-head'), { label: onWire, ms: 900 });
      await fly(s.stage, nodes[b.node].el.querySelector('.k-node-head'), b.el, { label: `${a.ip} → ${b.ip}`, ms: 700 });
    }
    ping(b.el);
    out(term, `<span class="ok">hello from ${escapeHtml(b.name)}</span>`);
    s.say(`<b>${b.app}</b> sees the sender as <code>${a.ip}</code> — the real pod IP. Kubernetes forbids NAT between pods.`);
  };

  const getWide = () => {
    typed(term, 'kubectl get pods -o wide');
    out(term, `<span class="dim">${columns([['NAME', 'READY', 'STATUS', 'IP', 'NODE'], ...live().map((p) => [p.name, '1/1', 'Running', p.ip, p.node])])}</span>`);
    s.say('Pods on the same node share the first three numbers of their IP: their node’s podCIDR.');
  };
  const getNodes = () => {
    typed(term, 'kubectl get nodes -o wide');
    out(term, `<span class="dim">${columns([['NAME', 'STATUS', 'INTERNAL-IP'], ...Object.entries(NODES).map(([n, x]) => [n, 'Ready', x.ip])])}</span>`);
    s.say('Node IPs (<code>172.18…</code>) and pod IPs (<code>10.244…</code>) are separate networks.');
  };

  const replace = async (pod) => {
    if (!pod) return;
    typed(term, `kubectl delete pod ${pod.name}`);
    pod.gone = true;
    pod.el.setStatus('terminating');
    out(term, `pod "${escapeHtml(pod.name)}" deleted`);
    s.say(`<code>${pod.name}</code> (${pod.ip}) is going away. Its Deployment will create a replacement…`);
    await wait(700);
    pod.el.vanish();
    const node = Object.keys(NODES).sort((x, y) => live().filter((p) => p.node === x).length - live().filter((p) => p.node === y).length)[0];
    const fresh = addPod(pod.app, node, st.next[node]++, 'creating');
    await wait(800);
    fresh.el.setStatus('ready');
    flash(fresh.el);
    s.say(`The replacement <code>${fresh.name}</code> got a <b>new IP: ${fresh.ip}</b> (it was ${pod.ip}). Anything that remembered the old IP is now broken — that is why we use <b>Services</b>.`);
  };
  const victim = () => live().find((p) => p.app === 'db') || live()[0];

  s.btn('📦 Same node: web → api', () => send('web', 'api'), { primary: true });
  s.btn('🌐 Across nodes: web → db', () => send('web', 'db'), { primary: true });
  s.sep();
  s.btn('kubectl get pods -o wide', getWide, { cmd: /^kubectl get (?:po|pods?)(?: -o wide)?$/, example: 'kubectl get pods -o wide' });
  s.btn('kubectl get nodes -o wide', getNodes, { cmd: /^kubectl get (?:no|nodes?)(?: -o wide)?$/, example: 'kubectl get nodes -o wide' });
  const deleteTyped = async (m) => {
    const pod = live().find((p) => p.name === m[1] || p.app === m[1]);
    if (pod) return replace(pod);
    typed(term, m.input);
    out(term, `<span class="bad">Error from server (NotFound): pods "${escapeHtml(m[1])}" not found</span>`);
    s.say('Copy a real pod name from <code>kubectl get pods -o wide</code>.');
  };
  s.btn('kubectl delete pod …', (_, m) => (m ? deleteTyped(m) : replace(victim())), {
    cmd: /^kubectl delete (?:po|pods?) (\S+)$/,
    example: () => `kubectl delete pod ${victim()?.name}`,
    enabled: () => live().length > 0,
    why: 'There are no pods left. Press ↺ Reset.',
  });
  s.sep();
  s.btn('↺ Reset', reset);
  reset();
};
