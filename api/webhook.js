/**
 * api/webhook.js
 * Vercel Serverless Function — Telegram Bot Webhook
 *
 * Telegram POSTs every update to this endpoint.
 * We respond to /start (and any message) with an inline
 * "Open Game 🧩" button that launches the Mini App fullscreen.
 *
 * Deploy checklist:
 *   1. Set TELEGRAM_BOT_TOKEN in Vercel Environment Variables
 *   2. Set TELEGRAM_GAME_URL  in Vercel Environment Variables  ← your game's Vercel URL
 *   3. Register the webhook once (see README)
 */

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const GAME_URL = process.env.TELEGRAM_GAME_URL;

// ---------------------------------------------------------------------------
// Telegram API helper — fire-and-forget POST to Bot API
// ---------------------------------------------------------------------------
async function callTelegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  // Log errors in Vercel function logs but never throw — always return 200 to Telegram
  if (!res.ok) {
    const text = await res.text();
    console.error(`[callTelegram] ${method} failed:`, text);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Build the reply that includes the WebApp launch button
// ---------------------------------------------------------------------------
function buildGameReply(chatId, isStart) {
  const intro = isStart
    ? `👋 *Hey there!*\n\nWelcome to *Unscramble Me* — rearrange the tiles to restore the image.\n\nTap the button below to launch the game 👇`
    : `🧩 Tap below to open the puzzle!`;

  return {
    chat_id:    chatId,
    text:       intro,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        {
          text:    '🧩 Open Game',
          // web_app type opens the URL as a Telegram Mini App (fullscreen, with SDK)
          web_app: { url: GAME_URL },
        },
      ]],
    },
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // Telegram only sends POST; reject anything else
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Guard: env vars must be set
  if (!TOKEN || !GAME_URL) {
    console.error('[webhook] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_GAME_URL env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  try {
    const update = req.body; // Vercel auto-parses JSON

    // ---- Handle message updates ----
    const msg = update?.message;
    if (msg) {
      const chatId  = msg.chat.id;
      const text    = msg.text?.trim() ?? '';
      const isStart = text === '/start' || text.startsWith('/start ');

      // Respond to /start OR any other text message with the game button
      await callTelegram('sendMessage', buildGameReply(chatId, isStart));
    }

    // ---- Handle inline button callbacks (future-proof) ----
    const cbq = update?.callback_query;
    if (cbq) {
      // Just acknowledge — no action needed for web_app buttons
      await callTelegram('answerCallbackQuery', { callback_query_id: cbq.id });
    }

    // Always return 200 quickly — Telegram will retry if we don't
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[webhook] Unhandled error:', err);
    // Still return 200 so Telegram doesn't flood us with retries
    return res.status(200).json({ ok: true });
  }
}
