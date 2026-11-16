// All course content. Each lesson is data: blocks are rendered by app.js, animations by anim/*.js.
// Block types: p, h, h3, list, tip, warn, analogy, anim, cmd, file, table, compare.
import { BEGINNER } from './beginner.js';
import { INTERMEDIATE_A } from './intermediate-a.js';
import { INTERMEDIATE_B } from './intermediate-b.js';
import { ADVANCED } from './advanced.js';
import { CHEATSHEET } from './cheatsheet.js';

export const LEVELS = [
  { id: 'beginner', title: 'Beginner', blurb: 'What Kubernetes is, how a cluster works, and your first pods.' },
  { id: 'intermediate', title: 'Intermediate', blurb: 'Run real apps: rollouts, Services, config, storage, health and batch work.' },
  { id: 'advanced', title: 'Advanced', blurb: 'Schedule, scale, secure, operate, debug and extend a cluster.' },
];

export const LESSONS = [...BEGINNER, ...INTERMEDIATE_A, ...INTERMEDIATE_B, ...ADVANCED];
export { CHEATSHEET };
