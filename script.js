/**
 * SLIDE PUZZLE — script.js
 * Telegram Mini App | Production-ready sliding tile puzzle
 *
 * Architecture:
 *   - All mutable state lives in the `state` object
 *   - Tile DOM elements stored in `tileEls` keyed by tile value
 *   - Image processing via offscreen Canvas (center-crop → resize → dataURL)
 *   - Tile rendering via CSS background-image + background-position (no redraw on move)
 *   - Solvable shuffle: start solved → apply SHUFFLE_MOVES valid random moves
 */

'use strict';

/* ============================================================
   CONSTANTS
   ============================================================ */

const INTERNAL_RES  = 1000;           // offscreen canvas resolution (px)
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB upload limit
const SHUFFLE_MOVES = 400;             // number of valid random moves for shuffle
const PREVIEW_MS    = 3000;            // image preview duration before puzzle starts
const MIN_IMAGE_DIM = 50;              // reject images smaller than this

/** 6 default images (picsum.photos supports CORS with crossOrigin=anonymous) */
const DEFAULT_IMAGES = [
  { url: 'https://picsum.photos/id/10/600/600',  label: 'Forest'    },
  { url: 'https://picsum.photos/id/15/600/600',  label: 'Mountain'  },
  { url: 'https://picsum.photos/id/29/600/600',  label: 'City'      },
  { url: 'https://picsum.photos/id/48/600/600',  label: 'Nature'    },
  { url: 'https://picsum.photos/id/67/600/600',  label: 'Coast'     },
  { url: 'https://picsum.photos/id/91/600/600',  label: 'Animal'    },
];

/* ============================================================
   STATE
   ============================================================ */

/**
 * All mutable game state. Never mutate this from outside the module functions.
 * @type {Object}
 */
const state = {
  size:          3,     // N — grid is N×N
  grid:          [],    // flat array; grid[pos] = tileValue (0 = empty, 1..N²-1 = tiles)
  emptyPos:      0,     // current index in grid where the empty tile sits
  moves:         0,
  seconds:       0,
  timerInterval: null,
  gameStarted:   false,
  imageDataUrl:  null,  // confirmed, normalized image as JPEG dataURL
  pendingDataUrl:null,  // image awaiting user confirmation
  tileSize:      0,     // CSS px size of each tile (recalculated on resize/size change)
  isProcessing:  false, // prevent concurrent image processing
};

/**
 * Map from tile value (1..N²-1) → HTMLDivElement
 * Rebuilt whenever the grid size or image changes.
 */
let tileEls = {};

/* ============================================================
   TELEGRAM INTEGRATION
   ============================================================ */

/** Telegram WebApp SDK instance (may be undefined outside Telegram) */
const TG = window.Telegram?.WebApp;

/**
 * Initialize Telegram WebApp:
 * - Call ready() + expand()
 * - Apply themeParams as CSS variables
 * - Wire up MainButton (restart) and BackButton (close modal)
 */
function initTelegram() {
  if (!TG) return;

  TG.ready();
  TG.expand();

  // Apply Telegram theme colors as CSS variables
  const t = TG.themeParams;
  if (t) {
    const r = document.documentElement.style;
    if (t.bg_color)     r.setProperty('--bg',       t.bg_color);
    if (t.text_color)   r.setProperty('--text',     t.text_color);
    if (t.button_color) r.setProperty('--accent',   t.button_color);
    if (t.hint_color)   r.setProperty('--text-3',   t.hint_color);
  }

  // MainButton: restart / new game
  TG.MainButton.setText('New Game');
  TG.MainButton.onClick(() => {
    closeAllModals();
    shuffleBoard();
    resetCounters();
    renderGrid(false);  // instant, no animation
  });

  // BackButton: dismiss whichever modal is open
  TG.BackButton.onClick(() => {
    if (!el('modal-picker').classList.contains('hidden'))  closePicker();
    else if (!el('modal-confirm').classList.contains('hidden')) closeConfirm();
    else if (!el('modal-win').classList.contains('hidden'))     closeWin();
  });
}

/** Light haptic on tile move */
function hapticMove() {
  TG?.HapticFeedback?.impactOccurred('light');
}

/** Success haptic on win */
function hapticWin() {
  TG?.HapticFeedback?.notificationOccurred('success');
}

/* ============================================================
   DOM HELPERS
   ============================================================ */

/** Shorthand for document.getElementById */
const el = id => document.getElementById(id);

/** Cached DOM references */
const dom = {
  puzzleGrid:     el('puzzle-grid'),
  statTimer:      el('stat-timer'),
  statMoves:      el('stat-moves'),
  statBest:       el('stat-best'),
  overlayLoading: el('overlay-loading'),
  overlayPreview: el('overlay-preview'),
  previewBg:      el('preview-image-bg'),
  confirmCanvas:  el('confirm-canvas'),
  imagePickGrid:  el('image-pick-grid'),
  fileInput:      el('file-input'),
  toast:          el('toast'),
  confettiCanvas: el('confetti-canvas'),
  winTime:        el('win-time'),
  winMoves:       el('win-moves'),
  winBest:        el('win-best'),
};

/* ============================================================
   UTILITY FUNCTIONS
   ============================================================ */

/**
 * Format seconds as M:SS
 * @param {number} s - total seconds
 * @returns {string}
 */
function formatTime(s) {
  const m   = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Get best time from localStorage for given size, or null */
function getBestTime(size) {
  const v = localStorage.getItem(`puzzle_best_${size}`);
  return v !== null ? parseInt(v, 10) : null;
}

/**
 * Attempt to set a new best time. Returns true if it's a new record.
 * @param {number} size
 * @param {number} seconds
 * @returns {boolean} isNewRecord
 */
function setBestTime(size, seconds) {
  const current = getBestTime(size);
  if (current === null || seconds < current) {
    localStorage.setItem(`puzzle_best_${size}`, seconds);
    return true;
  }
  return false;
}

/** Update the best-time stat display from localStorage */
function refreshBestDisplay() {
  const best = getBestTime(state.size);
  dom.statBest.textContent = best !== null ? formatTime(best) : '--:--';
}

/* Toast notification */
let _toastTimer = null;
function showToast(msg, durationMs = 3200) {
  const t = dom.toast;
  clearTimeout(_toastTimer);
  t.textContent = msg;
  t.classList.remove('hidden');
  // Force reflow before adding visible
  t.getBoundingClientRect();
  t.classList.add('visible');
  _toastTimer = setTimeout(() => {
    t.classList.remove('visible');
    setTimeout(() => t.classList.add('hidden'), 280);
  }, durationMs);
}

/* ============================================================
   IMAGE PROCESSING PIPELINE
   ============================================================ */

/**
 * Read a File as a base64 DataURL using FileReader.
 * Using FileReader (not URL.createObjectURL) avoids manual revocation
 * and is more compatible with Telegram WebApp on iOS.
 *
 * @param {File} file
 * @returns {Promise<string>} dataURL
 */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Load a src (dataURL or remote URL) into an HTMLImageElement.
 * Set crossOrigin for remote URLs so canvas.toDataURL() doesn't throw CORS errors.
 *
 * @param {string}  src
 * @param {boolean} crossOrigin - set crossOrigin="anonymous" for external URLs
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(src, crossOrigin = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

/**
 * Center-crop an image to a square, then scale to INTERNAL_RES × INTERNAL_RES.
 *
 * Square crop math:
 *   cropSize = min(naturalWidth, naturalHeight)  → largest centered square
 *   offsetX  = (naturalWidth  - cropSize) / 2   → left padding to center horizontally
 *   offsetY  = (naturalHeight - cropSize) / 2   → top  padding to center vertically
 *
 * The 9-argument drawImage form handles both crop and scale in one call:
 *   ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
 *
 * @param {HTMLImageElement} img
 * @returns {HTMLCanvasElement} 1000×1000 canvas
 */
function normalizeImageToCanvas(img) {
  const offscreen = document.createElement('canvas');
  offscreen.width  = INTERNAL_RES;
  offscreen.height = INTERNAL_RES;
  const ctx = offscreen.getContext('2d');

  // Use naturalWidth/Height (actual pixel dimensions, not CSS display size)
  const w = img.naturalWidth  || img.width;
  const h = img.naturalHeight || img.height;

  if (w < MIN_IMAGE_DIM || h < MIN_IMAGE_DIM) {
    // Tiny image — still draw it, browser will upscale
    console.warn('[normalizeImageToCanvas] Image is very small:', w, h);
  }

  // Center-crop: take the largest square from the center
  const cropSize = Math.min(w, h);
  const offsetX  = (w - cropSize) / 2;
  const offsetY  = (h - cropSize) / 2;

  // Draw: source region (offsetX, offsetY, cropSize, cropSize)
  //       → destination (0, 0, INTERNAL_RES, INTERNAL_RES)
  ctx.drawImage(
    img,
    offsetX, offsetY, cropSize, cropSize,  // source rect
    0, 0, INTERNAL_RES, INTERNAL_RES       // dest rect (scale to 1000×1000)
  );

  return offscreen;
}

/**
 * Full pipeline for a user-uploaded file:
 * validate → read → load → normalize → store pending → show confirm
 *
 * @param {File} file
 */
async function processUploadedImage(file) {
  if (state.isProcessing) return;

  // --- Validation ---
  if (!file || !file.type.startsWith('image/')) {
    showToast('Please select an image file.');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showToast('Image is too large (max 5 MB). Try a smaller photo.');
    return;
  }

  state.isProcessing = true;
  showLoading(true);
  closePicker();

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const img     = await loadImage(dataUrl); // no crossOrigin for local data
    const canvas  = normalizeImageToCanvas(img);
    state.pendingDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    showConfirmModal();
  } catch (err) {
    console.error('[processUploadedImage]', err);
    showToast('Could not process that image. Please try another.');
  } finally {
    state.isProcessing = false;
    showLoading(false);
    // Always reset file input so the same file can be reselected
    dom.fileInput.value = '';
  }
}

/**
 * Full pipeline for a built-in preset image URL.
 * Uses crossOrigin=anonymous so canvas.toDataURL() succeeds.
 *
 * @param {string} url
 */
async function processDefaultImage(url) {
  if (state.isProcessing) return;

  state.isProcessing = true;
  showLoading(true);
  closePicker();

  try {
    const img    = await loadImage(url, true); // crossOrigin = true
    const canvas = normalizeImageToCanvas(img);
    state.pendingDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    showConfirmModal();
  } catch (err) {
    console.error('[processDefaultImage]', err);
    showToast('Could not load that image. Check your connection.');
  } finally {
    state.isProcessing = false;
    showLoading(false);
  }
}

/* ============================================================
   TILE GENERATION
   ============================================================ */

/**
 * Create (or recreate) all N²-1 tile DOM elements.
 *
 * Each tile uses CSS background-image + background-position to display
 * its portion of the normalized image — no per-move canvas redraws.
 *
 * Tile index math for value v (1-indexed):
 *   originalPos = v - 1            (0-indexed position in solved puzzle)
 *   origRow = floor(originalPos / N)
 *   origCol = originalPos % N
 *   background-size:     N*tileSize × N*tileSize  (image fills the whole grid)
 *   background-position: -origCol*tileSize  -origRow*tileSize
 *
 * Tiles are positioned via transform:translate(x, y) from top-left (0,0).
 */
function generateTilesFromCanvas() {
  const { size, tileSize, imageDataUrl } = state;

  if (!imageDataUrl) return;

  // Clear existing tiles
  dom.puzzleGrid.innerHTML = '';
  tileEls = {};

  const totalPx  = size * tileSize;
  const bgSize   = `${totalPx}px ${totalPx}px`;

  for (let v = 1; v < size * size; v++) {
    const origPos = v - 1;                        // 0-indexed original position
    const origRow = Math.floor(origPos / size);
    const origCol = origPos % size;

    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.setAttribute('aria-label', `Tile ${v}`);

    // Size
    tile.style.width  = `${tileSize}px`;
    tile.style.height = `${tileSize}px`;

    // Background: full image scaled to grid size, offset to show this tile's slice
    tile.style.backgroundImage    = `url(${imageDataUrl})`;
    tile.style.backgroundSize     = bgSize;
    tile.style.backgroundPosition =
      `-${origCol * tileSize}px -${origRow * tileSize}px`;

    // Click + keyboard
    tile.addEventListener('click',   () => handleTileClick(v));
    tile.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleTileClick(v);
      }
    });

    dom.puzzleGrid.appendChild(tile);
    tileEls[v] = tile;
  }

  // Container size (tiles are absolute, so container needs explicit size)
  dom.puzzleGrid.style.width  = `${totalPx}px`;
  dom.puzzleGrid.style.height = `${totalPx}px`;
}

/* ============================================================
   GAME LOGIC
   ============================================================ */

/**
 * Returns all positions adjacent (up/down/left/right) to pos in an N×N grid.
 *
 * @param {number} pos  - flat array index
 * @param {number} size - grid dimension N
 * @returns {number[]}
 */
function getNeighbors(pos, size) {
  const row = Math.floor(pos / size);
  const col = pos % size;
  const nbrs = [];
  if (row > 0)        nbrs.push(pos - size); // up
  if (row < size - 1) nbrs.push(pos + size); // down
  if (col > 0)        nbrs.push(pos - 1);    // left
  if (col < size - 1) nbrs.push(pos + 1);    // right
  return nbrs;
}

/**
 * Set grid to the solved state: [1, 2, …, N²-1, 0].
 * Empty tile (0) is at position N²-1 (bottom-right).
 */
function setSolvedState() {
  const total = state.size * state.size;
  state.grid = [];
  for (let i = 0; i < total - 1; i++) state.grid.push(i + 1);
  state.grid.push(0);
  state.emptyPos = total - 1;
}

/**
 * Produce a solvable random shuffle by applying SHUFFLE_MOVES valid moves
 * starting from the solved state.
 *
 * Why this guarantees solvability:
 *   Every move is a legal slide (swapping a tile with the adjacent empty space).
 *   Starting from a known-solved state and applying any sequence of legal moves
 *   always produces a solvable configuration — because legal moves are reversible.
 *
 * The "avoid reversal" trick prevents immediately undoing the last move,
 * which produces better randomization.
 */
function shuffleBoard() {
  setSolvedState();

  let prevEmpty = -1; // track previous empty position to avoid back-and-forth

  for (let i = 0; i < SHUFFLE_MOVES; i++) {
    const nbrs    = getNeighbors(state.emptyPos, state.size);
    // Filter out the tile that was just moved (would reverse the last step)
    const choices = nbrs.filter(n => n !== prevEmpty);
    const pick    = choices[Math.floor(Math.random() * choices.length)];

    // Slide: move tile at `pick` into the empty slot
    state.grid[state.emptyPos] = state.grid[pick];
    state.grid[pick]           = 0;
    prevEmpty                  = state.emptyPos;
    state.emptyPos             = pick;
  }
}

/**
 * Handle a tile click: validate adjacency, then execute move.
 * Starts the timer on the very first move.
 *
 * @param {number} tileValue - value of the clicked tile (1-indexed)
 */
function handleTileClick(tileValue) {
  // Start timer on first interaction
  if (!state.gameStarted) {
    state.gameStarted = true;
    startTimer();
    TG?.MainButton?.show();
  }

  // Find where this tile currently sits in the grid
  const tilePos = state.grid.indexOf(tileValue);

  // Only move if the tile is directly adjacent to the empty slot
  if (!getNeighbors(state.emptyPos, state.size).includes(tilePos)) return;

  moveTile(tilePos);
}

/**
 * Execute a tile move: slide the tile at tilePos into the empty slot.
 * Updates state, increments move counter, re-renders, checks for win.
 *
 * @param {number} tilePos - grid index of the tile to move
 */
function moveTile(tilePos) {
  const val = state.grid[tilePos];

  // Swap tile with empty slot
  state.grid[state.emptyPos] = val;
  state.grid[tilePos]        = 0;
  state.emptyPos             = tilePos;

  state.moves++;
  dom.statMoves.textContent = state.moves;

  hapticMove();

  // Animated re-render (only the moved tile will visibly translate)
  renderGrid(true);

  // Check win condition
  if (checkWin()) {
    // Slight delay so the last tile finishes its animation
    setTimeout(handleWin, 280);
  }
}

/**
 * Check if the puzzle is in the solved state.
 * Solved: grid[i] === i+1 for all i < N²-1, and grid[N²-1] === 0
 *
 * @returns {boolean}
 */
function checkWin() {
  const total = state.size * state.size;
  for (let i = 0; i < total - 1; i++) {
    if (state.grid[i] !== i + 1) return false;
  }
  return state.grid[total - 1] === 0;
}

/**
 * Calculate the CSS pixel size of each tile based on current viewport width.
 * Puzzle never exceeds 420px wide, and always fits within the viewport
 * (with 16px padding on each side).
 */
function calculateTileSize() {
  const maxGridWidth = Math.min(window.innerWidth - 32, 420);
  state.tileSize = Math.floor(maxGridWidth / state.size);
}

/**
 * Update every tile's CSS transform to reflect current grid state.
 *
 * Each tile is positioned via transform:translate(col*tileSize, row*tileSize)
 * from its absolute home at (0, 0) within the grid container.
 *
 * @param {boolean} animated - if false, transitions are disabled (instant snap)
 */
function renderGrid(animated = true) {
  const { size, grid, tileSize } = state;

  if (!animated) {
    // Disable transitions temporarily for instant positioning (shuffle/init)
    Object.values(tileEls).forEach(t => t.classList.add('no-anim'));
  }

  for (let pos = 0; pos < size * size; pos++) {
    const val = grid[pos];
    if (val === 0) continue; // empty tile has no DOM element

    const tile = tileEls[val];
    if (!tile) continue;

    const row = Math.floor(pos / size);
    const col = pos % size;
    tile.style.transform = `translate(${col * tileSize}px, ${row * tileSize}px)`;
  }

  if (!animated) {
    // Re-enable transitions on next frame (after transforms are applied)
    requestAnimationFrame(() => {
      Object.values(tileEls).forEach(t => t.classList.remove('no-anim'));
    });
  }
}

/**
 * Reset move counter, timer display, and gameStarted flag.
 * Does NOT reshuffle or change the image.
 */
function resetCounters() {
  stopTimer();
  state.moves       = 0;
  state.seconds     = 0;
  state.gameStarted = false;
  dom.statMoves.textContent = '0';
  dom.statTimer.textContent = '0:00';
  refreshBestDisplay();
}

/**
 * Full game initialization:
 * calculate tile size → generate tile elements → solve board → optionally shuffle → render.
 *
 * @param {boolean} withPreview - show the 3-second image preview before shuffling
 */
function initGame(withPreview = false) {
  resetCounters();
  calculateTileSize();
  generateTilesFromCanvas();
  setSolvedState();
  renderGrid(false); // instant: show solved state first

  if (withPreview) {
    // Show the full image for PREVIEW_MS, then shuffle and reveal puzzle
    showPreviewOverlay();
  } else {
    shuffleBoard();
    renderGrid(false);
  }
}

/* ============================================================
   TIMER
   ============================================================ */

function startTimer() {
  stopTimer(); // safety: clear any existing interval
  state.timerInterval = setInterval(() => {
    state.seconds++;
    dom.statTimer.textContent = formatTime(state.seconds);
  }, 1000);
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

/* ============================================================
   WIN HANDLING
   ============================================================ */

/**
 * Called when checkWin() returns true.
 * Stops timer, saves best time, shows win modal + confetti.
 */
function handleWin() {
  stopTimer();
  hapticWin();

  const isNewBest = setBestTime(state.size, state.seconds);
  const best      = getBestTime(state.size);

  refreshBestDisplay();

  dom.winTime.textContent  = formatTime(state.seconds);
  dom.winMoves.textContent = state.moves;
  dom.winBest.textContent  = best !== null ? formatTime(best) : '--';
  if (isNewBest) dom.winBest.textContent += ' ⭐';

  openModal('modal-win');
  startConfetti();
}

/* ============================================================
   PREVIEW OVERLAY
   ============================================================ */

/**
 * Show the full normalized image as a preview for PREVIEW_MS milliseconds.
 * After it closes, the grid is shuffled and revealed.
 */
function showPreviewOverlay() {
  const overlay = dom.overlayPreview;
  dom.previewBg.style.backgroundImage = `url(${state.imageDataUrl})`;

  overlay.classList.remove('hidden');

  setTimeout(() => {
    overlay.classList.add('hidden');
    // Now shuffle and render the playable puzzle
    shuffleBoard();
    renderGrid(false);
  }, PREVIEW_MS);
}

/* ============================================================
   LOADING OVERLAY
   ============================================================ */

function showLoading(show) {
  dom.overlayLoading.classList.toggle('hidden', !show);
}

/* ============================================================
   MODALS
   ============================================================ */

/** Open a modal by id with CSS animation */
function openModal(id) {
  const m = el(id);
  m.classList.remove('hidden');
  // rAF ensures the 'hidden' removal is painted before 'open' triggers animation
  requestAnimationFrame(() => {
    requestAnimationFrame(() => m.classList.add('open'));
  });
  TG?.BackButton?.show();
}

/** Close a modal by id */
function closeModal(id) {
  const m = el(id);
  m.classList.remove('open');
  // Wait for CSS transition before hiding with display:none
  setTimeout(() => m.classList.add('hidden'), 380);
  TG?.BackButton?.hide();
}

function closeAllModals() {
  ['modal-picker', 'modal-confirm', 'modal-win'].forEach(closeModal);
}

function openPicker()  { buildImageGrid(); openModal('modal-picker');  }
function closePicker() { closeModal('modal-picker'); }
function closeConfirm(){ state.pendingDataUrl = null; closeModal('modal-confirm'); }
function closeWin()    { closeModal('modal-win'); stopConfetti(); }

/**
 * Show the confirm modal with a canvas preview of the pending image.
 */
function showConfirmModal() {
  const canvas = dom.confirmCanvas;
  const size   = Math.min(window.innerWidth - 80, 300);
  canvas.width  = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, size, size);
  img.src    = state.pendingDataUrl;

  openModal('modal-confirm');
}

/**
 * Populate the image picker grid with DEFAULT_IMAGES thumbnails.
 * Only rebuilds if grid is empty.
 */
function buildImageGrid() {
  const grid = dom.imagePickGrid;
  if (grid.children.length > 0) return; // already built

  DEFAULT_IMAGES.forEach(({ url, label }) => {
    const btn  = document.createElement('button');
    btn.className = 'image-thumb';
    btn.setAttribute('aria-label', label);

    const img = document.createElement('img');
    img.src     = url;
    img.alt     = label;
    img.loading = 'lazy';
    img.crossOrigin = 'anonymous';

    const span = document.createElement('span');
    span.textContent = label;

    btn.appendChild(img);
    btn.appendChild(span);
    btn.addEventListener('click', () => processDefaultImage(url));

    grid.appendChild(btn);
  });
}

/* ============================================================
   CONFETTI
   ============================================================ */

let confettiRaf  = null;
let confettiPtrs = [];

const CONFETTI_COLORS = [
  '#00e5ff', '#ff3d71', '#ffd700', '#00e676', '#d500f9', '#ff9100', '#40c4ff'
];

function startConfetti() {
  const canvas = dom.confettiCanvas;
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.display = 'block';

  confettiPtrs = Array.from({ length: 130 }, () => ({
    x:         Math.random() * canvas.width,
    y:        -10 - Math.random() * 120,
    vx:        (Math.random() - 0.5) * 5,
    vy:         2 + Math.random() * 5,
    size:       4 + Math.random() * 9,
    color:      CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    rotation:   Math.random() * 360,
    rotSpeed:   (Math.random() - 0.5) * 8,
    isRect:     Math.random() > 0.4,
  }));

  const ctx = canvas.getContext('2d');

  const step = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let anyAlive = false;

    confettiPtrs.forEach(p => {
      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.12; // gravity
      p.rotation += p.rotSpeed;

      if (p.y < canvas.height + 30) anyAlive = true;

      const alpha = Math.max(0, 1 - (p.y / canvas.height) * 1.2);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation * Math.PI / 180);
      ctx.fillStyle = p.color;

      if (p.isRect) {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });

    if (anyAlive) {
      confettiRaf = requestAnimationFrame(step);
    } else {
      stopConfetti();
    }
  };

  confettiRaf = requestAnimationFrame(step);
  setTimeout(stopConfetti, 5500); // hard cap
}

function stopConfetti() {
  if (confettiRaf) {
    cancelAnimationFrame(confettiRaf);
    confettiRaf = null;
  }
  const canvas = dom.confettiCanvas;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  canvas.style.display = 'none';
}

/* ============================================================
   INITIAL IMAGE LOAD
   ============================================================ */

/**
 * Load the first default image on app start.
 * Falls back to a procedural gradient if the network request fails.
 */
async function loadInitialImage() {
  showLoading(true);
  try {
    const img    = await loadImage(DEFAULT_IMAGES[0].url, true);
    const canvas = normalizeImageToCanvas(img);
    state.imageDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  } catch {
    // Generate a gradient placeholder so the game still works offline
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = INTERNAL_RES;
    const ctx  = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, INTERNAL_RES, INTERNAL_RES);
    grad.addColorStop(0,   '#1a237e');
    grad.addColorStop(0.5, '#00838f');
    grad.addColorStop(1,   '#f9a825');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, INTERNAL_RES, INTERNAL_RES);
    // Draw a subtle grid overlay so tiles are distinguishable
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth   = 2;
    for (let i = 1; i < 5; i++) {
      ctx.beginPath(); ctx.moveTo(i * 200, 0);  ctx.lineTo(i * 200, INTERNAL_RES);  ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * 200);  ctx.lineTo(INTERNAL_RES, i * 200);  ctx.stroke();
    }
    state.imageDataUrl = canvas.toDataURL();
    showToast('Could not load default image. Using placeholder.');
  } finally {
    showLoading(false);
  }
}

/* ============================================================
   EVENT LISTENERS
   ============================================================ */

function bindEvents() {
  // --- Difficulty buttons ---
  document.querySelectorAll('.diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (parseInt(btn.dataset.size) === state.size) return; // no change
      document.querySelectorAll('.diff-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      state.size = parseInt(btn.dataset.size, 10);
      closeAllModals();
      stopConfetti();
      initGame(); // no preview on difficulty change
    });
  });

  // --- Shuffle button ---
  el('btn-shuffle').addEventListener('click', () => {
    stopConfetti();
    closeModal('modal-win');
    shuffleBoard();
    resetCounters();
    renderGrid(false);
  });

  // --- Change image button ---
  el('btn-change-image').addEventListener('click', openPicker);

  // --- Picker backdrop / close button ---
  el('picker-backdrop').addEventListener('click', closePicker);
  el('btn-close-picker').addEventListener('click', closePicker);

  // --- File upload ---
  dom.fileInput.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) processUploadedImage(file);
  });

  // --- Confirm modal ---
  el('confirm-backdrop').addEventListener('click', closeConfirm);
  el('btn-cancel-image').addEventListener('click', closeConfirm);

  el('btn-use-image').addEventListener('click', () => {
    if (!state.pendingDataUrl) return;
    state.imageDataUrl  = state.pendingDataUrl;
    state.pendingDataUrl = null;
    closeModal('modal-confirm');
    stopConfetti();
    initGame(true); // withPreview = true
  });

  // --- Win modal ---
  el('btn-play-again').addEventListener('click', () => {
    closeWin();
    setTimeout(() => {
      shuffleBoard();
      resetCounters();
      renderGrid(false);
    }, 350);
  });

  // --- Window resize: recalculate tile size and re-render ---
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.imageDataUrl) return;
      calculateTileSize();
      generateTilesFromCanvas();
      renderGrid(false);
    }, 120);
  });

  // --- Keyboard: arrow keys to slide tiles ---
  document.addEventListener('keydown', e => {
    if (!state.imageDataUrl) return;
    const { emptyPos, size } = state;

    // Arrow key → try to move the tile in the opposite direction into the empty slot
    // e.g. ArrowLeft moves the tile to the RIGHT of empty leftward into the empty
    let targetPos = -1;
    if (e.key === 'ArrowLeft'  && emptyPos % size < size - 1) targetPos = emptyPos + 1;
    if (e.key === 'ArrowRight' && emptyPos % size > 0)        targetPos = emptyPos - 1;
    if (e.key === 'ArrowUp'    && Math.floor(emptyPos / size) < size - 1) targetPos = emptyPos + size;
    if (e.key === 'ArrowDown'  && Math.floor(emptyPos / size) > 0)        targetPos = emptyPos - size;

    if (targetPos !== -1 && state.grid[targetPos] !== 0) {
      e.preventDefault();
      if (!state.gameStarted) { state.gameStarted = true; startTimer(); TG?.MainButton?.show(); }
      moveTile(targetPos);
    }
  });
}

/* ============================================================
   BOOTSTRAP
   ============================================================ */

async function main() {
  initTelegram();
  bindEvents();
  await loadInitialImage();
  initGame();    // size=3, no preview on first load (go straight to puzzle)
}

// Run after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
