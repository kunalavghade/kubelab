// Kustomize: builds a kustomization directory into plain manifests (kubectl kustomize / apply -k).
// Supports resources (files and bases), namespace, namePrefix/nameSuffix, labels/commonLabels,
// commonAnnotations, images, replicas, configMapGenerator/secretGenerator and patches.
import { CommandError } from './util.js';
import { parseYaml, parseYamlDocs } from './yaml.js';
import { hashOf, clone } from './api.js';
import { b64encode } from './filters.js';

const KUSTOMIZATION_FILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'];
const KIND_ORDER = ['Namespace', 'ResourceQuota', 'LimitRange', 'ServiceAccount', 'Secret', 'ConfigMap', 'StorageClass', 'PersistentVolume', 'PersistentVolumeClaim', 'CustomResourceDefinition', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding', 'Service', 'DaemonSet', 'Pod', 'ReplicaSet', 'Deployment', 'HorizontalPodAutoscaler', 'StatefulSet', 'Job', 'CronJob', 'Ingress'];
const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job']);

const join = (dir, rel) => {
  const parts = `${dir}/${rel}`.split('/').filter((x) => x && x !== '.');
  const out = [];
  parts.forEach((x) => { if (x === '..') out.pop(); else out.push(x); });
  return out.join('/');
};
const podSpecOf = (o) => (o.kind === 'Pod' ? o.spec : o.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template?.spec : o.spec?.template?.spec);

// Strategic-merge-ish patch: maps merge, lists of named items merge by name.
const merge = (target, patch) => {
  if (Array.isArray(patch)) {
    if (!Array.isArray(target) || !patch.every((x) => x?.name)) return clone(patch);
    const out = [...target];
    patch.forEach((item) => { const i = out.findIndex((x) => x.name === item.name); if (i >= 0) out[i] = merge(out[i], item); else out.push(clone(item)); });
    return out;
  }
  if (patch && typeof patch === 'object') {
    const out = { ...(target && typeof target === 'object' ? target : {}) };
    Object.entries(patch).forEach(([k, v]) => { if (v === null) delete out[k]; else out[k] = merge(out[k], v); });
    return out;
  }
  return patch;
};

const generate = (E, dir, gen, kind) => {
  const data = {};
  (gen.literals || []).forEach((l) => { const at = l.indexOf('='); data[l.slice(0, at)] = l.slice(at + 1); });
  (gen.files || []).forEach((f) => { const [key, path] = f.includes('=') ? f.split('=') : [f.split('/').pop(), f]; data[key] = E.files.read(join(dir, path)) ?? ''; });
  (gen.envs || []).forEach((f) => (E.files.read(join(dir, f)) || '').split('\n').filter((l) => l.includes('=')).forEach((l) => { const at = l.indexOf('='); data[l.slice(0, at)] = l.slice(at + 1); }));
  const noHash = gen.options?.disableNameSuffixHash;
  const name = noHash ? gen.name : `${gen.name}-${hashOf({ kind, data }, 10)}`;
  return kind === 'ConfigMap'
    ? { apiVersion: 'v1', kind, metadata: { name }, data, _generatedFrom: gen.name }
    : { apiVersion: 'v1', kind, metadata: { name }, type: gen.type || 'Opaque', data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64encode(v)])), _generatedFrom: gen.name };
};

// Point every reference to a renamed ConfigMap/Secret/Service at its new name.
const renameRefs = (docs, renames) => docs.forEach((d) => {
  const spec = podSpecOf(d);
  const fix = (kind, name) => renames.get(`${kind}/${name}`) ?? name;
  if (spec) {
    [...(spec.containers || []), ...(spec.initContainers || [])].forEach((c) => {
      (c.envFrom || []).forEach((e) => { if (e.configMapRef) e.configMapRef.name = fix('ConfigMap', e.configMapRef.name); if (e.secretRef) e.secretRef.name = fix('Secret', e.secretRef.name); });
      (c.env || []).forEach((e) => { const r = e.valueFrom?.configMapKeyRef || e.valueFrom?.secretKeyRef; if (r) r.name = fix(e.valueFrom.configMapKeyRef ? 'ConfigMap' : 'Secret', r.name); });
    });
    (spec.volumes || []).forEach((v) => { if (v.configMap) v.configMap.name = fix('ConfigMap', v.configMap.name); if (v.secret) v.secret.secretName = fix('Secret', v.secret.secretName); });
  }
  if (d.kind === 'Ingress') (d.spec.rules || []).forEach((r) => (r.http?.paths || []).forEach((p) => { p.backend.service.name = fix('Service', p.backend.service.name); }));
  if (d.kind === 'HorizontalPodAutoscaler') d.spec.scaleTargetRef.name = fix(d.spec.scaleTargetRef.kind, d.spec.scaleTargetRef.name);
  if (d.kind === 'StatefulSet' && d.spec.serviceName) d.spec.serviceName = fix('Service', d.spec.serviceName);
});

const addLabels = (d, labels, selectors) => {
  d.metadata.labels = { ...d.metadata.labels, ...labels };
  if (!selectors) return;
  if (WORKLOADS.has(d.kind) && d.spec?.selector) {
    d.spec.selector.matchLabels = { ...d.spec.selector.matchLabels, ...labels };
    d.spec.template.metadata = { ...d.spec.template.metadata, labels: { ...d.spec.template.metadata?.labels, ...labels } };
  }
  if (d.kind === 'Service' && d.spec?.selector) d.spec.selector = { ...d.spec.selector, ...labels };
};

/** Builds a kustomization directory. E.files gives file access; E.C.def tells which kinds are namespaced. */
export const buildKustomization = (E, dir, depth = 0) => {
  if (depth > 8) throw new CommandError('error: kustomization bases nest too deeply', 'KUSTOMIZE');
  const clean = dir.replace(/\/$/, '') || '.';
  const kfile = KUSTOMIZATION_FILES.map((f) => join(clean, f)).find((p) => E.files.read(p) != null);
  if (!kfile) throw new CommandError(`error: unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${E.files.abs(clean)}'`, 'KUSTOMIZE');
  const k = parseYaml(E.files.read(kfile)) || {};

  let docs = (k.resources || k.bases || []).flatMap((r) => {
    const path = join(clean, r);
    if (E.files.isDir(path)) return buildKustomization(E, path, depth + 1);
    const text = E.files.read(path);
    if (text == null) throw new CommandError(`error: accumulating resources: accumulation err='accumulating resources from '${r}': open ${E.files.abs(path)}: no such file or directory'`, 'KUSTOMIZE');
    return parseYamlDocs(text);
  }).map(clone);

  docs.push(...(k.configMapGenerator || []).map((g) => generate(E, clean, g, 'ConfigMap')), ...(k.secretGenerator || []).map((g) => generate(E, clean, g, 'Secret')));

  [...(k.patches || []), ...(k.patchesStrategicMerge || []).map((path) => ({ path }))].forEach((patch) => {
    const body = patch.path ? parseYaml(E.files.read(join(clean, patch.path)) || '') : parseYaml(patch.patch || '');
    const target = patch.target || { kind: body?.kind, name: body?.metadata?.name };
    docs = docs.map((d) => (d.kind === target.kind && (!target.name || d.metadata.name === target.name) ? merge(d, { ...body, apiVersion: d.apiVersion, kind: d.kind, metadata: { ...body.metadata, name: d.metadata.name } }) : d));
  });

  (k.images || []).forEach((img) => docs.forEach((d) => {
    const spec = podSpecOf(d);
    [...(spec?.containers || []), ...(spec?.initContainers || [])].forEach((c) => {
      const [repo, tag] = c.image.split(':');
      if (repo !== img.name && repo.split('/').pop() !== img.name) return;
      c.image = `${img.newName || repo}${img.digest ? `@${img.digest}` : `:${img.newTag ?? tag ?? 'latest'}`}`;
    });
  }));
  (k.replicas || []).forEach((r) => docs.forEach((d) => { if (d.metadata.name === r.name && d.spec && 'replicas' in d.spec) d.spec.replicas = r.count; }));

  if (k.commonLabels) docs.forEach((d) => addLabels(d, k.commonLabels, true));
  (k.labels || []).forEach((l) => docs.forEach((d) => addLabels(d, l.pairs || {}, !!l.includeSelectors)));
  if (k.commonAnnotations) docs.forEach((d) => { d.metadata.annotations = { ...d.metadata.annotations, ...k.commonAnnotations }; });

  const renames = new Map();
  docs.forEach((d) => {
    if (d._generatedFrom) { renames.set(`${d.kind}/${d._generatedFrom}`, d.metadata.name); delete d._generatedFrom; }
    if (k.namePrefix || k.nameSuffix) {
      const base = d.metadata.name;
      const isNamespace = d.kind === 'Namespace' || d.kind === 'CustomResourceDefinition';
      if (!isNamespace) {
        d.metadata.name = `${k.namePrefix || ''}${base}${k.nameSuffix || ''}`;
        const original = [...renames.entries()].find(([, v]) => v === base)?.[0];
        renames.set(original || `${d.kind}/${base}`, d.metadata.name);
      }
    }
    if (k.namespace && d.kind !== 'Namespace' && E.C.def(d.kind)?.namespaced !== false) d.metadata.namespace = k.namespace;
  });
  renameRefs(docs, renames);
  if (k.namespace) docs.forEach((d) => (d.subjects || []).forEach((s) => { if (s.kind === 'ServiceAccount') s.namespace = k.namespace; }));

  return docs.sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a.kind), ib = KIND_ORDER.indexOf(b.kind);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.metadata.name.localeCompare(b.metadata.name);
  });
};
