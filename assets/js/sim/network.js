// Cluster networking: CoreDNS name resolution, Service load-balancing through kube-proxy,
// NodePorts, LoadBalancers, Ingress routing and NetworkPolicy enforcement.
import { matchesSelector, matchesMap } from './api.js';
import { imageInfo, parseImage } from './data.js';
import { behaviourOf } from './kubelet.js';

const CLUSTER_DOMAIN = 'cluster.local';
const EXTERNAL = { 'example.com': '93.184.215.14', 'google.com': '142.250.74.46', 'kubernetes.io': '15.197.167.90', 'registry-1.docker.io': '54.236.113.205' };
const roundRobin = new Map();

// ---------- DNS ----------
const services = (C, ns) => C.store.list(C.def('service'), ns);
const nsExists = (C, ns) => !!C.store.get(C.def('namespace'), null, ns);

/** Answers one fully-qualified name: { ips, cname } or null for NXDOMAIN. */
const answer = (C, fqdn) => {
  const name = fqdn.replace(/\.$/, '');
  if (EXTERNAL[name]) return { ips: [EXTERNAL[name]] };
  const svcMatch = new RegExp(`^(?:([a-z0-9-]+)\\.)?([a-z0-9-]+)\\.([a-z0-9-]+)\\.svc\\.${CLUSTER_DOMAIN.replace('.', '\\.')}$`).exec(name);
  if (svcMatch) {
    const [, host, svcName, ns] = svcMatch;
    const svc = nsExists(C, ns) && C.store.get(C.def('service'), ns, svcName);
    if (!svc) return null;
    if (svc.spec.type === 'ExternalName') return { cname: svc.spec.externalName, ips: answer(C, svc.spec.externalName)?.ips || [] };
    const ep = C.store.get(C.def('endpoints'), ns, svcName);
    const addrs = (ep?.subsets || []).flatMap((s) => s.addresses || []);
    if (host) {
      const a = addrs.find((x) => x.hostname === host);
      return a ? { ips: [a.ip] } : null;
    }
    if (svc.spec.clusterIP === 'None') return addrs.length ? { ips: addrs.map((a) => a.ip) } : null;
    return { ips: [svc.spec.clusterIP] };
  }
  const podMatch = new RegExp(`^(\\d+-\\d+-\\d+-\\d+)\\.([a-z0-9-]+)\\.pod\\.${CLUSTER_DOMAIN.replace('.', '\\.')}$`).exec(name);
  if (podMatch) return { ips: [podMatch[1].replace(/-/g, '.')] };
  return null;
};

/** Resolves a name the way a pod's resolver does: search domains when the name has fewer than 5 dots. */
export const resolveName = (C, name, ns = 'default') => {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return { fqdn: name, ips: [name] };
  const absolute = name.endsWith('.');
  const search = [`${ns}.svc.${CLUSTER_DOMAIN}`, `svc.${CLUSTER_DOMAIN}`, CLUSTER_DOMAIN];
  const candidates = absolute || name.split('.').length - 1 >= 5 ? [name] : [...search.map((d) => `${name}.${d}`), name];
  for (const fqdn of candidates) {
    const a = answer(C, fqdn);
    if (a) return { fqdn: fqdn.replace(/\.$/, ''), ...a };
  }
  return null;
};

export const dnsWorks = (C) => {
  const ep = C.store.get(C.def('endpoints'), 'kube-system', 'kube-dns');
  return (ep?.subsets || []).some((s) => s.addresses?.length);
};

// ---------- NetworkPolicy ----------
const ipInCidr = (ip, cidr) => {
  const [base, bits] = cidr.split('/');
  const toInt = (x) => x.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
};

const peerMatches = (C, policy, peer, src) => {
  if (peer.ipBlock) return ipInCidr(src.ip, peer.ipBlock.cidr) && !(peer.ipBlock.except || []).some((e) => ipInCidr(src.ip, e));
  if (!src.pod) return false;
  const nsLabels = C.store.get(C.def('namespace'), null, src.pod.metadata.namespace)?.metadata.labels || {};
  const nsOk = peer.namespaceSelector ? matchesSelector(nsLabels, peer.namespaceSelector) || !Object.keys(peer.namespaceSelector).length : src.pod.metadata.namespace === policy.metadata.namespace;
  const podOk = peer.podSelector ? (!Object.keys(peer.podSelector).length || matchesSelector(src.pod.metadata.labels, peer.podSelector)) : true;
  return nsOk && podOk;
};

const portMatches = (rulePorts, pod, port) => !rulePorts?.length || rulePorts.some((p) => {
  const n = typeof p.port === 'string' ? pod?.spec.containers.flatMap((c) => c.ports || []).find((x) => x.name === p.port)?.containerPort : p.port;
  return p.port == null || (n === port) || (p.endPort && port >= n && port <= p.endPort);
});

const policyTypes = (np) => np.spec.policyTypes || ['Ingress', ...(np.spec.egress ? ['Egress'] : [])];
const selecting = (C, pod, dir) => C.store.list(C.def('networkpolicy'), pod.metadata.namespace)
  .filter((np) => policyTypes(np).includes(dir) && (!Object.keys(np.spec.podSelector || {}).length || matchesSelector(pod.metadata.labels, np.spec.podSelector)));

/** Is traffic from src ({pod?, ip}) to dst pod on port allowed by NetworkPolicies? Returns the blocking policy or null. */
export const policyBlock = (C, src, dst, port) => {
  if (src.pod) {
    const egress = selecting(C, src.pod, 'Egress');
    const allowedOut = !egress.length || egress.some((np) => (np.spec.egress || []).some((rule) => (!rule.to?.length || rule.to.some((peer) => peerMatches(C, np, peer, { pod: dst, ip: dst.status.podIP }))) && portMatches(rule.ports, dst, port)));
    if (!allowedOut) return { dir: 'egress', policies: egress.map((n) => n.metadata.name) };
  }
  const ingress = selecting(C, dst, 'Ingress');
  const allowedIn = !ingress.length || ingress.some((np) => (np.spec.ingress || []).some((rule) => (!rule.from?.length || rule.from.some((peer) => peerMatches(C, np, peer, src))) && portMatches(rule.ports, dst, port)));
  return allowedIn ? null : { dir: 'ingress', policies: ingress.map((n) => n.metadata.name) };
};

/** DNS needs egress to kube-dns on port 53 when the source pod has egress policies. */
export const dnsBlocked = (C, srcPod) => {
  if (!srcPod) return false;
  const dns = C.store.list(C.def('pod'), 'kube-system').find((p) => p.metadata.labels?.['k8s-app'] === 'kube-dns');
  return !!(dns && policyBlock(C, { pod: srcPod, ip: srcPod.status.podIP }, dns, 53)?.dir === 'egress');
};

// ---------- HTTP ----------
const podByIp = (C, ip) => C.store.list(C.def('pod')).find((p) => p.status.podIP === ip && !p.metadata.deletionTimestamp);
const serviceByIp = (C, ip) => C.store.list(C.def('service')).find((s) => s.spec.clusterIP === ip);
const nodeByIp = (C, ip) => C.nodes().find((n) => n.status.addresses[0].address === ip);
const lbService = (C, ip) => C.store.list(C.def('service')).find((s) => s.status.loadBalancer?.ingress?.some((i) => i.ip === ip));

const pickEndpoint = (C, svc, port) => {
  const ep = C.store.get(C.def('endpoints'), svc.metadata.namespace, svc.metadata.name);
  const sp = (svc.spec.ports || []).find((p) => p.port === port) || (port == null ? svc.spec.ports?.[0] : null);
  if (!sp) return { error: 'refused' };
  const addrs = (ep?.subsets || []).flatMap((s) => (s.addresses || []).map((a) => ({ ip: a.ip, port: s.ports.find((p) => p.name === sp.name || s.ports.length === 1)?.port ?? sp.targetPort })));
  if (!addrs.length) return { error: 'refused' };
  const key = `${svc.metadata.namespace}/${svc.metadata.name}`;
  const n = roundRobin.get(key) || 0;
  roundRobin.set(key, n + 1);
  const pick = svc.spec.sessionAffinity === 'ClientIP' ? addrs[0] : addrs[n % addrs.length];
  return { ...pick };
};

/** Delivers one request to a pod: the app must be running and listening on the port. */
const deliver = (C, src, pod, port, path, host) => {
  if (!pod || pod.status.phase !== 'Running') return { error: 'refused' };
  const blocked = src.self ? null : policyBlock(C, src, pod, port);
  if (blocked) return { error: 'timeout', blocked };
  const c = pod.spec.containers.find((x) => {
    const b = behaviourOf(x);
    return b.kind === 'server' && !b.loop && b.info?.port === port;
  });
  const status = pod.status.containerStatuses?.find((s) => s.name === c?.name);
  if (!c || !status?.state?.running) return { error: 'refused' };
  const info = imageInfo(c.image);
  const ctx = { pod: pod.metadata.name, tag: parseImage(c.image).tag, path, clientIp: src.ip, host };
  const files = C.rt.get(pod.metadata.uid)?.fs?.[c.name] || {};
  const custom = path === '/' ? files['/usr/share/nginx/html/index.html'] : files[`/usr/share/nginx/html${path}`];
  const rt = C.rt.get(pod.metadata.uid)?.containers?.[c.name];
  if (rt && info.accessLog) rt.logs.push(info.accessLog(ctx));
  if (info.cpuPerRequest && rt) rt.requests = (rt.requests || 0) + 1;
  if (custom != null) return { status: 200, body: custom, pod };
  if (info.body && (path === '/' || path === '' || !/nginx/.test(c.image) || path === '/index.html')) return { status: 200, body: info.body(ctx), pod };
  return { status: 404, body: '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx/1.27.3</center>\r\n</body>\r\n</html>', pod };
};

const ingressRoute = (C, host, path) => {
  const rules = C.store.list(C.def('ingress')).flatMap((ing) => (ing.spec.rules || []).filter((r) => !r.host || r.host === host || (r.host.startsWith('*.') && host.endsWith(r.host.slice(1))))
    .flatMap((r) => (r.http?.paths || []).map((p) => ({ ing, p, specific: r.host ? 1 : 0 }))));
  const matches = rules.filter(({ p }) => (p.pathType === 'Exact' ? path === p.path : path === p.path || path.startsWith(p.path.endsWith('/') ? p.path : `${p.path}/`) || p.path === '/'))
    .sort((a, b) => b.specific - a.specific || b.p.path.length - a.p.path.length);
  return matches[0] || null;
};

const NGINX_ERROR = (code, text) => ({ status: code, body: `<html>\r\n<head><title>${code} ${text}</title></head>\r\n<body>\r\n<center><h1>${code} ${text}</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>` });

/**
 * Sends an HTTP request. src: { pod?, ip, node? } (a pod, or the host machine).
 * Returns { status, body, pod } or { error: 'refused' | 'timeout' | 'dns', blocked? }.
 */
export const httpRequest = (C, src, url, { hostHeader, forwards = [] } = {}) => {
  const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/[^\s]*)?$/.exec(url);
  if (!m) return { error: 'url' };
  const [, scheme = 'http', host, portText, path = '/'] = m;
  const port = Number(portText || (scheme === 'https' ? 443 : 80));
  const fromHost = !src.pod;

  if (!fromHost && ['localhost', '127.0.0.1'].includes(host)) return deliver(C, { pod: src.pod, ip: '127.0.0.1', self: true }, src.pod, port, path, host);
  // From the laptop: port-forwards, NodePorts, LoadBalancer IPs and the ingress controller.
  if (fromHost && ['localhost', '127.0.0.1'].includes(host)) {
    const fwd = forwards.find((f) => f.localPort === port);
    if (fwd) {
      const pod = C.store.get(C.def('pod'), fwd.ns, fwd.pod);
      return pod ? deliver(C, { ip: '127.0.0.1', viaForward: true }, pod, fwd.remotePort, path, host) : { error: 'refused', note: `error: lost connection to pod ${fwd.pod}` };
    }
    const node = C.nodes().find((n) => n.metadata.name === 'control-plane');
    return viaNodePort(C, node, port, path, host);
  }
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : (fromHost ? hostLookup(C, host) : resolveName(C, host, src.pod.metadata.namespace)?.ips?.[0]);
  if (!ip) return { error: 'dns', host };
  if (EXTERNAL[host] || Object.values(EXTERNAL).includes(ip)) return { status: 200, body: `<!doctype html><html><head><title>${host}</title></head><body><h1>${host}</h1></body></html>` };

  const lb = lbService(C, ip);
  if (lb) return lb.metadata.namespace === 'ingress-nginx' ? viaIngress(C, src, hostHeader || host, path) : viaService(C, { ip: '172.18.0.1' }, lb, port, path, host);
  const node = nodeByIp(C, ip);
  if (node) return viaNodePort(C, node, port, path, hostHeader || host);
  if (fromHost) return { error: 'timeout' }; // pod and Service IPs are not routable from outside the cluster
  const svc = serviceByIp(C, ip);
  if (svc) return viaService(C, src, svc, port, path, host);
  const pod = podByIp(C, ip);
  return pod ? deliver(C, src, pod, port, path, host) : { error: 'timeout' };
};

const viaService = (C, src, svc, port, path, host) => {
  const ep = pickEndpoint(C, svc, port);
  if (ep.error) return ep;
  return deliver(C, src, podByIp(C, ep.ip), ep.port, path, host);
};

const viaNodePort = (C, node, port, path, host) => {
  const svc = C.store.list(C.def('service')).find((s) => (s.spec.ports || []).some((p) => p.nodePort === port));
  if (!svc) return { error: 'refused' };
  if (svc.metadata.namespace === 'ingress-nginx') return viaIngress(C, { ip: node.status.addresses[0].address }, host, path);
  const sp = svc.spec.ports.find((p) => p.nodePort === port);
  return viaService(C, { ip: node.status.addresses[0].address }, svc, sp.port, path, host);
};

const viaIngress = (C, src, host, path) => {
  const controller = C.store.list(C.def('pod'), 'ingress-nginx').find((p) => p.status.phase === 'Running');
  if (!controller) return { error: 'refused' };
  const route = ingressRoute(C, host, path);
  if (!route) return { ...NGINX_ERROR(404, 'Not Found'), via: 'ingress' };
  const { ing, p } = route;
  const svc = C.store.get(C.def('service'), ing.metadata.namespace, p.backend.service.name);
  if (!svc) return { ...NGINX_ERROR(503, 'Service Temporarily Unavailable'), via: 'ingress' };
  const port = p.backend.service.port.number ?? svc.spec.ports.find((x) => x.name === p.backend.service.port.name)?.port;
  const res = viaService(C, { pod: controller, ip: controller.status.podIP }, svc, port, path, host);
  if (res.error) return { ...NGINX_ERROR(503, 'Service Temporarily Unavailable'), via: 'ingress' };
  return { ...res, via: 'ingress' };
};

// The lab's /etc/hosts sends every Ingress host to the ingress controller's address.
const hostLookup = (C, host) => {
  if (EXTERNAL[host]) return EXTERNAL[host];
  const known = C.store.list(C.def('ingress')).some((i) => (i.spec.rules || []).some((r) => r.host === host || (r.host?.startsWith('*.') && host.endsWith(r.host.slice(1)))));
  return known ? C.store.get(C.def('service'), 'ingress-nginx', 'ingress-nginx-controller')?.status.loadBalancer?.ingress?.[0]?.ip : null;
};

/** TCP connect (nc -z, redis-cli, psql): like HTTP but without a response body. */
export const tcpConnect = (C, src, host, port) => {
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : resolveName(C, host, src.pod?.metadata.namespace)?.ips?.[0];
  if (!ip) return { error: 'dns' };
  const svc = serviceByIp(C, ip);
  const target = svc ? (() => { const ep = pickEndpoint(C, svc, port); return ep.error ? null : { pod: podByIp(C, ep.ip), port: ep.port }; })() : { pod: podByIp(C, ip), port };
  if (!target?.pod || target.pod.status.phase !== 'Running') return { error: 'refused' };
  const blocked = policyBlock(C, src, target.pod, target.port);
  if (blocked) return { error: 'timeout', blocked };
  const listening = target.pod.spec.containers.some((c) => imageInfo(c.image)?.port === target.port);
  return listening ? { ok: true, pod: target.pod } : { error: 'refused' };
};

export { matchesMap };
