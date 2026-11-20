/* Servify landing page. No dependencies; every animation pauses when off-screen or the tab is hidden. */
(() => {
  'use strict';

  /** Change this once the repository is public. */
  const REPO_URL = 'https://github.com/OWNER/servify';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  for (const a of $$('[data-repo]')) a.href = REPO_URL;
  for (const s of $$('[data-repo-text]')) s.textContent = REPO_URL;

  /* ───────────── theme ───────────── */
  const themeListeners = [];
  $('#themeToggle').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('servify-site-theme', next);
    } catch (e) {}
    themeListeners.forEach((fn) => fn());
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => themeListeners.forEach((fn) => fn()));

  /* ───────────── nav + reveal ───────────── */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const revealIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          revealIO.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  $$('.reveal').forEach((el) => revealIO.observe(el));

  /* ───────────── shared animation loop ─────────────
   * One rAF for the page. Each scene registers a tick and an "active" flag;
   * the loop sleeps when nothing visible needs frames. */
  const scenes = new Set();
  let rafId = 0;
  let last = 0;
  function frame(now) {
    rafId = 0;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    let any = false;
    for (const s of scenes) {
      if (!s.active) continue;
      any = true;
      try {
        s.tick(dt, now);
      } catch (err) {
        console.error(err);
      }
    }
    if (any && !document.hidden) rafId = requestAnimationFrame(frame);
    else last = 0;
  }
  function wake() {
    if (!rafId && !document.hidden && !reduceMotion) rafId = requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wake();
  });
  function scene(el, tick) {
    const s = { active: false, tick };
    scenes.add(s);
    new IntersectionObserver((entries) => {
      s.active = entries[0].isIntersecting;
      if (s.active) wake();
    }).observe(el);
    return s;
  }

  /* ───────────── hero canvas ───────────── */
  const stage = $('#stage');
  const world = $('#world');
  const edgesSvg = $('#edges');
  const pCanvas = $('#particles');
  const pctx = pCanvas.getContext('2d');
  const toastEl = $('#toast');

  const NODES = [
    { id: 'edge', kind: 'edge' },
    { id: 'web', name: 'web', tile: 'Vi', brand: 'vite', src: 'github.com/acme/storefront', replicas: 3, url: 'web.shop.localhost', stepper: true },
    { id: 'api', name: 'api', tile: '{}', brand: 'node', src: '~/code/shop/api', replicas: 2, url: 'api.shop.localhost', stepper: true },
    { id: 'pg', name: 'postgres', tile: 'Pg', brand: 'postgres', src: 'postgres:17-alpine', replicas: 1, tcp: '127.0.0.1:15400', vol: '/var/lib/postgresql/data' },
    { id: 'redis', name: 'redis', tile: 'Rd', brand: 'redis', src: 'redis:7-alpine', replicas: 1, tcp: '127.0.0.1:15401' },
  ];
  const EDGES = [
    { from: 'edge', to: 'web', kind: 'ingress' },
    { from: 'edge', to: 'api', kind: 'ingress' },
    { from: 'web', to: 'api', kind: 'dep' },
    { from: 'api', to: 'pg', kind: 'dep' },
    { from: 'api', to: 'redis', kind: 'dep' },
  ];
  const LAYOUTS = {
    wide: { w: 1040, h: 480, pos: { edge: [70, 190], web: [360, 40], api: [360, 268], pg: [730, 40], redis: [730, 268] } },
    narrow: { w: 500, h: 640, pos: { edge: [166, 22], web: [16, 196], api: [270, 196], pg: [16, 452], redis: [270, 452] } },
  };
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));

  const icon = (id) => `<svg><use href="#${id}"/></svg>`;
  function nodeHTML(n) {
    if (n.kind === 'edge') {
      return `<div class="node-head"><span class="tile signal">${icon('i-globe')}</span><div class="node-title"><b>Edge</b><small>:8080</small></div></div>
        <div class="node-rows"><div class="row"><span class="rps val">0 req/s</span><span style="margin-left:auto">2 routed</span></div></div>`;
    }
    const rows = [
      `<div class="row"><span class="bars"></span><span class="count">${n.replicas}/${n.replicas}</span>${
        n.stepper
          ? `<span class="stepper"><button type="button" data-step="-1" aria-label="Remove a ${n.name} replica">−</button><output>${n.replicas}</output><button type="button" data-step="1" aria-label="Add a ${n.name} replica">+</button></span>`
          : ''
      }</div>`,
      n.url ? `<div class="row">${icon('i-link')}<span class="val">${n.url}</span></div>` : '',
      n.tcp ? `<div class="row">${icon('i-swap')}<span class="val">${n.tcp}</span></div>` : '',
      n.vol ? `<div class="row">${icon('i-disk')}<span class="val">${n.vol}</span></div>` : '',
    ].join('');
    return `<div class="node-head"><span class="tile" data-brand="${n.brand ?? ''}">${n.tile}</span><div class="node-title"><b>${n.name}</b><small>${n.src}</small></div></div>
      <span class="status">ONLINE</span><div class="node-rows">${rows}</div>`;
  }

  for (const n of NODES) {
    const el = document.createElement('div');
    el.className = 'node' + (n.kind === 'edge' ? ' edge-node' : '');
    el.innerHTML = nodeHTML(n);
    world.appendChild(el);
    n.el = el;
    n.rr = 0;
    if (n.kind !== 'edge') {
      n.barsEl = $('.bars', el);
      n.countEl = $('.count', el);
      n.statusEl = $('.status', el);
      n.outEl = $('output', el);
      for (let i = 0; i < n.replicas; i++) addBar(n, false);
    }
  }

  for (const e of EDGES) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('class', `edge-path ${e.kind}`);
    edgesSvg.appendChild(p);
    e.el = p;
  }

  function addBar(n, animate) {
    const b = document.createElement('span');
    b.className = 'bar' + (animate ? ' enter starting' : '');
    n.barsEl.appendChild(b);
    return b;
  }

  let mode = '';
  let k = 1;
  let L = LAYOUTS.wide;
  let dpr = 1;
  function layout() {
    const w = stage.clientWidth;
    const nextMode = w < 700 ? 'narrow' : 'wide';
    if (nextMode !== mode) {
      mode = nextMode;
      L = LAYOUTS[mode];
      for (const n of NODES) [n.x, n.y] = L.pos[n.id];
    }
    k = w / L.w;
    stage.style.height = `${Math.round(L.h * k)}px`;
    world.style.width = `${L.w}px`;
    world.style.height = `${L.h}px`;
    world.style.transform = `scale(${k})`;
    edgesSvg.setAttribute('viewBox', `0 0 ${L.w} ${L.h}`);
    edgesSvg.setAttribute('width', L.w);
    edgesSvg.setAttribute('height', L.h);
    dpr = Math.min(2, devicePixelRatio || 1) * Math.max(1, k);
    pCanvas.width = Math.round(L.w * dpr);
    pCanvas.height = Math.round(L.h * dpr);
    pCanvas.style.width = `${L.w}px`;
    pCanvas.style.height = `${L.h}px`;
    placeNodes();
    drawEdges();
    if (reduceMotion) drawParticles();
  }
  new ResizeObserver(layout).observe(stage);

  function placeNodes() {
    for (const n of NODES) n.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
  }

  function rect(n) {
    return { l: n.x, t: n.y, r: n.x + n.el.offsetWidth, b: n.y + n.el.offsetHeight };
  }

  /** Cubic bezier between two nodes, choosing sides the way the dashboard does. */
  function curve(a, b) {
    const A = rect(a);
    const B = rect(b);
    let p0, p3, c1, c2;
    const gapR = B.l - A.r;
    const gapL = A.l - B.r;
    if (gapR > 30 || gapL > 30) {
      const right = gapR > 30;
      p0 = [right ? A.r : A.l, (A.t + A.b) / 2];
      p3 = [right ? B.l : B.r, (B.t + B.b) / 2];
      const d = Math.max(40, Math.abs(p3[0] - p0[0]) * 0.5) * (right ? 1 : -1);
      c1 = [p0[0] + d, p0[1]];
      c2 = [p3[0] - d, p3[1]];
    } else {
      const down = B.t > A.t;
      p0 = [(A.l + A.r) / 2, down ? A.b : A.t];
      p3 = [(B.l + B.r) / 2, down ? B.t : B.b];
      const d = Math.max(30, Math.abs(p3[1] - p0[1]) * 0.5) * (down ? 1 : -1);
      c1 = [p0[0], p0[1] + d];
      c2 = [p3[0], p3[1] - d];
    }
    return [p0, c1, c2, p3];
  }
  function bez(c, t) {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, d = t * t * t;
    return [a * c[0][0] + b * c[1][0] + cc * c[2][0] + d * c[3][0], a * c[0][1] + b * c[1][1] + cc * c[2][1] + d * c[3][1]];
  }
  function drawEdges() {
    for (const e of EDGES) {
      e.c = curve(byId[e.from], byId[e.to]);
      const [p0, c1, c2, p3] = e.c;
      e.el.setAttribute('d', `M${p0[0]},${p0[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p3[0]},${p3[1]}`);
    }
  }

  /* particles */
  let signalColor = css('--signal');
  themeListeners.push(() => {
    signalColor = css('--signal');
    if (reduceMotion) drawParticles();
  });
  const particles = [];
  const spawnAcc = { web: 0, api: 0 };
  let rps = 420;
  let rpsShown = 0;

  function drawParticles() {
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pctx.clearRect(0, 0, L.w, L.h);
    pctx.fillStyle = signalColor;
    for (const p of particles) {
      const c = p.edge.c;
      if (!c) continue;
      for (let i = 3; i >= 0; i--) {
        const t = p.t - i * 0.025;
        if (t < 0) continue;
        const [x, y] = bez(c, t);
        pctx.globalAlpha = i === 0 ? 1 : 0.35 - i * 0.08;
        pctx.beginPath();
        pctx.arc(x, y, i === 0 ? 2.4 : 1.8, 0, Math.PI * 2);
        pctx.fill();
      }
      if (p.t > 0.02) {
        const [x, y] = bez(c, p.t);
        pctx.globalAlpha = 0.18;
        pctx.beginPath();
        pctx.arc(x, y, 6, 0, Math.PI * 2);
        pctx.fill();
      }
    }
    pctx.globalAlpha = 1;
  }

  function hitBar(n) {
    const bars = $$('.bar:not(.starting):not(.leaving)', n.barsEl);
    if (!bars.length) return;
    const b = bars[n.rr++ % bars.length];
    b.classList.add('hit');
    setTimeout(() => b.classList.remove('hit'), 130);
  }

  const rpsEl = $('.rps', byId.edge.el);
  rpsEl.textContent = `${rps} req/s`;
  function heroTick(dt) {
    drawEdges();
    const web = byId.web, api = byId.api;
    const total = web.replicas + api.replicas;
    const rate = 4 + total * 1.1; // particles per second
    spawnAcc.web += dt * rate * (web.replicas / total);
    spawnAcc.api += dt * rate * (api.replicas / total);
    for (const id of ['web', 'api']) {
      while (spawnAcc[id] >= 1) {
        spawnAcc[id] -= 1;
        particles.push({ edge: EDGES.find((e) => e.to === id && e.kind === 'ingress'), t: -Math.random() * 0.1, speed: 0.75 + Math.random() * 0.25 });
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += dt * p.speed;
      if (p.t >= 1) {
        hitBar(byId[p.edge.to]);
        particles.splice(i, 1);
      }
    }
    drawParticles();

    const target = 300 + total * 26;
    rps += (target - rps) * dt * 0.8 + (Math.random() - 0.5) * 30 * dt * 10;
    rpsShown += dt;
    if (rpsShown > 0.45) {
      rpsShown = 0;
      rpsEl.textContent = `${Math.round(rps)} req/s`;
    }
  }
  const heroScene = scene(stage, heroTick);

  /* replica steppers */
  let toastTimer = 0;
  function toast(msg, tone = '') {
    $('.tmsg', toastEl).innerHTML = msg;
    $('.tdot', toastEl).className = 'tdot' + (tone ? ' ' + tone : '');
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }
  function syncCount(n) {
    const ready = $$('.bar:not(.starting):not(.leaving)', n.barsEl).length;
    n.countEl.textContent = `${ready}/${n.replicas}`;
    if (n.outEl) n.outEl.textContent = n.replicas;
    $$('[data-step]', n.el).forEach((b) => {
      b.disabled = b.dataset.step === '1' ? n.replicas >= 8 : n.replicas <= 1;
    });
  }
  for (const n of NODES) {
    if (!n.stepper) continue;
    n.el.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-step]');
      if (!btn) return;
      const step = Number(btn.dataset.step);
      const next = Math.max(1, Math.min(8, n.replicas + step));
      if (next === n.replicas) return;
      const prev = n.replicas;
      n.replicas = next;
      if (step > 0) {
        const b = addBar(n, true);
        setTimeout(() => {
          b.classList.remove('starting');
          syncCount(n);
        }, reduceMotion ? 0 : 900);
        toast(`Scaling <b>${n.name}</b> ${prev} → ${next} replicas`, 'build');
      } else {
        const bars = $$('.bar:not(.leaving)', n.barsEl);
        const b = bars[bars.length - 1];
        b.classList.add('leaving');
        b.animate([{ transform: 'scaleY(1)', opacity: 0.75 }, { transform: 'scaleY(0)', opacity: 0 }], { duration: reduceMotion ? 1 : 280, easing: 'ease-in' }).onfinish = () => b.remove();
        toast(`Scaling <b>${n.name}</b> ${prev} → ${next} · draining 1 replica`);
      }
      syncCount(n);
    });
    syncCount(n);
  }

  /* dragging */
  let drag = null;
  for (const n of NODES) {
    n.el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('button')) return;
      drag = { n, sx: ev.clientX, sy: ev.clientY, ox: n.x, oy: n.y };
      n.el.classList.add('dragging');
      try {
        n.el.setPointerCapture(ev.pointerId);
      } catch (e) {}
    });
    n.el.addEventListener('pointermove', (ev) => {
      if (!drag || drag.n !== n) return;
      const w = n.el.offsetWidth, h = n.el.offsetHeight;
      n.x = Math.max(0, Math.min(L.w - w, drag.ox + (ev.clientX - drag.sx) / k));
      n.y = Math.max(0, Math.min(L.h - h, drag.oy + (ev.clientY - drag.sy) / k));
      n.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
      drawEdges();
      if (reduceMotion) drawParticles();
    });
    const end = () => {
      if (drag && drag.n === n) {
        n.el.classList.remove('dragging');
        drag = null;
      }
    };
    n.el.addEventListener('pointerup', end);
    n.el.addEventListener('pointercancel', end);
  }

  /* deploy moments: a calm, periodic redeploy so the canvas feels alive */
  const commits = ['3f9a1c2', 'b71e04d', '9c2d5e8', 'e04a77b', '51c8f3a'];
  let deployTurn = 0;
  function deployMoment() {
    if (!heroScene.active || document.hidden) return;
    const n = deployTurn++ % 2 ? byId.api : byId.web;
    const sha = commits[deployTurn % commits.length];
    const st = n.statusEl;
    st.className = 'status build';
    st.textContent = 'BUILDING';
    toast(`Deploying <b>${n.name}</b> · ${n.id === 'web' ? 'commit' : 'local'} ${sha}`, 'build');
    setTimeout(() => {
      st.className = 'status warn';
      st.textContent = 'DEPLOYING';
      toast(`<b>${n.name}</b> · new replicas passing health checks`, 'warn');
    }, 1600);
    setTimeout(() => {
      st.className = 'status';
      st.textContent = 'ONLINE';
      const r = document.createElement('span');
      r.className = 'ripple';
      n.el.appendChild(r);
      setTimeout(() => r.remove(), 1200);
      toast(`<b>${n.name}</b> is live · zero dropped requests`);
    }, 3200);
  }
  if (!reduceMotion) setInterval(deployMoment, 11000);

  /* ───────────── load balancer demo ───────────── */
  const lbStage = $('#lbStage');
  const lbCanvas = $('#lbCanvas');
  const lctx = lbCanvas.getContext('2d');
  const clientsEl = $('#clients');
  const replicasEl = $('#replicas');
  const killBtn = $('#lbKill');
  const plusBtn = $('#lbPlus');
  const minusBtn = $('#lbMinus');
  const nOut = $('#lbN');
  const stServed = $('#stServed');
  const stRetried = $('#stRetried');

  const clientColors = ['--signal', '--build', '--warn', '--ok'];
  const clients = ['10.0.0.12', '10.0.0.37', '10.0.0.58', '10.0.0.91'].map((ip, i) => {
    const el = document.createElement('div');
    el.className = 'client';
    el.innerHTML = `<i style="background:var(${clientColors[i]})"></i>${ip}`;
    clientsEl.appendChild(el);
    return { ip, i, el, color: '' };
  });
  function refreshClientColors() {
    clients.forEach((c, i) => (c.color = css(clientColors[i])));
  }
  refreshClientColors();
  themeListeners.push(refreshClientColors);

  let strategy = 'rr';
  let rrPtr = 0;
  let seq = 0;
  let served = 0;
  let retried = 0;
  const reps = [];
  const reqs = [];

  function makeReplica(starting) {
    const r = { id: ++seq, name: `api-${seq}`, state: starting ? 'starting' : 'up', active: 0, served: 0, speed: 0.7 + Math.random() * 0.9 };
    const el = document.createElement('div');
    el.className = 'replica' + (starting ? ' starting entering' : '');
    el.innerHTML = `<div class="top"><i></i>${r.name}<span class="state">${starting ? 'starting' : 'healthy'}</span></div><div class="meta"><span class="sv">served 0</span><span class="cn">0 conns</span></div><span class="load" style="width:0"></span>`;
    replicasEl.appendChild(el);
    r.el = el;
    r.stateEl = $('.state', el);
    r.svEl = $('.sv', el);
    r.cnEl = $('.cn', el);
    r.loadEl = $('.load', el);
    reps.push(r);
    if (starting) {
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('entering')));
      setTimeout(() => setState(r, 'up'), 1300);
    }
    return r;
  }
  function setState(r, s) {
    if (!reps.includes(r)) return;
    r.state = s;
    r.el.classList.remove('down', 'starting', 'leaving');
    if (s === 'down') r.el.classList.add('down');
    if (s === 'starting') r.el.classList.add('starting');
    if (s === 'draining') r.el.classList.add('leaving');
    r.stateEl.textContent = { up: 'healthy', down: 'crashed', starting: 'restarting', draining: 'draining' }[s];
    if (s === 'down') r.crashed = true;
    if (s === 'starting' && !r.crashed) r.stateEl.textContent = 'starting';
    syncLbControls();
  }
  for (let i = 0; i < 3; i++) makeReplica(false);

  function liveCount() {
    return reps.filter((r) => r.state !== 'draining').length;
  }
  function syncLbControls() {
    const live = liveCount();
    nOut.textContent = live;
    plusBtn.disabled = live >= 6;
    minusBtn.disabled = live <= 1;
    const up = reps.filter((r) => r.state === 'up').length;
    killBtn.disabled = up < 2;
    killBtn.title = up < 2 ? 'Add a replica first: with one replica, a crash would drop requests' : '';
  }
  syncLbControls();

  plusBtn.addEventListener('click', () => {
    if (liveCount() >= 6) return;
    makeReplica(true);
    syncLbControls();
  });
  minusBtn.addEventListener('click', () => {
    const live = reps.filter((r) => r.state !== 'draining');
    if (live.length <= 1) return;
    setState(live[live.length - 1], 'draining');
  });
  killBtn.addEventListener('click', () => {
    const up = reps.filter((r) => r.state === 'up');
    if (up.length < 2) return;
    const r = up[Math.floor(Math.random() * up.length)];
    setState(r, 'down');
    // In-flight requests on the crashed replica are retried elsewhere.
    for (const q of reqs) {
      if (q.rep === r) {
        if (q.phase === 3) r.active--;
        reroute(q, r);
      }
    }
    setTimeout(() => setState(r, 'starting'), 1500);
    setTimeout(() => setState(r, 'up'), 3200);
  });

  const segEl = $('#strategy');
  const thumb = $('.thumb', segEl);
  const stratLabel = $('#lbStrat');
  function placeThumb() {
    const b = $('[aria-pressed="true"]', segEl);
    thumb.style.left = `${b.offsetLeft}px`;
    thumb.style.width = `${b.offsetWidth}px`;
  }
  segEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    $$('button', segEl).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    strategy = b.dataset.s;
    stratLabel.textContent = b.textContent;
    placeThumb();
  });
  new ResizeObserver(placeThumb).observe(segEl);
  document.fonts?.ready.then(placeThumb);

  function pick(client) {
    const up = reps.filter((r) => r.state === 'up');
    if (!up.length) return null;
    if (strategy === 'rr') return up[rrPtr++ % up.length];
    if (strategy === 'rand') return up[Math.floor(Math.random() * up.length)];
    if (strategy === 'ip') return up[(client.i * 7 + 3) % up.length];
    let best = up[0];
    for (const r of up) if (r.active < best.active) best = r;
    return best;
  }

  let rects = null;
  function measure() {
    const base = lbStage.getBoundingClientRect();
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - base.left, t: r.top - base.top, r: r.right - base.left, b: r.bottom - base.top };
    };
    const bal = rel($('.balancer', lbStage));
    rects = { w: base.width, h: base.height, bal, clients: clients.map((c) => rel(c.el)), reps: new Map(reps.map((r) => [r, rel(r.el)])) };
  }
  function sizeLbCanvas() {
    const r = lbStage.getBoundingClientRect();
    const d = Math.min(2, devicePixelRatio || 1);
    lbCanvas.width = Math.round(r.width * d);
    lbCanvas.height = Math.round(r.height * d);
    lctx.setTransform(d, 0, 0, d, 0, 0);
  }
  new ResizeObserver(sizeLbCanvas).observe(lbStage);

  function repPoint(r) {
    const rr = rects.reps.get(r);
    return rr ? [rr.l, (rr.t + rr.b) / 2] : [rects.w, rects.h / 2];
  }
  function reroute(q, from) {
    retried++;
    stRetried.textContent = retried.toLocaleString();
    const next = pick(q.client);
    q.from = rects ? repPoint(from) : [0, 0];
    q.rep = next;
    q.phase = 2;
    q.t = 0;
  }

  let spawnT = 0;
  let statT = 0;
  function lbTick(dt) {
    measure();
    spawnT += dt;
    while (spawnT > 0.13) {
      spawnT -= 0.13;
      const client = clients[Math.floor(Math.random() * clients.length)];
      reqs.push({ client, phase: 1, t: 0, rep: null, from: null, work: 0 });
    }
    const bal = rects.bal;
    const balL = [bal.l, (bal.t + bal.b) / 2];
    const balR = [bal.r, (bal.t + bal.b) / 2];

    lctx.clearRect(0, 0, rects.w, rects.h);
    for (let i = reqs.length - 1; i >= 0; i--) {
      const q = reqs[i];
      if (q.phase === 1) {
        q.t += dt / 0.45;
        if (q.t >= 1) {
          q.phase = 2;
          q.t = 0;
          q.from = balR;
          q.rep = pick(q.client);
        }
      } else if (q.phase === 2) {
        if (!q.rep || !reps.includes(q.rep) || q.rep.state !== 'up') {
          // Target went away before arrival: send it to another healthy replica.
          q.rep = pick(q.client);
          if (!q.rep) continue;
        }
        q.t += dt / 0.5;
        if (q.t >= 1) {
          q.phase = 3;
          q.work = (0.5 + Math.random() * 0.9) / q.rep.speed;
          q.rep.active++;
        }
      } else {
        q.work -= dt;
        if (q.work <= 0) {
          const r = q.rep;
          r.active--;
          r.served++;
          served++;
          r.el.classList.remove('flash');
          void r.el.offsetWidth;
          r.el.classList.add('flash');
          reqs.splice(i, 1);
          continue;
        }
      }
      if (q.phase === 3) continue;
      let a, b;
      if (q.phase === 1) {
        const c = rects.clients[q.client.i];
        a = [c.r, (c.t + c.b) / 2];
        b = balL;
      } else {
        a = q.from || balR;
        b = q.rep ? repPoint(q.rep) : balR;
      }
      const t = easeInOut(Math.min(1, Math.max(0, q.t)));
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t + Math.sin(t * Math.PI) * (q.phase === 1 ? 0 : (b[1] - a[1]) * -0.08);
      lctx.fillStyle = q.client.color;
      lctx.globalAlpha = 0.2;
      lctx.beginPath();
      lctx.arc(x, y, 6, 0, Math.PI * 2);
      lctx.fill();
      lctx.globalAlpha = 1;
      lctx.beginPath();
      lctx.arc(x, y, 2.6, 0, Math.PI * 2);
      lctx.fill();
    }

    // Finish draining replicas once they're idle.
    for (let i = reps.length - 1; i >= 0; i--) {
      const r = reps[i];
      if (r.state === 'draining' && r.active <= 0) {
        reps.splice(i, 1);
        r.el.animate([{ opacity: 0.4, transform: 'none' }, { opacity: 0, transform: 'translateX(12px) scale(0.96)' }], { duration: 260, easing: 'ease-in' }).onfinish = () => r.el.remove();
        syncLbControls();
      }
    }

    statT += dt;
    if (statT > 0.12) {
      statT = 0;
      stServed.textContent = served.toLocaleString();
      for (const r of reps) {
        r.svEl.textContent = `served ${r.served.toLocaleString()}`;
        r.cnEl.textContent = `${Math.max(0, r.active)} conns`;
        r.loadEl.style.width = `${Math.min(100, Math.max(0, r.active) * 22)}%`;
      }
    }
  }
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  scene(lbStage, lbTick);

  /* ───────────── agent terminal ───────────── */
  const termBody = $('#termBody');
  const LINES = [
    ['t-prompt', '$ claude mcp add --transport http servify http://localhost:7700/mcp \\'],
    ['t-dim', '    --header "Authorization: Bearer svf_••••••••"'],
    ['t-ok', '✓ servify connected · 48 tools'],
    ['gap'],
    ['t-user', '> The api feels slow under load. Scale it up and check if p95 improves.', 'type'],
    ['gap'],
    ['t-tool', '● servify.get_metrics({ service: "api" })'],
    ['t-dim', '  ⎿ 182 req/s · p95 640 ms · 2 replicas'],
    ['t-tool', '● servify.scale_service({ service: "api", replicas: 4 })'],
    ['t-dim', '  ⎿ api: 2 → 4 replicas'],
    ['t-tool', '● servify.get_service({ service: "api" })'],
    ['t-dim', '  ⎿ 4/4 replicas healthy'],
    ['t-tool', '● servify.get_metrics({ service: "api" })'],
    ['t-dim', '  ⎿ 186 req/s · p95 210 ms'],
    ['gap'],
    ['t-say', 'Scaled api from 2 to 4 replicas. Under the same load, p95 dropped from 640 ms to 210 ms. Want me to turn on autoscaling so it handles spikes on its own?'],
  ];
  const lineEls = LINES.map(([cls, text]) => {
    const d = document.createElement('div');
    d.className = 'tl ' + (cls === 'gap' ? 'gap' : cls);
    if (text) d.textContent = text;
    termBody.appendChild(d);
    return d;
  });
  const caret = document.createElement('span');
  caret.className = 'caret-block';

  function showAll() {
    lineEls.forEach((el, i) => {
      el.classList.add('on');
      if (LINES[i][1]) el.textContent = LINES[i][1];
    });
    lineEls[lineEls.length - 1].append(' ', caret);
  }
  async function playTerminal() {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < LINES.length; i++) {
      const [, text, how] = LINES[i];
      const el = lineEls[i];
      if (how === 'type') {
        el.textContent = '';
        el.classList.add('on');
        el.append(caret);
        await wait(500);
        for (let c = 1; c <= text.length; c++) {
          el.textContent = text.slice(0, c);
          el.append(caret);
          await wait(16 + Math.random() * 22);
        }
        await wait(450);
        caret.remove();
      } else {
        el.classList.add('on');
        await wait(LINES[i][0] === 't-tool' ? 520 : LINES[i][0] === 'gap' ? 120 : 260);
      }
    }
    lineEls[lineEls.length - 1].append(' ', caret);
  }
  if (reduceMotion) showAll();
  else {
    const tio = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          tio.disconnect();
          playTerminal();
        }
      },
      { threshold: 0.35 },
    );
    tio.observe(termBody);
  }

  /* ───────────── quick start tabs + copy ───────────── */
  const tabs = $$('[role="tab"]');
  for (const t of tabs) {
    t.addEventListener('click', () => {
      for (const o of tabs) {
        const on = o === t;
        o.setAttribute('aria-selected', String(on));
        document.getElementById(o.getAttribute('aria-controls')).hidden = !on;
      }
    });
  }
  for (const btn of $$('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const pre = btn.closest('pre');
      const text = [...pre.childNodes]
        .filter((n) => n !== btn)
        .map((n) => n.textContent)
        .join('')
        .split('\n')
        .map((l) => l.replace(/^\$ /, ''))
        .join('\n')
        .trim();
      try {
        await navigator.clipboard.writeText(text);
        btn.innerHTML = '<svg><use href="#i-check"/></svg>Copied';
      } catch (e) {
        btn.textContent = 'Select and copy';
      }
      setTimeout(() => (btn.innerHTML = '<svg><use href="#i-copy"/></svg>Copy'), 1600);
    });
  }

  /* ───────────── brand logos (simple-icons, CC0) ───────────── */
  function brandSvg(b, size) {
    const cls = b.neutral ? 'brand-logo brand-neutral' : 'brand-logo';
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" role="img" aria-label="${b.title}" style="--hue:${b.hex}"><path d="${b.path}" fill="currentColor"/></svg>`;
  }
  fetch('brand-icons.json')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((icons) => {
      for (const el of $$('[data-brand]')) {
        const b = icons[el.dataset.brand];
        if (!b) continue;
        if (el.classList.contains('chip')) {
          const dot = el.querySelector('i');
          if (dot) dot.replaceWith(document.createRange().createContextualFragment(brandSvg(b, 14)));
        } else if (el.classList.contains('tile')) {
          el.innerHTML = brandSvg(b, 17);
          el.classList.add('has-brand');
          el.style.setProperty('--hue', b.neutral ? 'var(--text-2)' : b.hex);
        } else if (el.tagName === 'I') {
          el.replaceWith(document.createRange().createContextualFragment(brandSvg(b, 16)));
        } else {
          el.innerHTML = brandSvg(b, 20);
        }
      }
      drawEdges(); // logo tiles can change node heights slightly
    })
    .catch(() => {});

  layout();
  if (reduceMotion) drawParticles();
})();
