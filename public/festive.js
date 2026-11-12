/* Decorations only: falling snow and a Christmas tree with blinking lights.
   Nothing here touches any data. Honours "reduce motion": no snow, and steady lights. */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

  /* ---------- tree ---------- */

  // Light positions, hand-placed inside the three tiers (viewBox 120 x 150).
  const LIGHTS = [
    [60, 28], [50, 46], [70, 46], [42, 56], [78, 56],
    [54, 62], [68, 70], [40, 82], [80, 84], [60, 88],
    [50, 92], [72, 100], [30, 114], [60, 112], [90, 118], [44, 122],
  ];

  function svgEl(tag, attrs, className) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (className) node.setAttribute('class', className);
    return node;
  }

  function starPoints(cx, cy, outer, inner) {
    const pts = [];
    for (let k = 0; k < 10; k += 1) {
      const angle = (-90 + k * 36) * (Math.PI / 180);
      const r = k % 2 === 0 ? outer : inner;
      pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
    }
    return pts.join(' ');
  }

  function mountTree(container) {
    const svg = svgEl('svg', { viewBox: '0 0 120 150', focusable: 'false', 'aria-hidden': 'true' });
    svg.append(
      svgEl('rect', { x: 52, y: 124, width: 16, height: 20, rx: 2 }, 'tree-trunk'),
      svgEl('polygon', { points: '60,58 110,126 10,126' }, 'tree-tier tree-tier-3'),
      svgEl('polygon', { points: '60,34 100,92 20,92' }, 'tree-tier tree-tier-2'),
      svgEl('polygon', { points: '60,14 92,60 28,60' }, 'tree-tier tree-tier-1'),
      svgEl('polygon', { points: starPoints(60, 10, 9, 4) }, 'tree-star'),
    );
    LIGHTS.forEach(([x, y], i) => {
      const light = svgEl('g', {}, `tree-light l${i % 4}`);
      // Different speed and starting point per bulb so they twinkle out of step.
      light.style.animationDuration = `${(1.1 + ((i * 7) % 10) / 8).toFixed(2)}s`;
      light.style.animationDelay = `-${(((i * 5) % 13) / 5).toFixed(2)}s`;
      light.append(
        svgEl('circle', { cx: x, cy: y, r: 5.2 }, 'light-halo'),
        svgEl('circle', { cx: x, cy: y, r: 2.4 }, 'light-core'),
      );
      svg.append(light);
    });
    container.replaceChildren(svg);
  }

  /* ---------- snow ---------- */

  const canvas = document.getElementById('snow');
  const ctx = canvas ? canvas.getContext('2d') : null;
  let flakes = [];
  let width = 0;
  let height = 0;
  let running = false;
  let frameId = 0;
  let lastTime = 0;
  let resizePending = false;

  function makeFlake(anywhere) {
    const r = 1 + Math.random() * 2.2; // small flakes; bigger ones fall a bit faster
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : -6,
      r,
      speed: 14 + r * 12 + Math.random() * 10,
      sway: 8 + Math.random() * 18,
      phase: Math.random() * Math.PI * 2,
      freq: 0.4 + Math.random() * 0.6,
    };
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = Math.max(30, Math.min(90, Math.round((width * height) / 18000)));
    while (flakes.length < target) flakes.push(makeFlake(true));
    flakes.length = Math.min(flakes.length, target);
  }

  function frame(time) {
    if (!running) return;
    const dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;
    ctx.clearRect(0, 0, width, height);
    // Soft blue-grey on the light theme so flakes show; white on the dark one.
    ctx.fillStyle = darkScheme.matches ? 'rgba(255, 255, 255, 0.75)' : 'rgba(112, 146, 165, 0.7)';
    for (const f of flakes) {
      f.y += f.speed * dt;
      f.phase += f.freq * dt;
      if (f.y > height + 6) Object.assign(f, makeFlake(false));
      ctx.beginPath();
      ctx.arc(f.x + Math.sin(f.phase) * f.sway, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    frameId = requestAnimationFrame(frame);
  }

  function startSnow() {
    if (running) return;
    running = true;
    canvas.hidden = false;
    resizeCanvas();
    lastTime = performance.now();
    frameId = requestAnimationFrame(frame);
  }

  function stopSnow() {
    running = false;
    cancelAnimationFrame(frameId);
    if (ctx) ctx.clearRect(0, 0, width, height);
    if (canvas) canvas.hidden = true;
  }

  function applySnow() {
    if (!canvas || !ctx) return;
    if (!reduceMotion.matches && !document.hidden) startSnow();
    else stopSnow();
  }

  /* ---------- wiring ---------- */

  document.querySelectorAll('.tree').forEach(mountTree);

  document.addEventListener('visibilitychange', applySnow); // no animation work in a hidden tab
  reduceMotion.addEventListener('change', applySnow);
  window.addEventListener('resize', () => {
    if (!running || resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => { resizePending = false; resizeCanvas(); });
  });

  applySnow();
})();
