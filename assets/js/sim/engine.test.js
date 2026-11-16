// Behaviour tests for the simulated cluster. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from './engine.js';
import { parseYamlDocs, toYaml } from './yaml.js';
import { REFERENCE } from '../reference.js';

/** A fresh lab. sh(cmd) returns stdout+stderr text; errors(cmd) returns only error lines. */
const lab = () => {
  let lines = [];
  const writer = { print: (text, cls) => lines.push({ text: String(text), cls }), html: () => {}, clear: () => { lines = []; } };
  const engine = createEngine(writer);
  const run = (cmd) => { lines = []; engine.execute(cmd); return lines; };
  return {
    engine,
    sh: (cmd) => run(cmd).map((l) => l.text).join('\n'),
    errors: (cmd) => run(cmd).filter((l) => l.cls === 'bad').map((l) => l.text).join('\n'),
    pods: (selector) => engine.cluster.store.list(engine.cluster.def('pod'), 'default').filter((p) => !selector || Object.entries(selector).every(([k, v]) => p.metadata.labels?.[k] === v)),
    wait: (n = 3) => engine.execute(`sleep ${n * 10}`),
  };
};

test('YAML round-trips manifests, block scalars and flow lists', () => {
  const [doc] = parseYamlDocs('kind: ConfigMap\ndata:\n  conf: |\n    a=1\n    b=2\n  list: [x, "y z"]\n');
  assert.equal(doc.data.conf, 'a=1\nb=2\n');
  assert.deepEqual(doc.data.list, ['x', 'y z']);
  assert.deepEqual(parseYamlDocs(toYaml(doc))[0], doc);
});

test('a Deployment rolls out, records history and rolls back', () => {
  const t = lab();
  assert.match(t.sh('kubectl apply -f deployment.yaml'), /deployment.apps\/web created/);
  assert.match(t.sh('kubectl rollout status deployment/web'), /successfully rolled out/);
  t.sh('kubectl set image deployment/web nginx=nginx:1.26');
  assert.match(t.sh('kubectl rollout status deployment/web'), /successfully rolled out/);
  assert.match(t.sh('kubectl rollout history deployment/web'), /1 +<none>\n2 +<none>/);
  assert.ok(t.pods({ app: 'web' }).every((p) => p.spec.containers[0].image === 'nginx:1.26'));
  assert.match(t.sh('kubectl rollout undo deployment/web'), /rolled back/);
  t.sh('kubectl rollout status deployment/web');
  assert.equal(t.sh('kubectl get deploy web -o jsonpath={.spec.template.spec.containers[0].image}'), 'nginx:1.27');
});

test('a bad image stalls the rollout without taking the app down', () => {
  const t = lab();
  t.sh('kubectl apply -f deployment.yaml');
  t.sh('kubectl rollout status deployment/web');
  t.sh('kubectl set image deployment/web nginx=nginx:does-not-exist');
  assert.match(t.errors('kubectl rollout status deployment/web'), /exceeded its progress deadline/);
  assert.match(t.sh('kubectl get pods'), /ImagePullBackOff|ErrImagePull/);
  assert.equal(t.pods({ app: 'web' }).filter((p) => p.status.phase === 'Running' && p.spec.containers[0].image === 'nginx:1.27').length, 3, 'maxUnavailable: 0 keeps every old pod');
});

test('ReplicaSets heal deleted pods and nodes that die', () => {
  const t = lab();
  t.sh('kubectl create deployment web --image=nginx --replicas=3');
  t.wait();
  const victim = t.pods({ app: 'web' })[0].metadata.name;
  t.sh(`kubectl delete pod ${victim}`);
  t.wait();
  const after = t.pods({ app: 'web' }).filter((p) => !p.metadata.deletionTimestamp);
  assert.equal(after.length, 3);
  assert.ok(!after.some((p) => p.metadata.name === victim));
  const node = after[0].spec.nodeName;
  t.sh(`sim node down ${node}`);
  t.wait(5);
  const live = t.pods({ app: 'web' }).filter((p) => !p.metadata.deletionTimestamp && p.status.phase === 'Running');
  assert.equal(live.length, 3);
  assert.ok(live.every((p) => p.spec.nodeName !== node));
});

test('Services load-balance over ready pods and resolve through CoreDNS', () => {
  const t = lab();
  t.sh('kubectl create deployment hello --image=kubelab/hello:1.0 --replicas=3 --port=8080');
  t.sh('kubectl expose deployment hello --port=80 --target-port=8080');
  t.wait();
  assert.match(t.sh('kubectl run t --rm -it --image=busybox:1.37 --restart=Never -- nslookup hello'), /Name:\thello\.default\.svc\.cluster\.local\nAddress: 10\.96\./);
  t.sh('kubectl run client --image=busybox:1.37 -- sleep 3600');
  t.wait();
  const seen = new Set(Array.from({ length: 6 }, () => t.sh('kubectl exec client -- wget -qO- http://hello')));
  assert.equal(seen.size, 3, 'requests spread over all three pods');
  assert.match(t.errors('kubectl exec client -- wget -qO- http://nope'), /bad address/);
});

test('NetworkPolicies block traffic until a rule allows it', () => {
  const t = lab();
  t.sh('kubectl apply -f deployment.yaml -f service.yaml -f networkpolicy.yaml');
  t.sh('kubectl run client --image=busybox:1.37 -- sleep 3600');
  t.wait();
  assert.match(t.errors('kubectl exec client -- wget -qO- -T 2 http://web'), /timed out/);
  t.sh('kubectl label pod client role=frontend');
  assert.match(t.sh('kubectl exec client -- wget -qO- -T 2 http://web'), /Welcome to nginx/);
});

test('StatefulSets keep names, order and data', () => {
  const t = lab();
  t.sh('kubectl apply -f statefulset.yaml');
  t.engine.run([], { silent: true });
  assert.deepEqual(t.pods({ app: 'db' }).map((p) => p.metadata.name).sort(), ['db-0', 'db-1', 'db-2']);
  assert.match(t.sh('kubectl get pvc'), /data-db-0 +Bound/);
  t.sh('kubectl exec db-0 -- sh -c "echo kept > /var/lib/postgresql/data/note"');
  t.sh('kubectl delete pod db-0');
  t.wait();
  assert.equal(t.sh('kubectl exec db-0 -- cat /var/lib/postgresql/data/note'), 'kept');
  assert.match(t.sh('kubectl run t --rm -it --image=busybox:1.37 --restart=Never -- nslookup db-1.db'), /db-1\.db\.default\.svc\.cluster\.local/);
});

test('the HPA scales with load and back down', () => {
  const t = lab();
  t.sh('kubectl apply -f deployment.yaml -f service.yaml -f hpa.yaml');
  t.wait(2);
  t.sh('sim load web');
  t.wait(4);
  const up = Number(t.sh('kubectl get deploy web -o jsonpath={.spec.replicas}'));
  assert.ok(up > 3, `scaled up to ${up}`);
  t.sh('kubectl delete pod -l run=load-generator');
  t.wait(8);
  assert.equal(t.sh('kubectl get deploy web -o jsonpath={.spec.replicas}'), '2');
});

test('the scheduler explains why pods stay Pending', () => {
  const t = lab();
  t.sh('kubectl taint nodes node-1 gpu=true:NoSchedule');
  t.sh('kubectl create deployment big --image=nginx --replicas=10');
  t.sh('kubectl set resources deployment big --requests=cpu=600m');
  t.wait(2);
  const events = t.sh('kubectl get events --field-selector reason=FailedScheduling');
  assert.match(events, /Insufficient cpu/);
  assert.match(events, /untolerated taint \{gpu: true\}/);
  assert.ok(t.pods({ app: 'big' }).every((p) => p.spec.nodeName !== 'node-1'));
});

test('RBAC answers can-i and forbids impersonated requests', () => {
  const t = lab();
  t.sh('kubectl apply -f rbac.yaml');
  const as = '--as=system:serviceaccount:default:viewer';
  assert.equal(t.sh(`kubectl auth can-i list pods ${as}`), 'yes');
  assert.equal(t.sh(`kubectl auth can-i delete pods ${as}`), 'no');
  assert.match(t.errors(`kubectl get secrets ${as}`), /Forbidden.*cannot list resource "secrets"/);
});

test('drain evicts pods but honours the PodDisruptionBudget', () => {
  const t = lab();
  t.sh('kubectl apply -f deployment.yaml -f pdb.yaml');
  t.wait(2);
  const node = t.pods({ app: 'web' })[0].spec.nodeName;
  assert.match(t.errors(`kubectl drain ${node}`), /cannot delete DaemonSet-managed Pods/);
  assert.match(t.sh(`kubectl drain ${node} --ignore-daemonsets`), /drained/);
  assert.ok(t.pods({ app: 'web' }).filter((p) => !p.metadata.deletionTimestamp).every((p) => p.spec.nodeName !== node));
  assert.match(t.sh('kubectl get nodes'), new RegExp(`${node} +Ready,SchedulingDisabled`));
});

test('Pod Security admission and quotas reject what they should', () => {
  const t = lab();
  t.sh('kubectl create namespace secure');
  t.sh('kubectl label ns secure pod-security.kubernetes.io/enforce=restricted');
  assert.match(t.errors('kubectl run x --image=nginx -n secure'), /violates PodSecurity "restricted:latest"/);
  t.sh('kubectl create quota small --hard=pods=1 -n default');
  t.sh('kubectl run a --image=nginx');
  assert.match(t.errors('kubectl run b --image=nginx'), /exceeded quota: small/);
});

test('Helm installs, upgrades and rolls back releases', () => {
  const t = lab();
  t.sh('helm install site charts/web');
  assert.equal(t.sh('kubectl get deploy site-web -o jsonpath={.spec.replicas}'), '2');
  t.sh('helm upgrade site charts/web -f charts/web/values-prod.yaml');
  assert.equal(t.sh('kubectl get deploy site-web -o jsonpath={.spec.replicas}'), '4');
  t.sh('helm rollback site 1');
  assert.equal(t.sh('kubectl get deploy site-web -o jsonpath={.spec.replicas}'), '2');
  assert.match(t.sh('helm history site'), /3\s+.*deployed.*Rollback to 1/);
  assert.match(t.sh('kubectl get secrets'), /sh\.helm\.release\.v1\.site\.v3/);
});

test('Kustomize overlays rename, relabel and generate hashed ConfigMaps', () => {
  const t = lab();
  const out = t.sh('kubectl kustomize kustomize/overlays/dev');
  assert.match(out, /name: dev-web/);
  assert.match(out, /name: dev-app-config-[a-z0-9]{10}/);
  assert.match(t.sh('kubectl apply -k kustomize/overlays/prod'), /deployment.apps\/web created/);
  assert.equal(t.sh('kubectl get deploy web -n prod -o jsonpath={.spec.replicas}'), '4');
});

test('every reference entry is well formed and every lab runs without simulator errors', () => {
  const ids = new Set();
  for (const r of REFERENCE) {
    assert.ok(r.cmd && r.summary && r.syntax && r.group, `incomplete entry ${r.cmd}`);
    assert.ok(!ids.has(r.id), `duplicate id ${r.id}`);
    ids.add(r.id);
    assert.ok(r.examples.length >= 2, `${r.cmd} needs at least two examples`);
    let internal = [];
    const engine = createEngine({ print: (text, cls) => { if (/internal simulator error/.test(text)) internal.push(text); }, html: () => {}, clear: () => {} });
    engine.run(r.setup, { silent: true });
    r.examples.forEach(([cmd]) => engine.execute(cmd));
    assert.deepEqual(internal, [], `${r.cmd}: ${internal.join(' | ')}`);
    internal = [];
  }
});
