// Optional outbound notification when someone submits a payment.
// Set SM_NOTIFY_WEBHOOK_URL in .env to any endpoint that accepts a JSON POST
// (Slack/Discord incoming webhook, n8n/Zapier hook, a WhatsApp gateway, ...).
// The Super Manager portal also polls for new requests, so this is a bonus
// channel for when nobody has the portal open.
async function notifySuperManagers(text, payload = {}) {
  const url = process.env.SM_NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` for Slack/Mattermost, `content` for Discord.
      body: JSON.stringify({ text, content: text, ...payload }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.warn('[notify] webhook failed:', err.message);
  }
}

module.exports = { notifySuperManagers };
