import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { computeResults } from './scoring.js';

/** An error whose message is safe to show to the rater or admin. */
export class RankingError extends Error {}

export const DEFAULT_CRITERIA = [
  { name: 'Quality of Content', weight: 20, description: 'Clear, confident understanding of the topic. Relevant, engaging, well-organized information. Balances solid research with accessible storytelling.' },
  { name: 'Creativity', weight: 20, description: 'Presents ideas in fresh, original, or unexpected ways. Uses visuals, humor, or structure creatively. Keeps the audience curious and entertained.' },
  { name: 'Delivery & Flow', weight: 15, description: 'Smooth pacing and confident presentation. Natural transitions and clear communication. Polished without sounding overly rehearsed.' },
  { name: 'Team Collaboration', weight: 15, description: 'Everyone contributes meaningfully and supports one another. Seamless transitions between speakers. Strong sense of teamwork and shared purpose.' },
  { name: 'Slide Aesthetics', weight: 15, description: 'Clean, consistent formatting and alignment. Free of typos or clutter. Visuals enhance understanding and engagement.' },
  { name: 'Fun Factor', weight: 15, description: 'Brings positive energy and enthusiasm to the room. Engaging and enjoyable to watch. Leaves a lasting, upbeat impression.' },
];

const clean = (s, max = 60) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const lines = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Evaluations (one per presentation day), their raters and rankings.
 * Raters sign in with just a name; the first device to use a name keeps it until the admin resets it.
 * Emits 'change' after every mutation.
 */
export class RankingStore extends EventEmitter {
  constructor() {
    super();
    this.evaluations = [];
    this.currentId = null;
    this.seq = 0;
  }

  nextId(prefix) {
    return `${prefix}${++this.seq}`;
  }

  changed() {
    this.emit('change');
  }

  current() {
    return this.evaluations.find((e) => e.id === this.currentId) ?? null;
  }

  get(evaluationId) {
    const ev = this.evaluations.find((e) => e.id === evaluationId);
    if (!ev) throw new RankingError('Unknown evaluation');
    return ev;
  }

  // ---------------------------------------------------------------- admin setup

  /**
   * groups:   one group name per line
   * roster:   optional "Name, Group" per line (leave the group empty for audience raters).
   *           With a roster only listed names can sign in, and their group is fixed.
   * criteria: "Name | weight | description" per line
   * alpha:    share of the grade from the presentation score, e.g. 0.9
   */
  createEvaluation({ name, groups, roster = '', criteria, alpha = 0.9 } = {}) {
    const ev = {
      id: this.nextId('e'),
      name: clean(name) || `Evaluation ${this.evaluations.length + 1}`,
      status: 'draft', // draft | open | closed
      published: false,
      groups: [],
      criteria: [],
      roster: [],
      alpha: 0.9,
      raters: [],
      rankings: {},
      createdAt: Date.now(),
    };
    this.applySetup(ev, { groups, roster, criteria, alpha });
    this.evaluations.push(ev);
    this.currentId = ev.id;
    this.changed();
    return ev;
  }

  /** Edit the current evaluation. Groups and criteria can only change before anyone has ranked. */
  editEvaluation(evaluationId, { name, groups, roster, criteria, alpha } = {}) {
    const ev = this.get(evaluationId);
    const ranked = Object.values(ev.rankings).some((r) => Object.keys(r).length);
    const newGroups = groups === undefined ? null : parseGroups(groups);
    const newCriteria = criteria === undefined ? null : parseCriteria(criteria);
    if (ranked) {
      if (newGroups && newGroups.map((g) => g.toLowerCase()).join('|') !== ev.groups.map((g) => g.name.toLowerCase()).join('|')) {
        throw new RankingError('Groups can’t change after rankings have been submitted');
      }
      if (newCriteria && newCriteria.map((c) => c.name.toLowerCase()).join('|') !== ev.criteria.map((c) => c.name.toLowerCase()).join('|')) {
        throw new RankingError('Criteria names can’t change after rankings have been submitted (weights and descriptions can)');
      }
    }
    if (name !== undefined) ev.name = clean(name) || ev.name;
    this.applySetup(ev, { groups, roster, criteria, alpha });
    this.changed();
  }

  applySetup(ev, { groups, roster, criteria, alpha }) {
    if (groups !== undefined) {
      const names = parseGroups(groups);
      // keep ids for groups whose name didn't change
      ev.groups = names.map((n) => ev.groups.find((g) => g.name.toLowerCase() === n.toLowerCase()) ?? { id: this.nextId('g'), name: n });
    }
    if (criteria !== undefined) {
      const parsed = parseCriteria(criteria);
      ev.criteria = parsed.map((c) => {
        const existing = ev.criteria.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
        return { id: existing?.id ?? this.nextId('c'), ...c };
      });
    }
    if (roster !== undefined) {
      ev.roster = lines(roster).map((line) => {
        const [rawName, rawGroup = ''] = line.split(/\t|,/);
        const name = clean(rawName, 40);
        if (!name) throw new RankingError(`Roster line "${line}" has no name`);
        const groupName = clean(rawGroup);
        const group = groupName ? ev.groups.find((g) => g.name.toLowerCase() === groupName.toLowerCase()) : null;
        if (groupName && !group) throw new RankingError(`Roster: "${groupName}" (for ${name}) isn't one of the groups`);
        return { name, groupId: group?.id ?? null };
      });
      const seen = new Set();
      for (const r of ev.roster) {
        if (seen.has(r.name.toLowerCase())) throw new RankingError(`Roster lists ${r.name} twice`);
        seen.add(r.name.toLowerCase());
      }
      // keep signed-in raters' groups in line with the roster
      for (const rater of ev.raters) {
        const entry = ev.roster.find((r) => r.name.toLowerCase() === rater.name.toLowerCase());
        if (entry && entry.groupId !== rater.groupId) {
          rater.groupId = entry.groupId;
          delete ev.rankings[rater.id]; // their eligible groups changed
        }
      }
    }
    if (alpha !== undefined && alpha !== '') {
      let a = Number(alpha);
      if (a > 1) a /= 100; // accept 90 as 90%
      if (!Number.isFinite(a) || a < 0 || a > 1) throw new RankingError('Presentation weight must be between 0 and 100%');
      ev.alpha = a;
    }
    if (ev.groups.length < 3) throw new RankingError('Add at least 3 groups (4+ recommended)');
  }

  setStatus(evaluationId, status) {
    if (!['draft', 'open', 'closed'].includes(status)) throw new RankingError('Unknown status');
    this.get(evaluationId).status = status;
    this.changed();
  }

  setPublished(evaluationId, published) {
    this.get(evaluationId).published = !!published;
    this.changed();
  }

  setCurrent(evaluationId) {
    this.currentId = this.get(evaluationId).id;
    this.changed();
  }

  deleteEvaluation(evaluationId) {
    const ev = this.get(evaluationId);
    this.evaluations = this.evaluations.filter((e) => e !== ev);
    if (this.currentId === ev.id) this.currentId = this.evaluations.at(-1)?.id ?? null;
    this.changed();
  }

  /** Let a rater sign in again from a new device (their rankings are kept). */
  resetRater(evaluationId, raterId) {
    const rater = this.getRater(this.get(evaluationId), raterId);
    rater.token = null;
    this.emit('signout', rater.id);
    this.changed();
  }

  removeRater(evaluationId, raterId) {
    const ev = this.get(evaluationId);
    const rater = this.getRater(ev, raterId);
    ev.raters = ev.raters.filter((r) => r !== rater);
    delete ev.rankings[rater.id];
    this.emit('signout', rater.id);
    this.changed();
  }

  getRater(ev, raterId) {
    const rater = ev.raters.find((r) => r.id === raterId);
    if (!rater) throw new RankingError('Unknown rater');
    return rater;
  }

  // ---------------------------------------------------------------- raters

  /** Sign in to the current evaluation with a saved token, or claim a name. */
  login({ name, groupId, token } = {}) {
    const ev = this.current();
    if (!ev) throw new RankingError('No evaluation is set up yet');
    if (token) {
      const rater = ev.raters.find((r) => r.token === token);
      if (rater) return rater;
      if (!name) throw new RankingError('Please sign in again');
    }
    const clean_ = clean(name, 40);
    if (!clean_) throw new RankingError('Enter your name');
    const key = clean_.toLowerCase();
    let group = null;
    let displayName = clean_;
    if (ev.roster.length) {
      const entry = ev.roster.find((r) => r.name.toLowerCase() === key);
      if (!entry) throw new RankingError('That name isn’t on the list. Check the spelling or ask the organizer.');
      group = entry.groupId;
      displayName = entry.name;
    } else if (groupId && groupId !== 'none') {
      if (!ev.groups.some((g) => g.id === groupId)) throw new RankingError('Pick your group');
      group = groupId;
    } else if (groupId !== 'none') {
      throw new RankingError('Pick your group, or "None" if you’re not in one');
    }

    let rater = ev.raters.find((r) => r.name.toLowerCase() === key);
    if (rater?.token) throw new RankingError(`${rater.name} is already signed in on another device. Ask the organizer to reset it.`);
    if (!rater) {
      rater = { id: this.nextId('r'), name: displayName, groupId: group, token: null, createdAt: Date.now() };
      ev.raters.push(rater);
    }
    rater.token = randomUUID();
    this.changed();
    return rater;
  }

  findRaterByToken(token) {
    return this.current()?.raters.find((r) => r.token && r.token === token) ?? null;
  }

  /**
   * Submit a rater's rankings for every category at once: { [criterionId]: [groupId, ...] } best first,
   * each listing every group except their own exactly once. Resubmitting replaces the previous submission.
   */
  submitAll(raterId, rankings = {}) {
    const ev = this.current();
    if (!ev) throw new RankingError('No evaluation is running');
    if (ev.status !== 'open') throw new RankingError(ev.status === 'closed' ? 'Ranking is closed' : 'Ranking hasn’t opened yet');
    const rater = this.getRater(ev, raterId);
    const eligible = eligibleGroups(ev, rater);
    const clean = {};
    for (const c of ev.criteria) {
      const order = rankings?.[c.id];
      if (!Array.isArray(order) || order.length !== eligible.length || new Set(order).size !== order.length || !order.every((g) => eligible.includes(g))) {
        throw new RankingError(`Finish ranking “${c.name}” first: every group except your own, once each`);
      }
      clean[c.id] = [...order];
    }
    ev.rankings[rater.id] = clean;
    rater.submittedAt = Date.now();
    this.changed();
  }

  /** Erase every rater and submission (e.g. after testing). The setup is kept. */
  clearRankings(evaluationId) {
    const ev = this.get(evaluationId);
    const ids = ev.raters.map((r) => r.id);
    ev.raters = [];
    ev.rankings = {};
    for (const id of ids) this.emit('signout', id);
    this.changed();
  }

  // ---------------------------------------------------------------- views

  results(ev) {
    return computeResults(ev, ev.raters, ev.rankings);
  }

  /** What every rater sees. Results only once published. */
  publicView() {
    const ev = this.current();
    if (!ev) return null;
    const view = {
      id: ev.id,
      name: ev.name,
      status: ev.status,
      published: ev.published,
      alpha: ev.alpha,
      groups: ev.groups,
      criteria: ev.criteria,
      roster: ev.roster.map((r) => r.name),
    };
    if (ev.published) {
      view.results = this.results(ev).groups.map(({ id, name, rank, P, A, grade, byCriterion }) => ({ id, name, rank, P, A, grade, byCriterion }));
    }
    return view;
  }

  raterView(raterId) {
    const ev = this.current();
    const rater = ev?.raters.find((r) => r.id === raterId);
    if (!rater) return null;
    const view = {
      id: rater.id,
      name: rater.name,
      groupId: rater.groupId,
      eligible: eligibleGroups(ev, rater),
      rankings: ev.rankings[rater.id] ?? {},
      submittedAt: rater.submittedAt ?? null,
    };
    if (ev.published) {
      const mine = this.results(ev).raters.find((r) => r.id === rater.id);
      view.agreement = mine?.A ?? null;
      view.grade = mine?.grade ?? null;
    }
    return view;
  }

  adminView() {
    const ev = this.current();
    return {
      evaluations: this.evaluations.map((e) => ({ id: e.id, name: e.name, status: e.status, createdAt: e.createdAt, raters: e.raters.length })),
      current: ev && {
        ...this.publicView(),
        published: ev.published,
        roster: ev.roster,
        raters: ev.raters.map((r) => ({ id: r.id, name: r.name, groupId: r.groupId, signedIn: !!r.token, submittedAt: r.submittedAt ?? null })),
        results: this.results(ev),
      },
      defaults: DEFAULT_CRITERIA,
    };
  }

  // ---------------------------------------------------------------- persistence

  toJSON() {
    return { version: 1, seq: this.seq, currentId: this.currentId, evaluations: this.evaluations };
  }

  static fromJSON(data) {
    const store = new RankingStore();
    store.seq = data.seq ?? 0;
    store.currentId = data.currentId ?? null;
    store.evaluations = data.evaluations ?? [];
    return store;
  }
}

export function eligibleGroups(ev, rater) {
  return ev.groups.filter((g) => g.id !== rater.groupId).map((g) => g.id);
}

function parseGroups(text) {
  const names = (Array.isArray(text) ? text : lines(text)).map((n) => clean(n)).filter(Boolean);
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw new RankingError('Group names must be different');
  return names;
}

function parseCriteria(text) {
  const list = Array.isArray(text)
    ? text
    : lines(text).map((line) => {
        const [name, weight, ...rest] = line.split('|').map((s) => s.trim());
        return { name, weight, description: rest.join(' | ') };
      });
  const parsed = list.map((c) => ({ name: clean(c.name), weight: Number(String(c.weight ?? '').replace('%', '')), description: clean(c.description, 300) }));
  if (!parsed.length) throw new RankingError('Add at least one category');
  for (const c of parsed) {
    if (!c.name) throw new RankingError('Every category needs a name');
    if (!Number.isFinite(c.weight) || c.weight <= 0) throw new RankingError(`"${c.name}" needs a positive weight`);
  }
  if (new Set(parsed.map((c) => c.name.toLowerCase())).size !== parsed.length) throw new RankingError('Category names must be different');
  return parsed;
}
