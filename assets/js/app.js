// App shell: hash router, sidebar, progress, and page renderers.
import { h, store, copyText, disposeTimers, getSpeed, setSpeed, setPage, GITHUB_PROFILE, GITHUB_REPO } from './dom.js';
import { LEVELS, LESSONS, CHEATSHEET } from './lessons/index.js';
import { ANIMATIONS } from './animations.js';
import './anim/beginner.js';
import './anim/intermediate-a.js';
import './anim/intermediate-b.js';
import './anim/advanced.js';
import { commandBlock, fileBlock, quizBlock } from './components.js';
import { renderPlayground } from './playground.js';
import { renderCommandIndex, renderCommandPage } from './commands.js';
import { REFERENCE, refById, entryFor, shortCmd } from './reference.js';
import { lessonCommands, homeLesson, linkCommands } from './sync.js';
import { GLOSSARY_INDEX, termsInLesson } from './glossary.js';

const view = document.getElementById('view');
const sidebar = document.getElementById('sidebar');
const DONE_KEY = 'kl-done';
const done = new Set(store.get(DONE_KEY, []));

const markDone = (id, value = true) => {
  value ? done.add(id) : done.delete(id);
  store.set(DONE_KEY, [...done]);
  renderSidebar();
  renderProgress();
};

// ---------- chrome ----------
const renderProgress = () => {
  const pct = Math.round((done.size / LESSONS.length) * 100);
  const pill = document.getElementById('progressPill');
  pill.textContent = `${done.size}/${LESSONS.length} · ${pct}%`;
  pill.style.setProperty('--p', `${pct}%`);
};

// One sidebar for lessons and commands: the open lesson lists the commands it uses.
const renderSidebar = (activeId = currentLessonId()) => {
  const onCommand = location.hash.startsWith('#/commands/') && refById(activeId);
  const openLesson = onCommand ? homeLesson(activeId)?.id : activeId;
  const levels = LEVELS.map((lvl) => {
    const lessons = LESSONS.filter((l) => l.level === lvl.id);
    const count = lessons.filter((l) => done.has(l.id)).length;
    return h('div', { class: 'side-level' },
      h('h4', {}, h('span', {}, lvl.title), h('span', {}, `${count}/${lessons.length}`)),
      lessons.map((l) => [
        h('a', {
          class: `side-link ${l.id === activeId ? 'active' : ''} ${l.id === openLesson && onCommand ? 'open' : ''} ${done.has(l.id) ? 'done' : ''}`,
          href: `#/lesson/${l.id}`,
        }, h('span', { class: 'side-num' }, done.has(l.id) ? '✓' : LESSONS.indexOf(l) + 1), l.title),
        l.id === openLesson && lessonCommands.get(l.id).length ? h('div', { class: 'side-cmds' },
          lessonCommands.get(l.id).map((cid) => h('a', { class: `side-cmd ${cid === activeId ? 'active' : ''}`, href: `#/commands/${cid}` }, shortCmd(refById(cid).cmd)))) : null,
      ]));
  });
  sidebar.replaceChildren(...levels,
    h('div', { class: 'side-level side-extra' },
      h('a', { class: `side-link ${activeId === 'commands' || onCommand ? 'active' : ''}`, href: '#/commands' }, h('span', { class: 'side-num' }, '📚'), `Command reference (${REFERENCE.length})`),
      h('a', { class: `side-link ${activeId === 'playground' ? 'active' : ''}`, href: '#/playground' }, h('span', { class: 'side-num' }, '▶'), 'Playground'),
      h('a', { class: `side-link ${activeId === 'cheatsheet' ? 'active' : ''}`, href: '#/cheatsheet' }, h('span', { class: 'side-num' }, '≡'), 'Cheat sheet'),
      h('a', { class: `side-link ${activeId === 'glossary' ? 'active' : ''}`, href: '#/glossary' }, h('span', { class: 'side-num' }, '📖'), 'Glossary')));
  sidebar.querySelector('.side-cmd.active, .side-link.active')?.scrollIntoView({ block: 'nearest' });
};

const setTopNav = (key) => document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));

// ---------- pages ----------
const renderHome = () => {
  const next = LESSONS.find((l) => !done.has(l.id)) || LESSONS[0];
  view.append(
    h('section', { class: 'hero' },
      h('span', { class: 'badge' }, '☸ Free · interactive · zero to advanced'),
      h('h1', { html: 'Learn Kubernetes by <em>seeing</em> it work.' }),
      h('p', {}, 'Every concept is an animation you can play with: pods get scheduled, controllers heal, traffic flows. Every kubectl command is broken down flag by flag, every manifest line by line. Then practise on a live simulated cluster.'),
      h('div', { class: 'hero-actions' },
        h('a', { class: 'btn btn-primary', href: `#/lesson/${next.id}` }, done.size ? `Continue: ${next.title} →` : 'Start learning →'),
        h('a', { class: 'btn', href: '#/commands' }, '📚 Command reference'),
        h('a', { class: 'btn', href: '#/playground' }, '▶ Open playground')),
      h('div', { class: 'hero-ship', 'aria-hidden': 'true' },
        h('div', { class: 'boxes' }, Array.from({ length: 10 }, (_, i) => h('i', { class: i % 3 === 0 ? 'b' : '', style: { animationDelay: `${0.2 + i * 0.12}s` } }))),
        h('div', { class: 'hull' }), h('div', { class: 'waves' }))),
    h('div', { class: 'features' },
      [['🎬 Animations', 'Click buttons — or type the real kubectl command — and watch pods, nodes, Services and controllers react.'],
        ['🔍 Explained commands', 'Hover any part of a command to see exactly what it does.'],
        ['📄 Explained manifests', 'Deployments, Services, Ingress, RBAC, Helm charts — every YAML line explained.'],
        ['📚 Every command', `${REFERENCE.length} commands, each with options, examples, errors and a live lab.`],
        ['📖 Plain-English glossary', 'Every term in one simple sentence first, then the detail.'],
        ['🧪 Playground', 'A simulated multi-node cluster with real controllers and challenges. Safe to break.']]
        .map(([b, t]) => h('div', { class: 'feature' }, h('b', {}, b), h('span', {}, t)))),
    ...LEVELS.flatMap((lvl) => [
      h('div', { class: 'section-title' }, h('h2', {}, lvl.title), h('p', {}, lvl.blurb)),
      h('div', { class: 'roadmap' }, LESSONS.filter((l) => l.level === lvl.id).map((l) => h('a', { class: `lesson-card ${done.has(l.id) ? 'done' : ''}`, href: `#/lesson/${l.id}` },
        h('span', { class: 'done-tick' }, done.has(l.id) ? '✓' : ''),
        h('span', { class: 'num' }, `LESSON ${String(LESSONS.indexOf(l) + 1).padStart(2, '0')} · ${l.minutes} MIN`),
        h('h3', {}, l.title),
        h('p', {}, l.summary)))),
    ]),
  );
};

const BLOCKS = {
  p: (html) => h('p', { html: linkCommands(html) }),
  h: (text) => h('h2', {}, text),
  h3: (text) => h('h3', {}, text),
  list: (items) => h('ul', { class: 'points' }, items.map((html) => h('li', { html: linkCommands(html) }))),
  tip: (html) => h('div', { class: 'callout' }, h('span', { class: 'ico' }, '💡'), h('p', { html: linkCommands(html) })),
  warn: (html) => h('div', { class: 'callout warn' }, h('span', { class: 'ico' }, '⚠️'), h('p', { html: linkCommands(html) })),
  analogy: (html) => h('div', { class: 'callout analogy' }, h('span', { class: 'ico' }, '🚢'), h('p', { html: linkCommands(html) })),
  cmd: (spec) => commandBlock({ ...spec, refId: entryFor(spec.parts.map((p) => p[0]).join(' '))?.id }),
  file: fileBlock,
  table: ({ head, rows }) => h('table', { class: 'ref' }, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, c)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', { html: linkCommands(c) })))))),
  compare: ({ a, b }) => h('div', { class: 'compare' }, [a, b].map((side) => h('div', {}, h('h4', {}, side.title), h('ul', {}, side.items.map((t) => h('li', {}, t)))))),
  anim: (key) => {
    const mount = h('div', {});
    const make = ANIMATIONS[key];
    if (!make) return h('div', { class: 'callout warn' }, h('p', {}, `Animation "${key}" is missing.`));
    // Mount after insertion so layout-dependent animations can measure the DOM.
    queueMicrotask(() => {
      try { make(mount); } catch (err) {
        console.error(`[animation:${key}]`, err);
        mount.append(h('div', { class: 'callout warn' }, h('p', {}, 'This animation failed to load. Try reloading the page.')));
      }
    });
    return mount;
  },
};

// The commands this lesson uses (found by sync.js), each linked to its reference page and lab.
const lessonCommandBox = (lessonId) => {
  const ids = lessonCommands.get(lessonId);
  if (!ids.length) return null;
  return h('div', { class: 'learn-box cmd-box' },
    h('h4', {}, `Commands in this lesson · ${ids.length}`),
    h('div', { class: 'chips' }, ids.map((id) => h('a', { class: `chip ${homeLesson(id)?.id === lessonId ? 'blue' : 'light'}`, href: `#/commands/${id}`, title: refById(id).summary }, refById(id).cmd))),
    h('p', {}, 'Dark blue = taught here. Each one opens a full page with every option and a live lab. Commands in the text below are links too.'));
};

// Jargon the lesson uses, each with a one-line plain-English meaning (from the glossary).
const keyTermsBox = (lesson) => {
  const terms = termsInLesson(lesson);
  if (!terms.length) return null;
  return h('details', { class: 'terms-box', open: '' },
    h('summary', {}, `📖 Key terms in this lesson · ${terms.length}`),
    h('dl', {}, terms.map((g) => [h('dt', {}, h('a', { href: `#/glossary?t=${g.slug}` }, g.term)), h('dd', {}, g.simple)])),
    h('p', { class: 'muted' }, 'Every term is in the ', h('a', { href: '#/glossary' }, 'glossary'), ' with more detail and the lesson that teaches it.'));
};

const renderGlossary = (focus) => {
  setPage('Kubernetes glossary — every term in plain English | Kube Lab', 'Every Kubernetes term explained in plain English: pods, nodes, Deployments, Services, Ingress, ConfigMaps, Secrets, volumes, probes, RBAC, taints, HPA, Helm, operators and more.');
  const list = h('div', { class: 'gl-list' });
  const letters = h('div', { class: 'ref-jump' });
  const sorted = [...GLOSSARY_INDEX].sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }));
  const draw = (q = '') => {
    const needle = q.trim().toLowerCase();
    const hits = sorted.filter((g) => !needle || `${g.term} ${g.aka.join(' ')} ${g.simple} ${g.more}`.toLowerCase().includes(needle));
    const groups = new Map();
    hits.forEach((g) => { const k = g.term[0].toUpperCase(); groups.set(k, [...(groups.get(k) || []), g]); });
    list.replaceChildren(...[...groups.entries()].map(([letter, items]) => h('section', { id: `gl-${letter}` },
      h('h2', { class: 'gl-letter' }, letter),
      items.map((g) => {
        const lesson = LESSONS.find((l) => l.id === g.lesson);
        return h('div', { class: `gl-item ${g.slug === focus ? 'focus' : ''}`, id: `term-${g.slug}` },
          h('h3', {}, g.term, g.aka.length ? h('small', {}, ` also: ${g.aka.slice(0, 3).join(', ')}`) : null),
          h('p', { class: 'gl-simple' }, g.simple),
          h('p', { class: 'muted' }, g.more),
          lesson ? h('a', { class: 'chip light', href: `#/lesson/${lesson.id}` }, `🎬 Lesson ${LESSONS.indexOf(lesson) + 1}: ${lesson.title}`) : null);
      }))));
    if (!hits.length) list.append(h('p', { class: 'pg-empty' }, 'No term matches your search.'));
    letters.replaceChildren(...[...groups.keys()].map((k) => h('a', { class: 'chip', href: '#/glossary', onclick: (e) => { e.preventDefault(); document.getElementById(`gl-${k}`)?.scrollIntoView({ behavior: 'smooth' }); } }, k)));
  };
  view.append(h('div', { class: 'lesson', style: { maxWidth: '1000px' } },
    h('div', { class: 'lesson-head' }, h('div', { class: 'meta' }, h('span', { class: 'badge' }, '📖 Glossary'), h('span', {}, `${GLOSSARY_INDEX.length} terms`)),
      h('h1', {}, 'Kubernetes in plain English'),
      h('p', { class: 'lead' }, 'Every word you will meet, explained in one simple sentence first, then a little more detail, with the lesson that teaches it.')),
    h('input', { class: 'cs-search', type: 'search', placeholder: 'Search terms… (e.g. pod, taint, ingress)', oninput: (e) => draw(e.target.value), 'aria-label': 'Search the glossary' }),
    letters, list));
  draw();
  if (focus) queueMicrotask(() => document.getElementById(`term-${focus}`)?.scrollIntoView({ block: 'center' }));
};

const renderLesson = (id) => {
  const idx = LESSONS.findIndex((l) => l.id === id);
  if (idx < 0) return renderNotFound();
  const l = LESSONS[idx];
  const prev = LESSONS[idx - 1], next = LESSONS[idx + 1];
  setPage(`${l.title} — Kubernetes tutorial | Kube Lab`, `${l.summary} An interactive Kubernetes lesson with animations, explained kubectl commands and manifests, and a quiz.`);

  const completeBtn = h('button', { class: `btn ${done.has(l.id) ? '' : 'btn-primary'}` });
  const syncComplete = () => { completeBtn.textContent = done.has(l.id) ? '✓ Completed (undo)' : 'Mark lesson complete'; completeBtn.className = `btn ${done.has(l.id) ? '' : 'btn-primary'}`; };
  completeBtn.addEventListener('click', () => { markDone(l.id, !done.has(l.id)); syncComplete(); });
  syncComplete();

  view.append(h('article', { class: 'lesson' },
    h('header', { class: 'lesson-head' },
      h('div', { class: 'meta' }, h('span', { class: `badge ${l.level}` }, l.level), h('span', {}, `Lesson ${idx + 1} of ${LESSONS.length}`), h('span', {}, `· ${l.minutes} min`)),
      h('h1', {}, l.title),
      h('p', { class: 'lead' }, l.summary),
      l.plain ? h('div', { class: 'plain-box' }, h('span', { class: 'ico' }, '🧒'), h('div', {}, h('b', {}, 'In plain words'), h('p', { html: l.plain }))) : null,
      h('div', { class: 'learn-grid' },
        h('div', { class: 'learn-box' }, h('h4', {}, 'You will learn'), h('ul', {}, l.learn.map((t) => h('li', {}, t)))),
        lessonCommandBox(l.id)),
      keyTermsBox(l)),
    l.blocks.map(([type, data]) => (BLOCKS[type] ? BLOCKS[type](data) : null)),
    quizBlock(l.quiz, () => { if (!done.has(l.id)) { markDone(l.id); syncComplete(); } }),
    h('div', { class: 'complete-row' }, h('span', {}, 'Answer every quiz question correctly to complete the lesson automatically — or mark it yourself.'), completeBtn),
    h('nav', { class: 'lesson-foot' },
      prev ? h('a', { class: 'nav-card', href: `#/lesson/${prev.id}` }, h('small', {}, '← Previous'), h('b', {}, prev.title)) : h('span'),
      next ? h('a', { class: 'nav-card next', href: `#/lesson/${next.id}` }, h('small', {}, 'Next →'), h('b', {}, next.title))
        : h('a', { class: 'nav-card next', href: '#/playground' }, h('small', {}, 'Finished! Next →'), h('b', {}, 'Practice in the playground'))),
  ));
};

const renderCheatsheet = () => {
  setPage('kubectl cheat sheet — every common Kubernetes command | Kube Lab', 'A searchable kubectl and Helm cheat sheet: pods, deployments, services, config, storage, RBAC, scheduling and debugging. Click to copy, or open the full explanation.');
  const grid = h('div', { class: 'cs-grid' });
  const draw = (q = '') => {
    const needle = q.trim().toLowerCase();
    grid.replaceChildren(...CHEATSHEET.map((g) => {
      const items = g.items.filter(([c, d]) => !needle || c.toLowerCase().includes(needle) || d.toLowerCase().includes(needle));
      return items.length ? h('section', { class: 'cs-group' }, h('h3', {}, g.group),
        items.map(([c, d]) => {
          const ref = entryFor(c);
          return h('div', { class: 'cs-item', title: 'Click to copy', onclick: () => copyText(c) }, h('code', {}, c), h('span', {}, d,
            ref ? h('a', { class: 'cs-ref', href: `#/commands/${ref.id}`, onclick: (e) => e.stopPropagation() }, ' details →') : null));
        })) : null;
    }).filter(Boolean));
    if (!grid.children.length) grid.append(h('p', { class: 'pg-empty' }, 'No command matches your search.'));
  };
  view.append(h('div', { class: 'lesson', style: { maxWidth: '1200px' } },
    h('div', { class: 'lesson-head' }, h('h1', {}, 'kubectl cheat sheet'), h('p', { class: 'lead', html: `The commands you will actually use. Click a command to copy it, or <b>details →</b> for its full page and live lab. All ${REFERENCE.length} commands: <a href="#/commands">command reference</a>.` })),
    h('input', { class: 'cs-search', type: 'search', placeholder: 'Search commands… (e.g. logs, rollout, secret)', oninput: (e) => draw(e.target.value), 'aria-label': 'Search commands' }),
    grid));
  draw();
};

// Author credit and project links, shown at the bottom of every page.
const siteFooter = () => h('footer', { class: 'site-foot' },
  h('div', { class: 'foot-author' },
    h('a', { class: 'foot-avatar', href: GITHUB_PROFILE, target: '_blank', rel: 'noopener me' }, h('img', { src: `${GITHUB_PROFILE}.png?size=96`, alt: 'Kunal Avghade', width: 44, height: 44, loading: 'lazy' })),
    h('div', {},
      h('b', {}, 'Made by ', h('a', { href: GITHUB_PROFILE, target: '_blank', rel: 'noopener me author' }, 'Kunal Avghade')),
      h('span', {}, 'Kube Lab is free and open source. If it helped you, a ⭐ on GitHub helps others find it.'))),
  h('div', { class: 'foot-links' },
    h('a', { class: 'btn', href: GITHUB_PROFILE, target: '_blank', rel: 'noopener me' }, '🐙 github.com/kunalavghade'),
    h('a', { class: 'btn btn-primary', href: GITHUB_REPO, target: '_blank', rel: 'noopener' }, '⭐ Star on GitHub'),
    h('a', { class: 'btn', href: `${GITHUB_REPO}/issues`, target: '_blank', rel: 'noopener' }, '🐞 Report an issue')));

const renderNotFound = () => {
  setPage('Page not found | Kube Lab');
  view.append(h('div', { class: 'lesson' }, h('h1', {}, 'Page not found'), h('p', {}, h('a', { href: '#/' }, 'Back to the roadmap'))));
};

// ---------- router ----------
function currentLessonId() {
  const [, page, id] = location.hash.replace(/^#/, '').split('?')[0].split('/');
  return page === 'lesson' || (page === 'commands' && id) ? id : page;
}

const route = () => {
  disposeTimers();
  document.body.classList.remove('nav-open');
  view.replaceChildren();
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const [, page, id] = path.split('/');
  switch (page || '') {
    case '': setPage('Kube Lab — Learn Kubernetes Visually, From Beginner to Advanced'); setTopNav('home'); renderHome(); break;
    case 'lesson': setTopNav(''); renderLesson(id); break;
    case 'playground': setPage('Kubernetes playground — run kubectl in your browser | Kube Lab', 'Practise Kubernetes in the browser on a simulated multi-node cluster: deploy, scale, expose, roll out, break and debug, with challenges. Nothing to install.'); setTopNav('playground'); renderPlayground(view, new URLSearchParams(query).get('cmd')); break;
    case 'cheatsheet': setTopNav('cheatsheet'); renderCheatsheet(); break;
    case 'glossary': setTopNav('glossary'); renderGlossary(new URLSearchParams(query).get('t')); break;
    case 'commands':
      setTopNav('commands');
      if (!id) renderCommandIndex(view, new URLSearchParams(query).get('q') || '');
      else if (!renderCommandPage(view, id)) renderNotFound();
      break;
    default: renderNotFound();
  }
  view.append(siteFooter());
  renderSidebar(currentLessonId());
  window.scrollTo({ top: 0, behavior: 'instant' });
};

// ---------- boot ----------
const speedSel = document.getElementById('speedSel');
speedSel.value = String(getSpeed());
if (!speedSel.value) { speedSel.value = '1'; setSpeed(1); } // stored value is not one of the options
speedSel.addEventListener('change', () => setSpeed(speedSel.value));
document.getElementById('menuBtn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
document.getElementById('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
window.addEventListener('hashchange', route);
renderProgress();
route();
