(() => {
  'use strict';

  // ---------- Canvas Setup ----------
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');

  let DPR = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0; // CSS pixel dimensions

  function resizeCanvas() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
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
  const GRAVITY = 1500;         // px/s^2
  const LIFT = -3600;           // px/s^2 while holding
  const MAX_FALL_SPEED = 620;
  const MAX_RISE_SPEED = -520;
  const PLANE_X_RATIO = 0.28;   // plane's horizontal position as ratio of width
  const PLANE_SIZE = 0.052;     // plane size relative to width
  const TOWER_WIDTH_RATIO = 0.15;
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
  let state = 'start'; // 'start' | 'playing' | 'gameover'
  let plane, towers, score, elapsed, spawnTimer, holding, lastTime;
  let clouds = [];
  let skylineScrollX = 0;
  const SKYLINE_PARALLAX = 0.35; // scrolls slower than towers for a depth feel
  const SKYLINE_HEIGHT_RATIO = 0.16; // band height relative to screen height

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
      passed: false
    });
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

  function endGame(hitTowerIndex) {
    state = 'gameover';
    stopWind();
    sfxCrash();
    scoreHud.classList.add('hidden');
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
      endGame(towerHitNumber);
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
          endGame(towerHitNumber);
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

  function drawTowerVector(t) {
    const gapTop = t.gapY - t.gapH / 2;
    const gapBottom = t.gapY + t.gapH / 2;
    const capH = Math.min(28, t.width * 0.35);

    // Concrete gradient
    const grad = ctx.createLinearGradient(t.x, 0, t.x + t.width, 0);
    grad.addColorStop(0, '#8b8f92');
    grad.addColorStop(0.15, '#c7cbcd');
    grad.addColorStop(0.5, '#a9adb0');
    grad.addColorStop(0.85, '#8b8f92');
    grad.addColorStop(1, '#75797c');

    // Top tower
    ctx.fillStyle = grad;
    ctx.fillRect(t.x, 0, t.width, gapTop);
    // Bottom tower
    ctx.fillRect(t.x, gapBottom, t.width, H - gapBottom);

    // Caps (slightly darker, protruding lip near the gap edges)
    ctx.fillStyle = '#6d7174';
    ctx.fillRect(t.x - 4, Math.max(0, gapTop - capH), t.width + 8, capH);
    ctx.fillRect(t.x - 4, gapBottom, t.width + 8, capH);

    // Subtle vertical panel lines for concrete texture
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    const lines = 3;
    for (let i = 1; i < lines; i++) {
      const lx = t.x + (t.width / lines) * i;
      ctx.beginPath();
      ctx.moveTo(lx, 0);
      ctx.lineTo(lx, gapTop);
      ctx.moveTo(lx, gapBottom);
      ctx.lineTo(lx, H);
      ctx.stroke();
    }
  }

  function drawTower(t) {
    const gapTop = t.gapY - t.gapH / 2;
    const gapBottom = t.gapY + t.gapH / 2;

    const topReady = towerTopAsset.loaded && towerTopAsset.img.naturalWidth > 0;
    const bottomReady = towerBottomAsset.loaded && towerBottomAsset.img.naturalWidth > 0;

    if (!topReady && !bottomReady) {
      drawTowerVector(t);
      return;
    }

    // Top tower: image's natural top sits at the screen's top edge,
    // stretched down to the gap.
    if (topReady) {
      ctx.drawImage(towerTopAsset.img, t.x, 0, t.width, gapTop);
    } else {
      ctx.fillStyle = '#8b8f92';
      ctx.fillRect(t.x, 0, t.width, gapTop);
    }

    // Bottom tower: image's natural top sits right at the gap edge,
    // stretched down to the screen's bottom edge.
    if (bottomReady) {
      ctx.drawImage(towerBottomAsset.img, t.x, gapBottom, t.width, H - gapBottom);
    } else {
      ctx.fillStyle = '#8b8f92';
      ctx.fillRect(t.x, gapBottom, t.width, H - gapBottom);
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
    drawSky();
    drawSkyline();
    for (const c of clouds) drawCloud(c);
    if (state === 'playing' || state === 'gameover') {
      for (const t of towers) drawTower(t);
      drawPlane();
    } else {
      // Idle preview plane on start screen
      if (!plane) {
        plane = { x: W * PLANE_X_RATIO, y: H * 0.45, vy: 0, rotation: 0 };
      }
      plane.rotation = Math.sin(performance.now() / 500) * 0.08;
      plane.y = H * 0.45 + Math.sin(performance.now() / 600) * 14;
      drawPlane();
    }
  }

  // ---------- Main loop ----------
  function loop(now) {
    const dt = Math.min(0.033, (now - lastTime) / 1000);
    lastTime = now;

    if (state === 'playing') {
      update(dt);
    }
    draw();

    requestAnimationFrame(loop);
  }

  // ---------- Init ----------
  initClouds();
  lastTime = performance.now();
  requestAnimationFrame(loop);
})();
