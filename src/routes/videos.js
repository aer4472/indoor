// src/routes/videos.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const db = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffprobeStatic = require('ffprobe-static');
const broadcast = require('../broadcast');

ffmpeg.setFfprobePath(ffprobeStatic.path);

// Usa ffmpeg-static (binário empacotado, funciona no Render) ou busca no sistema como fallback
(function setFfmpegBin() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) { ffmpeg.setFfmpegPath(ffmpegStatic); return; }
  } catch(_) {}
  const { execSync } = require('child_process');
  const candidates = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
  for (const p of candidates) {
    try { require('fs').accessSync(p); ffmpeg.setFfmpegPath(p); return; } catch(_) {}
  }
  try {
    const found = execSync('which ffmpeg 2>/dev/null').toString().trim();
    if (found) ffmpeg.setFfmpegPath(found);
  } catch(_) {}
})();

const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac', 'audio/x-m4a', 'audio/mp4'];
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_PDF_TYPES   = ['application/pdf'];

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../../storage/videos');
    await fs.mkdir(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allAllowed = [...ALLOWED_VIDEO_TYPES, ...ALLOWED_IMAGE_TYPES, ...ALLOWED_PDF_TYPES, ...ALLOWED_AUDIO_TYPES];
    if (allAllowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo não permitido. Use MP4, WebM, MOV, AVI, JPG, PNG, WebP, PDF ou MP3.'));
    }
  },
  limits: { fileSize: 500 * 1024 * 1024 }
});

function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err || !metadata) return resolve(null);
      const dur = metadata.format && metadata.format.duration;
      resolve(dur ? Math.round(dur) : null);
    });
  });
}

// Extrai o ID do YouTube de qualquer formato de URL
function extractYouTubeId(url) {
  const videoPatterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];

  // Extrai videoId
  let videoId = null;
  for (const p of videoPatterns) {
    const m = url.match(p);
    if (m) { videoId = m[1]; break; }
  }

  // Extrai listId (playlist)
  const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  const listId = listMatch ? listMatch[1] : null;

  if (videoId && listId) return { type: 'video_playlist', videoId, listId };
  if (listId && !videoId)  return { type: 'playlist', id: listId };
  if (videoId)              return { type: 'video', id: videoId };
  return null;
}

// Adicionar vídeo do YouTube (sem upload de arquivo)
router.post('/youtube', async (req, res, next) => {
  try {
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'URL obrigatória' });

    const extracted = extractYouTubeId(url.trim());
    if (!extracted) return res.status(400).json({ error: 'URL do YouTube inválida' });

    const id = `video-${uuidv4().substring(0, 8)}`;

    let filename, mimeType, typeLabel;
    if (extracted.type === 'video_playlist') {
      // Vídeo com playlist — salva "videoId|listId" no filename
      filename  = `${extracted.videoId}|${extracted.listId}`;
      mimeType  = 'youtube_playlist';
      typeLabel = 'YouTube+Playlist';
    } else if (extracted.type === 'playlist') {
      filename  = extracted.id;
      mimeType  = 'youtube_playlist';
      typeLabel = 'Playlist YT';
    } else {
      filename  = extracted.id;
      mimeType  = 'youtube';
      typeLabel = 'YouTube';
    }

    const displayName = name && name.trim() ? name.trim() : `${typeLabel}: ${filename}`;

    await db.run(
      `INSERT INTO videos (id, filename, original_name, size, mime_type, media_type)
       VALUES (?, ?, ?, 0, ?, 'youtube')`,
      [id, filename, displayName, mimeType]
    );

    const video = await db.get('SELECT * FROM videos WHERE id = ?', [id]);
    res.status(201).json(video);
  } catch (error) {
    next(error);
  }
});

// Criar card especial na playlist (relógio, clima, slide — sem arquivo)
router.post('/card', async (req, res, next) => {
  try {
    const { name, media_type, config = {}, display_duration = 15, rotation = 0 } = req.body;
    const VALID = ['clock_card','weather_card','weather_clock','slide'];
    if (!VALID.includes(media_type)) return res.status(400).json({ error: 'Tipo inválido. Use: ' + VALID.join(', ') });
    if (!name?.trim()) return res.status(400).json({ error: 'name obrigatório' });
    const rot = [0,90,180,270].includes(Number(rotation)) ? Number(rotation) : 0;

    const id = `video-${uuidv4().substring(0,8)}`;
    await db.run(
      `INSERT INTO videos (id, filename, original_name, display_duration, size, mime_type, media_type, config, rotation)
       VALUES (?, ?, ?, ?, 0, 'card', ?, ?, ?)`,
      [id, id, name.trim(), display_duration, media_type, JSON.stringify(config), rot]
    );
    const row = await db.get('SELECT * FROM videos WHERE id=?', [id]);
    broadcast.contentChanged(null, 'card-created');
    res.status(201).json({ ...row, config: JSON.parse(row.config || '{}') });
  } catch (e) { next(e); }
});

// Atualizar card (config, nome, duração, rotação)
router.put('/card/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, config, display_duration, rotation } = req.body;
    const cfg = config !== undefined ? (typeof config === 'string' ? config : JSON.stringify(config)) : null;
    const rot = rotation !== undefined ? ([0,90,180,270].includes(Number(rotation)) ? Number(rotation) : 0) : null;
    await db.run(
      `UPDATE videos SET
        original_name   = COALESCE(?,original_name),
        config          = COALESCE(?,config),
        display_duration= COALESCE(?,display_duration),
        rotation        = COALESCE(?,rotation)
       WHERE id=?`,
      [name ?? null, cfg, display_duration ?? null, rot, id]
    );
    const row = await db.get('SELECT * FROM videos WHERE id=?', [id]);
    broadcast.contentChanged(null, 'card-updated');
    res.json({ ...row, config: JSON.parse(row.config || '{}') });
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    const videos = await db.all('SELECT * FROM videos ORDER BY created_at DESC');
    res.json(videos.map(v => ({ ...v, config: JSON.parse(v.config || '{}') })));
  } catch (error) {
    next(error);
  }
});

router.post('/upload', upload.single('video'), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  }

  const filePath = req.file.path;

  try {
    const id = `video-${uuidv4().substring(0, 8)}`;
    const stats = await fs.stat(filePath);
    const isImage = ALLOWED_IMAGE_TYPES.includes(req.file.mimetype);
    const isPdf   = ALLOWED_PDF_TYPES.includes(req.file.mimetype);
    const isAudio = ALLOWED_AUDIO_TYPES.includes(req.file.mimetype);
    const mediaType = isPdf ? 'pdf' : isImage ? 'image' : isAudio ? 'audio' : 'video';

    // Duração: vídeos usam ffprobe, imagens/PDFs usam display_duration configurável (default 10s)
    let duration = null;
    const displayDuration = parseInt(req.body.display_duration) || 10;

    if (!isImage && !isPdf && !isAudio) {
      duration = await getVideoDuration(filePath);
    }

    await db.run(
      `INSERT INTO videos (id, filename, original_name, duration, display_duration, size, mime_type, media_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.file.filename, req.file.originalname, duration, displayDuration,
       stats.size, req.file.mimetype, mediaType]
    );

    const video = await db.get('SELECT * FROM videos WHERE id = ?', [id]);
    res.status(201).json(video);
  } catch (error) {
    // Rollback: remover arquivo se falhar no banco
    await fs.unlink(filePath).catch(() => {});
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { display_duration, original_name, rotation } = req.body;

    if (display_duration !== undefined) {
      await db.run('UPDATE videos SET display_duration = ? WHERE id = ?', [display_duration, id]);
    }
    if (original_name !== undefined) {
      await db.run('UPDATE videos SET original_name = ? WHERE id = ?', [original_name, id]);
    }
    if (rotation !== undefined) {
      const validRotations = [0, 90, 180, 270];
      const rot = validRotations.includes(Number(rotation)) ? Number(rotation) : 0;
      await db.run('UPDATE videos SET rotation = ? WHERE id = ?', [rot, id]);
      // Notificar TVs para recarregar playlist com nova rotação
      broadcast.contentChanged(null, 'video-rotation-changed');
    }

    const video = await db.get('SELECT * FROM videos WHERE id = ?', [id]);
    res.json(video);
  } catch (error) {
    next(error);
  }
});

// ── Re-encode com rotação ──────────────────────────────────────────────────
// Mapa de jobs em memória: jobId -> { status, progress, error }
const encodeJobs = {};

// GET progresso do job
router.get('/encode-job/:jobId', (req, res) => {
  const job = encodeJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  res.json(job);
});

// POST iniciar re-encode
router.post('/:id/encode-rotate', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rotation } = req.body;

    const validRotations = [90, 180, 270];
    const rot = Number(rotation);
    if (!validRotations.includes(rot)) {
      return res.status(400).json({ error: 'Rotação inválida. Use 90, 180 ou 270.' });
    }

    const video = await db.get('SELECT * FROM videos WHERE id = ?', [id]);
    if (!video) return res.status(404).json({ error: 'Vídeo não encontrado' });
    if (video.media_type !== 'video') {
      return res.status(400).json({ error: 'Re-encode disponível apenas para vídeos' });
    }

    const storageDir = path.join(__dirname, '../../storage/videos');
    const inputPath  = path.join(storageDir, video.filename);
    const ext        = path.extname(video.filename);
    const tmpName    = `tmp_${uuidv4()}${ext}`;
    const tmpPath    = path.join(storageDir, tmpName);

    const jobId = uuidv4().substring(0, 8);
    encodeJobs[jobId] = { status: 'running', progress: 0, error: null };

    // Responde imediatamente com o jobId
    res.json({ jobId });

    // Monta filtro FFmpeg
    let vfFilter;
    if (rot === 90)       vfFilter = 'transpose=1';
    else if (rot === 270) vfFilter = 'transpose=2';
    else                  vfFilter = 'hflip,vflip'; // 180°

    ffmpeg(inputPath)
      .videoFilters(vfFilter)
      .audioCodec('copy')         // mantém áudio sem re-encode
      .videoCodec('libx264')
      .outputOptions(['-preset fast', '-crf 23', '-movflags +faststart'])
      .output(tmpPath)
      .on('progress', (p) => {
        encodeJobs[jobId].progress = Math.round(p.percent || 0);
      })
      .on('end', async () => {
        try {
          // Substitui o arquivo original
          await fs.unlink(inputPath);
          await fs.rename(tmpPath, inputPath);
          // Zera a rotação no banco (já está correta no arquivo)
          await db.run('UPDATE videos SET rotation = 0 WHERE id = ?', [id]);
          encodeJobs[jobId].status   = 'done';
          encodeJobs[jobId].progress = 100;
          broadcast.contentChanged(null, 'video-reencoded');
          // Limpa job após 5 min
          setTimeout(() => delete encodeJobs[jobId], 300000);
        } catch (e) {
          encodeJobs[jobId].status = 'error';
          encodeJobs[jobId].error  = e.message;
        }
      })
      .on('error', async (e) => {
        await fs.unlink(tmpPath).catch(() => {});
        encodeJobs[jobId].status = 'error';
        encodeJobs[jobId].error  = e.message;
        setTimeout(() => delete encodeJobs[jobId], 300000);
      })
      .run();

  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const video = await db.get('SELECT filename FROM videos WHERE id = ?', [id]);

    if (video) {
      const filePath = path.join(__dirname, '../../storage/videos', video.filename);
      await fs.unlink(filePath).catch(() => {});
      await db.run('DELETE FROM videos WHERE id = ?', [id]);
    }

    // Notificar TVs: um vídeo foi removido de playlists
    broadcast.contentChanged(null, 'video-deleted');
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

module.exports.setIO = (io) => broadcast.setIO(io);
