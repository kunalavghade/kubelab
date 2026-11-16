// What you can do inside a container (kubectl exec / run -it / debug): a small shell with the
// container's env, its mounted volumes, DNS, curl/wget, nc, and the service-account token.
import { parseImage, imageInfo } from './data.js';
import { tokenize } from './util.js';
import { isFilter, applyFilter } from './filters.js';
import { containerEnv, runtimeOf, containerRuntime, behaviourOf } from './kubelet.js';
import { resolveName, httpRequest, tcpConnect, dnsWorks, dnsBlocked } from './network.js';

const DEBIAN = /^(nginx|httpd|postgres|redis|mysql|perl|kubelab\/|bitnami\/)/;
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** The prompt a shell inside this container shows. */
export const podPrompt = (pod, c) => {
  const nonRoot = c.securityContext?.runAsUser || pod.spec.securityContext?.runAsUser;
  return DEBIAN.test(parseImage(c.image).repo) ? `${nonRoot ? 'I have no name!' : 'root'}@${pod.metadata.name}:/# ` : `/ ${nonRoot ? '$' : '#'} `;
};

// ---------- file system: image files + writable layer + volumes ----------
const imageFiles = (C, pod, c) => {
  const files = {
    '/etc/hostname': `${pod.spec.hostname || pod.metadata.name}\n`,
    '/etc/hosts': `127.0.0.1\tlocalhost\n${pod.status.podIP}\t${pod.spec.hostname ? `${pod.spec.hostname}.${pod.spec.subdomain}.${pod.metadata.namespace}.svc.cluster.local\t${pod.spec.hostname}` : pod.metadata.name}\n`,
    '/etc/resolv.conf': `search ${pod.metadata.namespace}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`,
    '/etc/os-release': DEBIAN.test(parseImage(c.image).repo) ? 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n' : 'NAME="Alpine Linux"\nVERSION_ID=3.21.0\n',
  };
  if (/^nginx/.test(c.image)) Object.assign(files, { '/usr/share/nginx/html/index.html': imageInfo(c.image).body(), '/usr/share/nginx/html/50x.html': '<h1>An error occurred.</h1>', '/etc/nginx/nginx.conf': 'user  nginx;\nworker_processes  auto;\n…\n' });
  return files;
};

const keyFiles = (C, kind, ns, name, items) => {
  const obj = C.store.get(C.def(kind), ns, name);
  if (!obj) return {};
  const decode = (v) => (kind === 'secret' ? C.unb64(v) : v);
  const entries = items?.length ? items.map((it) => [it.path, obj.data?.[it.key]]) : Object.entries(obj.data || {});
  return Object.fromEntries(entries.filter(([, v]) => v != null).map(([k, v]) => [k, decode(v)]));
};

/** Mount table: [{ path, readOnly, files() → {rel: content}, store?: Map }] */
const mountsOf = (C, pod, c) => {
  const ns = pod.metadata.namespace;
  const vols = new Map((pod.spec.volumes || []).map((v) => [v.name, v]));
  const mounts = (c.volumeMounts || []).map((m) => {
    const v = vols.get(m.name) || {};
    if (v.configMap) return { path: m.mountPath, readOnly: true, files: () => keyFiles(C, 'configmap', ns, v.configMap.name, v.configMap.items), sub: m.subPath };
    if (v.secret) return { path: m.mountPath, readOnly: true, files: () => keyFiles(C, 'secret', ns, v.secret.secretName, v.secret.items), sub: m.subPath };
    const key = v.persistentVolumeClaim ? `pv:${C.store.get(C.def('pvc'), ns, v.persistentVolumeClaim.claimName)?.spec.volumeName}`
      : v.hostPath ? `host:${pod.spec.nodeName}:${v.hostPath.path}` : `emptydir:${pod.metadata.uid}:${m.name}`;
    if (!C.volumeData.has(key)) C.volumeData.set(key, new Map());
    return { path: m.mountPath, readOnly: !!m.readOnly, store: C.volumeData.get(key) };
  });
  const token = `eyJhbGciOiJSUzI1NiIsImtpZCI6Imt1YmVsYWIifQ.${C.b64(JSON.stringify({ sub: `system:serviceaccount:${ns}:${pod.spec.serviceAccountName}` })).replace(/=+$/, '')}.c2lnbmF0dXJl`;
  if (pod.spec.automountServiceAccountToken !== false) mounts.push({ path: SA_DIR, readOnly: true, files: () => ({ token, namespace: ns, 'ca.crt': '-----BEGIN CERTIFICATE-----\n(simulated)\n-----END CERTIFICATE-----\n' }) });
  return mounts;
};

const norm = (cwd, p) => {
  const parts = (p.startsWith('/') ? p : `${cwd}/${p}`).split('/').filter(Boolean);
  const out = [];
  parts.forEach((x) => { if (x === '..') out.pop(); else if (x !== '.') out.push(x); });
  return `/${out.join('/')}`;
};

const createFs = (C, pod, c) => {
  const layer = (runtimeOf(C, pod).fs[c.name] ||= {});
  const mounts = mountsOf(C, pod, c).sort((a, b) => b.path.length - a.path.length);
  const mountFor = (path) => mounts.find((m) => path === m.path || path.startsWith(`${m.path}/`));
  const rel = (m, path) => path.slice(m.path.length + 1);
  const readOnlyRoot = c.securityContext?.readOnlyRootFilesystem;
  const fs = {
    read(path) {
      const m = mountFor(path);
      if (m) return m.store ? m.store.get(rel(m, path)) ?? null : (m.sub && path === m.path ? m.files()[m.sub] : m.files()[rel(m, path)]) ?? null;
      return layer[path] ?? imageFiles(C, pod, c)[path] ?? null;
    },
    write(path, content, append = false) {
      const m = mountFor(path);
      if (m?.readOnly || (!m && readOnlyRoot)) return `sh: can't create ${path}: Read-only file system`;
      const prev = append ? fs.read(path) || '' : '';
      if (m) m.store.set(rel(m, path), prev + content); else layer[path] = prev + content;
      return null;
    },
    remove(path) {
      const m = mountFor(path);
      if (m?.readOnly) return `rm: can't remove '${path}': Read-only file system`;
      if (m) m.store.delete(rel(m, path)); else delete layer[path];
      return null;
    },
    list(dir) {
      const d = dir === '/' ? '' : dir;
      const names = new Set();
      const add = (full) => { if (full.startsWith(`${d}/`)) names.add(full.slice(d.length + 1).split('/')[0]); };
      Object.keys({ ...imageFiles(C, pod, c), ...layer }).forEach(add);
      mounts.forEach((m) => {
        add(m.path);
        if (m.path === d || m.path === dir) (m.store ? [...m.store.keys()] : Object.keys(m.files())).forEach((k) => names.add(k.split('/')[0]));
        if (m.path === d || m.path === dir) names.delete('');
      });
      if (dir === '/') ['bin', 'dev', 'etc', 'home', 'lib', 'proc', 'root', 'run', 'sys', 'tmp', 'usr', 'var'].forEach((x) => names.add(x));
      return [...names].sort();
    },
    mounts,
  };
  return fs;
};

// ---------- commands ----------
const curlError = (res, host, port, verbose) => {
  if (res.error === 'dns') return [`curl: (6) Could not resolve host: ${host}`, 6];
  if (res.error === 'timeout') return [`curl: (28) Failed to connect to ${host} port ${port} after 10002 ms: Timeout was reached${verbose && res.blocked ? `\n# (blocked by NetworkPolicy ${res.blocked.policies.join(', ')} — ${res.blocked.dir})` : ''}`, 28];
  return [`curl: (7) Failed to connect to ${host} port ${port} after 3 ms: Couldn't connect to server`, 7];
};

/** curl / wget for both the pod shell and the host. src: { pod?, ip }. */
export const runHttp = (C, src, args, { forwards = [], wget = false } = {}) => {
  let url = null, head = false, outNull = false, write = null, hostHeader = null, quiet = false, withHeaders = false, method = 'GET', auth = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-s', '--silent', '-sS', '-q', '-L', '-k', '--insecure', '-f', '-v'].includes(a)) { if (a === '-q') quiet = true; continue; }
    if (a === '-I' || a === '--head') { head = true; continue; }
    if (a === '-i') { withHeaders = true; continue; }
    if (a === '-o' || a === '-O') { outNull = args[i + 1] === '/dev/null'; if (wget && args[i + 1] === '-') outNull = false; i++; continue; }
    if (a === '-qO-' || a === '-O-') { quiet = true; continue; }
    if (a === '-w' || a === '--write-out') { write = args[++i]; continue; }
    if (a === '-H' || a === '--header') { const h = args[++i] || ''; if (/^host:/i.test(h)) hostHeader = h.split(':')[1].trim(); if (/^authorization:/i.test(h)) auth = h.split(':').slice(1).join(':').trim(); continue; }
    if (a === '-X') { method = args[++i]; continue; }
    if (['-m', '--max-time', '--connect-timeout', '-T', '--timeout', '-d', '--data'].includes(a)) { i++; continue; }
    if (!a.startsWith('-')) url = a;
  }
  if (!url) return { lines: [wget ? 'BusyBox v1.37.0 multi-call binary.\n\nUsage: wget [-cqS] [-O FILE] URL' : 'curl: try \'curl --help\' for more information'], code: 2 };
  if (/kubernetes\.default|10\.96\.0\.1\b|^https:\/\/kubernetes/.test(url)) return apiFromPod(C, src, url, auth, method);
  const res = httpRequest(C, src, url, { hostHeader, forwards });
  const host = /^(?:https?:\/\/)?([^/:]+)/.exec(url)[1];
  const port = /:(\d+)/.exec(url.replace(/^https?:\/\//, ''))?.[1] || '80';
  if (res.error) {
    if (wget) return { lines: [res.error === 'dns' ? `wget: bad address '${host}'` : res.error === 'timeout' ? 'wget: download timed out' : `wget: can't connect to remote host (${host}): Connection refused`], code: 1 };
    const [msg, code] = curlError(res, host, port, true);
    return { lines: write?.includes('http_code') ? ['000', msg] : [msg], code };
  }
  const statusText = { 200: 'OK', 404: 'Not Found', 503: 'Service Temporarily Unavailable' }[res.status] || '';
  const headers = [`HTTP/1.1 ${res.status} ${statusText}`, `Server: ${res.via === 'ingress' ? 'nginx' : 'nginx/1.27.3'}`, 'Date: Mon, 16 Nov 2026 09:00:00 GMT', 'Content-Type: text/html', `Content-Length: ${res.body.length}`, 'Connection: keep-alive', ''];
  if (wget && res.status >= 400) return { lines: [`wget: server returned error: HTTP/1.1 ${res.status} ${statusText}`], code: 1 };
  const lines = [];
  if (head || withHeaders) lines.push(...headers);
  if (!head && !outNull) lines.push(...res.body.split(/\r?\n/));
  if (write) lines.push(write.replace(/%\{http_code\}/g, String(res.status)).replace(/\\n/g, '\n').replace(/%\{remote_ip\}/g, res.pod?.status.podIP || ''));
  if (wget && !quiet && !lines.length) lines.push(`Connecting to ${host}`, "saving to 'index.html'", "'index.html' saved");
  return { lines, code: 0, pod: res.pod };
};

// Calls to the API server from inside a pod use its service-account token and RBAC.
const apiFromPod = (C, src, url, auth, method) => {
  const path = /https?:\/\/[^/]+(\/.*)?/.exec(url)?.[1] || '/';
  if (!auth) return { lines: ['{', '  "kind": "Status",', '  "apiVersion": "v1",', '  "status": "Failure",', '  "message": "forbidden: User \\"system:anonymous\\" cannot get path \\"' + path + '\\"",', '  "reason": "Forbidden",', '  "code": 403', '}'], code: 0 };
  const sa = src.pod ? `system:serviceaccount:${src.pod.metadata.namespace}:${src.pod.spec.serviceAccountName}` : 'kubernetes-admin';
  const m = /^\/api\/v1\/namespaces\/([^/]+)\/([^/?]+)/.exec(path);
  if (!m) return { lines: ['{', '  "paths": ["/api", "/api/v1", "/apis", "/healthz", "/version"]', '}'], code: 0 };
  const allowed = C.authorize?.({ user: sa, groups: ['system:serviceaccounts', `system:serviceaccounts:${src.pod?.metadata.namespace}`, 'system:authenticated'] }, method === 'GET' ? 'list' : method.toLowerCase(), m[2], m[1]);
  if (!allowed) return { lines: ['{', '  "kind": "Status",', '  "status": "Failure",', `  "message": "${m[2]} is forbidden: User \\"${sa}\\" cannot list resource \\"${m[2]}\\" in API group \\"\\" in the namespace \\"${m[1]}\\"",`, '  "reason": "Forbidden",', '  "code": 403', '}'], code: 0 };
  const items = C.store.list(C.def(m[2]), m[1]).map((o) => `    { "metadata": { "name": "${o.metadata.name}", "namespace": "${m[1]}" } }`);
  return { lines: ['{', `  "kind": "${C.def(m[2])?.kind || 'Unknown'}List",`, '  "apiVersion": "v1",', '  "items": [', items.join(',\n'), '  ]', '}'], code: 0 };
};

const nslookup = (C, pod, name) => {
  const server = ['Server:\t\t10.96.0.10', 'Address:\t10.96.0.10:53', ''];
  if (!dnsWorks(C) || dnsBlocked(C, pod)) return { lines: [';; connection timed out; no servers could be reached', ''], code: 1 };
  const r = resolveName(C, name, pod.metadata.namespace);
  if (!r) return { lines: [...server, `** server can't find ${name}.${pod.metadata.namespace}.svc.cluster.local: NXDOMAIN`, '', `** server can't find ${name}: NXDOMAIN`, ''], code: 1 };
  const answers = r.cname ? [`${r.fqdn}\tcanonical name = ${r.cname}`, ...r.ips.flatMap((ip) => [`Name:\t${r.cname}`, `Address: ${ip}`])] : r.ips.flatMap((ip) => [`Name:\t${r.fqdn}`, `Address: ${ip}`]);
  return { lines: [...server, ...answers, ''], code: 0 };
};

const PS = (C, pod, c) => {
  const target = c.targetContainerName && pod.spec.containers.find((x) => x.name === c.targetContainerName);
  if (target) return [...PS(C, pod, target).slice(0, -2), '   53 root      0:00 sh', '   59 root      0:00 ps'];
  const b = behaviourOf(c);
  const main = { nginx: 'nginx: master process nginx -g daemon off;', redis: 'redis-server *:6379', postgres: 'postgres', httpd: 'httpd -DFOREGROUND', 'kubelab/hello': '/hello' }[parseImage(c.image).repo]
    || [...(c.command || []), ...(c.args || [])].join(' ') || (b.kind === 'command' ? 'sh' : parseImage(c.image).repo);
  const lines = ['PID   USER     TIME  COMMAND', `    1 root      0:00 ${main}`];
  if (/^nginx/.test(c.image)) lines.push('   29 nginx     0:00 nginx: worker process', '   30 nginx     0:00 nginx: worker process');
  lines.push('   41 root      0:00 sh', '   47 root      0:00 ps aux');
  return lines;
};

/**
 * Runs one command line inside a container. Returns { lines, code, exit?: true } — exit means
 * the interactive shell should close (the user typed exit or killed PID 1).
 */
export const runInContainer = (C, pod, c, line, { forwards = [] } = {}) => {
  const env = { ...containerEnv(C, pod, c), ...(runtimeOf(C, pod).shellEnv ||= {}) };
  const expanded = line.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k) => env[k] ?? '').replace(/\$\(cat ([^)]+)\)/g, (m, f) => (createFs(C, pod, c).read(f.trim()) || '').trim());
  const fs = createFs(C, pod, c);
  const cwd = runtimeOf(C, pod).cwd || '/';
  let toks;
  try { toks = tokenize(expanded); } catch (err) { return { lines: [err.message], code: 2 }; }
  const redirect = toks.findIndex((t) => typeof t === 'object' && (t.op === '>' || t.op === '>>'));
  const words = (redirect >= 0 ? toks.slice(0, redirect) : toks).filter((t) => typeof t === 'string');
  if (toks.some((t) => typeof t === 'object' && ['&&', ';', '|', '||'].includes(t.op))) {
    // Simple chains: run each part; pipes only feed grep/head/wc.
    return runChain(C, pod, c, toks, { forwards });
  }
  const [cmd, ...args] = words;
  const result = (lines, code = 0) => {
    if (redirect >= 0) {
      const target = norm(cwd, toks[redirect + 1] || '');
      const err = fs.write(target, lines.length ? `${lines.join('\n')}\n` : '', toks[redirect].op === '>>');
      return err ? { lines: [err], code: 1 } : { lines: [], code };
    }
    return { lines, code };
  };
  const bin = (cmd || '').split('/').pop();
  const HANDLERS = {
    exit: () => ({ lines: [], code: 0, exit: true }),
    env: () => result(Object.entries(env).map(([k, v]) => `${k}=${v}`)),
    printenv: () => result(args.length ? args.map((k) => env[k]).filter((v) => v != null) : Object.entries(env).map(([k, v]) => `${k}=${v}`), args.length && env[args[0]] == null ? 1 : 0),
    echo: () => result([args.filter((a) => a !== '-n').join(' ')]),
    hostname: () => result([pod.spec.hostname || pod.metadata.name]),
    whoami: () => result([c.securityContext?.runAsUser || pod.spec.securityContext?.runAsUser ? `whoami: unknown uid ${c.securityContext?.runAsUser || pod.spec.securityContext.runAsUser}` : 'root']),
    id: () => { const u = c.securityContext?.runAsUser ?? pod.spec.securityContext?.runAsUser ?? 0; return result([`uid=${u}${u ? '' : '(root)'} gid=${u}${u ? '' : '(root)'} groups=${u}${u ? '' : '(root)'}`]); },
    pwd: () => result([cwd]),
    cd: () => { runtimeOf(C, pod).cwd = norm(cwd, args[0] || '/'); return result([]); },
    ls: () => {
      const target = norm(cwd, args.filter((a) => !a.startsWith('-'))[0] || '.');
      const file = fs.read(target);
      if (file != null) return result([target.split('/').pop()]);
      const entries = fs.list(target);
      if (!entries.length) return result([`ls: ${target}: No such file or directory`], 1);
      return result(args.includes('-l') || args.includes('-la') ? entries.map((e) => `-rw-r--r--    1 root     root          ${String((fs.read(`${target}/${e}`) || '').length).padStart(5)} Nov 16 09:00 ${e}`) : [entries.join('  ')]);
    },
    cat: () => {
      const out = [];
      for (const f of args) {
        const content = fs.read(norm(cwd, f));
        if (content == null) return result([...out, `cat: can't open '${f}': No such file or directory`], 1);
        out.push(...String(content).replace(/\n$/, '').split('\n'));
      }
      return result(out);
    },
    touch: () => { for (const f of args) { const err = fs.read(norm(cwd, f)) == null && fs.write(norm(cwd, f), ''); if (err) return result([err.replace('sh: can\'t create', 'touch:')], 1); } return result([]); },
    rm: () => { for (const f of args.filter((a) => !a.startsWith('-'))) { const err = fs.remove(norm(cwd, f)); if (err) return result([err], 1); } return result([]); },
    mkdir: () => result([]),
    ps: () => result(PS(C, pod, c)),
    date: () => result([new Date(C.clock.now()).toUTCString().replace('GMT', 'UTC')]),
    uname: () => result([args.includes('-a') ? `Linux ${pod.metadata.name} 6.8.0-49-generic #49-Ubuntu SMP x86_64 GNU/Linux` : 'Linux']),
    df: () => result(['Filesystem                Size      Used Available Use% Mounted on', 'overlay                  58.4G     12.1G     43.3G  22% /', ...fs.mounts.map((m) => `${m.store ? '/dev/sda1' : 'tmpfs'}                  ${m.store ? '58.4G' : '7.6G'}     ${m.store ? '12.1G' : '12.0K'}     ${m.store ? '43.3G' : '7.6G'}   1% ${m.path}`)]),
    mount: () => result(fs.mounts.map((m) => `${m.store ? '/dev/sda1' : 'tmpfs'} on ${m.path} type ${m.store ? 'ext4' : 'tmpfs'} (${m.readOnly ? 'ro' : 'rw'},relatime)`)),
    nslookup: () => (args[0] ? nslookup(C, pod, args.filter((a) => !a.startsWith('-'))[0]) : result(['BusyBox v1.37.0 multi-call binary.', '', 'Usage: nslookup [-type=QUERY_TYPE] [-debug] HOST [DNS_SERVER]'], 1)),
    host: () => { const r = dnsWorks(C) && resolveName(C, args[0], pod.metadata.namespace); return r ? result(r.ips.map((ip) => `${r.fqdn} has address ${ip}`)) : result([`Host ${args[0]} not found: 3(NXDOMAIN)`], 1); },
    dig: () => { const r = dnsWorks(C) && resolveName(C, args.filter((a) => !a.startsWith('+'))[0], pod.metadata.namespace); return result(args.includes('+short') ? (r?.ips || []) : [';; ANSWER SECTION:', ...(r?.ips || []).map((ip) => `${r.fqdn}.\t30\tIN\tA\t${ip}`)]); },
    curl: () => { const r = runHttp(C, { pod, ip: pod.status.podIP }, args, { forwards }); return result(r.lines, r.code); },
    wget: () => { const r = runHttp(C, { pod, ip: pod.status.podIP }, args, { forwards, wget: true }); return result(r.lines, r.code); },
    ping: () => {
      const target = args.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a)).pop();
      const r = resolveName(C, target, pod.metadata.namespace);
      if (!r) return result([`ping: bad address '${target}'`], 1);
      const isSvc = C.store.list(C.def('service')).some((s) => s.spec.clusterIP === r.ips[0]);
      // A ClusterIP is virtual: nothing answers ICMP on it.
      return isSvc ? result([`PING ${target} (${r.ips[0]}): 56 data bytes`, '', `--- ${target} ping statistics ---`, '3 packets transmitted, 0 packets received, 100% packet loss'], 1)
        : result([`PING ${target} (${r.ips[0]}): 56 data bytes`, `64 bytes from ${r.ips[0]}: seq=0 ttl=63 time=0.091 ms`, `64 bytes from ${r.ips[0]}: seq=1 ttl=63 time=0.102 ms`, '', `--- ${target} ping statistics ---`, '2 packets transmitted, 2 packets received, 0% packet loss']);
    },
    nc: () => {
      const [host, port] = args.filter((a) => !a.startsWith('-'));
      const r = tcpConnect(C, { pod, ip: pod.status.podIP }, host, Number(port));
      return r.ok ? result([`${host} (${resolveName(C, host, pod.metadata.namespace)?.ips[0] || host}:${port}) open`]) : result([r.error === 'timeout' ? `nc: ${host} (${port}): Operation timed out` : `nc: ${host} (${port}): Connection refused`], 1);
    },
    'redis-cli': () => {
      const h = args.indexOf('-h') >= 0 ? args[args.indexOf('-h') + 1] : '127.0.0.1';
      const cmdArgs = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '-h' && args[i - 1] !== '-p');
      if (h !== '127.0.0.1' && h !== 'localhost') { const r = tcpConnect(C, { pod, ip: pod.status.podIP }, h, 6379); if (!r.ok) return result([`Could not connect to Redis at ${h}:6379: ${r.error === 'dns' ? 'Name does not resolve' : 'Connection refused'}`], 1); }
      const op = (cmdArgs[0] || 'ping').toLowerCase();
      const data = (C.redisData ||= new Map());
      const map = { ping: () => 'PONG', set: () => { data.set(cmdArgs[1], cmdArgs.slice(2).join(' ')); return 'OK'; }, get: () => (data.has(cmdArgs[1]) ? `"${data.get(cmdArgs[1])}"` : '(nil)'), info: () => '# Server\nredis_version:7.4.1', dbsize: () => `(integer) ${data.size}` };
      return result([(map[op] || (() => `(error) ERR unknown command '${op}'`))()]);
    },
    kill: () => {
      const pid = args.filter((a) => !a.startsWith('-')).pop();
      if (pid !== '1') return result([]);
      const cr = containerRuntime(C, pod, c.name);
      const finishedAt = C.clock.iso();
      Object.assign(cr, {
        last: { exitCode: 137, reason: 'Error', startedAt: cr.startedAt, finishedAt }, prevLogs: cr.logs, ready: false,
        ...(pod.spec.restartPolicy === 'Never' ? { state: 'terminated', exitCode: 137, reason: 'Error', finishedAt } : { state: 'waiting', reason: 'CrashLoopBackOff', restarts: cr.restarts + 1, backoff: 1, backoffLeft: 1, message: 'back-off 10s restarting failed container' }),
      });
      C.record(pod, 'Normal', 'Killing', `Container ${c.name} was killed (PID 1 received SIGKILL)`);
      return { lines: ['command terminated with exit code 137'], code: 137, exit: true };
    },
    sleep: () => result([]),
    true: () => result([]),
    false: () => result([], 1),
    sh: () => result([]), bash: () => result([]),
    apk: () => result(args[0] === 'add' ? ['fetch https://dl-cdn.alpinelinux.org/alpine/v3.21/main/x86_64/APKINDEX.tar.gz', `(1/1) Installing ${args[args.length - 1]}`, 'OK: 8 MiB in 16 packages'] : ['apk-tools 2.14.6']),
    'apt-get': () => result(args[0] === 'install' ? ['Reading package lists... Done', `Setting up ${args[args.length - 1]} ...`] : ['Reading package lists... Done']),
    export: () => { args.forEach((a) => { const [k, ...v] = a.split('='); runtimeOf(C, pod).shellEnv[k] = v.join('='); }); return result([]); },
    nginx: () => result(args.includes('-v') || args.includes('-V') ? ['nginx version: nginx/1.27.3'] : args.includes('-t') ? ['nginx: the configuration file /etc/nginx/nginx.conf syntax is ok', 'nginx: configuration file /etc/nginx/nginx.conf test is successful'] : ['nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address in use)'], args.some((a) => /^-[vVt]$/.test(a)) ? 0 : 1),
    stress: () => result(['stress: info: [1] dispatching hogs: 0 cpu, 0 io, 1 vm, 0 hdd']),
    perl: () => result([args.join(' ').includes('bpi') ? '3.14159265358979323846264338327950288419716939937510' : '']),
    psql: () => result(['psql (17.2)', 'Type "help" for help.', '', 'postgres=# (the simulator does not run SQL — try \\q)']),
  };
  if (!cmd) return result([]);
  const handler = HANDLERS[bin];
  if (!handler) return result([`sh: ${cmd}: not found`], 127);
  return handler();
};

const quote = (t) => (typeof t === 'string' ? (/[\s;&|]/.test(t) || t === '' ? `'${t}'` : t) : t.op);

// "a | grep x && b; c": pipelines joined by && || ; — later pipe stages are text filters.
const runChain = (C, pod, c, toks, opts) => {
  const lines = [];
  let code = 0, skip = false, stage = [], pipeline = [];
  const runPipeline = () => {
    const [first, ...rest] = pipeline;
    const r = runInContainer(C, pod, c, first.map(quote).join(' '), opts);
    let out = r.lines;
    for (const seg of rest) {
      const [cmd, ...args] = seg.filter((t) => typeof t === 'string');
      out = isFilter(cmd) ? applyFilter(cmd, args, out) : [`sh: ${cmd}: not found`];
    }
    return { ...r, lines: out };
  };
  const end = (op) => {
    pipeline.push(stage);
    stage = [];
    if (op === '|') return false;
    if (!skip) {
      const r = runPipeline();
      lines.push(...r.lines);
      code = r.code;
      if (r.exit) return true;
    }
    pipeline = [];
    skip = (op === '&&' && code !== 0) || (op === '||' && code === 0);
    return false;
  };
  for (const t of toks) {
    if (typeof t === 'object' && ['&&', ';', '||', '|'].includes(t.op)) { if (end(t.op)) return { lines, code, exit: true }; continue; }
    stage.push(t);
  }
  end(null);
  return { lines, code };
};
