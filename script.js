const state = {
  n: 4,
  board: [],
  solvedBoard: [],
  moves: 0,
  timer: 0,
  timerInterval: null,
  isPlaying: false,
  imageSrc: null,
  tileSize: 0,
  boardPixelSize: 0,
  isProcessing: false,
  uploadRotation: 0,
  tempImage: null,
  defaultImages: [
    'https://images.unsplash.com/photo-1518791841217-8f162f1e1131?ixlib=rb-1.2.1&auto=format&fit=crop&w=1000&q=80',
    'https://images.unsplash.com/photo-1517849845537-4d257902454a?ixlib=rb-1.2.1&auto=format&fit=crop&w=1000&q=80',
    'https://images.unsplash.com/photo-1472457897821-70d3819a0e24?ixlib=rb-1.2.1&auto=format&fit=crop&w=1000&q=80',
    'https://images.unsplash.com/photo-1550439062-609e1531270e?ixlib=rb-1.2.1&auto=format&fit=crop&w=1000&q=80',
    'https://images.unsplash.com/photo-1507146426996-ef05306b995a?ixlib=rb-1.2.1&auto=format&fit=crop&w=1000&q=80',
    'https://images.unsplash.com/photo-1511512578047-dfb367046420?ixlib=rb-1.2.1&auto=format&fit=crop&w=1000&q=80'
  ]
};

document.addEventListener('DOMContentLoaded', () => {
  initTelegram();
  initUI();

  const img = new Image();
  img.crossOrigin = "Anonymous";
  img.onload = () => { setImageSource(img); };
  img.src = state.defaultImages[0];

  // ✅ Keep board + background math correct on Telegram resize/orientation changes
  window.addEventListener('resize', () => {
    if (state.board.length) generateTileRenderData();
  });
});

function initTelegram() {
  if (window.Telegram && Telegram.WebApp) {
    Telegram.WebApp.ready();
    Telegram.WebApp.expand();

    const themeParams = Telegram.WebApp.themeParams;
    const root = document.documentElement;
    if (themeParams.bg_color) root.style.setProperty('--bg-color', themeParams.bg_color);
    if (themeParams.text_color) root.style.setProperty('--text-color', themeParams.text_color);
    if (themeParams.hint_color) root.style.setProperty('--hint-color', themeParams.hint_color);
    if (themeParams.button_color) root.style.setProperty('--button-color', themeParams.button_color);
    if (themeParams.button_text_color) root.style.setProperty('--button-text-color', themeParams.button_text_color);
    if (themeParams.secondary_bg_color) root.style.setProperty('--secondary-bg-color', themeParams.secondary_bg_color);

    const user = Telegram.WebApp.initDataUnsafe?.user;
    if (user) {
      document.getElementById('userInfo').textContent = user.first_name || user.username || 'Player';
    }

    Telegram.WebApp.MainButton.setText('RESTART');
    Telegram.WebApp.MainButton.onClick(() => initGame());
    Telegram.WebApp.MainButton.show();
  }
}

function initUI() {
 const grid = document.getElementById('thumbnailMount');
  state.defaultImages.forEach((src, idx) => {
    const div = document.createElement('div');
    div.className = `thumbnail ${idx === 0 ? 'selected' : ''}`;
    div.style.backgroundImage = `url(${src})`;
    div.onclick = () => {
      document.querySelectorAll('.thumbnail').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      const img = new Image();
      img.crossOrigin = "Anonymous";
      img.onload = () => setImageSource(img);
      img.src = src;
    };
    grid.appendChild(div);
  });
}

function initGame() {
  state.moves = 0;
  state.timer = 0;
  state.isPlaying = false;
  clearInterval(state.timerInterval);
  document.getElementById('moveCount').textContent = state.moves;
  document.getElementById('timeCount').textContent = '0s';

  if (window.Telegram && Telegram.WebApp) {
    Telegram.WebApp.MainButton.setText('RESTART');
  }

  const n = state.n;
  const total = n * n;
  state.solvedBoard = Array.from({ length: total - 1 }, (_, i) => i + 1);
  state.solvedBoard.push(0);

  state.board = [...state.solvedBoard];

  shuffleBoard();
  generateTileRenderData();
}

function setDifficulty(n) {
  state.n = n;
  initGame();
}

function setImageSource(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 1000;
  canvas.height = 1000;
  const ctx = canvas.getContext('2d');

  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;

  ctx.drawImage(img, sx, sy, side, side, 0, 0, 1000, 1000);
  state.imageSrc = canvas.toDataURL('image/jpeg', 0.8);

  document.getElementById('fullPreviewImage').style.backgroundImage = `url(${state.imageSrc})`;
  initGame();
}

function processUploadedImage(input) {
  if (state.isProcessing) return;
  const file = input.files[0];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    alert("File is too large! Maximum size is 5MB.");
    input.value = "";
    return;
  }

  state.isProcessing = true;
  showModal('loadingOverlay');
  input.disabled = true;

  const objectUrl = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    state.tempImage = img;
    state.uploadRotation = 0;

    if (Math.min(img.width, img.height) < 500) {
      document.getElementById('blurWarning').classList.remove('hidden');
    } else {
      document.getElementById('blurWarning').classList.add('hidden');
    }

    normalizeToSquareCanvas(state.tempImage, state.uploadRotation);

    hideModal('loadingOverlay');
    showModal('uploadPreviewModal');
    input.disabled = false;
    input.value = "";
    URL.revokeObjectURL(objectUrl);
    state.isProcessing = false;
  };

  img.onerror = () => {
    alert("Failed to load image.");
    hideModal('loadingOverlay');
    input.disabled = false;
    state.isProcessing = false;
    URL.revokeObjectURL(objectUrl);
  };

  img.src = objectUrl;
}

function normalizeToSquareCanvas(img, rotationDegrees) {
  const canvas = document.getElementById('previewCanvas');
  const ctx = canvas.getContext('2d');

  // Ensure internal resolution is correct
  canvas.width = 1000;
  canvas.height = 1000;

  ctx.clearRect(0, 0, 1000, 1000);

  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;

  ctx.save();
  ctx.translate(500, 500);
  ctx.rotate((rotationDegrees * Math.PI) / 180);

  // Center-crop square then draw to 1000x1000
  ctx.drawImage(img, sx, sy, side, side, -500, -500, 1000, 1000);

  ctx.restore();
}

function rotatePreview() {
  state.uploadRotation = (state.uploadRotation + 90) % 360;
  normalizeToSquareCanvas(state.tempImage, state.uploadRotation);
}

function confirmUpload() {
  const canvas = document.getElementById('previewCanvas');
  state.imageSrc = canvas.toDataURL('image/jpeg', 0.8);
  document.getElementById('fullPreviewImage').style.backgroundImage = `url(${state.imageSrc})`;

  document.querySelectorAll('.thumbnail').forEach(el => el.classList.remove('selected'));

  hideModal('uploadPreviewModal');
  initGame();
}

// ✅ True solvable shuffle via random valid moves from solved
function shuffleBoard() {
  const n = state.n;
  const total = n * n;
  let emptyIdx = total - 1;
  const shuffles = 450; // solid shuffle count

  let lastEmpty = -1;
  for (let i = 0; i < shuffles; i++) {
    const candidates = [];
    const row = Math.floor(emptyIdx / n);
    const col = emptyIdx % n;

    const up = emptyIdx - n;
    const down = emptyIdx + n;
    const left = emptyIdx - 1;
    const right = emptyIdx + 1;

    if (row > 0 && up !== lastEmpty) candidates.push(up);
    if (row < n - 1 && down !== lastEmpty) candidates.push(down);
    if (col > 0 && left !== lastEmpty) candidates.push(left);
    if (col < n - 1 && right !== lastEmpty) candidates.push(right);

    const nextIdx = candidates[Math.floor(Math.random() * candidates.length)];

    state.board[emptyIdx] = state.board[nextIdx];
    state.board[nextIdx] = 0;

    lastEmpty = emptyIdx;
    emptyIdx = nextIdx;
  }
}

/**
 * ✅ KEY FIX:
 * Uses the actual rendered board width (responsive) instead of hardcoded 320
 * so tiles + background always align and controls don’t get “covered”.
 */
function generateTileRenderData() {
  const boardEl = document.getElementById('gameBoard');
  boardEl.innerHTML = '';

  const n = state.n;
  const gap = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tile-gap')) || 2;

  // ✅ real board size from CSS layout
  const rect = boardEl.getBoundingClientRect();
  const boardSize = Math.floor(rect.width);
  state.boardPixelSize = boardSize;

  const tileSize = (boardSize - gap * (n - 1)) / n;
  state.tileSize = tileSize;

  for (let i = 0; i < state.board.length; i++) {
    const tileVal = state.board[i];
    const tileEl = document.createElement('div');

    tileEl.id = `tile-${tileVal}`;
    tileEl.className = `tile ${tileVal === 0 ? 'empty' : ''}`;
    tileEl.style.width = `${tileSize}px`;
    tileEl.style.height = `${tileSize}px`;

    if (tileVal !== 0 && state.imageSrc) {
      const solvedIdx = state.solvedBoard.indexOf(tileVal);
      const sRow = Math.floor(solvedIdx / n);
      const sCol = solvedIdx % n;

      tileEl.style.backgroundImage = `url(${state.imageSrc})`;
      tileEl.style.backgroundRepeat = 'no-repeat';
      tileEl.style.backgroundSize = `${boardSize}px ${boardSize}px`;

      const bgX = -(sCol * (tileSize + gap));
      const bgY = -(sRow * (tileSize + gap));
      tileEl.style.backgroundPosition = `${bgX}px ${bgY}px`;

      tileEl.textContent = '';
    } else {
      tileEl.textContent = tileVal !== 0 ? tileVal : '';
    }

    boardEl.appendChild(tileEl);
  }

  updateTilePositions();
}

function updateTilePositions() {
  const n = state.n;
  const gap = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tile-gap')) || 2;
  const tileSize = state.tileSize;

  for (let i = 0; i < state.board.length; i++) {
    const tileVal = state.board[i];
    const tileEl = document.getElementById(`tile-${tileVal}`);
    if (!tileEl) continue;

    const row = Math.floor(i / n);
    const col = i % n;

    const x = col * (tileSize + gap);
    const y = row * (tileSize + gap);

    tileEl.style.transform = `translate(${x}px, ${y}px)`;
    tileEl.onclick = () => moveTile(i);
  }
}

function canMove(index) {
  const n = state.n;
  const emptyIdx = state.board.indexOf(0);

  const r1 = Math.floor(index / n);
  const c1 = index % n;
  const r2 = Math.floor(emptyIdx / n);
  const c2 = emptyIdx % n;

  return (Math.abs(r1 - r2) === 1 && c1 === c2) || (Math.abs(c1 - c2) === 1 && r1 === r2);
}

function moveTile(index) {
  if (!canMove(index)) return;

  if (!state.isPlaying) {
    state.isPlaying = true;
    state.timerInterval = setInterval(() => {
      state.timer++;
      document.getElementById('timeCount').textContent = state.timer + 's';
    }, 1000);
  }

  const emptyIdx = state.board.indexOf(0);

  state.board[emptyIdx] = state.board[index];
  state.board[index] = 0;

  state.moves++;
  document.getElementById('moveCount').textContent = state.moves;

  if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
    Telegram.WebApp.HapticFeedback.impactOccurred('light');
  }

  updateTilePositions();
  checkWin();
}

function checkWin() {
  const isWin = state.board.every((val, index) => val === state.solvedBoard[index]);
  if (!isWin) return;

  clearInterval(state.timerInterval);
  state.isPlaying = false;

  document.getElementById('winDifficulty').textContent = `${state.n}x${state.n}`;
  document.getElementById('winMoves').textContent = state.moves;
  document.getElementById('winTime').textContent = state.timer;

  if (window.Telegram && Telegram.WebApp) {
    Telegram.WebApp.MainButton.setText('SHARE SCORE');
    Telegram.WebApp.MainButton.offClick?.(); // safe if supported
    Telegram.WebApp.MainButton.onClick(() => {
      Telegram.WebApp.switchInlineQuery(
        `I solved Unscramble Me (${state.n}x${state.n}) in ${state.moves} moves and ${state.timer}s!`
      );
    });
  }

  setTimeout(() => {
    showModal('winModal');
    shootConfetti();
  }, 250);
}

function showPreview() {
  document.getElementById('fullPreviewOverlay').classList.remove('hidden');
}

function hidePreview() {
  document.getElementById('fullPreviewOverlay').classList.add('hidden');
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function shootConfetti() {
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'];
  for (let i = 0; i < 50; i++) {
    const conf = document.createElement('div');
    conf.style.position = 'fixed';
    conf.style.width = '10px';
    conf.style.height = '10px';
    conf.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    conf.style.left = '50%';
    conf.style.top = '50%';
    conf.style.zIndex = '9999';
    conf.style.transition = 'all 1s ease-out';
    conf.style.transform = `translate(-50%, -50%)`;
    document.body.appendChild(conf);

    setTimeout(() => {
      const angle = Math.random() * Math.PI * 2;
      const velocity = 100 + Math.random() * 200;
      const tx = Math.cos(angle) * velocity;
      const ty = Math.sin(angle) * velocity + 200;
      conf.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) rotate(${Math.random() * 360}deg)`;
      conf.style.opacity = '0';
    }, 10);

    setTimeout(() => conf.remove(), 1000);
  }
}

