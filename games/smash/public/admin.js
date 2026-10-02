/* Smash admin panel: create matches (one binary contract per player) and settle them by picking the winner. */
(() => {
  'use strict';
  const { h, admin, toast, registerAdminPanel } = window.Exchange;

  function matchesFrom(state) {
    const matches = new Map();
    for (const m of state.markets) {
      if (!m.meta?.matchId) continue;
      const id = m.meta.matchId;
      if (!matches.has(id)) matches.set(id, { id, name: m.group.name, players: m.meta.players, markets: [] });
      matches.get(id).markets.push(m);
    }
    return [...matches.values()].map((match) => ({
      ...match,
      settled: match.markets.every((m) => m.status === 'settled'),
      winner: match.markets.find((m) => m.status === 'settled' && m.settlement === 100)?.meta.player,
    }));
  }

  registerAdminPanel({
    title: 'Smash matches',
    gameId: 'smash', // only shown during a Smash session

    mount(el) {
      const name = h('input', { placeholder: 'Match name (optional)' });
      const players = h('div', { class: 'players' });
      const addPlayer = (value = '') => {
        const input = h('input', { placeholder: `Player ${players.children.length + 1}`, value });
        players.append(input);
        return input;
      };
      addPlayer();
      addPlayer();

      const form = h(
        'form',
        { class: 'inline', onsubmit: async (e) => {
          e.preventDefault();
          const list = [...players.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
          const res = await admin('createMatch', { name: name.value, players: list });
          if (!res.ok) return;
          toast(`Listed ${name.value || 'match'}: ${list.join(' vs ')}`);
          name.value = '';
          players.replaceChildren();
          addPlayer();
          addPlayer();
        } },
        name,
        players,
        h('button', { type: 'button', class: 'small', onclick: () => addPlayer().focus() }, '+ player'),
        h('button', { type: 'button', class: 'small', onclick: () => players.children.length > 2 && players.lastElementChild.remove() }, '− player'),
        h('button', { type: 'submit', class: 'primary' }, 'List match'),
      );

      this.list = h('div', { class: 'match-list' });
      this.rows = new Map();
      el.append(form, this.list);
    },

    update(state) {
      const matches = matchesFrom(state);
      const active = matches.filter((m) => !m.settled).reverse();
      const recent = matches.filter((m) => m.settled).slice(-3).reverse();
      const shown = [...active, ...recent];

      // Rows are keyed so an open <select> isn't reset by live updates.
      for (const [id, row] of this.rows) {
        if (!shown.some((m) => m.id === id)) {
          row.root.remove();
          this.rows.delete(id);
        }
      }
      shown.forEach((match, i) => {
        let row = this.rows.get(match.id);
        if (row && row.settled !== match.settled) {
          row.root.remove();
          row = null;
        }
        if (!row) {
          row = match.settled ? settledRow(match) : activeRow(match);
          this.rows.set(match.id, row);
        }
        if (this.list.children[i] !== row.root) this.list.insertBefore(row.root, this.list.children[i] ?? null);
        row.status.textContent = match.settled
          ? `${match.winner ?? '?'} won`
          : match.markets.some((m) => m.status === 'halted') ? 'halted' : 'trading';
      });
    },
  });

  function activeRow(match) {
    const status = h('span', { class: 'muted' });
    const winner = h('select', {}, h('option', { value: '' }, 'Winner…'), match.players.map((p) => h('option', { value: p }, p)));
    const settle = h('button', { type: 'button', class: 'primary small', onclick: async () => {
      if (!winner.value) return toast('Pick the winner first', 'error');
      if (!confirm(`${winner.value} won ${match.name}? Settles ${winner.value} at 100 and everyone else at 0.`)) return;
      const res = await admin('settleMatch', { matchId: match.id, winner: winner.value });
      if (res.ok) toast(`${match.name} settled: ${winner.value} wins`);
    } }, 'Settle');
    const root = h('div', { class: 'match-row' }, h('b', {}, match.name), h('span', {}, match.players.join(' vs ')), status, winner, settle, deleteButton(match));
    return { root, status, settled: false };
  }

  function deleteButton(match) {
    return h('button', { type: 'button', class: 'small danger', onclick: async () => {
      if (!confirm(`Delete ${match.name}? Any trades in it are cancelled and everyone's chips restored.`)) return;
      const res = await admin('deleteMarket', { groupId: match.id });
      if (res.ok) toast(`${match.name} deleted`);
    } }, 'Delete');
  }

  function settledRow(match) {
    const status = h('span', { class: 'muted' });
    const rematch = h('button', { type: 'button', class: 'small', onclick: async () => {
      const res = await admin('createMatch', { players: match.players });
      if (res.ok) toast(`Rematch listed: ${match.players.join(' vs ')}`);
    } }, 'Rematch');
    const root = h('div', { class: 'match-row done' }, h('b', {}, match.name), h('span', {}, match.players.join(' vs ')), status, rematch, deleteButton(match));
    return { root, status, settled: true };
  }
})();
