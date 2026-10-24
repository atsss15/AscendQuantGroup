/**
 * Peer-ranking scores for group presentations.
 *
 * Each rater ranks every group except their own, separately for each rubric criterion.
 *
 * Presentation score P (per group): in a ranking of m groups, position r (1 = best) is worth
 * (m - r) / (m - 1), so first place = 1 and last = 0. Average over raters, then take the
 * weighted average over criteria. A rater never ranks their own group, so nothing they report
 * can change their own group's P.
 *
 * Agreement score A (per rater): for every pair of groups the rater ordered, compare their order
 * with every other rater who also ordered that pair, excluding the rater's teammates. A is the
 * fraction of those comparisons that agree, weighted across criteria. A criterion the rater
 * didn't rank counts as 0 agreement when comparisons were possible.
 *
 * Grade = 100 × (alpha × P + (1 − alpha) × A). If everyone else ranks honestly and the class
 * shares the same ordering, any deviation from it lowers your own A and nothing else.
 *
 * Inputs:
 *   evaluation: { groups: [{ id, name }], criteria: [{ id, name, weight }], alpha }
 *   raters:     [{ id, name, groupId | null }]   (null = audience, ranks every group)
 *   rankings:   { [raterId]: { [criterionId]: [groupId, ...] } }   best first
 */
export function computeResults(evaluation, raters, rankings) {
  const { groups, criteria } = evaluation;
  const alpha = evaluation.alpha ?? 0.9;

  // position of each group in each rater's ranking: raterId -> criterionId -> Map(groupId -> index)
  const pos = new Map();
  for (const r of raters) {
    const byCriterion = {};
    for (const c of criteria) {
      const order = rankings[r.id]?.[c.id];
      if (order?.length) byCriterion[c.id] = new Map(order.map((g, i) => [g, i]));
    }
    pos.set(r.id, byCriterion);
  }

  const weighted = (values) => {
    let total = 0;
    let weights = 0;
    for (const c of criteria) {
      if (values[c.id] == null) continue;
      total += c.weight * values[c.id];
      weights += c.weight;
    }
    return weights ? total / weights : null;
  };

  // ---- presentation scores
  const groupResults = groups.map((g) => {
    const byCriterion = {};
    const raterIds = new Set();
    for (const c of criteria) {
      let sum = 0;
      let count = 0;
      for (const r of raters) {
        const order = pos.get(r.id)[c.id];
        if (!order?.has(g.id)) continue;
        const m = order.size;
        sum += m > 1 ? (m - 1 - order.get(g.id)) / (m - 1) : 1;
        count++;
        raterIds.add(r.id);
      }
      byCriterion[c.id] = count ? sum / count : null;
    }
    return { id: g.id, name: g.name, P: weighted(byCriterion), byCriterion, ratedBy: raterIds.size };
  });

  // ---- agreement scores
  const raterResults = raters.map((j) => {
    const mine = pos.get(j.id);
    const byCriterion = {};
    let comparisons = 0;
    for (const c of criteria) {
      const others = raters.filter((k) => k.id !== j.id && !(j.groupId && k.groupId === j.groupId) && pos.get(k.id)[c.id]);
      const order = mine[c.id];
      if (!order) {
        // didn't rank this criterion: 0 if anyone could have been compared with, otherwise not counted
        byCriterion[c.id] = others.length ? 0 : null;
        continue;
      }
      const ids = [...order.keys()];
      let agree = 0;
      let total = 0;
      for (let a = 0; a < ids.length; a++) {
        for (let b = a + 1; b < ids.length; b++) {
          const [x, y] = [ids[a], ids[b]];
          const jPrefersX = order.get(x) < order.get(y);
          for (const k of others) {
            const theirs = pos.get(k.id)[c.id];
            if (!theirs.has(x) || !theirs.has(y)) continue;
            total++;
            if (theirs.get(x) < theirs.get(y) === jPrefersX) agree++;
          }
        }
      }
      comparisons += total;
      byCriterion[c.id] = total ? agree / total : null;
    }
    const completed = criteria.filter((c) => mine[c.id]).length;
    return { id: j.id, name: j.name, groupId: j.groupId, completed, A: completed ? weighted(byCriterion) : 0, byCriterion, comparisons };
  });

  // ---- grades
  const grade = (P, A) => (P == null ? null : 100 * (A == null ? P : alpha * P + (1 - alpha) * A));
  for (const g of groupResults) {
    const members = raterResults.filter((r) => r.groupId === g.id && r.completed > 0 && r.A != null);
    g.A = members.length ? members.reduce((s, r) => s + r.A, 0) / members.length : null;
    g.grade = grade(g.P, g.A);
  }
  const ranked = [...groupResults].sort((a, b) => (b.grade ?? -1) - (a.grade ?? -1));
  ranked.forEach((g, i) => (g.rank = i + 1));
  for (const r of raterResults) {
    const group = groupResults.find((g) => g.id === r.groupId);
    r.grade = group ? grade(group.P, r.A) : r.A == null ? null : 100 * r.A; // audience: evaluation score only
  }

  return { groups: ranked, raters: raterResults, alpha };
}
