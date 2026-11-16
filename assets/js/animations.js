// Animation registry and the shared visual vocabulary for every lesson scene.
// Lesson animations live in anim/<level>.js and register themselves on ANIMATIONS.
import { h, wait, escapeHtml, removeAnimated } from './dom.js';

export const ANIMATIONS = {};

// ---------- generic helpers ----------
const mkTerm = (style = {}) => h('div', { class: 'term', style });
const out = (t, html) => { t.append(h('div', { html })); t.scrollTop = t.scrollHeight; };
const typed = (t, cmd, prompt = '$') => out(t, `<span class="p">${prompt}</span> ${escapeHtml(cmd)}`);
const mkBar = (cls = '') => h('div', { class: `bar ${cls}` }, h('i'));
const setBar = (bar, pct) => { bar.firstChild.style.width = `${Math.max(0, Math.min(100, pct))}%`; };
const title = (text, small) => h('div', { class: 'node-title' }, text, small && h('small', {}, small));
const zone = (label, body) => h('div', { class: 'zone' }, h('div', { class: 'zone-title' }, label), body);
const rand = (a, b) => a + Math.random() * (b - a);
const shortHash = () => Math.random().toString(36).slice(2, 7);

// ---------- Kubernetes building blocks ----------
const POD_STATUS = ['pending', 'creating', 'running', 'ready', 'terminating', 'failed', 'crash', 'succeeded'];
const STATUS_TEXT = { pending: 'Pending', creating: 'ContainerCreating', running: 'Running', ready: 'Running', terminating: 'Terminating', failed: 'Error', crash: 'CrashLoopBackOff', succeeded: 'Completed' };

/**
 * A pod card. Returns the element with helpers attached:
 * pod.setStatus('running'), pod.setLabel(text), pod.remove() (animated).
 * opts: { status, image, labels: {k: v}, ip, cls }
 */
const podEl = (name, { status = 'pending', image = '', labels = {}, ip = '', cls = '' } = {}) => {
  const statusEl = h('small', { class: 'k-pod-status' });
  const labelRow = h('div', { class: 'k-pod-labels' });
  const el = h('div', { class: `k-pod pop ${cls}`, title: name },
    h('div', { class: 'k-pod-name' }, h('span', { class: 'k-dot' }), h('b', {}, name)),
    image ? h('small', { class: 'k-pod-img' }, `📦 ${image}`) : null,
    ip ? h('small', { class: 'k-pod-ip' }, ip) : null,
    statusEl, labelRow);
  el.setStatus = (s) => {
    POD_STATUS.forEach((x) => el.classList.toggle(x, x === s));
    statusEl.textContent = STATUS_TEXT[s] || s;
    el.dataset.status = s;
  };
  el.setLabels = (map) => labelRow.replaceChildren(...Object.entries(map).map(([k, v]) => h('span', { class: 'k-label' }, `${k}=${v}`)));
  el.vanish = () => removeAnimated(el);
  el.setStatus(status);
  el.setLabels(labels);
  return el;
};

/** A worker or control-plane node with a pod area. Returns { el, pods, setState(text, cls) }. */
const nodeBox = (name, { role = 'worker', capacity = '' } = {}) => {
  const pods = h('div', { class: 'k-node-pods' });
  const state = h('span', { class: 'k-node-state' }, 'Ready');
  const el = h('div', { class: `k-node ${role}` },
    h('div', { class: 'k-node-head' }, h('b', {}, `${role === 'control-plane' ? '🧠' : '🖥'} ${name}`), state),
    capacity ? h('small', { class: 'k-node-cap' }, capacity) : null,
    pods);
  return {
    el, pods,
    setState: (text, cls = '') => { state.textContent = text; state.className = `k-node-state ${cls}`; el.classList.toggle('cordoned', cls === 'warn'); el.classList.toggle('down', cls === 'bad'); },
  };
};

/** The control plane: API server, etcd, scheduler, controller manager. Returns { el, parts }. */
const controlPlane = ({ compact = false } = {}) => {
  const part = (key, icon, label, sub) => h('div', { class: `k-cp-part ${key}` }, h('b', {}, `${icon} ${label}`), compact ? null : h('small', {}, sub));
  const parts = {
    api: part('api', '🚪', 'kube-apiserver', 'the front door'),
    etcd: part('etcd', '🗄', 'etcd', 'the source of truth'),
    sched: part('sched', '🧭', 'scheduler', 'picks a node'),
    cm: part('cm', '🔁', 'controller-manager', 'fixes drift'),
  };
  const el = h('div', { class: 'k-cp' }, h('div', { class: 'k-cp-title' }, '🧠 Control plane'), h('div', { class: 'k-cp-grid' }, ...Object.values(parts)));
  return { el, parts };
};

/** A small read-only YAML card; lines that start with # are dimmed. */
const yamlCard = (text, { name = '' } = {}) => h('div', { class: 'k-yaml' },
  name ? h('div', { class: 'k-yaml-name' }, `📄 ${name}`) : null,
  h('pre', { html: escapeHtml(text).replace(/^(\s*)([\w.-]+):/gm, '$1<span class="key">$2</span>:').replace(/^(\s*#.*)$/gm, '<span class="cm">$1</span>') }));

/** Pulses an element briefly (e.g. the API server when a request arrives). */
const ping = async (el, cls = 'k-ping', ms = 700) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); await wait(ms); el.classList.remove(cls); };

export const helpers = { mkTerm, out, typed, mkBar, setBar, title, zone, rand, shortHash, podEl, nodeBox, controlPlane, yamlCard, ping };
