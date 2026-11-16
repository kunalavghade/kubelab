// Kubernetes playground: a big terminal on a simulated 4-node cluster, a live picture of the
// cluster and challenges. The cluster itself lives in sim/; this file is only the page.
import { h, store, toast } from './dom.js';
import { createTerminal } from './terminal.js';
import { createStateView } from './stateview.js';

const userNs = (ns) => !['kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx', 'local-path-storage'].includes(ns);
const CHALLENGES = [
  { id: 'nodes', text: 'List the nodes of the cluster', hint: 'kubectl get nodes', check: (s) => s.used.has('get') },
  { id: 'deploy', text: 'Create a Deployment', hint: 'kubectl apply -f deployment.yaml', check: (s) => s.deployments.some((d) => userNs(d.ns)) },
  { id: 'ready', text: 'Get 3 replicas of one Deployment ready', hint: 'kubectl get deploy -w', check: (s) => s.deployments.some((d) => userNs(d.ns) && d.ready >= 3) },
  { id: 'svc', text: 'Put a Service in front of it (with endpoints)', hint: 'kubectl expose deployment web --port=80', check: (s) => s.services.some((x) => !x.system && x.endpoints > 0) },
  { id: 'outside', text: 'Reach the app from your laptop', hint: 'kubectl port-forward svc/web 8080:80, then curl localhost:8080', check: (s) => s.used.has('port-forward') || s.services.some((x) => !x.system && x.type !== 'ClusterIP') },
  { id: 'scale', text: 'Scale a Deployment to 5 replicas', hint: 'kubectl scale deployment web --replicas=5', check: (s) => s.deployments.some((d) => userNs(d.ns) && d.replicas >= 5) },
  { id: 'rollout', text: 'Roll out a new image and watch it', hint: 'kubectl set image deployment/web nginx=nginx:1.26', check: (s) => s.used.has('rollout') && s.used.has('set') },
  { id: 'logs', text: 'Read a pod\'s logs', hint: 'kubectl logs deploy/web', check: (s) => s.used.has('logs') },
  { id: 'shell', text: 'Open a shell inside a pod', hint: 'kubectl exec -it deploy/web -- sh', check: (s) => s.inShell || s.used.has('exec') },
  { id: 'config', text: 'Create a ConfigMap and a Secret', hint: 'kubectl apply -f configmap.yaml -f secret.yaml', check: (s) => s.configmaps.some((c) => userNs(c.ns)) && s.secrets.some((x) => userNs(x.ns)) },
  { id: 'pvc', text: 'Get a PersistentVolumeClaim bound', hint: 'kubectl apply -f statefulset.yaml', check: (s) => s.pvcs.some((p) => p.phase === 'Bound') },
  { id: 'job', text: 'Run a Job to completion', hint: 'kubectl apply -f job.yaml', check: (s) => s.jobs.some((j) => j.done) },
  { id: 'heal', text: 'Watch self-healing: take a node down', hint: 'sim node down node-2', check: (s) => s.nodes.some((n) => !n.ready) },
  { id: 'drain', text: 'Cordon or drain a node for maintenance', hint: 'kubectl drain node-1 --ignore-daemonsets', check: (s) => s.nodes.some((n) => n.cordoned) },
  { id: 'hpa', text: 'Autoscale a Deployment', hint: 'kubectl apply -f hpa.yaml, then sim load web', check: (s) => s.hpas.length > 0 },
  { id: 'rbac', text: 'Create a Role and check it with auth can-i', hint: 'kubectl apply -f rbac.yaml', check: (s) => s.roles.length > 0 && s.used.has('auth') },
  { id: 'helm', text: 'Install a Helm release', hint: 'helm install site charts/web', check: (s) => s.releases.length > 0 },
];
const QUICK = ['kubectl get nodes', 'kubectl apply -f deployment.yaml', 'kubectl get pods -o wide', 'kubectl expose deployment web --type=NodePort --port=80', 'kubectl get svc', 'kubectl scale deployment web --replicas=5', 'kubectl set image deployment/web nginx=nginx:1.26', 'kubectl rollout status deployment/web', 'kubectl logs deploy/web', 'kubectl exec -it deploy/web -- sh', 'sim node down node-2', 'help'];
const WELCOME = '<span class="ok">Welcome to the Kube Lab playground!</span><br><span class="dim">A simulated kind cluster: 1 control-plane + 3 worker nodes, real controllers, scheduler and DNS. Your manifests are in </span><span class="y">~/k8s</span><span class="dim"> (</span><span class="y">ls</span><span class="dim">). Type </span><span class="y">help</span><span class="dim"> for everything you can run. Each command lets 10 seconds pass.</span>';

export const renderPlayground = (view, initialCmd) => {
  const doneSaved = new Set(store.get('kl-pg-done', []));
  const chList = h('div', { class: 'challenges' });
  const chCount = h('small');
  const stateView = createStateView();

  const renderChallenges = (S) => {
    let n = 0;
    chList.replaceChildren(...CHALLENGES.map((ch) => {
      const done = doneSaved.has(ch.id) || ch.check(S);
      if (done && !doneSaved.has(ch.id)) { doneSaved.add(ch.id); store.set('kl-pg-done', [...doneSaved]); toast(`🎯 Challenge complete: ${ch.text}`); }
      if (done) n++;
      return h('div', { class: `challenge ${done ? 'done' : ''}` }, h('span', { class: 'ck' }, done ? '✓' : ''), h('div', {}, ch.text, h('br'), h('code', {}, ch.hint)));
    }));
    chCount.textContent = `${n} / ${CHALLENGES.length}`;
  };
  const onChange = (engine) => { const S = engine.state(); stateView.render(S); renderChallenges(S); };
  const term = createTerminal({ height: 560, historyKey: 'kl-pg-history', placeholder: 'type a command, e.g. kubectl apply -f deployment.yaml', welcome: WELCOME, onChange });

  view.append(h('div', { class: 'lesson', style: { maxWidth: '1300px' } },
    h('div', { class: 'lesson-head' },
      h('div', { class: 'meta' }, h('span', { class: 'badge' }, '🧪 Playground'), h('span', {}, 'A safe, simulated Kubernetes cluster — nothing runs on your computer')),
      h('h1', {}, 'Kubernetes playground'),
      h('p', { class: 'lead', html: 'Type real <code>kubectl</code> and <code>helm</code> commands on the left and watch pods get scheduled onto nodes, roll out, heal and scale on the right. Pipes, <code>$(…)</code>, <code>&amp;&amp;</code>, <code>-o jsonpath</code>, shells inside pods, port-forwards, Ingress and Helm all work. Every command is explained on the <a href="#/commands">Commands</a> page.' })),
    h('div', { class: 'pg' },
      h('div', {}, term.el, h('div', { class: 'quick-cmds' }, QUICK.map((c) => h('button', { class: 'btn btn-sm mono', onclick: () => { term.input.value = c; term.focus(); } }, c)))),
      h('div', {}, stateView.el, h('div', { class: 'pg-panel', style: { marginTop: '12px' } }, h('h4', {}, '🎯 Challenges', chCount), chList)))));

  onChange(term.engine);
  if (initialCmd) {
    term.writer.html('<span class="dim"># command sent from a lesson:</span>');
    term.run(initialCmd);
  }
  term.focus();
};
