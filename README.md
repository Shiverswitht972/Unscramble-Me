# Slide Puzzle — Telegram Mini App

A production-ready sliding tile puzzle built with vanilla HTML/CSS/JS.
Mobile-first, Telegram WebApp SDK integrated, robust image upload.

---

## Image Processing Pipeline

1. **File receipt** — `<input type="file" accept="image/*">` captures the user's photo; `FileReader.readAsDataURL()` converts it to a base64 string (no URL.revokeObjectURL needed, safer on iOS Telegram).
2. **Image load** — `new Image()` with `.src = dataURL`; for preset URLs we add `crossOrigin = "anonymous"` so `canvas.toDataURL()` doesn't throw a CORS security error.
3. **Square crop** — `cropSize = Math.min(naturalWidth, naturalHeight)` picks the largest square that fits; `offsetX = (w - cropSize) / 2` and `offsetY = (h - cropSize) / 2` center it.
4. **Normalize** — 9-arg `ctx.drawImage(img, offsetX, offsetY, cropSize, cropSize, 0, 0, 1000, 1000)` crops and scales in one GPU-accelerated call, producing a 1000×1000 canvas.
5. **Export** — `canvas.toDataURL('image/jpeg', 0.92)` exports as a ~150–300 KB JPEG, stored in `state.imageDataUrl`. Never regenerated on moves.
6. **Tile slicing** — Each tile div gets `background-image: url(dataUrl)`, `background-size: N*tileSize px`, and `background-position: -col*ts -row*ts` — no canvas per tile, just CSS math.
7. **Positioning** — Tiles live at `position: absolute; left:0; top:0` and are moved via `transform: translate(x, y)` — GPU-composited, no layout thrash, smooth 60 fps.
8. **Solvable shuffle** — Start from solved state `[1,2,…,N²-1,0]`, apply 400 valid random moves (each swaps a neighbor with the empty slot). Reverse-move prevention improves randomization. Solvability is guaranteed because every legal move is reversible.

---

## Hosting on Vercel

### Step 1 — Create the project

```
your-puzzle/
├── index.html
├── styles.css
└── script.js
```

### Step 2 — Deploy

**Option A — Vercel CLI**
```bash
npm i -g vercel
cd your-puzzle
vercel
```
Follow the prompts. When asked "What's your build command?" leave it blank.
When asked "Output directory?" leave it blank (Vercel auto-detects static HTML).

**Option B — GitHub + Vercel Dashboard**
1. Push your folder to a GitHub repo.
2. Go to [vercel.com](https://vercel.com) → **Add New Project**.
3. Import your GitHub repo.
4. Framework Preset: **Other** (no build step needed).
5. Click **Deploy**.

Vercel will give you a URL like `https://your-puzzle.vercel.app`.

---

## Connecting to BotFather

### Step 1 — Create a bot (if you don't have one)
1. Open Telegram and message **@BotFather**.
2. Send `/newbot`, follow prompts to name your bot and pick a username.
3. Copy the **HTTP API token** BotFather gives you (keep it secret).

### Step 2 — Enable Mini Apps
1. Send `/mybots` to BotFather.
2. Select your bot → **Bot Settings** → **Menu Button** → **Configure Menu Button**.
3. Enter your Vercel URL: `https://your-puzzle.vercel.app`
4. Enter a button label, e.g. `🧩 Play Puzzle`.

### Step 3 — Set as Mini App (Web App)
1. In BotFather: `/mybots` → your bot → **Bot Settings** → **Configure Mini App**.
2. **Enable Mini App**, paste your Vercel URL.
3. (Optional) Set a short name for the app.

### Step 4 — Test
1. Open your bot in Telegram.
2. Tap the **Menu Button** (bottom-left of the chat input).
3. The Mini App opens fullscreen inside Telegram. ✅

---

## Local Development

Since this is pure HTML with no build step, open it with a local server (not `file://`):

```bash
# Python 3
python3 -m http.server 3000

# Node (npx)
npx serve .

# VS Code: Live Server extension → right-click index.html → Open with Live Server
```

Open `http://localhost:3000` in your browser.

> **Note:** The Telegram SDK (`telegram-web-app.js`) is loaded from Telegram's CDN. Outside of Telegram, the `TG` object will be undefined — the app gracefully handles this and all game features still work.

---

## Controls

| Action | How |
|---|---|
| Move tile | Tap tile (or arrow keys on desktop) |
| Shuffle | Tap **Shuffle** button |
| Change image | Tap **Image** button → pick preset or upload |
| Restart (Telegram) | Main Button at bottom |
| Close modal (Telegram) | Back Button |

---

## File Structure

```
index.html   — App shell, all modals, overlay HTML
styles.css   — Dark theme, tile animations, bottom sheets
script.js    — Game logic, image pipeline, Telegram integration
```
