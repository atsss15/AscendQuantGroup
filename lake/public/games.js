/**
 * Lake Lurkers phone mini-games: the seven ~2-minute games behind the 'task' chores.
 *
 *   window.LakeGames.<name>(el, { done, fail, seed }) → cleanup
 *
 * Each game renders inside `el` (the app supplies the title and the Quit bar, so only the game goes here) and returns
 * a function that stops every timer, animation frame, observer and listener it started.
 *
 * done() is called once when the player wins. fail() is called once when the player loses one of the four games that
 * can be lost, and the game then stops for good (no restart, no new word): the app sends choreFail and the game moves
 * to another room. Losing means
 *   hold       letting go for more than 1 s (a 1 s "Don't let go!" warning first)
 *   wordle     6 wrong guesses (the word shows for a moment first)
 *   snake      a crash (the crash shows for a moment first)
 *   blackjack  3 lost hands before 3 won ones (pushes don't count; the last hand shows for a moment first)
 * make24, tap50 and crack can't be lost. At most one of done() / fail() is ever called, and neither after cleanup, so a
 * Campfire or pause that closes the game never counts as a loss.
 *
 * `seed` makes the random parts repeatable for the test page (games-test.html?seed=…); the app never passes one, so
 * answers are unpredictable. Answers live only in closures: nothing on window or in the DOM gives them away before the
 * game is over. Plain DOM, no network, no libraries; styles in games.css.
 */
(() => {
  'use strict';

  // ---------- shared plumbing

  /** Tracks everything a game starts (timers, frames, listeners, observers) so cleanup can stop all of it. */
  function scope() {
    const timers = new Set();
    const frames = new Set();
    const undo = [];
    const S = {
      dead: false,
      on(target, type, fn, options) {
        const f = (e) => { if (!S.dead) fn(e); };
        target.addEventListener(type, f, options);
        undo.push(() => target.removeEventListener(type, f, options));
      },
      after(ms, fn) {
        const id = setTimeout(() => {
          timers.delete(id);
          if (!S.dead) fn();
        }, ms);
        timers.add(id);
        return id;
      },
      every(ms, fn) {
        const id = setInterval(() => { if (!S.dead) fn(); }, ms);
        timers.add(id);
        return id;
      },
      clear(id) {
        clearTimeout(id);
        clearInterval(id);
        timers.delete(id);
      },
      frame(fn) {
        const id = requestAnimationFrame((t) => {
          frames.delete(id);
          if (!S.dead) fn(t);
        });
        frames.add(id);
        return id;
      },
      unframe(id) {
        cancelAnimationFrame(id);
        frames.delete(id);
      },
      defer(fn) { undo.push(fn); },
      stop() {
        if (S.dead) return;
        S.dead = true;
        for (const id of timers) { clearTimeout(id); clearInterval(id); }
        for (const id of frames) cancelAnimationFrame(id);
        timers.clear();
        frames.clear();
        while (undo.length) {
          try { undo.pop()(); } catch { /* keep cleaning */ }
        }
      },
    };
    return S;
  }

  /** h(tag, attrs, ...children); `on…` attributes become listeners owned by the scope. */
  function builder(S) {
    return function h(tag, attrs, ...kids) {
      const el = document.createElement(tag);
      if (tag === 'button') el.type = 'button';
      for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') S.on(el, k.slice(2), v);
        else if (k === 'class') el.className = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
      for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
      return el;
    };
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, String(v));
    el.append(...kids);
    return el;
  }

  /** Random floats in [0, 1): crypto when unseeded, a seeded mulberry32 (per game) on the test page. */
  function makeRng(seed, salt) {
    if (seed == null || seed === '') {
      const buf = new Uint32Array(1);
      return () => {
        if (globalThis.crypto?.getRandomValues) {
          crypto.getRandomValues(buf);
          return buf[0] / 4294967296;
        }
        return Math.random();
      };
    }
    let a = 2166136261;
    for (const ch of `${seed}:${salt}`) a = Math.imul(a ^ ch.charCodeAt(0), 16777619) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const randInt = (rng, n) => Math.floor(rng() * n);
  function shuffle(rng, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(rng, i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** m:ss, rounding up so 0:00 means really done. */
  const mmss = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  /** Elapsed time with tenths: 42.3 → "0:42.3". */
  const clock = (ms) => {
    const t = Math.max(0, Math.floor(ms / 100));
    const s = Math.floor(t / 10);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${t % 10}`;
  };

  /** A key press the game should leave alone: shortcuts, typing in a field, or a control outside the game. */
  function foreignKey(e, root) {
    if (e.metaKey || e.ctrlKey || e.altKey || !root.isConnected) return true;
    const t = e.target;
    return t instanceof Element && !root.contains(t) && !!t.closest('input, textarea, select, button, a, [contenteditable]');
  }

  /** Presses on a button: pointerdown for speed (no wait for the finger to lift), Enter/Space still work. */
  function onPress(S, el, fn) {
    if (window.PointerEvent) {
      S.on(el, 'pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        fn(e);
      });
      S.on(el, 'click', (e) => { if (e.detail === 0) fn(e); }); // keyboard activation
    } else S.on(el, 'click', fn);
  }

  /** Mounts a game root in `el` and returns the per-game kit. */
  function setup(el, opts, name) {
    const S = scope();
    const h = builder(S);
    const rng = makeRng(opts?.seed, name);
    const root = h('div', { class: `lg lg-${name}` });
    let ended = false;
    // the game is over one way or the other: tell the app exactly once (never after cleanup)
    const end = (fn) => {
      if (ended || S.dead) return;
      ended = true;
      try {
        if (typeof fn === 'function') fn();
      } catch (err) {
        console.error(err);
      }
    };
    const win = () => end(opts?.done);
    const lose = () => end(opts?.fail);
    // no iOS long-press menus, text selection or pinch zoom inside a game
    S.on(root, 'contextmenu', (e) => e.preventDefault());
    S.on(root, 'selectstart', (e) => e.preventDefault());
    S.on(root, 'gesturestart', (e) => e.preventDefault());
    S.on(root, 'dblclick', (e) => e.preventDefault());
    el.replaceChildren(root);
    return { S, h, rng, root, win, lose, cleanup: () => S.stop() };
  }

  /** A short buzz where the phone supports it (Android; iPhones ignore it). */
  const buzz = (ms) => {
    try {
      // without a tap first, Chrome logs an intervention instead of buzzing
      if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(ms);
    } catch { /* not allowed here */ }
  };

  // ---------- hold: keep a finger on the button for 2 minutes; letting go for more than a second loses

  function hold(el, opts) {
    const { S, h, root, win, lose, cleanup } = setup(el, opts, 'hold');
    const TOTAL = 120_000;
    const GRACE = 1000;
    const R = 46;
    const C = 2 * Math.PI * R;
    const prog = svg('circle', { cx: 50, cy: 50, r: R, class: 'lg-hd-prog', 'stroke-dasharray': C.toFixed(2), 'stroke-dashoffset': C.toFixed(2), transform: 'rotate(-90 50 50)' });
    const ring = svg('svg', { viewBox: '0 0 100 100', class: 'lg-hd-ring', 'aria-hidden': 'true' },
      svg('circle', { cx: 50, cy: 50, r: R, class: 'lg-hd-track' }), prog);
    const time = h('span', { class: 'lg-hd-time' }, mmss(TOTAL));
    const label = h('span', { class: 'lg-hd-label' }, 'Hold');
    const btn = h('button', { class: 'lg-hd-btn', 'aria-label': 'Hold' }, time, label);
    const hint = h('p', { class: 'lg-hint' }, 'Press and hold for 2 minutes. Let go for more than a second and you lose.');
    root.append(h('div', { class: 'lg-hd-wrap' }, ring, btn), hint);

    const down = new Set(); // pointers / touches / keys currently holding
    let held = 0;
    let last = 0;
    let raf = 0;
    let warnTimer = 0;
    let over = false;

    // nothing touches the screen for 2 minutes, so keep it from dimming and locking (Safari 16.4+, Chrome)
    let wake = null;
    let waking = false;
    const keepAwake = () => {
      if (wake || waking || over || document.hidden || !navigator.wakeLock?.request) return;
      waking = true;
      navigator.wakeLock.request('screen').then((lock) => {
        waking = false;
        if (S.dead || over) return lock.release().catch(() => {});
        wake = lock;
        lock.addEventListener?.('release', () => { if (wake === lock) wake = null; });
      }, () => { waking = false; });
    };
    const letSleep = () => {
      const lock = wake;
      wake = null;
      lock?.release().catch(() => {});
    };
    S.defer(letSleep);

    const render = () => {
      prog.setAttribute('stroke-dashoffset', (C * (1 - Math.min(1, held / TOTAL))).toFixed(2));
      time.textContent = mmss(TOTAL - held);
    };
    const step = (now) => {
      raf = 0;
      if (over || !down.size) return;
      held += Math.min(Math.max(0, now - last), 500); // a stalled frame never jumps ahead
      last = now;
      render();
      if (held >= TOTAL) complete();
      else raf = S.frame(step);
    };
    const press = (id) => {
      if (over || down.has(id)) return;
      down.add(id);
      if (down.size > 1) return;
      if (warnTimer) S.clear(warnTimer);
      warnTimer = 0;
      root.classList.remove('lg-warn');
      last = performance.now();
      btn.classList.add('lg-on');
      label.textContent = 'Holding…';
      hint.textContent = 'Keep holding. Let go for more than a second and you lose.';
      keepAwake();
      if (!raf) raf = S.frame(step);
    };
    const release = (id) => {
      if (!down.delete(id) || down.size || over) return;
      if (raf) S.unframe(raf);
      raf = 0;
      btn.classList.remove('lg-on');
      root.classList.add('lg-warn');
      label.textContent = 'Don’t let go!';
      hint.textContent = 'Put your finger back on, quick!';
      buzz(200);
      warnTimer = S.after(GRACE, () => {
        warnTimer = 0;
        letGo();
      });
    };
    const releaseAll = () => { for (const id of [...down]) release(id); };
    const letGo = () => {
      over = true;
      letSleep();
      root.classList.remove('lg-warn');
      root.classList.add('lg-lost');
      btn.disabled = true;
      label.textContent = 'You let go';
      hint.textContent = `You let go with ${mmss(TOTAL - held)} to go.`;
      lose();
    };
    const complete = () => {
      over = true;
      down.clear();
      letSleep();
      held = TOTAL;
      render();
      btn.classList.remove('lg-on');
      btn.classList.add('lg-done');
      root.classList.add('lg-done');
      label.textContent = 'Done!';
      hint.textContent = 'Two minutes held. What a grip.';
      win();
    };

    if (window.PointerEvent) {
      S.on(btn, 'pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        // a finger that slides off the button is still holding; only lifting it counts
        try { btn.setPointerCapture(e.pointerId); } catch { /* already released */ }
        press(`p${e.pointerId}`);
      });
      for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) S.on(btn, type, (e) => release(`p${e.pointerId}`));
    } else {
      S.on(btn, 'mousedown', (e) => { if (e.button === 0) press('mouse'); });
      for (const type of ['mouseup', 'mouseleave']) S.on(btn, type, () => release('mouse'));
      for (const type of ['touchend', 'touchcancel']) S.on(btn, type, (e) => { for (const t of e.changedTouches) release(`t${t.identifier}`); });
    }
    // stops the iOS magnifier, callout and double-tap zoom; pointer events still arrive
    S.on(btn, 'touchstart', (e) => {
      e.preventDefault();
      if (!window.PointerEvent) for (const t of e.changedTouches) press(`t${t.identifier}`);
    }, { passive: false });
    S.on(window, 'keydown', (e) => {
      if (e.key !== ' ' || foreignKey(e, root)) return;
      e.preventDefault();
      if (!e.repeat) press('key');
    });
    S.on(window, 'keyup', (e) => { if (e.key === ' ') release('key'); });
    // the page going away (lock screen, app switch, tab switch) counts as letting go
    S.on(document, 'visibilitychange', () => {
      if (document.hidden) releaseAll();
      else if (down.size) keepAwake(); // the lock goes when the page hides
    });
    S.on(window, 'pagehide', releaseAll);
    S.on(window, 'blur', releaseAll);
    return cleanup;
  }

  // ---------- wordle

  const WORDS = `
    ACORN ACTOR ALARM ALBUM ALERT ALIVE ALONE AMBER ANGLE ANGRY APPLE APRON ARENA ARROW AWARD BACON BADGE BAGEL BAKER
    BEACH BEARD BENCH BERRY BIRTH BLACK BLADE BLAST BLINK BLOCK BLOOM BOARD BONUS BOOTH BRAIN BRAKE BRAND BRAVE BREAD
    BREAK BRICK BRING BROOK BROOM BROWN BRUSH BUDDY BUILD BUNCH BUNNY CABIN CABLE CAMEL CANDY CANOE CARGO CARRY CATCH
    CHAIN CHAIR CHALK CHARM CHART CHASE CHECK CHEEK CHEER CHESS CHEST CHICK CHILD CHILL CHIRP CHORE CLASS CLEAN CLEAR
    CLIMB CLOCK CLOTH CLOUD CLOWN COACH COAST COCOA COUCH CRAFT CRANE CRAZY CREAM CRISP CROWD CROWN CRUMB DAISY DANCE
    DIARY DINER DIZZY DOUGH DOZEN DRAMA DREAM DRESS DRIFT DRILL DRINK DRIVE EAGLE EARLY EARTH EIGHT ELBOW ENJOY FAIRY
    FEAST FENCE FERRY FIELD FIFTY FLAME FLASH FLOAT FLOOR FLOUR FRAME FROST FRUIT FUNNY GHOST GIANT GLASS GLOBE GLOVE
    GRACE GRAIN GRAPE GRASS GREEN GREET GRILL GROUP GUARD GUEST GUIDE HAPPY HEART HONEY HORSE HOTEL HOUSE JELLY JEWEL
    JOKER JUICE KAYAK KOALA LASER LAUGH LEARN LEMON LIGHT LLAMA LODGE LUCKY LUNCH MAGIC MANGO MAPLE MARCH MATCH MEDAL
    MELON MERRY MIXER MODEL MONEY MOOSE MOTOR MOUSE MOUTH MOVIE MUSIC NIGHT NORTH OCEAN OLIVE ONION OPERA ORBIT OTTER
    PAINT PANDA PAPER PARTY PASTA PATCH PEACE PEACH PEARL PEDAL PENNY PHONE PHOTO PIANO PIECE PILOT PIZZA PLANE PLANT
    PLATE PLAZA POLAR POUCH POWER PRIZE PUPPY QUEEN QUEST QUILT QUOTE RADAR RADIO RAINY RANCH RAVEN READY RELAX RHYME
    RIDER RIVER ROAST ROBIN ROBOT ROCKY ROUND RULER SALAD SAUCE SCARF SCOOP SCORE SCOUT SEVEN SHADE SHAKE SHARE SHARK
    SHEEP SHELF SHELL SHINE SHIRT SHORE SHOUT SKATE SKILL SLEEP SLICE SLIDE SMART SMILE SNACK SNAIL SNAKE SOLAR SOLVE
    SOUND SPACE SPARK SPEAK SPEED SPICE SPOON SPORT SPRAY STACK STAIR STAMP STONE STOOL STORM STORY STOVE STRAW SUGAR
    SUNNY SUPER SWEET SWING TABLE TASTE TEACH TEETH THREE THROW THUMB TIGER TIMER TOAST TOOTH TORCH TOWEL TOWER TRACK
    TRAIL TRAIN TRUCK TULIP UNCLE VIDEO VISIT VOICE WAGON WATER WHALE WHEAT WHEEL WHITE WORLD YACHT YOUNG ZEBRA
  `.trim().split(/\s+/);

  /** g = right spot, y = in the word elsewhere, b = not in the word. Repeated letters count only as often as the answer has them. */
  function scoreGuess(guess, answer) {
    const res = Array(answer.length).fill('b');
    const left = {};
    for (let i = 0; i < answer.length; i++) {
      if (guess[i] === answer[i]) res[i] = 'g';
      else left[answer[i]] = (left[answer[i]] ?? 0) + 1;
    }
    for (let i = 0; i < answer.length; i++) {
      if (res[i] !== 'g' && left[guess[i]] > 0) {
        res[i] = 'y';
        left[guess[i]]--;
      }
    }
    return res;
  }

  function wordle(el, opts) {
    const { S, h, rng, root, win, lose, cleanup } = setup(el, opts, 'wordle');
    const ROWS = 6;
    const LEN = 5;
    const RANK = { b: 1, y: 2, g: 3 };
    const FLIP_MS = 150;
    const SHOW_WORD_MS = 2600; // how long the answer shows after the last miss, before the game counts as lost

    const tiles = [];
    const rowEls = [];
    const board = h('div', { class: 'lg-wd-board', role: 'grid', 'aria-label': 'Guesses' });
    for (let r = 0; r < ROWS; r++) {
      const rowEl = h('div', { class: 'lg-wd-row', role: 'row' });
      tiles.push(Array.from({ length: LEN }, (_, i) => rowEl.appendChild(h('div', { class: 'lg-wd-tile', role: 'gridcell', style: `--i:${i}` }))));
      rowEls.push(rowEl);
      board.append(rowEl);
    }
    const msg = h('div', { class: 'lg-msg', role: 'status', 'aria-live': 'polite' });
    const keys = {};
    const key = (k, label = k, cls = '') => {
      keys[k] = h('button', { class: `lg-key ${cls}`, tabindex: -1, 'aria-label': k === 'BACK' ? 'Delete' : k, onclick: () => input(k) }, label);
      return keys[k];
    };
    const gap = () => h('span', { class: 'lg-kb-gap' });
    const kb = h('div', { class: 'lg-kb' },
      [...'QWERTYUIOP'].map((k) => key(k)),
      gap(), [...'ASDFGHJKL'].map((k) => key(k)), gap(),
      key('ENTER', 'Enter', 'lg-wide'), [...'ZXCVBNM'].map((k) => key(k)), key('BACK', '⌫', 'lg-wide'));
    root.append(board, msg, kb);

    const answer = WORDS[randInt(rng, WORDS.length)];
    let row = 0;
    let cur = '';
    let over = false;
    let busy = false;
    const known = {};

    const say = (text, cls = '') => {
      msg.className = `lg-msg${cls ? ` lg-${cls}` : ''}`;
      msg.replaceChildren(text);
    };
    const left = () => (row === 0 ? 'Guess the 5-letter word in 6 tries.' : row === ROWS - 1 ? 'Last guess!' : `${ROWS - row} guesses left`);
    const paintRow = () => tiles[row].forEach((t, i) => {
      t.textContent = cur[i] ?? '';
      t.classList.toggle('lg-full', i < cur.length);
    });
    const shake = () => {
      rowEls[row].classList.remove('lg-shaking');
      void rowEls[row].offsetWidth; // restart the animation
      rowEls[row].classList.add('lg-shaking');
    };

    function input(k) {
      if (over || busy) return;
      if (k === 'ENTER') return submit();
      if (k === 'BACK') cur = cur.slice(0, -1);
      else if (/^[A-Z]$/.test(k) && cur.length < LEN) cur += k;
      else return;
      paintRow();
      say(left());
    }

    function submit() {
      if (cur.length < LEN) {
        say('Type all 5 letters first.');
        shake();
        return;
      }
      const guess = cur;
      const res = scoreGuess(guess, answer);
      tiles[row].forEach((t, i) => t.classList.add(`lg-${res[i]}`));
      busy = true;
      S.after(LEN * FLIP_MS + 420, () => {
        busy = false;
        for (let i = 0; i < LEN; i++) {
          const ch = guess[i];
          if (RANK[res[i]] > (RANK[known[ch]] ?? 0)) {
            known[ch] = res[i];
            keys[ch].classList.remove('lg-g', 'lg-y', 'lg-b');
            keys[ch].classList.add(`lg-${res[i]}`);
          }
        }
        row++;
        cur = '';
        if (guess === answer) {
          over = true;
          kb.classList.add('lg-off');
          say(`Solved in ${row}!`, 'good');
          win();
        } else if (row === ROWS) {
          // out of guesses: the game is lost and over for good; the word shows for a moment first
          over = true;
          kb.classList.add('lg-off');
          msg.className = 'lg-msg lg-bad';
          msg.replaceChildren(h('span', {}, 'Out of guesses. The word was ', h('b', {}, answer), '.'));
          buzz(200);
          S.after(SHOW_WORD_MS, lose);
        } else say(left());
      });
    }

    S.on(window, 'keydown', (e) => {
      if (foreignKey(e, root)) return;
      let k = e.key;
      if (k === 'Enter') k = 'ENTER';
      else if (k === 'Backspace') k = 'BACK';
      else if (/^[a-z]$/i.test(k)) k = k.toUpperCase();
      else return;
      e.preventDefault();
      input(k);
    });

    say(left());
    return cleanup;
  }

  // ---------- make 24: exact fractions, so 8 ÷ (3 − 8 ÷ 3) works

  const gcd = (a, b) => {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) [a, b] = [b, a % b];
    return a;
  };
  function frac(n, d = 1) {
    if (d < 0) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d) || 1;
    return { n: n / g + 0, d: d / g };
  }
  /** a op b as an exact fraction, or null for ÷ 0. */
  function calc(a, op, b) {
    switch (op) {
      case '+': return frac(a.n * b.d + b.n * a.d, a.d * b.d);
      case '-': return frac(a.n * b.d - b.n * a.d, a.d * b.d);
      case '*': return frac(a.n * b.n, a.d * b.d);
      case '/': return b.n === 0 ? null : frac(a.n * b.d, a.d * b.n);
      default: return null;
    }
  }
  const is24 = (f) => f.n === 24 && f.d === 1;
  /** Can these fractions make exactly 24 with + − × ÷ (any order, any grouping)? */
  function solvable(nums) {
    if (nums.length === 1) return is24(nums[0]);
    for (let i = 0; i < nums.length; i++) {
      for (let j = 0; j < nums.length; j++) {
        if (i === j) continue;
        const rest = nums.filter((_, k) => k !== i && k !== j);
        for (const op of i < j ? ['+', '*', '-', '/'] : ['-', '/']) {
          const r = calc(nums[i], op, nums[j]);
          if (r && solvable([...rest, r])) return true;
        }
      }
    }
    return false;
  }
  /** Also reachable with whole, non-negative numbers at every step? Skips the notorious ones like 3 3 8 8. */
  function friendly(nums) {
    if (nums.length === 1) return nums[0] === 24;
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const a = nums[i];
        const b = nums[j];
        const rest = nums.filter((_, k) => k !== i && k !== j);
        const out = [a + b, a * b, Math.abs(a - b)];
        if (b && a % b === 0) out.push(a / b);
        if (a && b % a === 0) out.push(b / a);
        for (const r of out) if (friendly([...rest, r])) return true;
      }
    }
    return false;
  }
  const fracText = (f) => {
    const s = f.d === 1 ? String(Math.abs(f.n)) : `${Math.abs(f.n)}/${f.d}`;
    return f.n < 0 ? `−${s}` : s;
  };

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RED = new Set(['♥', '♦']);
  const RANK_LABEL = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  const rankText = (r) => RANK_LABEL[r] ?? String(r);

  function make24(el, opts) {
    const { S, h, rng, root, win, cleanup } = setup(el, opts, 'make24');
    const NEED = 3;
    const OPS = [['+', '+', 'plus'], ['-', '−', 'minus'], ['*', '×', 'times'], ['/', '÷', 'divided by']];

    const progress = h('div', { class: 'lg-top' });
    const msg = h('div', { class: 'lg-msg', role: 'status', 'aria-live': 'polite' });
    const cardEls = [0, 1, 2, 3].map((i) => h('button', { class: 'lg-m24-card', onclick: () => tapNum(i) }));
    const opEls = OPS.map(([op, label, name]) => h('button', { class: 'lg-m24-op', 'aria-label': name, onclick: () => tapOp(op) }, label));
    const undoBtn = h('button', { class: 'lg-btn', onclick: () => undo() }, 'Undo');
    const resetBtn = h('button', { class: 'lg-btn', onclick: () => reset() }, 'Reset');
    const skipBtn = h('button', { class: 'lg-btn', onclick: () => skip() }, 'Skip hand');
    root.append(progress, h('div', { class: 'lg-m24-cards' }, cardEls), h('div', { class: 'lg-m24-ops' }, opEls), msg,
      h('div', { class: 'lg-row' }, undoBtn, resetBtn, skipBtn));

    let solved = 0;
    let start = []; // the dealt cards: { v, rank, suit }
    let slots = []; // what's on the table now: a dealt card, a computed { v }, or null once used up
    let history = [];
    let sel = -1;
    let op = null;
    let lock = false;

    const say = (text, cls = '') => {
      msg.className = `lg-msg${cls ? ` lg-${cls}` : ''}`;
      msg.textContent = text;
    };

    function deal() {
      let vals;
      do vals = [0, 0, 0, 0].map(() => 1 + randInt(rng, 13));
      while (!solvable(vals.map((v) => frac(v))) || !friendly(vals));
      start = vals.map((v) => ({ v: frac(v), rank: v, suit: SUITS[randInt(rng, 4)] }));
      slots = start.slice();
      history = [];
      sel = -1;
      op = null;
      lock = false;
      render();
    }

    function tapNum(i) {
      if (lock || !slots[i]) return;
      if (sel === -1 || op === null) {
        sel = sel === i ? -1 : i;
        say('');
        return render();
      }
      if (i === sel) {
        sel = -1;
        op = null;
        return render();
      }
      const r = calc(slots[sel].v, op, slots[i].v);
      if (!r) {
        op = null;
        say("Can't divide by 0.", 'bad');
        return render();
      }
      history.push(slots.slice());
      slots[i] = { v: r };
      slots[sel] = null;
      sel = -1;
      op = null;
      say('');
      const left = slots.filter(Boolean);
      if (left.length === 1) {
        if (is24(left[0].v)) return handWon(i);
        say(`That makes ${fracText(left[0].v)}, not 24. Undo or reset.`, 'bad');
      }
      render();
    }

    function tapOp(o) {
      if (lock) return;
      if (sel === -1) {
        say('Tap a number first.');
        return;
      }
      op = op === o ? null : o;
      render();
    }

    function undo() {
      if (lock || !history.length) return;
      slots = history.pop();
      sel = -1;
      op = null;
      say('');
      render();
    }

    function reset() {
      if (lock) return;
      slots = start.slice();
      history = [];
      sel = -1;
      op = null;
      say('');
      render();
    }

    function skip() {
      if (lock) return;
      deal();
      say("New hand. Skipped hands don't count.");
    }

    function handWon(i) {
      lock = true;
      solved++;
      render();
      cardEls[i].classList.add('lg-win');
      if (solved >= NEED) {
        say('24! All 3 hands solved.', 'good');
        progress.textContent = `Solved ${NEED} of ${NEED}`;
        win();
        return;
      }
      say('24! Hand solved.', 'good');
      S.after(1100, () => {
        deal();
        say('');
      });
    }

    function render() {
      progress.textContent = `Hand ${Math.min(solved + 1, NEED)} of ${NEED}`;
      cardEls.forEach((b, i) => {
        const s = slots[i];
        const dealt = s && s.rank != null;
        b.className = 'lg-m24-card';
        b.classList.toggle('lg-gone', !s);
        b.classList.toggle('lg-calc', !!s && !dealt);
        b.classList.toggle('lg-red', !!dealt && RED.has(s.suit));
        b.classList.toggle('lg-sel', i === sel);
        b.disabled = !s || lock;
        if (!s) {
          b.replaceChildren();
          b.setAttribute('aria-label', 'used');
        } else if (dealt) {
          b.replaceChildren(h('span', { class: 'lg-m24-rank' }, rankText(s.rank)), h('span', { class: 'lg-m24-suit' }, s.suit));
          if (RANK_LABEL[s.rank]) b.append(h('span', { class: 'lg-m24-val' }, `= ${s.rank}`));
          b.setAttribute('aria-label', String(s.rank));
        } else {
          const text = fracText(s.v);
          b.replaceChildren(h('span', { class: `lg-m24-rank${text.length > 4 ? ' lg-long' : ''}` }, text));
          b.setAttribute('aria-label', text);
        }
      });
      opEls.forEach((b, k) => {
        b.classList.toggle('lg-sel', OPS[k][0] === op);
        b.disabled = lock;
      });
      undoBtn.disabled = lock || !history.length;
      resetBtn.disabled = lock || !history.length;
      skipBtn.disabled = lock;
    }

    deal();
    say('Tap a card, an operation, then another card.');
    return cleanup;
  }

  // ---------- snake

  function snake(el, opts) {
    const { S, h, rng, root, win, lose, cleanup } = setup(el, opts, 'snake');
    const N = 15;
    const NEED = 12;
    const STEP = 1000 / 6.5; // moves per second
    const SHOW_CRASH_MS = 1200; // the crash stays on screen this long before the game counts as lost
    const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
    const ARROW = { up: '▲', down: '▼', left: '◀', right: '▶' };

    const score = h('div', { class: 'lg-top' });
    const canvas = h('canvas', { class: 'lg-sn-canvas', role: 'img', 'aria-label': 'Snake board' });
    const note = h('div', { class: 'lg-sn-note' });
    const wrap = h('div', { class: 'lg-sn-wrap' }, canvas, note);
    const pad = h('div', { class: 'lg-sn-pad' });
    for (const d of ['up', 'left', 'down', 'right']) {
      const b = h('button', { class: `lg-sn-btn lg-${d}`, 'aria-label': d }, ARROW[d]);
      onPress(S, b, () => steer(d));
      pad.append(b);
    }
    root.append(score, wrap, pad);

    const css = getComputedStyle(root);
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const COL = {
      a: color('--panel', '#161b22'),
      b: color('--panel-2', '#1c2230'),
      apple: color('--red', '#f85149'),
      body: color('--green', '#3fb950'),
      head: '#a6f0b0',
      crash: color('--amber', '#d29922'),
      eye: '#0d1117',
    };

    let body = [];
    let dir = 'right';
    let queue = [];
    let apple = null;
    let eaten = 0;
    let mode = 'ready'; // ready | run | paused | crash | won
    let acc = 0;
    let lastT = 0;
    let raf = 0;

    const show = (text) => {
      note.textContent = text;
      note.hidden = !text;
    };
    const updateScore = () => { score.textContent = `Apples: ${eaten} / ${NEED}`; };

    function placeApple() {
      const free = [];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!body.some(([bx, by]) => bx === x && by === y)) free.push([x, y]);
      apple = free[randInt(rng, free.length)];
    }

    function reset() {
      const mid = Math.floor(N / 2);
      body = [[mid - 2, mid], [mid - 3, mid], [mid - 4, mid]];
      dir = 'right';
      queue = [];
      eaten = 0;
      mode = 'ready';
      placeApple();
      updateScore();
      show('Swipe or tap an arrow to go. Don’t crash!');
      draw();
    }

    function steer(d) {
      if (mode === 'crash' || mode === 'won') return;
      if (mode === 'ready' || mode === 'paused') {
        mode = 'run';
        show('');
        acc = 0;
        lastT = performance.now();
        if (!raf) raf = S.frame(frame);
      }
      const lastDir = queue.length ? queue[queue.length - 1] : dir;
      if (d === lastDir || d === OPP[lastDir] || queue.length >= 2) return;
      queue.push(d);
    }

    function tick() {
      if (queue.length) dir = queue.shift();
      const [dx, dy] = DIRS[dir];
      const nx = body[0][0] + dx;
      const ny = body[0][1] + dy;
      const eats = !!apple && nx === apple[0] && ny === apple[1];
      // the tail moves out of the way this step unless the snake is growing
      const hitsSelf = body.some(([x, y], k) => x === nx && y === ny && (eats || k < body.length - 1));
      if (nx < 0 || ny < 0 || nx >= N || ny >= N || hitsSelf) return crash();
      body.unshift([nx, ny]);
      if (!eats) {
        body.pop();
        return;
      }
      eaten++;
      updateScore();
      if (eaten >= NEED) {
        mode = 'won';
        apple = null;
        show(`All ${NEED} apples!`);
        win();
      } else placeApple();
    }

    // one crash and the game is lost and over for good (no restart)
    function crash() {
      mode = 'crash';
      queue = [];
      show(`Crashed with ${eaten} of ${NEED} apples`);
      buzz(200);
      S.after(SHOW_CRASH_MS, lose);
    }

    function frame(t) {
      raf = 0;
      if (mode !== 'run') return;
      acc += Math.min(Math.max(0, t - lastT), 250);
      lastT = t;
      let moved = false;
      while (acc >= STEP && mode === 'run') {
        acc -= STEP;
        tick();
        moved = true;
      }
      if (moved) draw();
      if (mode === 'run') raf = S.frame(frame);
    }

    function cellRect(x, y, k, inset) {
      const x0 = Math.round(x * k) + inset;
      const y0 = Math.round(y * k) + inset;
      return [x0, y0, Math.round((x + 1) * k) - inset - x0, Math.round((y + 1) * k) - inset - y0];
    }
    function rounded(c, x, y, w, hgt, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + hgt, r);
      c.arcTo(x + w, y + hgt, x, y + hgt, r);
      c.arcTo(x, y + hgt, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
      c.fill();
    }

    function draw() {
      const W = canvas.width;
      if (!W) return;
      const c = canvas.getContext('2d');
      const k = W / N;
      c.fillStyle = COL.a;
      c.fillRect(0, 0, W, W);
      c.fillStyle = COL.b;
      for (let y = 0; y < N; y++) for (let x = (y % 2); x < N; x += 2) c.fillRect(...cellRect(x, y, k, 0));
      if (apple) {
        c.fillStyle = COL.apple;
        c.beginPath();
        c.arc((apple[0] + 0.5) * k, (apple[1] + 0.5) * k, k * 0.38, 0, 2 * Math.PI);
        c.fill();
      }
      const inset = Math.max(1, Math.round(k * 0.06));
      for (let i = body.length - 1; i >= 0; i--) {
        const [x, y] = body[i];
        c.fillStyle = i === 0 ? (mode === 'crash' ? COL.crash : COL.head) : COL.body;
        rounded(c, ...cellRect(x, y, k, inset), k * 0.22);
      }
      if (body.length) {
        // two eyes, ahead of the head's centre
        const [x, y] = body[0];
        const [dx, dy] = DIRS[dir];
        const cx = (x + 0.5 + dx * 0.18) * k;
        const cy = (y + 0.5 + dy * 0.18) * k;
        c.fillStyle = COL.eye;
        for (const s of [-1, 1]) {
          c.beginPath();
          c.arc(cx + dy * s * 0.22 * k, cy + dx * s * 0.22 * k, k * 0.08, 0, 2 * Math.PI);
          c.fill();
        }
      }
    }

    function resize() {
      const w = canvas.clientWidth;
      if (!w) return;
      const px = Math.round(w * (window.devicePixelRatio || 1));
      if (canvas.width !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      draw();
    }
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => { if (!S.dead) resize(); });
      ro.observe(canvas);
      S.defer(() => ro.disconnect());
    }
    S.on(window, 'resize', resize);

    // swipes on the board: each 18 px of travel in one direction is a turn, so one drag can turn twice
    let swipe = null;
    S.on(canvas, 'pointerdown', (e) => {
      e.preventDefault();
      swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    S.on(canvas, 'pointermove', (e) => {
      if (!swipe || e.pointerId !== swipe.id) return;
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
      steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
      swipe.x = e.clientX;
      swipe.y = e.clientY;
    });
    for (const type of ['pointerup', 'pointercancel']) S.on(canvas, type, () => { swipe = null; });
    for (const type of ['touchstart', 'touchmove']) S.on(canvas, type, (e) => e.preventDefault(), { passive: false });

    const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
    S.on(window, 'keydown', (e) => {
      const d = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (!d || foreignKey(e, root)) return;
      e.preventDefault();
      steer(d);
    });
    S.on(document, 'visibilitychange', () => {
      if (!document.hidden || mode !== 'run') return;
      mode = 'paused';
      queue = [];
      if (raf) S.unframe(raf);
      raf = 0;
      show('Paused. Tap an arrow to go on');
    });

    reset();
    resize();
    return cleanup;
  }

  // ---------- blackjack

  function blackjack(el, opts) {
    const { S, h, rng, root, win, lose, cleanup } = setup(el, opts, 'blackjack');
    const NEED = 3;
    const DECKS = 6;
    const SHOW_LAST_MS = 1800; // the losing hand stays on screen this long before the game counts as lost

    const winsEl = h('span', {});
    const lossesEl = h('span', { class: 'lg-bj-losses' });
    const dealerTot = h('span', { class: 'lg-bj-tot' });
    const playerTot = h('span', { class: 'lg-bj-tot' });
    const dealerCards = h('div', { class: 'lg-bj-cards' });
    const playerCards = h('div', { class: 'lg-bj-cards' });
    const msg = h('div', { class: 'lg-msg', role: 'status', 'aria-live': 'polite' });
    const dealBtn = h('button', { class: 'lg-btn lg-primary', onclick: () => deal() }, 'Deal');
    const hitBtn = h('button', { class: 'lg-btn lg-primary', onclick: () => hit() }, 'Hit');
    const standBtn = h('button', { class: 'lg-btn', onclick: () => stand() }, 'Stand');
    const play = h('div', { class: 'lg-row' }, hitBtn, standBtn);
    root.append(h('div', { class: 'lg-top lg-split' }, winsEl, lossesEl),
      h('div', { class: 'lg-bj-hand' }, h('div', { class: 'lg-bj-head' }, h('span', {}, 'Dealer'), dealerTot), dealerCards),
      h('div', { class: 'lg-bj-hand lg-you' }, h('div', { class: 'lg-bj-head' }, h('span', {}, 'You'), playerTot), playerCards),
      msg, dealBtn, play);

    let shoe = [];
    let wins = 0;
    let losses = 0;
    let player = [];
    let dealer = [];
    let hidden = true;
    let phase = 'idle'; // idle | player | dealer | over (between hands) | won | lost

    const say = (text, cls = '') => {
      msg.className = `lg-msg${cls ? ` lg-${cls}` : ''}`;
      msg.textContent = text;
    };
    function newShoe() {
      shoe = [];
      for (let d = 0; d < DECKS; d++) for (const s of SUITS) for (let r = 1; r <= 13; r++) shoe.push({ r, s });
      shuffle(rng, shoe);
    }
    const draw = () => shoe.pop();
    /** Best total: aces count 11 when that doesn't bust (a "soft" total). */
    function total(cards) {
      let t = 0;
      let aces = 0;
      for (const c of cards) {
        t += Math.min(c.r, 10);
        if (c.r === 1) aces++;
      }
      const soft = aces > 0 && t + 10 <= 21;
      return { t: soft ? t + 10 : t, soft };
    }
    const natural = (cards) => cards.length === 2 && total(cards).t === 21;
    const totText = (cards) => {
      if (!cards.length) return '';
      if (natural(cards)) return 'Blackjack';
      const { t, soft } = total(cards);
      return t > 21 ? `${t} bust` : soft ? `soft ${t}` : String(t);
    };

    function cardEl(c, i, faceDown) {
      if (faceDown) return h('div', { class: 'lg-card lg-back', style: `--i:${i}`, 'aria-label': 'face-down card' });
      return h('div', { class: `lg-card${RED.has(c.s) ? ' lg-red' : ''}`, style: `--i:${i}`, 'aria-label': `${rankText(c.r)}${c.s}` },
        h('span', { class: 'lg-card-r' }, rankText(c.r)), h('span', { class: 'lg-card-s' }, c.s));
    }

    function render() {
      winsEl.textContent = `Wins: ${wins} / ${NEED}`;
      lossesEl.textContent = `Losses: ${losses} / ${NEED}`;
      lossesEl.classList.toggle('lg-close', losses >= NEED - 1 && phase !== 'won');
      dealerCards.replaceChildren(...dealer.map((c, i) => cardEl(c, i, hidden && i === 1)));
      playerCards.replaceChildren(...player.map((c, i) => cardEl(c, i, false)));
      dealerCards.classList.toggle('lg-tight', dealer.length > 4);
      playerCards.classList.toggle('lg-tight', player.length > 4);
      dealerTot.textContent = hidden && dealer.length ? `shows ${totText([dealer[0]]).replace('soft ', '')}` : totText(dealer);
      playerTot.textContent = totText(player);
      const playing = phase === 'player' || phase === 'dealer';
      dealBtn.hidden = playing || phase === 'won' || phase === 'lost';
      dealBtn.textContent = phase === 'idle' ? 'Deal' : 'Next hand';
      play.hidden = !playing;
      hitBtn.disabled = phase !== 'player';
      standBtn.disabled = phase !== 'player';
    }

    function deal() {
      if (phase !== 'idle' && phase !== 'over') return;
      let note = '';
      if (shoe.length < 60) {
        if (shoe.length) note = 'Fresh shoe shuffled. ';
        newShoe();
      }
      player = [draw()];
      dealer = [draw()];
      player.push(draw());
      dealer.push(draw());
      hidden = true;
      phase = 'player';
      say(note || 'Hit or stand?');
      if (natural(player) || natural(dealer)) {
        hidden = false;
        return settle();
      }
      render();
    }

    function hit() {
      if (phase !== 'player') return;
      player.push(draw());
      const { t } = total(player);
      if (t > 21) {
        hidden = false;
        return result('lose', `Bust with ${t}. Dealer wins.`);
      }
      if (t === 21) return stand();
      render();
    }

    function stand() {
      if (phase !== 'player') return;
      phase = 'dealer';
      hidden = false;
      say('Dealer plays…');
      render();
      dealerStep();
    }

    // the dealer draws to 17 and stands on every 17, soft or hard
    function dealerStep() {
      S.after(650, () => {
        if (total(dealer).t < 17) {
          dealer.push(draw());
          render();
          dealerStep();
        } else settle();
      });
    }

    function settle() {
      const p = total(player).t;
      const d = total(dealer).t;
      const pn = natural(player);
      const dn = natural(dealer);
      if (pn && dn) return result('push', "Both blackjack. Push, doesn't count.");
      if (pn) return result('win', 'Blackjack! You win.');
      if (dn) return result('lose', 'Dealer has blackjack.');
      if (d > 21) return result('win', `Dealer busts with ${d}. You win!`);
      if (p > d) return result('win', `You win, ${p} to ${d}.`);
      if (p < d) return result('lose', `Dealer wins, ${d} to ${p}.`);
      return result('push', `Push at ${p}. Doesn't count.`);
    }

    function result(out, text) {
      phase = 'over';
      if (out === 'win') wins++;
      if (out === 'lose') losses++;
      if (wins >= NEED) {
        phase = 'won';
        render();
        say(`${text} That's ${NEED} wins!`, 'good');
        win();
        return;
      }
      if (losses >= NEED) {
        // the third loss before the third win: the game is lost and over for good
        phase = 'lost';
        render();
        say(`${text} That's ${NEED} losses.`, 'bad');
        buzz(200);
        S.after(SHOW_LAST_MS, lose);
        return;
      }
      render();
      say(text, out === 'win' ? 'good' : out === 'lose' ? 'bad' : '');
    }

    newShoe();
    render();
    say('Win 3 hands before the dealer wins 3. Pushes don’t count.');
    return cleanup;
  }

  // ---------- tap 1 to 50

  function tap50(el, opts) {
    const { S, h, rng, root, win, cleanup } = setup(el, opts, 'tap50');
    const N = 50;
    const FREEZE = 3000;

    const nextEl = h('span', {});
    const timeEl = h('span', { class: 'lg-t50-time' });
    const grid = h('div', { class: 'lg-t50-grid' });
    const cover = h('div', { class: 'lg-t50-cover', hidden: true });
    const order = shuffle(rng, Array.from({ length: N }, (_, i) => i + 1));
    for (const n of order) {
      const b = h('button', { class: 'lg-t50-cell' }, String(n));
      onPress(S, b, () => tap(n, b));
      grid.append(b);
    }
    root.append(h('div', { class: 'lg-top lg-split' }, nextEl, timeEl), h('div', { class: 'lg-t50-box' }, grid, cover));

    let next = 1;
    let frozen = false;
    let over = false;
    const t0 = performance.now();
    const tickId = S.every(100, () => { timeEl.textContent = clock(performance.now() - t0); });
    timeEl.textContent = clock(0);
    const showNext = () => { nextEl.innerHTML = ''; nextEl.append('Next: ', h('b', {}, String(next))); };

    function tap(n, b) {
      if (over || frozen || n < next) return; // already-tapped numbers are harmless
      if (n === next) {
        b.classList.add('lg-hit');
        b.setAttribute('aria-disabled', 'true');
        next++;
        if (next > N) return finish();
        return showNext();
      }
      frozen = true;
      b.classList.add('lg-bad');
      grid.classList.add('lg-frozen');
      let left = FREEZE / 1000;
      cover.hidden = false;
      cover.textContent = `Wrong! Frozen ${left}`;
      const id = S.every(1000, () => {
        left--;
        cover.textContent = `Wrong! Frozen ${left}`;
      });
      S.after(FREEZE, () => {
        S.clear(id);
        frozen = false;
        b.classList.remove('lg-bad');
        grid.classList.remove('lg-frozen');
        cover.hidden = true;
      });
    }

    function finish() {
      over = true;
      S.clear(tickId);
      const t = clock(performance.now() - t0);
      timeEl.textContent = t;
      nextEl.textContent = `All 50 in ${t}!`;
      root.classList.add('lg-done');
      win();
    }

    showNext();
    return cleanup;
  }

  // ---------- crack the 2-digit code

  function crack(el, opts) {
    const { S, h, rng, root, win, cleanup } = setup(el, opts, 'crack');
    const CHECK_MS = 1500;
    const two = (n) => String(n).padStart(2, '0');

    const digits = [h('span', { class: 'lg-ck-digit' }), h('span', { class: 'lg-ck-digit' })];
    const status = h('div', { class: 'lg-ck-status', role: 'status', 'aria-live': 'polite' });
    const bar = h('div', { class: 'lg-ck-bar' });
    const screen = h('div', { class: 'lg-ck-screen' }, h('div', { class: 'lg-ck-code' }, digits), status, bar);
    const pad = h('div', { class: 'lg-ck-pad' });
    const keyEls = [];
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'back', 'try']) {
      const b = h('button', { class: `lg-ck-key${k === 'try' ? ' lg-try' : ''}`, 'aria-label': k === 'back' ? 'Delete' : k },
        k === 'back' ? '⌫' : k === 'try' ? 'Try' : k);
      onPress(S, b, () => press(k));
      keyEls.push(b);
      pad.append(b);
    }
    const triesEl = h('div', { class: 'lg-ck-tries' });
    const cells = [];
    const grid = h('div', { class: 'lg-ck-grid', 'aria-label': 'Codes tried' });
    for (let n = 0; n < 100; n++) grid.append((cells[n] = h('span', { class: 'lg-ck-cell' }, two(n))));
    root.append(screen, pad, triesEl, grid);

    const secret = randInt(rng, 100);
    const tried = new Set();
    let entry = '';
    let checking = false;
    let cracked = false;

    const setStatus = (text, cls = '') => {
      status.className = `lg-ck-status${cls ? ` lg-${cls}` : ''}`;
      status.textContent = text;
    };
    function render() {
      digits.forEach((d, i) => {
        d.textContent = entry[i] ?? '_';
        d.classList.toggle('lg-empty', entry[i] == null);
      });
      for (const b of keyEls) b.disabled = checking || cracked;
      keyEls[keyEls.length - 1].disabled = checking || cracked || entry.length < 2;
      triesEl.textContent = `Tried: ${tried.size} of 100`;
    }

    function press(k) {
      if (checking || cracked) return;
      if (k === 'try') return attempt();
      if (k === 'back') entry = entry.slice(0, -1);
      else entry = entry.length >= 2 ? k : entry + k;
      render();
    }

    function attempt() {
      if (entry.length < 2 || checking || cracked) return;
      const code = Number(entry);
      if (tried.has(code)) {
        setStatus(`${entry} was already denied`, 'bad');
        entry = '';
        return render();
      }
      checking = true;
      setStatus('CHECKING…', 'busy');
      bar.classList.remove('lg-run');
      void bar.offsetWidth;
      bar.classList.add('lg-run');
      render();
      S.after(CHECK_MS, () => {
        checking = false;
        bar.classList.remove('lg-run');
        tried.add(code);
        entry = '';
        if (code === secret) {
          cracked = true;
          cells[code].classList.add('lg-ok');
          setStatus(`ACCESS GRANTED · ${two(code)}`, 'good');
          screen.classList.add('lg-open');
          render();
          win();
          return;
        }
        cells[code].classList.add('lg-x');
        setStatus(`ACCESS DENIED · ${two(code)}`, 'bad');
        render();
      });
    }

    S.on(window, 'keydown', (e) => {
      if (foreignKey(e, root)) return;
      let k = null;
      if (/^[0-9]$/.test(e.key)) k = e.key;
      else if (e.key === 'Backspace') k = 'back';
      else if (e.key === 'Enter') k = 'try';
      if (!k) return;
      e.preventDefault();
      press(k);
    });

    setStatus('ENTER A 2-DIGIT CODE');
    render();
    return cleanup;
  }

  window.LakeGames = Object.freeze({ hold, wordle, make24, snake, blackjack, tap50, crack });
})();
