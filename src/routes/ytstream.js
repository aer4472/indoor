const express = require('express');
const router  = express.Router();
const { exec, spawn } = require('child_process');

const plCache = new Map();
const PL_TTL  = 6 * 60 * 60 * 1000;

// ── GET /api/ytstream/check ───────────────────────────────────────
router.get('/check', (req, res) => {
  exec('yt-dlp --version', (err, stdout) => {
    res.json({ ok: !err, version: stdout?.trim() || null, error: err ? 'yt-dlp não encontrado. Instale com: pip install yt-dlp' : null });
  });
});

// ── GET /api/ytstream/video/:videoId ─────────────────────────────
// Faz proxy do vídeo: yt-dlp baixa e o servidor repassa como stream mp4
router.get('/video/:videoId', (req, res) => {
  const { videoId } = req.params;

  // Formato: mp4 progressivo (vídeo+áudio combinados) até 720p
  // NÃO usar bestvideo+bestaudio (DASH) — browser não consegue combinar
  const fmt = '(mp4)[height<=720][vcodec^=avc][acodec!=none]/(mp4)[height<=480][vcodec^=avc][acodec!=none]/best[ext=mp4][acodec!=none]/best[acodec!=none]';

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // evita buffer no nginx

  const args = [
    '-f', fmt,
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '-o', '-',
    '--no-part',
    '--no-mtime',
    '--quiet',
    '--no-warnings',
    `https://www.youtube.com/watch?v=${videoId}`
  ];

  console.log(`[ytstream] iniciando stream: ${videoId}`);
  const proc = spawn('yt-dlp', args, { shell: true });

  let started = false;

  proc.stdout.on('data', (chunk) => {
    if (!started) { started = true; console.log(`[ytstream] stream iniciado: ${videoId}`); }
    if (!res.writableEnded) res.write(chunk);
  });

  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[ytstream] stderr: ${msg}`);
  });

  proc.on('error', (err) => {
    console.error('[ytstream] erro spawn:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'yt-dlp não instalado ou erro: ' + err.message });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  proc.on('close', (code) => {
    console.log(`[ytstream] processo encerrado (code=${code}): ${videoId}`);
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    console.log(`[ytstream] cliente desconectou: ${videoId}`);
    proc.kill('SIGTERM');
  });
});

// ── GET /api/ytstream/playlist/:listId ───────────────────────────
router.get('/playlist/:listId', (req, res) => {
  const { listId } = req.params;

  const hit = plCache.get(listId);
  if (hit && Date.now() - hit.ts < PL_TTL) {
    return res.json({ ok: true, ids: hit.ids });
  }

  exec(
    `yt-dlp --flat-playlist --print id "https://www.youtube.com/playlist?list=${listId}"`,
    { timeout: 60000, shell: true },
    (err, stdout, stderr) => {
      if (err) {
        console.error('[ytstream playlist]', stderr || err.message);
        return res.status(500).json({ ok: false, error: stderr?.split('\n')[0] || err.message });
      }
      const ids = stdout.trim().split('\n').filter(Boolean);
      if (!ids.length) return res.status(404).json({ ok: false, error: 'Playlist vazia' });
      plCache.set(listId, { ids, ts: Date.now() });
      console.log(`[ytstream] playlist ${listId}: ${ids.length} vídeos`);
      res.json({ ok: true, ids });
    }
  );
});

module.exports = router;
