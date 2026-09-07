(() => {
  'use strict';

  // ---------- Canvas Setup ----------
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const gameContainer = document.getElementById('game-container');

  let DPR = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0; // CSS pixel dimensions

  function resizeCanvas() {
    // Use the *visible* viewport, not the CSS 100vh box — on mobile browsers
    // 100vh is sized as if the address bar were hidden, which pushes anything
    // near the bottom of the page (like the skyline strip) off-screen behind
    // the real, currently-visible browser chrome. Sizing everything in real
    // pixels from JS keeps the canvas exactly matched to what's on screen.
    const vv = window.visualViewport;
    W = vv ? vv.width : window.innerWidth;
    H = vv ? vv.height : window.innerHeight;

    gameContainer.style.width = W + 'px';
    gameContainer.style.height = H + 'px';

    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', resizeCanvas);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resizeCanvas);
  }
  resizeCanvas();

  // ---------- DOM refs ----------
  const scoreHud = document.getElementById('scoreHud');
  const startScreen = document.getElementById('startScreen');
  const gameOverScreen = document.getElementById('gameOverScreen');
  const finalScoreEl = document.getElementById('finalScore');
  const bestScoreEndEl = document.getElementById('bestScoreEnd');
  const bestScoreStartEl = document.getElementById('bestScoreStart');
  const crashMessageEl = document.getElementById('crashMessage');
  const retryBtn = document.getElementById('retryBtn');

  const BEST_KEY = 'towerDodgeBestScore';
  let bestScore = parseInt(localStorage.getItem(BEST_KEY) || '0', 10);
  bestScoreStartEl.textContent = bestScore;

  // ---------- Custom image assets (optional — drop files into /assets) ----------
  // If a file isn't there (or fails to load), the game quietly falls back to the
  // built-in vector art, so it always runs even before you add anything.
  const ASSET_PATHS = {
    plane: 'assets/plane.png',
    towerTop: 'assets/tower-top.png',
    towerBottom: 'assets/tower-bottom.png'
  };

  function loadImage(src) {
    const img = new Image();
    const state = { img, loaded: false };
    img.onload = () => { state.loaded = true; };
    img.onerror = () => { state.loaded = false; };
    img.src = src;
    return state;
  }

  const planeAsset = loadImage(ASSET_PATHS.plane);
  const towerTopAsset = loadImage(ASSET_PATHS.towerTop);
  const towerBottomAsset = loadImage(ASSET_PATHS.towerBottom);
  const skylineAsset = loadImage('assets/skyline.png');

  // ---------- Audio (simple WebAudio synthesized SFX) ----------
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } else if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playTone(freq, duration, type, volume, glideTo) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    if (glideTo) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(glideTo, 1),
        audioCtx.currentTime + duration
      );
    }
    gain.gain.setValueAtTime(volume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  }

  function sfxFlap() {
    playTone(320, 0.12, 'triangle', 0.18, 220);
  }
  function sfxPass() {
    playTone(660, 0.09, 'sine', 0.12, 880);
  }
  function sfxCrash() {
    if (!audioCtx) return;
    // noise burst for a crash thud
    const bufferSize = audioCtx.sampleRate * 0.35;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.35, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
    noise.connect(gain);
    gain.connect(audioCtx.destination);
    noise.start();
    playTone(120, 0.3, 'sawtooth', 0.2, 40);
  }

  let windOsc = null, windGain = null;
  function startWind() {
    if (!audioCtx || windOsc) return;
    windOsc = audioCtx.createOscillator();
    windGain = audioCtx.createGain();
    windOsc.type = 'sawtooth';
    windOsc.frequency.value = 90;
    windGain.gain.value = 0.02;
    windOsc.connect(windGain);
    windGain.connect(audioCtx.destination);
    windOsc.start();
  }
  function stopWind() {
    if (windOsc) {
      try { windOsc.stop(); } catch (e) {}
      windOsc.disconnect();
      windGain.disconnect();
      windOsc = null;
      windGain = null;
    }
  }

  // ---------- Game constants ----------
  const GRAVITY = 1300;         // px/s^2
  const LIFT = -3200;           // px/s^2 while holding
  const MAX_FALL_SPEED = 520;
  const MAX_RISE_SPEED = -620;
  const PLANE_X_RATIO = 0.28;   // plane's horizontal position as ratio of width
  const PLANE_SIZE = 0.052;     // plane size relative to width
  const TOWER_WIDTH_RATIO = 0.25;
  const BASE_GAP_RATIO = 0.32;  // gap size relative to height
  const MIN_GAP_RATIO = 0.24;
  const BASE_SPEED = 220;       // px/s scroll speed
  const MAX_SPEED = 420;
  const SPEED_RAMP_TIME = 45;   // seconds to reach near-max speed
  const BASE_SPAWN_DIST_RATIO = 0.62; // horizontal distance between towers, relative to width

  const ORDINALS = [
    '', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh',
    'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth',
    'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth',
    'Nineteenth', 'Twentieth'
  ];
  function ordinalWord(n) {
    if (n >= 1 && n < ORDINALS.length) return ORDINALS[n];
    return `#${n}`;
  }

  // ---------- Game state ----------
  let state = 'start'; // 'start' | 'playing' | 'exploding' | 'gameover'
  let plane, towers, score, elapsed, spawnTimer, holding, lastTime;
  let clouds = [];
  let skylineScrollX = 0;
  const SKYLINE_PARALLAX = 0.35; // scrolls slower than towers for a depth feel
  const SKYLINE_HEIGHT_RATIO = 0.16; // band height relative to screen height

  // ---------- Crash / blast effect ----------
  let particles = [];
  let explosionTimer = 0;
  let shakeTime = 0;
  let pendingCrashTowerNumber = 1;
  let crashOriginX = 0, crashOriginY = 0;
  const EXPLOSION_DURATION = 1.1; // seconds the blast plays before the Game Over screen appears
  const SHAKE_DURATION = 0.4;
  const SHAKE_MAGNITUDE = 16; // px

  // Color ramp a fire particle passes through as it cools, white-hot -> ember -> soot.
  const FIRE_RAMP = [
    { t: 0.0, c: [255, 250, 220] },
    { t: 0.18, c: [255, 214, 120] },
    { t: 0.4, c: [255, 140, 40] },
    { t: 0.7, c: [200, 60, 20] },
    { t: 1.0, c: [40, 20, 15] }
  ];
  function fireColorAt(t) {
    for (let i = 0; i < FIRE_RAMP.length - 1; i++) {
      const a = FIRE_RAMP[i], b = FIRE_RAMP[i + 1];
      if (t >= a.t && t <= b.t) {
        const localT = (t - a.t) / (b.t - a.t || 1);
        const r = a.c[0] + (b.c[0] - a.c[0]) * localT;
        const g = a.c[1] + (b.c[1] - a.c[1]) * localT;
        const bch = a.c[2] + (b.c[2] - a.c[2]) * localT;
        return `rgb(${r | 0},${g | 0},${bch | 0})`;
      }
    }
    return 'rgb(40,20,15)';
  }

  function spawnExplosion(x, y) {
    particles = [];
    crashOriginX = x;
    crashOriginY = y;

    // Dense core fireball puffs — additive-blended, drive the "real fire" look.
    const fireCount = 22;
    for (let i = 0; i < fireCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 30 + Math.random() * 170;
      particles.push({
        type: 'fire',
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        size: 14 + Math.random() * 22,
        drag: 2.2,
        age: 0,
        life: 0.5 + Math.random() * 0.45
      });
    }

    // Sharp hot sparks / shrapnel — small, fast, arc under gravity, trail briefly.
    const sparkCount = 20;
    for (let i = 0; i < sparkCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 220 + Math.random() * 380;
      particles.push({
        type: 'spark',
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 1.2 + Math.random() * 1.8,
        age: 0,
        life: 0.4 + Math.random() * 0.5
      });
    }

    // Tumbling dark debris chunks (concrete/metal shards) — normal-blended, real gravity.
    const debrisCount = 10;
    for (let i = 0; i < debrisCount; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.2;
      const speed = 120 + Math.random() * 260;
      particles.push({
        type: 'debris',
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 3 + Math.random() * 6,
        h: 2 + Math.random() * 5,
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 14,
        shade: 40 + Math.random() * 60,
        age: 0,
        life: 0.9 + Math.random() * 0.6
      });
    }

    // Billowing soot smoke — slow, dark, expands and rises well after the flash fades.
    const smokeCount = 14;
    for (let i = 0; i < smokeCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 15 + Math.random() * 55;
      particles.push({
        type: 'smoke',
        x: x + (Math.random() - 0.5) * 20,
        y: y + (Math.random() - 0.5) * 20,
        vx: Math.cos(angle) * speed * 0.4,
        vy: Math.sin(angle) * speed * 0.4 - 22,
        size: 10 + Math.random() * 14,
        age: Math.random() * 0.15,
        life: 1.0 + Math.random() * 0.7
      });
    }
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.type === 'fire') {
        p.vx *= Math.max(0, 1 - p.drag * dt);
        p.vy *= Math.max(0, 1 - p.drag * dt);
        p.vy -= 55 * dt; // hot gas rises
      } else if (p.type === 'spark') {
        p.vy += 780 * dt; // gravity arc
        p.vx *= (1 - 1.2 * dt);
      } else if (p.type === 'debris') {
        p.vy += 640 * dt;
        p.vx *= (1 - 0.5 * dt);
        p.rot += p.rotSpeed * dt;
      } else { // smoke
        p.vy -= 18 * dt;
        p.size += 22 * dt;
      }
    }
    particles = particles.filter(p => p.age < p.life);
  }

  function updateExplosion(dt) {
    explosionTimer += dt;
    if (shakeTime > 0) shakeTime = Math.max(0, shakeTime - dt);
    updateParticles(dt);
    updateFallingTowers(dt);

    if (explosionTimer >= EXPLOSION_DURATION) {
      finalizeGameOver(pendingCrashTowerNumber);
    }
  }

  function drawExplosion() {
    // --- Soot smoke first (sits behind the fire, drawn normally so it reads dark) ---
    for (const p of particles) {
      if (p.type !== 'smoke') continue;
      const t = p.age / p.life;
      const alpha = Math.max(0, (1 - t) * 0.45);
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
      grad.addColorStop(0, `rgba(55,50,48,${alpha})`);
      grad.addColorStop(1, `rgba(55,50,48,0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Fireball + sparks, additive blend for a genuine hot-glow look ---
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const p of particles) {
      if (p.type !== 'fire') continue;
      const t = Math.min(1, p.age / p.life);
      const alpha = Math.max(0, 1 - t * t);
      const size = p.size * (1 - t * 0.3);
      const color = fireColorAt(t);
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size);
      grad.addColorStop(0, color.replace('rgb', 'rgba').replace(')', `,${alpha})`));
      grad.addColorStop(1, color.replace('rgb', 'rgba').replace(')', ',0)'));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const p of particles) {
      if (p.type !== 'spark') continue;
      const t = p.age / p.life;
      const alpha = Math.max(0, 1 - t);
      const color = fireColorAt(Math.min(1, t * 1.3));
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Central flash + shockwave ring, brief and additive
    const flashT = explosionTimer / 0.16;
    if (flashT < 1) {
      const glow = ctx.createRadialGradient(crashOriginX, crashOriginY, 0, crashOriginX, crashOriginY, 90);
      glow.addColorStop(0, `rgba(255,250,225,${(1 - flashT) * 0.9})`);
      glow.addColorStop(1, 'rgba(255,250,225,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(crashOriginX, crashOriginY, 90, 0, Math.PI * 2);
      ctx.fill();
    }
    const shockT = explosionTimer / 0.45;
    if (shockT < 1) {
      ctx.strokeStyle = `rgba(255,220,160,${(1 - shockT) * 0.5})`;
      ctx.lineWidth = 4 * (1 - shockT) + 1;
      ctx.beginPath();
      ctx.arc(crashOriginX, crashOriginY, 20 + shockT * 130, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // --- Dark tumbling debris on top, normal blend so it reads as solid matter ---
    for (const p of particles) {
      if (p.type !== 'debris') continue;
      const t = p.age / p.life;
      const alpha = Math.max(0, 1 - t);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = `rgb(${p.shade | 0},${p.shade | 0},${p.shade | 0})`;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
  }

  function initClouds() {
    clouds = [];
    const count = 5;
    for (let i = 0; i < count; i++) {
      clouds.push({
        x: Math.random() * W,
        y: H * (0.08 + Math.random() * 0.28),
        scale: 0.6 + Math.random() * 0.9,
        speedFactor: 0.25 + Math.random() * 0.2
      });
    }
  }

  function resetGame() {
    plane = {
      x: W * PLANE_X_RATIO,
      y: H * 0.45,
      vy: 0,
      rotation: 0
    };
    towers = [];
    score = 0;
    elapsed = 0;
    spawnTimer = 0;
    holding = false;
    lastTime = performance.now();
    // seed first tower a bit off-screen to the right
    spawnTower(W + W * 0.3);
    scoreHud.textContent = '0';
    initClouds();
    skylineScrollX = 0;
    particles = [];
    explosionTimer = 0;
    shakeTime = 0;
  }

  function currentSpeed() {
    const t = Math.min(elapsed / SPEED_RAMP_TIME, 1);
    return BASE_SPEED + (MAX_SPEED - BASE_SPEED) * t;
  }

  function currentGapRatio() {
    const t = Math.min(elapsed / SPEED_RAMP_TIME, 1);
    return BASE_GAP_RATIO - (BASE_GAP_RATIO - MIN_GAP_RATIO) * t;
  }

  function spawnTower(xPos) {
    const towerWidth = W * TOWER_WIDTH_RATIO;
    const gapH = H * currentGapRatio();
    const margin = H * 0.08;
    const minGapY = margin + gapH / 2;
    const maxGapY = H - margin - gapH / 2;
    const gapY = minGapY + Math.random() * Math.max(1, (maxGapY - minGapY));
    towers.push({
      x: xPos !== undefined ? xPos : W + towerWidth,
      width: towerWidth,
      gapY: gapY,
      gapH: gapH,
      passed: false,
      topFalling: false,
      topCollapseT: 0,
      topSmokeTimer: 0,
      bottomFalling: false,
      bottomCollapseT: 0,
      bottomSmokeTimer: 0
    });
  }

  const COLLAPSE_DURATION = 1.0; // seconds for a hit pillar to fully crumble away
  const BIG_SMOKE_INTERVAL = 0.11; // seconds between extra dust puffs while collapsing

  function collapseEase(t) {
    const p = Math.min(1, t / COLLAPSE_DURATION);
    return Math.pow(p, 1.6); // slow to start, then gives way fast — like real structural failure
  }

  function spawnBigSmokePuff(x, y) {
    particles.push({
      type: 'smoke',
      x: x + (Math.random() - 0.5) * 34,
      y: y + (Math.random() - 0.5) * 16,
      vx: (Math.random() - 0.5) * 16,
      vy: -16 - Math.random() * 24,
      size: 26 + Math.random() * 32,
      age: 0,
      life: 1.3 + Math.random() * 1.0
    });
  }

  function updateFallingTowers(dt) {
    for (const t of towers) {
      const gapTop = t.gapY - t.gapH / 2;
      const gapBottom = t.gapY + t.gapH / 2;
      const topH = gapTop;
      const bottomH = H - gapBottom;
      const cx = t.x + t.width / 2;

      if (t.topFalling && t.topCollapseT < COLLAPSE_DURATION) {
        t.topCollapseT += dt;
        t.topSmokeTimer -= dt;
        if (t.topSmokeTimer <= 0) {
          t.topSmokeTimer = BIG_SMOKE_INTERVAL;
          const visH = topH * (1 - collapseEase(t.topCollapseT));
          spawnBigSmokePuff(cx + (Math.random() - 0.5) * t.width * 0.7, visH);
        }
      }
      if (t.bottomFalling && t.bottomCollapseT < COLLAPSE_DURATION) {
        t.bottomCollapseT += dt;
        t.bottomSmokeTimer -= dt;
        if (t.bottomSmokeTimer <= 0) {
          t.bottomSmokeTimer = BIG_SMOKE_INTERVAL;
          const visH = bottomH * (1 - collapseEase(t.bottomCollapseT));
          spawnBigSmokePuff(cx + (Math.random() - 0.5) * t.width * 0.7, H - visH);
        }
      }
    }
  }

  // ---------- Input ----------
  function setHolding(v) {
    if (v && !holding) {
      ensureAudio();
      sfxFlap();
    }
    holding = v;
  }

  function handlePrimaryAction() {
    if (state === 'start') {
      ensureAudio();
      startGame();
    } else if (state === 'gameover') {
      ensureAudio();
      startGame();
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (state === 'playing') {
        setHolding(true);
      } else {
        handlePrimaryAction();
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      setHolding(false);
    }
  });

  function onPointerDown(e) {
    // Don't hijack clicks/taps on the retry button — it has its own handler.
    if (retryBtn.contains(e.target)) return;
    e.preventDefault();
    if (state === 'playing') {
      setHolding(true);
    } else {
      handlePrimaryAction();
    }
  }
  function onPointerUp(e) {
    if (retryBtn.contains(e.target)) return;
    setHolding(false);
  }

  // Attached to window (not just the canvas) so taps/clicks still register
  // even while the start/game-over overlay divs are sitting on top of the canvas.
  window.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mouseup', onPointerUp);
  window.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('touchend', onPointerUp, { passive: false });
  window.addEventListener('blur', () => setHolding(false));

  retryBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ensureAudio();
    startGame();
  });

  // ---------- Screen management ----------
  function startGame() {
    state = 'playing';
    startScreen.classList.add('hidden');
    gameOverScreen.classList.add('hidden');
    scoreHud.classList.remove('hidden');
    resetGame();
    startWind();
  }

  function triggerCrash(hitTowerIndex, hitTower, hitPiece) {
    state = 'exploding';
    pendingCrashTowerNumber = hitTowerIndex;
    explosionTimer = 0;
    shakeTime = SHAKE_DURATION;
    spawnExplosion(plane.x, plane.y);
    stopWind();
    sfxCrash();
    scoreHud.classList.add('hidden');

    if (hitTower && hitPiece === 'top') {
      hitTower.topFalling = true;
      hitTower.topCollapseT = 0;
      hitTower.topSmokeTimer = 0;
      const gapTop = hitTower.gapY - hitTower.gapH / 2;
      const cx = hitTower.x + hitTower.width / 2;
      for (let i = 0; i < 9; i++) {
        spawnBigSmokePuff(cx + (Math.random() - 0.5) * hitTower.width, gapTop);
      }
    } else if (hitTower && hitPiece === 'bottom') {
      hitTower.bottomFalling = true;
      hitTower.bottomCollapseT = 0;
      hitTower.bottomSmokeTimer = 0;
      const gapBottom = hitTower.gapY + hitTower.gapH / 2;
      const cx = hitTower.x + hitTower.width / 2;
      for (let i = 0; i < 9; i++) {
        spawnBigSmokePuff(cx + (Math.random() - 0.5) * hitTower.width, gapBottom);
      }
    }
  }

  function finalizeGameOver(hitTowerIndex) {
    state = 'gameover';
    finalScoreEl.textContent = score;
    if (score > bestScore) {
      bestScore = score;
      localStorage.setItem(BEST_KEY, String(bestScore));
    }
    bestScoreEndEl.textContent = bestScore;
    crashMessageEl.textContent = `Damn, You Hit The ${ordinalWord(hitTowerIndex)} Tower!`;
    gameOverScreen.classList.remove('hidden');
  }

  // ---------- Update ----------
  function update(dt) {
    elapsed += dt;

    // Physics
    const accel = holding ? LIFT + GRAVITY : GRAVITY;
    plane.vy += accel * dt;
    plane.vy = Math.max(MAX_RISE_SPEED, Math.min(MAX_FALL_SPEED, plane.vy));
    plane.y += plane.vy * dt;

    // rotation follows velocity (nose up when rising, down when falling)
    const targetRot = Math.max(-0.5, Math.min(0.9, plane.vy / 700));
    plane.rotation += (targetRot - plane.rotation) * Math.min(1, dt * 8);

    const speed = currentSpeed();

    skylineScrollX += speed * SKYLINE_PARALLAX * dt;

    // Move towers
    for (const t of towers) {
      t.x -= speed * dt;
    }
    // Remove offscreen towers
    towers = towers.filter(t => t.x + t.width > -10);

    // Spawn new towers based on spacing
    const spawnDist = W * BASE_SPAWN_DIST_RATIO;
    const lastTower = towers[towers.length - 1];
    if (!lastTower || (W - lastTower.x) >= spawnDist) {
      const newX = lastTower ? lastTower.x + spawnDist : W + W * 0.3;
      spawnTower(Math.max(newX, W + 20));
    }

    // Clouds drift (slow parallax)
    for (const c of clouds) {
      c.x -= speed * c.speedFactor * dt * 0.5;
      if (c.x < -150) {
        c.x = W + 150;
        c.y = H * (0.08 + Math.random() * 0.28);
      }
    }

    // Collision & scoring
    const planeR = W * PLANE_SIZE * 0.42;
    const planeTop = plane.y - planeR * 0.55;
    const planeBottom = plane.y + planeR * 0.55;
    const planeLeft = plane.x - planeR * 0.9;
    const planeRight = plane.x + planeR * 0.9;

    // Ground/ceiling bounds
    if (plane.y - planeR < 0 || plane.y + planeR > H) {
      const towerHitNumber = towers.filter(t => t.passed).length + 1;
      triggerCrash(towerHitNumber);
      return;
    }

    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      const towerLeft = t.x;
      const towerRight = t.x + t.width;

      // scoring: passed when plane's left edge goes beyond tower's right edge
      if (!t.passed && towerRight < planeLeft) {
        t.passed = true;
        score++;
        scoreHud.textContent = String(score);
        sfxPass();
      }

      // collision check (AABB against top/bottom obstacle rects)
      if (planeRight > towerLeft && planeLeft < towerRight) {
        const gapTop = t.gapY - t.gapH / 2;
        const gapBottom = t.gapY + t.gapH / 2;
        if (planeTop < gapTop || planeBottom > gapBottom) {
          const towerHitNumber = towers.filter(tt => tt.passed).length + 1;
          const hitPiece = planeTop < gapTop ? 'top' : 'bottom';
          triggerCrash(towerHitNumber, t, hitPiece);
          return;
        }
      }
    }
  }

  // ---------- Draw ----------
  function drawSky() {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#3f97dc');
    grad.addColorStop(0.55, '#6db8ea');
    grad.addColorStop(1, '#bfe3f7');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  function drawCloud(c) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(c.scale, c.scale);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 42, 18, 0, 0, Math.PI * 2);
    ctx.ellipse(30, 6, 28, 15, 0, 0, Math.PI * 2);
    ctx.ellipse(-30, 6, 26, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Draws one tower piece (top or bottom half) as flat concrete, in absolute canvas coords.
  function drawTowerPieceVector(x, y, w, h, isTopPiece) {
    const capH = Math.min(28, w * 0.35);

    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#8b8f92');
    grad.addColorStop(0.15, '#c7cbcd');
    grad.addColorStop(0.5, '#a9adb0');
    grad.addColorStop(0.85, '#8b8f92');
    grad.addColorStop(1, '#75797c');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);

    // Cap sits at the free end (the end nearest the gap)
    ctx.fillStyle = '#6d7174';
    if (isTopPiece) {
      ctx.fillRect(x - 4, y + h - capH, w + 8, capH);
    } else {
      ctx.fillRect(x - 4, y, w + 8, capH);
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    const lines = 3;
    for (let i = 1; i < lines; i++) {
      const lx = x + (w / lines) * i;
      ctx.beginPath();
      ctx.moveTo(lx, y);
      ctx.lineTo(lx, y + h);
      ctx.stroke();
    }
  }

  function drawTower(t) {
    const gapTop = t.gapY - t.gapH / 2;
    const gapBottom = t.gapY + t.gapH / 2;
    const topH = gapTop;
    const bottomH = H - gapBottom;

    const topReady = towerTopAsset.loaded && towerTopAsset.img.naturalWidth > 0;
    const bottomReady = towerBottomAsset.loaded && towerBottomAsset.img.naturalWidth > 0;

    // TOP PIECE — stays pinned to the ceiling. If struck, it doesn't tip
    // sideways: it crumbles straight down, shrinking from its free (lower)
    // end until nothing's left, revealing open sky.
    const topVisH = t.topFalling ? topH * (1 - collapseEase(t.topCollapseT)) : topH;
    if (topVisH > 0.5) {
      if (topReady) ctx.drawImage(towerTopAsset.img, t.x, 0, t.width, topVisH);
      else drawTowerPieceVector(t.x, 0, t.width, topVisH, true);
    }

    // BOTTOM PIECE — stays pinned to the ground. If struck, it crumbles
    // straight down into rubble, shrinking from its free (upper) end.
    const bottomVisH = t.bottomFalling ? bottomH * (1 - collapseEase(t.bottomCollapseT)) : bottomH;
    if (bottomVisH > 0.5) {
      const y = H - bottomVisH;
      if (bottomReady) ctx.drawImage(towerBottomAsset.img, t.x, y, t.width, bottomVisH);
      else drawTowerPieceVector(t.x, y, t.width, bottomVisH, false);
    }
  }

  function drawPlaneVector() {
    const size = W * PLANE_SIZE;
    ctx.save();
    ctx.translate(plane.x, plane.y);
    ctx.rotate(plane.rotation);

    // Fuselage
    ctx.fillStyle = '#e8ecef';
    ctx.strokeStyle = '#9aa3aa';
    ctx.lineWidth = size * 0.03;
    ctx.beginPath();
    ctx.moveTo(size * 0.95, 0);
    ctx.quadraticCurveTo(size * 0.55, -size * 0.18, size * 0.1, -size * 0.14);
    ctx.quadraticCurveTo(-size * 0.75, -size * 0.13, -size * 0.95, 0);
    ctx.quadraticCurveTo(-size * 0.75, size * 0.13, size * 0.1, size * 0.14);
    ctx.quadraticCurveTo(size * 0.55, size * 0.18, size * 0.95, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Wing
    ctx.fillStyle = '#d5dade';
    ctx.beginPath();
    ctx.moveTo(size * 0.05, -size * 0.06);
    ctx.lineTo(size * 0.02, -size * 0.55);
    ctx.lineTo(-size * 0.22, -size * 0.5);
    ctx.lineTo(-size * 0.18, -size * 0.02);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(size * 0.05, size * 0.06);
    ctx.lineTo(size * 0.02, size * 0.55);
    ctx.lineTo(-size * 0.22, size * 0.5);
    ctx.lineTo(-size * 0.18, size * 0.02);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Tail fin
    ctx.fillStyle = '#d5dade';
    ctx.beginPath();
    ctx.moveTo(-size * 0.75, -size * 0.03);
    ctx.lineTo(-size * 0.98, -size * 0.32);
    ctx.lineTo(-size * 0.62, -size * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Cockpit
    ctx.fillStyle = 'rgba(90, 130, 160, 0.75)';
    ctx.beginPath();
    ctx.ellipse(size * 0.32, -size * 0.02, size * 0.14, size * 0.075, 0, 0, Math.PI * 2);
    ctx.fill();

    // Nose accent stripe
    ctx.fillStyle = '#d33b3b';
    ctx.beginPath();
    ctx.moveTo(size * 0.95, 0);
    ctx.lineTo(size * 0.75, -size * 0.1);
    ctx.lineTo(size * 0.75, size * 0.1);
    ctx.closePath();
    ctx.fill();

    // Propeller blur
    ctx.strokeStyle = 'rgba(60,60,60,0.5)';
    ctx.lineWidth = size * 0.05;
    ctx.beginPath();
    ctx.ellipse(size * 1.0, 0, size * 0.02, size * 0.24, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  function drawPlane() {
    const planeReady = planeAsset.loaded && planeAsset.img.naturalWidth > 0;
    if (!planeReady) {
      drawPlaneVector();
      return;
    }
    const img = planeAsset.img;
    const size = W * PLANE_SIZE;
    // Fit the image inside a box roughly matching the vector plane's footprint,
    // preserving its own aspect ratio (assumes the artwork faces right, nose right).
    const aspect = img.naturalWidth / img.naturalHeight;
    const drawW = size * 2.0;
    const drawH = drawW / aspect;

    ctx.save();
    ctx.translate(plane.x, plane.y);
    ctx.rotate(plane.rotation);
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  }

  function drawSkyline() {
    const img = skylineAsset.img;
    if (!skylineAsset.loaded || img.naturalWidth === 0) return;

    const bandH = H * SKYLINE_HEIGHT_RATIO;
    const aspect = img.naturalWidth / img.naturalHeight;
    const tileW = bandH * aspect;
    const y = H - bandH;

    // Continuous leftward tiling: figure out where the first tile should
    // start so the repeating band has no visible seam or gap.
    const offset = -(skylineScrollX % tileW);
    let x = offset;
    if (x > 0) x -= tileW;
    for (; x < W; x += tileW) {
      ctx.drawImage(img, x, y, tileW, bandH);
    }
  }

  function draw() {
    ctx.save();
    if (state === 'exploding' && shakeTime > 0) {
      const shakeAmt = (shakeTime / SHAKE_DURATION) * SHAKE_MAGNITUDE;
      ctx.translate((Math.random() * 2 - 1) * shakeAmt, (Math.random() * 2 - 1) * shakeAmt);
    }

    drawSky();
    for (const c of clouds) drawCloud(c);

    if (state === 'playing') {
      for (const t of towers) drawTower(t);
      drawSkyline();
      drawPlane();
    } else if (state === 'exploding') {
      for (const t of towers) drawTower(t);
      drawSkyline();
      drawExplosion();
    } else if (state === 'gameover') {
      for (const t of towers) drawTower(t);
      drawSkyline();
      drawExplosion(); // lingering dust/debris keep fading behind the Game Over screen
    } else {
      drawSkyline();
      // Idle preview plane on start screen
      if (!plane) {
        plane = { x: W * PLANE_X_RATIO, y: H * 0.45, vy: 0, rotation: 0 };
      }
      plane.rotation = Math.sin(performance.now() / 500) * 0.08;
      plane.y = H * 0.45 + Math.sin(performance.now() / 600) * 14;
      drawPlane();
    }

    ctx.restore();
  }

  // ---------- Main loop ----------
  function loop(now) {
    const dt = Math.min(0.033, (now - lastTime) / 1000);
    lastTime = now;

    if (state === 'playing') {
      update(dt);
    } else if (state === 'exploding') {
      updateExplosion(dt);
    } else if (state === 'gameover') {
      // Let the collapsing pillar and its dust keep settling behind the UI.
      updateFallingTowers(dt);
      updateParticles(dt);
    }
    draw();

    requestAnimationFrame(loop);
  }

  // ---------- Init ----------
  initClouds();
  lastTime = performance.now();
  requestAnimationFrame(loop);
})();