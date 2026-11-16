/**
 * The command reference: one entry per kubectl / helm command, shown at #/commands/<id> with a live lab.
 * Entry shape:
 *   cmd, group, summary, syntax, details[html], args?[[name, html]], flags?[[names, value, html]],
 *   examples[[command, html]], setup?[commands run silently before the lab], errors?[[message, fix]],
 *   lesson? (lesson id), related?[ids], aliases?[commands]
 * The id drops "kubectl " and joins words with dashes ("kubectl rollout undo" → "rollout-undo",
 * "helm install" → "helm-install"). Add a command by adding an entry to one of the ref/*.js files.
 */
import { BASICS_REFS } from './ref/basics.js';
import { WORKLOAD_REFS } from './ref/workloads.js';
import { NETWORK_REFS } from './ref/networking.js';
import { CONFIG_REFS } from './ref/config.js';
import { CLUSTER_REFS } from './ref/cluster.js';
import { HELM_REFS } from './ref/helm.js';

export const CLIS = ['kubectl', 'helm'];
const CLI_AT = new RegExp(`(^|\\s)(${CLIS.join('|')})\\s`);

export const REF_GROUPS = [
  { name: 'Cluster & contexts', icon: '☸', blurb: 'Which cluster you talk to, and what it can do.' },
  { name: 'Create, apply & delete', icon: '📝', blurb: 'Manage objects from YAML or straight from the command line.' },
  { name: 'Inspect resources', icon: '🔍', blurb: 'List, describe, watch and measure objects.' },
  { name: 'Debug pods', icon: '🐞', blurb: 'Logs, shells, port-forwards, copies and debug containers.' },
  { name: 'Deployments & rollouts', icon: '🚀', blurb: 'Scale, update, roll back and autoscale workloads.' },
  { name: 'Services & networking', icon: '🌐', blurb: 'Expose pods and route traffic into the cluster.' },
  { name: 'Config & secrets', icon: '🔐', blurb: 'Settings and passwords kept outside the image.' },
  { name: 'Jobs & batch', icon: '⏱', blurb: 'Run-to-completion work and schedules.' },
  { name: 'Nodes & scheduling', icon: '🖥', blurb: 'Taints, cordons, drains and node labels.' },
  { name: 'Access control', icon: '🛡', blurb: 'Service accounts, roles, bindings and permission checks.' },
  { name: 'Helm & Kustomize', icon: '📦', blurb: 'Package, template and release whole apps.' },
];

export const refId = (cmd) => cmd.replace(/^kubectl /, '').trim().replace(/\s+/g, '-');

/** The command without the kubectl prefix, for compact chips and sidebar links. */
export const shortCmd = (cmd) => cmd.replace(/^kubectl /, '');

export const REFERENCE = [...BASICS_REFS, ...WORKLOAD_REFS, ...NETWORK_REFS, ...CONFIG_REFS, ...CLUSTER_REFS, ...HELM_REFS]
  .map((r) => ({ setup: [], args: [], flags: [], errors: [], related: [], aliases: [], ...r, id: refId(r.cmd) }));

const REF_BY_ID = new Map(REFERENCE.map((r) => [r.id, r]));
export const refById = (id) => REF_BY_ID.get(id);

// Global flags may sit between "kubectl" and the command: kubectl -n shop get pods.
const VALUED_GLOBAL = /^(-n|--namespace|--context|--kubeconfig)$/;

const stripGlobals = (cmd) => {
  const [cli, ...rest] = cmd.split(' ');
  const kept = [];
  for (let i = 0; i < rest.length; i++) {
    if (VALUED_GLOBAL.test(rest[i])) { i++; continue; }
    if (/^--(namespace|context|kubeconfig)=/.test(rest[i]) || rest[i] === '-A' || rest[i] === '--all-namespaces') continue;
    kept.push(rest[i]);
  }
  return [cli, ...kept].join(' ');
};

/** Finds the entry whose command (or alias) is the longest prefix of a command line. */
export const entryFor = (line) => {
  const text = String(line).replace(/\s+/g, ' ');
  const at = text.search(CLI_AT); // "echo x | kubectl apply -f -" → the kubectl part
  if (at < 0) return null;
  const norm = stripGlobals(text.slice(at).trim());
  return REFERENCE.filter((r) => [r.cmd, ...r.aliases].some((c) => norm === c || norm.startsWith(`${c} `)))
    .sort((a, b) => b.cmd.length - a.cmd.length)[0] || null;
};
