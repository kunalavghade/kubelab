// The simulated lab: a host shell (pipes, $(…), &&, redirects, env vars) in ~/k8s with kubectl,
// helm, kustomize and everyday programs, wired to a simulated multi-node cluster.
// createEngine(writer) is used by the playground, every command lab, and the Node tests.
import { CommandError, tokenize, findSubstitutions } from './util.js';
import { createCluster } from './cluster.js';
import { PROJECT_FILES, PROJECT_DIR, K8S_VERSION } from './data.js';
import { coreCommands, splitGlobals, authorize, fqName } from './kubectl.js';
import { opsCommands } from './kubectl-ops.js';
import { createHelm } from './helm.js';
import { buildKustomization } from './kustomize.js';
import { runInContainer, runHttp, podPrompt } from './podshell.js';
import { behaviourOf } from './kubelet.js';
import { isFilter, applyFilter, sedReplace, b64encode } from './filters.js';
import { podStatus } from './printers.js';
import { REFERENCE } from '../reference.js';

const HOST = { ip: '172.18.0.1' };
const LOCAL_CLUSTER = 'kind-kubelab';
const NO_API = new Set(['config', 'version', 'completion', 'kustomize', 'help', 'options', 'plugin', 'explain']);
const KUBECTL_HELP = [
  'kubectl controls the Kubernetes cluster manager.', '', ' Find more information at: https://kubernetes.io/docs/reference/kubectl/', '',
  'Basic Commands (Beginner):', '  create          Create a resource from a file or from stdin', '  expose          Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service', '  run             Run a particular image on the cluster', '  set             Set specific features on objects', '',
  'Basic Commands (Intermediate):', '  explain         Get documentation for a resource', '  get             Display one or many resources', '  edit            Edit a resource on the server', '  delete          Delete resources by file names, stdin, resources and names, or by resources and label selector', '',
  'Deploy Commands:', '  rollout         Manage the rollout of a resource', '  scale           Set a new size for a deployment, replica set, or replication controller', '  autoscale       Auto-scale a deployment, replica set, stateful set, or replication controller', '',
  'Cluster Management Commands:', '  certificate     Modify certificate resources', '  cluster-info    Display cluster information', '  top             Display resource (CPU/memory) usage', '  cordon          Mark node as unschedulable', '  uncordon        Mark node as schedulable', '  drain           Drain node in preparation for maintenance', '  taint           Update the taints on one or more nodes', '',
  'Troubleshooting and Debugging Commands:', '  describe        Show details of a specific resource or group of resources', '  logs            Print the logs for a container in a pod', '  attach          Attach to a running container', '  exec            Execute a command in a container', '  port-forward    Forward one or more local ports to a pod', '  proxy           Run a proxy to the Kubernetes API server', '  cp              Copy files and directories to and from containers', '  auth            Inspect authorization', '  debug           Create debugging sessions for troubleshooting workloads and nodes', '  events          List events', '',
  'Advanced Commands:', '  diff            Diff the live version against a would-be applied version', '  apply           Apply a configuration to a resource by file name or stdin', '  patch           Update fields of a resource', '  replace         Replace a resource by file name or stdin', '  wait            Experimental: Wait for a specific condition on one or many resources', '  kustomize       Build a kustomization target from a directory or URL', '',
  'Settings Commands:', '  label           Update the labels on a resource', '  annotate        Update the annotations on a resource', '  completion      Output shell completion code for the specified shell (bash, zsh, fish, or powershell)', '',
  'Other Commands:', '  api-resources   Print the supported API resources on the server', '  api-versions    Print the supported API versions on the server, in the form of "group/version"', '  config          Modify kubeconfig files', '  plugin          Provides utilities for interacting with plugins', '  version         Print the client and server version information', '',
  'Usage:', '  kubectl [flags] [options]', '', 'Use "kubectl <command> --help" for more information about a given command.',
];
const SIM_HELP = ['Simulator helpers (not real commands):', '  sim node down node-2     power a node off (its pods are evicted after ~20s)', '  sim node up node-2       power it back on', '  sim tick [n]             let n×10 seconds pass', '  sim load <service>       start a busybox load generator against a Service (for HPA)', '  sim reset                start again with a fresh cluster'];

export const createEngine = (writer) => {
  let C, E, files, cwd, shell, env, kubectl, helm, used;
  const out = (text, cls = '') => writer?.print(text, cls);

  // ---------- files in ~/k8s ----------
  const normalize = (p) => {
    const raw = String(p).replace(/^~\/k8s\/?/, '').replace(/^~\/?/, '');
    const parts = (raw.startsWith('/') ? raw.replace(/^\/home\/you\/k8s\/?/, '') : `${cwd}/${raw}`).split('/').filter((x) => x && x !== '.');
    const stack = [];
    parts.forEach((x) => { if (x === '..') stack.pop(); else stack.push(x); });
    return stack.join('/');
  };
  const fileApi = {
    read: (p) => files.get(normalize(p)) ?? null,
    write: (p, content) => { files.set(normalize(p), content); },
    remove: (p) => files.delete(normalize(p)),
    isDir: (p) => { const n = normalize(p); return n === '' || [...files.keys()].some((f) => f.startsWith(`${n}/`)); },
    list: (p, recursive = false) => {
      const n = normalize(p);
      const prefix = n ? `${n}/` : '';
      return [...files.keys()].filter((f) => f.startsWith(prefix) && (recursive || !f.slice(prefix.length).includes('/'))).sort();
    },
    abs: (p) => `/home/you/k8s/${normalize(p)}`.replace(/\/$/, ''),
  };

  // ---------- reset ----------
  const reset = () => {
    C = createCluster();
    C.boot();
    C.clock.advance(3 * 24 * 3600); // the cluster has been running for a few days
    files = new Map(Object.entries(PROJECT_FILES));
    files.set('.env', 'APP_MODE=production\nAPP_COLOR=blue\n');
    cwd = '';
    shell = null;
    env = { HOME: '/home/you', USER: 'you', SHELL: '/bin/bash', KUBECONFIG: '/home/you/.kube/config', PATH: '/usr/local/bin:/usr/bin:/bin' };
    used = new Set();
    E = {
      C, files: fileApi, forwards: [], proxy: false,
      helmState: { repos: new Map(), releases: new Map() },
      kubeconfig: {
        current: LOCAL_CLUSTER,
        contexts: { [LOCAL_CLUSTER]: { cluster: LOCAL_CLUSTER, user: LOCAL_CLUSTER }, staging: { cluster: 'staging', user: 'staging-admin', namespace: 'shop' } },
        clusters: { [LOCAL_CLUSTER]: { server: 'https://127.0.0.1:6443' }, staging: { server: 'https://10.0.40.12:6443' } },
      },
      namespace: () => E.kubeconfig.contexts[E.kubeconfig.current]?.namespace || 'default',
      enterShell: (pod, container, opts = {}) => { shell = { ns: pod.metadata.namespace, pod: pod.metadata.name, container, rm: !!opts.rmOnExit }; },
      attachRun,
      kustomize: (dir) => buildKustomization(E, dir),
    };
    C.authorize = (who, verb, resource, ns, name) => authorize(C, who, verb, resource, ns, name);
    kubectl = { ...coreCommands(E), ...opsCommands(E) };
    helm = createHelm(E);
  };

  // kubectl run -it: wait for the pod, then show its output or open a shell inside it.
  const attachRun = ({ ns, name, rm, hasCommand, quiet }) => {
    const pod = () => C.store.get(C.def('pod'), ns, name);
    C.tickUntil(() => ['Running', 'Succeeded', 'Failed'].includes(pod()?.status.phase), 5);
    const p = pod();
    if (!p || p.status.phase === 'Pending') throw new CommandError(`error: timed out waiting for the condition`, 'TIMEOUT');
    const c = p.spec.containers[0];
    const lines = [];
    const removeIfRm = () => { if (rm) { C.delete(pod(), { grace: 0, force: true }); C.settle(); lines.push(`pod "${name}" deleted from ${ns} namespace`); } };
    if (!hasCommand && behaviourOf(c).kind !== 'server') {
      shell = { ns, pod: name, container: c, rm, attached: true };
      if (!quiet) lines.push('If you don\'t see a command prompt, try pressing enter.');
      return lines;
    }
    const cmdLine = [...(c.command || []), ...(c.args || [])].join(' ');
    const inner = /^(\/bin\/)?sh -c (.*)$/.exec(cmdLine)?.[2]?.replace(/^["']|["']$/g, '') ?? cmdLine;
    if (behaviourOf(c).loop) {
      const sample = /wget|curl/.test(inner) ? runInContainer(C, p, c, inner.replace(/^.*?do\s+/, '').replace(/;\s*done.*$/, '')).lines.join('') : '';
      lines.push(...(sample ? [sample.repeat(6)] : []), `# (simulator: "${name}" keeps running in the background — stop it with: kubectl delete pod ${name})`);
      return lines;
    }
    const r = cmdLine ? runInContainer(C, p, c, inner) : { lines: [] };
    lines.push(...r.lines);
    removeIfRm();
    return lines;
  };

  // ---------- program dispatch ----------
  const kubectlRun = (args, stdin) => {
    const sub = args[0];
    if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return KUBECTL_HELP;
    if (args.includes('--help') || args.includes('-h')) return helpFor(args.filter((a) => !a.startsWith('-')));
    // config set-context owns its --namespace flag; everywhere else -n is global.
    const { globals, rest } = sub === 'config' ? { globals: {}, rest: args.slice(1) } : splitGlobals(args.slice(1));
    const ctx = globals.context || E.kubeconfig.current;
    if (!E.kubeconfig.contexts[ctx]) throw new CommandError(`error: context "${ctx}" does not exist`, 'NO_CONTEXT');
    if (E.kubeconfig.contexts[ctx].cluster !== LOCAL_CLUSTER && !NO_API.has(sub) && !(sub === 'version' && rest.includes('--client'))) {
      const server = E.kubeconfig.clusters[E.kubeconfig.contexts[ctx].cluster]?.server || 'https://10.0.40.12:6443';
      throw new CommandError(`E1116 09:00:30.214587   48213 memcache.go:265] "Unhandled Error" err="couldn't get current server API group list: Get \\"${server}/api?timeout=32s\\": dial tcp ${server.replace('https://', '')}: i/o timeout"\nUnable to connect to the server: dial tcp ${server.replace('https://', '')}: i/o timeout\n# (simulator: the "${ctx}" context points at a cluster this lab can't reach — kubectl config use-context ${LOCAL_CLUSTER})`, 'UNREACHABLE');
    }
    if (globals.context && E.kubeconfig.contexts[globals.context]?.namespace && !globals.namespace) globals.namespace = E.kubeconfig.contexts[globals.context].namespace;
    const fn = kubectl[sub];
    if (!fn) throw new CommandError(`error: unknown command "${sub}" for "kubectl"${suggest(sub)}`, 'UNKNOWN');
    used.add(sub);
    return fn(globals, rest, stdin);
  };
  const suggest = (sub) => {
    const near = Object.keys(kubectl).find((k) => k.startsWith(sub.slice(0, 3)));
    return near ? `\n\nDid you mean this?\n\t${near}` : '';
  };
  const helpFor = (words) => {
    const name = `kubectl ${words.slice(1).join(' ')}`.trim();
    const entry = REFERENCE.filter((r) => name.startsWith(r.cmd)).sort((a, b) => b.cmd.length - a.cmd.length)[0];
    if (!entry) return KUBECTL_HELP;
    return [entry.summary.replace(/<[^>]+>/g, ''), '', 'Usage:', `  ${entry.syntax}`, '', ...(entry.flags.length ? ['Options:', ...entry.flags.map(([n, v, d]) => `    ${n}${v ? `=${v}` : ''}:\n\t${d.replace(/<[^>]+>/g, '')}`)] : []), '', `See it explained with a live lab: #/commands/${entry.id}`];
  };

  const sim = (args) => {
    const [sub, ...rest] = args;
    if (sub === 'node') {
      const [state, name] = rest;
      if (!C.store.get(C.def('node'), null, name)) throw new CommandError(`sim: no node named "${name}"`, 'SIM');
      C.setNodePower(name, state === 'up');
      C.settle();
      return [`node ${name} powered ${state === 'up' ? 'on' : 'off'}${state === 'up' ? '' : ' — watch kubectl get nodes and kubectl get pods -o wide'}`];
    }
    if (sub === 'tick') { C.tick(Number(rest[0] || 1)); return [`${(Number(rest[0]) || 1) * 10}s passed`]; }
    if (sub === 'load') {
      const target = rest[0] || 'web';
      C.create({ apiVersion: 'v1', kind: 'Pod', metadata: { name: `load-generator-${Math.random().toString(36).slice(2, 7)}`, namespace: E.namespace(), labels: { run: 'load-generator' } }, spec: { restartPolicy: 'Never', containers: [{ name: 'load', image: 'busybox:1.37', command: ['/bin/sh', '-c', `while sleep 0.01; do wget -q -O- http://${target}; done`] }] } });
      C.settle();
      return [`load generator started against ${target} — watch kubectl get hpa -w (delete it with kubectl delete pod -l run=load-generator)`];
    }
    if (sub === 'reset') { reset(); return ['fresh cluster ready']; }
    return SIM_HELP;
  };

  const HOST_PROGRAMS = {
    kubectl: (args, stdin) => kubectlRun(args, stdin),
    k: (args, stdin) => kubectlRun(args, stdin),
    helm: (args) => { used.add('helm'); return helm(args); },
    kustomize: (args) => { if (args[0] !== 'build') throw new CommandError('Error: unknown command. Try: kustomize build <dir>', 'ARGS'); return kubectl.kustomize({}, args.slice(1)); },
    sim: (args) => sim(args),
    echo: (args) => [args.filter((a) => a !== '-n' && a !== '-e').join(' ')],
    printf: (args) => [args.slice(1).reduce((s, a) => s.replace('%s', a), args[0] || '').replace(/\\n/g, '\n')],
    pwd: () => [fileApi.abs(cwd || '.').replace(/\/\.?$/, '') || PROJECT_DIR],
    cd: (args) => {
      const target = args[0] || '~';
      if (target === '~' || target === '-') { cwd = ''; return []; }
      const n = normalize(target);
      if (target.startsWith('..') && !cwd) throw new CommandError(`cd: the lab keeps you inside ${PROJECT_DIR}`, 'CD');
      if (n && !fileApi.isDir(n)) throw new CommandError(`cd: ${target}: No such file or directory`, 'CD');
      cwd = n;
      return [];
    },
    ls: (args) => {
      const target = args.filter((a) => !a.startsWith('-'))[0] || '.';
      const n = normalize(target);
      if (files.has(n)) return [target];
      if (!fileApi.isDir(n)) throw new CommandError(`ls: cannot access '${target}': No such file or directory`, 'LS');
      const prefix = n ? `${n}/` : '';
      const names = [...new Set([...files.keys()].filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split('/')[0] + (f.slice(prefix.length).includes('/') ? '/' : '')))].filter((x) => args.some((a) => a.includes('a')) || !x.startsWith('.')).sort();
      return args.some((a) => /^-\w*l/.test(a)) ? names.map((x) => `${x.endsWith('/') ? 'drwxr-xr-x' : '-rw-r--r--'}  1 you  staff  ${String(x.endsWith('/') ? 4096 : (files.get(prefix + x) || '').length).padStart(5)} Nov 16 09:00 ${x}`) : [names.join('  ')];
    },
    cat: (args, stdin) => {
      if (!args.length) return stdin;
      return args.flatMap((f) => { const c = fileApi.read(f); if (c == null) throw new CommandError(`cat: ${f}: No such file or directory`, 'CAT'); return c.replace(/\n$/, '').split('\n'); });
    },
    touch: (args) => { args.forEach((f) => { if (fileApi.read(f) == null) fileApi.write(f, ''); }); return []; },
    rm: (args) => { args.filter((a) => !a.startsWith('-')).forEach((f) => { const n = normalize(f); if (!files.has(n) && !args.some((a) => a.includes('f'))) throw new CommandError(`rm: cannot remove '${f}': No such file or directory`, 'RM'); [...files.keys()].filter((k) => k === n || k.startsWith(`${n}/`)).forEach((k) => files.delete(k)); }); return []; },
    mkdir: (args) => { args.filter((a) => !a.startsWith('-')).forEach((d) => files.set(`${normalize(d)}/.keep`, '')); return []; },
    cp: (args) => { const [src, dst] = args.filter((a) => !a.startsWith('-')); const c = fileApi.read(src); if (c == null) throw new CommandError(`cp: cannot stat '${src}': No such file or directory`, 'CP'); fileApi.write(fileApi.isDir(dst) ? `${dst}/${src.split('/').pop()}` : dst, c); return []; },
    mv: (args) => { const [src, dst] = args; const c = fileApi.read(src); if (c == null) throw new CommandError(`mv: cannot stat '${src}': No such file or directory`, 'MV'); fileApi.write(dst, c); fileApi.remove(src); return []; },
    sed: (args, stdin) => {
      const inPlace = args.includes('-i') || args.some((a) => /^-i/.test(a));
      const rest = args.filter((a) => !/^-i/.test(a) && a !== '-e' && a !== "''" && a !== '');
      const [expr, file] = rest;
      if (!file) return sedReplace(expr, stdin);
      const content = fileApi.read(file);
      if (content == null) throw new CommandError(`sed: can't read ${file}: No such file or directory`, 'SED');
      const result = sedReplace(expr, content.split('\n')).join('\n');
      if (inPlace) { fileApi.write(file, result); return []; }
      return result.replace(/\n$/, '').split('\n');
    },
    curl: (args) => {
      const urlArg = args.find((a) => /^(https?:\/\/)?(localhost|127\.0\.0\.1):8001/.test(a));
      if (urlArg && E.proxy) {
        const path = urlArg.replace(/^(https?:\/\/)?[^/]+/, '') || '/';
        return kubectl.get({}, ['--raw', path]);
      }
      const r = runHttp(C, HOST, args, { forwards: E.forwards });
      if (r.code) throw new CommandError(r.lines.join('\n'), 'CURL');
      return r.lines;
    },
    wget: (args) => { const r = runHttp(C, HOST, args, { forwards: E.forwards, wget: true }); if (r.code) throw new CommandError(r.lines.join('\n'), 'WGET'); return r.lines; },
    sleep: (args) => { C.tick(Math.min(30, Math.max(1, Math.ceil(Number(args[0] || 1) / 10)))); return []; },
    watch: (args) => {
      const cmd = args.filter((a, i) => !a.startsWith('-') && !(args[i - 1] === '-n')).join(' ');
      const lines = [];
      for (let i = 0; i < 3; i++) { if (i) C.tick(); lines.push(`Every 2.0s: ${cmd}`, '', ...capture(cmd), ''); }
      return [...lines, '^C  (the simulator shows three refreshes)'];
    },
    export: (args) => { args.forEach((a) => { const at = a.indexOf('='); if (at > 0) env[a.slice(0, at)] = a.slice(at + 1); }); return []; },
    unset: (args) => { args.forEach((a) => delete env[a]); return []; },
    env: () => Object.entries(env).map(([k, v]) => `${k}=${v}`),
    printenv: (args) => (args.length ? args.map((a) => env[a] ?? '') : Object.entries(env).map(([k, v]) => `${k}=${v}`)),
    alias: () => ['alias k=\'kubectl\''],
    which: (args) => args.map((a) => (HOST_PROGRAMS[a] ? `/usr/local/bin/${a}` : `${a} not found`)),
    whoami: () => ['you'],
    hostname: () => ['laptop'],
    date: () => [new Date(C.clock.now()).toUTCString().replace('GMT', 'UTC')],
    uname: (args) => [args.includes('-a') ? 'Linux laptop 6.8.0-49-generic #49-Ubuntu SMP x86_64 GNU/Linux' : 'Linux'],
    jobs: () => (E.forwards.length ? E.forwards.map((f, i) => `[${i + 1}]  Running                 ${f.label} &`) : []),
    kill: (args) => {
      const id = Number(String(args[0] || '').replace('%', ''));
      const i = E.forwards.findIndex((f, idx) => idx + 1 === id);
      if (i < 0) throw new CommandError(`kill: ${args[0]}: no such job`, 'KILL');
      const [f] = E.forwards.splice(i, 1);
      return [`[${id}]  Terminated              ${f.label}`];
    },
    openssl: (args) => {
      const out = args[args.indexOf('-out') + 1], key = args[args.indexOf('-keyout') + 1];
      const cn = /CN=([^/"']+)/.exec(args.join(' '))?.[1] || 'example.com';
      if (args[0] === 'req' && out && key) {
        fileApi.write(out, `-----BEGIN CERTIFICATE-----\nMIIC+zCCAeOgAwIBAgIU${b64encode(cn).slice(0, 20)}…(simulated certificate for ${cn})\n-----END CERTIFICATE-----\n`);
        fileApi.write(key, '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC…(simulated key)\n-----END PRIVATE KEY-----\n');
        return ['.....+++++', '..+++++', '-----'];
      }
      return ['OpenSSL 3.0.13 30 Jan 2024'];
    },
    kind: (args) => {
      if (args[0] === 'get' && args[1] === 'clusters') return ['kubelab'];
      if (args[0] === 'get' && args[1] === 'nodes') return ['kubelab-control-plane', 'kubelab-worker', 'kubelab-worker2', 'kubelab-worker3', '# (in this lab the nodes are named control-plane, node-1, node-2, node-3)'];
      if (args[0] === 'create') return ['ERROR: failed to create cluster: node(s) already exist for a cluster with the name "kubelab"', '# (the lab cluster is already running: kubectl get nodes)'];
      return ['kind creates and manages local Kubernetes clusters using Docker container \'nodes\'', '', 'Usage:', '  kind [command]', '', 'Available Commands:', '  create      Creates one of [cluster]', '  delete      Deletes one of [cluster]', '  get         Gets one of [clusters, nodes, kubeconfig]', '  load        Loads images into nodes'];
    },
    minikube: () => ['😄  minikube v1.34.0', '# (this lab already runs a 4-node cluster — just use kubectl)'],
    docker: () => ['# This lab simulates a Kubernetes cluster, not a Docker engine.', '# Learn Docker visually at https://kunalavghade.github.io/dockerlab/'],
    nano: (args) => editorHint(args), vim: (args) => editorHint(args), vi: (args) => editorHint(args), code: (args) => editorHint(args),
    help: () => ['Kube Lab terminal — a simulated kind cluster with 1 control-plane and 3 worker nodes.', '', 'Kubernetes:  kubectl (or k), helm, kustomize', `Files:       ls, cat, cd, cp, mv, rm, mkdir, touch, sed -i, echo … > file   (your project is ${PROJECT_DIR})`, 'Network:     curl, wget (NodePorts, LoadBalancer IPs, Ingress hosts, port-forwards)', 'Text:        grep, head, tail, wc, sort, uniq, cut, awk, tr, base64, jq, xargs', 'Other:       sleep N (lets time pass), watch, export, env, jobs, kill %N, openssl', '', ...SIM_HELP, '', 'Every kubectl command is explained on the Commands page (#/commands).'],
    exit: () => ['# (this is the lab terminal — there is nothing to exit; inside a pod, exit leaves the shell)'],
    clear: () => [],
    history: () => [],
    true: () => [],
    false: () => { throw new CommandError('', 'FALSE'); },
  };
  const editorHint = (args) => [`# (the simulator has no text editor — change ${args[0] || 'files'} with sed -i, e.g.:)`, `#   sed -i 's/replicas: 3/replicas: 5/' ${args[0] || 'deployment.yaml'}`, '#   echo "key: value" >> file.yaml   ·   cat file.yaml'];

// Error output often starts with normal progress lines ("node/x cordoned") before the error.
const PROGRESS_LINE = /^([\w.-]+\/[\w.-]+ (created|configured|unchanged|cordoned|evicted|deleted|labeled|patched|scaled)|evicting pod |Waiting for |Warning: (ignoring|deleting) )/;
const lineClass = (l) => (/^#/.test(l) ? 'dim' : PROGRESS_LINE.test(l) ? '' : 'bad');

  // ---------- the shell ----------
  const expandVars = (line) => {
    let outLine = '', quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) { if (ch === quote) quote = null; if (quote !== "'" && ch === '$' && /[A-Za-z_{]/.test(line[i + 1] || '')) { const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(line.slice(i)); outLine += env[m[1]] ?? ''; i += m[0].length - 1; continue; } outLine += ch; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      if (ch === '$' && /[A-Za-z_{]/.test(line[i + 1] || '')) { const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(line.slice(i)); outLine += env[m[1]] ?? ''; i += m[0].length - 1; continue; }
      outLine += ch;
    }
    return outLine;
  };

  const substitute = (line) => {
    let result = line;
    findSubstitutions(line).reverse().forEach(({ start, end, inner }) => { result = result.slice(0, start) + capture(inner).join(' ').trim() + result.slice(end); });
    return result;
  };

  /** Runs a line and returns its stdout lines (errors are swallowed), for $(…) and watch. */
  const capture = (line) => {
    try { return runPipelines(line, { capture: true }); } catch { return []; }
  };

  const runSegment = (words, stdin) => {
    const [cmd, ...args] = words;
    if (!cmd) return stdin;
    if (cmd === 'xargs') return runSegment([...args, ...stdin.join(' ').split(/\s+/).filter(Boolean)], []);
    if (isFilter(cmd) && (stdin.length || !args.some((a) => !a.startsWith('-') && fileApi.read(a) != null) || cmd === 'jq')) {
      const fileArg = args.find((a, i) => i > 0 && fileApi.read(a) != null);
      if (fileArg && cmd !== 'sed') return applyFilter(cmd, args.filter((a) => a !== fileArg), fileApi.read(fileArg).replace(/\n$/, '').split('\n'));
      if (cmd === 'tee') { args.filter((a) => !a.startsWith('-')).forEach((f) => fileApi.write(f, `${stdin.join('\n')}\n`)); return stdin; }
      if (cmd !== 'sed' && cmd !== 'cat') return applyFilter(cmd, args, stdin);
    }
    if (isFilter(cmd) && !HOST_PROGRAMS[cmd]) {
      const fileArg = args.find((a) => fileApi.read(a) != null);
      if (fileArg) return applyFilter(cmd, args.filter((a) => a !== fileArg), fileApi.read(fileArg).replace(/\n$/, '').split('\n'));
    }
    const program = HOST_PROGRAMS[cmd];
    if (!program) throw new CommandError(`bash: ${cmd}: command not found${/^(kubeclt|kubect|kubctl|kubetcl)$/.test(cmd) ? ' — did you mean kubectl?' : ''}`, 'NOT_FOUND');
    return program(args, stdin);
  };

  /** Executes "a | b > f && c; d" and prints (or returns) output. */
  const runPipelines = (rawLine, { capture: capturing = false } = {}) => {
    const line = substitute(expandVars(rawLine));
    const toks = tokenize(line);
    const collected = [];
    let code = 0, skip = false, segs = [[]], redirect = null, stdinFile = null, quietErr = false;
    const flush = (op) => {
      if (!skip) {
        try {
          let data = stdinFile != null ? stdinFile : [];
          segs.forEach((seg, i) => { data = runSegment(seg, i === 0 ? data : data) ?? []; });
          if (redirect) {
            const text = data.length ? `${data.join('\n')}\n` : '';
            fileApi.write(redirect.file, redirect.append ? (fileApi.read(redirect.file) || '') + text : text);
          } else if (capturing) collected.push(...data);
          else data.forEach((l) => out(l, /^Warning:/.test(l) ? 'warn' : /^#/.test(l) ? 'dim' : ''));
          code = 0;
        } catch (err) {
          if (!(err instanceof CommandError)) throw err;
          code = 1;
          if (!quietErr && !capturing && err.message) err.message.split('\n').forEach((l) => out(l, lineClass(l)));
        }
      }
      skip = (op === '&&' && code !== 0) || (op === '||' && code === 0);
      segs = [[]];
      redirect = null;
      stdinFile = null;
      quietErr = false;
    };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (typeof t === 'string') { segs.at(-1).push(t); continue; }
      if (t.op === '|') { segs.push([]); continue; }
      if (t.op === '>' || t.op === '>>') {
        const seg = segs.at(-1);
        const target = toks[++i];
        if (seg.at(-1) === '2') { seg.pop(); if (target === '/dev/null' || target === '&1') quietErr = target === '/dev/null'; continue; }
        if (target === '/dev/null') { redirect = { file: '.devnull', append: false }; continue; }
        redirect = { file: target, append: t.op === '>>' };
        continue;
      }
      if (t.op === '<') { const f = toks[++i]; const c = fileApi.read(f); if (c == null) throw new CommandError(`bash: ${f}: No such file or directory`, 'NO_FILE'); stdinFile = c.replace(/\n$/, '').split('\n'); continue; }
      flush(t.op);
    }
    flush(null);
    files.delete('.devnull');
    return collected;
  };

  // ---------- inside a pod ----------
  const shellPod = () => C.store.get(C.def('pod'), shell.ns, shell.pod);
  const leaveShell = (lines = []) => {
    const s = shell;
    shell = null;
    if (s.rm) { const p = C.store.get(C.def('pod'), s.ns, s.pod); if (p) { C.delete(p, { grace: 0, force: true }); C.settle(); } lines.push(`pod "${s.pod}" deleted from ${s.ns} namespace`); } else if (s.attached) lines.push(`Session ended, resume using 'kubectl attach ${s.pod} -c ${s.container.name} -i -t' command when the pod is running`);
    return lines;
  };
  const executeInPod = (line) => {
    const pod = shellPod();
    if (!pod || pod.metadata.deletionTimestamp) { leaveShell().forEach((l) => out(l, 'dim')); return out('command terminated with exit code 137 (the pod was deleted)', 'bad'); }
    const r = runInContainer(C, pod, shell.container, line, { forwards: E.forwards });
    r.lines.forEach((l) => out(l, r.code && r.lines.length === 1 ? 'bad' : ''));
    if (r.exit) leaveShell([]).forEach((l) => out(l, 'dim'));
    C.settle();
  };

  // ---------- public API ----------
  const execute = (raw) => {
    const line = String(raw).trim();
    if (!line || line.startsWith('#')) return;
    try {
      if (shell) return executeInPod(line);
      C.tick(); // time passes between commands
      runPipelines(line);
      C.settle();
    } catch (err) {
      if (!(err instanceof CommandError)) { out(`internal simulator error: ${err.message}`, 'bad'); console.error(err); return; }
      err.message.split('\n').forEach((l) => out(l, lineClass(l)));
    }
  };

  /** Runs setup lines silently, then lets the cluster settle so labs start in a steady state. */
  const run = (lines, { silent = false } = {}) => {
    const saved = writer;
    if (silent) writer = null;
    try { lines.forEach((l) => execute(l)); } finally { writer = saved; }
    const steady = () => C.store.list(C.def('pod')).every((p) => {
      if (p.metadata.deletionTimestamp) return false;
      if (['Succeeded', 'Failed'].includes(p.status.phase)) return true;
      if (!p.spec.nodeName) return true; // unschedulable is a steady state too
      const waiting = (p.status.containerStatuses || []).map((s) => s.state.waiting?.reason).filter(Boolean);
      if (waiting.some((r) => ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError'].includes(r))) return true;
      return p.status.phase === 'Running' && C.isPodReady(p);
    });
    C.tickUntil(steady, 8);
    if (shell) shell = null;
  };

  const prompt = () => {
    if (!shell) return '$';
    const pod = shellPod();
    return pod ? podPrompt(pod, shell.container).trim() : '$';
  };

  const completions = () => {
    const names = ['pods', 'deployments', 'services', 'nodes', 'namespaces', 'configmaps', 'secrets', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'ingresses', 'pvc', 'hpa', 'events', 'all']
      .concat(Object.keys(kubectl), Object.keys(HOST_PROGRAMS), [...files.keys()])
      .concat(C.store.all().filter((o) => ['Pod', 'Deployment', 'Service', 'Node', 'Namespace', 'StatefulSet', 'Job', 'ConfigMap', 'Secret'].includes(o.kind) && (!o.metadata.namespace || o.metadata.namespace === E.namespace() || o.kind === 'Node')).map((o) => o.metadata.name));
    return [...new Set(names)];
  };

  /** A compact picture of the cluster for the visual panel and the challenges. */
  const state = () => {
    const ns = E.namespace();
    const pods = C.store.list(C.def('pod'));
    const podView = (p) => ({
      name: p.metadata.name, ns: p.metadata.namespace, node: p.spec.nodeName || null, status: podStatus(p), ready: C.isPodReady(p),
      owner: p.metadata.ownerReferences?.[0]?.kind || null, app: p.metadata.labels?.app || p.metadata.labels?.['app.kubernetes.io/name'] || p.metadata.labels?.['k8s-app'] || null,
      system: ['kube-system', 'ingress-nginx', 'local-path-storage'].includes(p.metadata.namespace), restarts: (p.status.containerStatuses || []).reduce((s, c) => s + c.restartCount, 0),
    });
    const list = (kind, scope = ns) => C.store.list(C.def(kind), scope);
    return {
      context: E.kubeconfig.current, namespace: ns, inShell: !!shell, shellPod: shell?.pod || null,
      nodes: C.nodes().map((n) => ({
        name: n.metadata.name, ready: C.isNodeReady(n), cordoned: !!n.spec.unschedulable, controlPlane: 'node-role.kubernetes.io/control-plane' in n.metadata.labels,
        taints: (n.spec.taints || []).filter((t) => !t.key.startsWith('node.kubernetes.io/')).map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`),
        labels: Object.entries(n.metadata.labels).filter(([k]) => !/kubernetes\.io\/(arch|os|hostname)|node-role/.test(k)).map(([k, v]) => `${k.replace('topology.kubernetes.io/', '')}=${v}`),
        pods: pods.filter((p) => p.spec.nodeName === n.metadata.name).map(podView),
      })),
      pending: pods.filter((p) => !p.spec.nodeName).map(podView),
      pods: pods.map(podView),
      deployments: list('deployment', null).map((d) => ({ name: d.metadata.name, ns: d.metadata.namespace, ready: d.status.readyReplicas || 0, replicas: d.spec.replicas, image: d.spec.template.spec.containers[0].image, system: d.metadata.namespace !== ns })),
      statefulsets: list('statefulset', null).map((s) => ({ name: s.metadata.name, ns: s.metadata.namespace, ready: s.status.readyReplicas || 0, replicas: s.spec.replicas })),
      daemonsets: list('daemonset', null).map((d) => ({ name: d.metadata.name, ns: d.metadata.namespace, ready: d.status.numberReady || 0, desired: d.status.desiredNumberScheduled || 0 })),
      jobs: list('job', null).map((j) => ({ name: j.metadata.name, ns: j.metadata.namespace, succeeded: j.status.succeeded || 0, completions: j.spec.completions, done: !!j.status.completionTime })),
      cronjobs: list('cronjob', null).map((c) => ({ name: c.metadata.name, ns: c.metadata.namespace })),
      services: list('service', null).filter((s) => !['kubernetes'].includes(s.metadata.name)).map((s) => {
        const ep = C.store.get(C.def('endpoints'), s.metadata.namespace, s.metadata.name);
        return { name: s.metadata.name, ns: s.metadata.namespace, type: s.spec.type, clusterIP: s.spec.clusterIP, external: s.status.loadBalancer?.ingress?.[0]?.ip || null, nodePort: s.spec.ports?.[0]?.nodePort || null, endpoints: (ep?.subsets || []).reduce((n, x) => n + (x.addresses || []).length, 0), system: ['kube-system', 'ingress-nginx'].includes(s.metadata.namespace) };
      }),
      ingresses: list('ingress', null).map((i) => ({ name: i.metadata.name, ns: i.metadata.namespace, hosts: (i.spec.rules || []).map((r) => r.host || '*') })),
      pvcs: list('pvc', null).map((p) => ({ name: p.metadata.name, ns: p.metadata.namespace, phase: p.status.phase, volume: p.spec.volumeName || null })),
      configmaps: list('configmap', null).filter((c) => c.metadata.name !== 'kube-root-ca.crt' && !['kube-system', 'kube-public'].includes(c.metadata.namespace)).map((c) => ({ name: c.metadata.name, ns: c.metadata.namespace })),
      secrets: list('secret', null).filter((s) => s.type !== 'helm.sh/release.v1').map((s) => ({ name: s.metadata.name, ns: s.metadata.namespace, type: s.type })),
      hpas: list('hpa', null).map((h) => ({ name: h.metadata.name, ns: h.metadata.namespace, current: h.status.currentReplicas, target: h.spec.metrics?.[0]?.resource?.target?.averageUtilization, utilization: h.status.currentMetrics?.[0]?.resource.current.averageUtilization ?? null })),
      netpols: list('networkpolicy', null).map((n) => ({ name: n.metadata.name, ns: n.metadata.namespace })),
      namespaces: C.store.list(C.def('namespace')).map((n) => n.metadata.name),
      roles: [...list('role', null), ...list('rolebinding', null)].map((r) => ({ kind: r.kind, name: r.metadata.name, ns: r.metadata.namespace })),
      serviceaccounts: list('serviceaccount', null).filter((s) => s.metadata.name !== 'default').map((s) => ({ name: s.metadata.name, ns: s.metadata.namespace })),
      crds: C.store.list(C.def('crd')).map((c) => c.metadata.name),
      releases: [...E.helmState.releases.values()].map((r) => ({ name: r.name, ns: r.ns, revision: r.revisions.at(-1).revision, chart: r.revisions.at(-1).chart })),
      forwards: E.forwards.map((f) => ({ local: f.localPort, pod: f.pod })),
      warnings: C.store.list(C.def('event')).filter((e) => e.type === 'Warning').slice(-4).map((e) => `${e.involvedObject.name}: ${e.reason}`),
      used, files: [...files.keys()],
    };
  };

  reset();
  return {
    execute, prompt, reset, state, completions, run,
    get cluster() { return C; },
    files: fileApi,
    version: K8S_VERSION,
    fqName,
  };
};
