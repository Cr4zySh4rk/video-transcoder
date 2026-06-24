'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const OUTPUT_DIR = process.env.OUTPUTS_DIR || path.join(__dirname, 'outputs');
const IS_ELECTRON = !!process.env.ELECTRON_RUN;

// ── Use bundled FFmpeg/FFprobe ─────────────────────────────────────────────
function resolveBin(envVar, staticPkg, fallback) {
  if (process.env[envVar]) return process.env[envVar];
  try { return require(staticPkg).path || require(staticPkg); } catch {}
  return fallback;
}
const FFMPEG_BIN  = resolveBin('FFMPEG_PATH',  'ffmpeg-static',  'ffmpeg');
const FFPROBE_BIN = resolveBin('FFPROBE_PATH', 'ffprobe-static', 'ffprobe');

[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, 'docs');
app.use(express.static(DOCS_DIR));

// ── Upload ────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 * 1024 } });

// ── Active jobs ────────────────────────────────────────────────────────────
const jobs = new Map();

// ── Hardware + codec detection ─────────────────────────────────────────────
// Includes H.264, H.265/HEVC hardware encoders and available software codecs.
// Inspired by brarcher/video-transcoder codec matrix and lisamelton/video_transcoding
// hardware mode detection.
app.get('/api/detect-hw', (req, res) => {
  exec(`"${FFMPEG_BIN}" -encoders 2>&1`, (err, stdout) => {
    if (err && !stdout) return res.json({ error: 'FFmpeg not found', encoders: [], softwareCodecs: [] });

    const hwChecks = [
      // H.264 GPU encoders
      { id: 'h264_nvenc',        label: 'NVIDIA H.264 NVENC',       family: 'h264', platform: 'nvidia' },
      { id: 'h264_amf',          label: 'AMD H.264 AMF',            family: 'h264', platform: 'amd'   },
      { id: 'h264_qsv',          label: 'Intel H.264 Quick Sync',   family: 'h264', platform: 'intel' },
      { id: 'h264_videotoolbox', label: 'Apple H.264 VideoToolbox', family: 'h264', platform: 'apple' },
      { id: 'h264_v4l2m2m',      label: 'V4L2 H.264 (ARM/SBC)',     family: 'h264', platform: 'arm'   },
      // H.265 / HEVC GPU encoders
      { id: 'hevc_nvenc',        label: 'NVIDIA H.265 NVENC',       family: 'hevc', platform: 'nvidia' },
      { id: 'hevc_amf',          label: 'AMD H.265 AMF',            family: 'hevc', platform: 'amd'   },
      { id: 'hevc_qsv',          label: 'Intel H.265 Quick Sync',   family: 'hevc', platform: 'intel' },
      { id: 'hevc_videotoolbox', label: 'Apple H.265 VideoToolbox', family: 'hevc', platform: 'apple' },
      { id: 'hevc_v4l2m2m',      label: 'V4L2 H.265 (ARM/SBC)',     family: 'hevc', platform: 'arm'   },
    ];

    const available = hwChecks.filter(e => stdout.includes(e.id));

    // Software codecs beyond libx264 (always available in our bundled ffmpeg)
    const swChecks = ['libx265', 'libvpx-vp9', 'libvpx', 'libaom-av1', 'libsvtav1', 'libmp3lame', 'libopus'];
    const softwareCodecs = swChecks.filter(c => stdout.includes(c));

    res.json({ encoders: available, softwareCodecs });
  });
});

// ── Probe (post-upload) ────────────────────────────────────────────────────
app.get('/api/probe/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  exec(
    `"${FFPROBE_BIN}" -v quiet -print_format json -show_streams -show_format "${job.inputPath}"`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: 'Probe failed' });
      try { res.json(JSON.parse(stdout)); } catch { res.status(500).json({ error: 'Parse failed' }); }
    }
  );
});

// ── Probe-partial (pre-upload, 2 MB slice) ─────────────────────────────────
app.post('/api/probe-partial', (req, res) => {
  const os  = require('os');
  const ext = (req.query.ext || '.mkv').replace(/[^.\w]/g, '');
  const tmp = path.join(os.tmpdir(), `vf-probe-${uuidv4()}${ext}`);
  const out = fs.createWriteStream(tmp);
  const MAX = 4 * 1024 * 1024;
  let bytes = 0;

  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes <= MAX) out.write(chunk);
    else if (!out.destroyed) out.end();
  });
  req.on('end',   () => { if (!out.destroyed) out.end(); });
  req.on('error', () => { out.destroy(); fs.unlink(tmp, () => {}); });

  out.on('finish', () => {
    exec(
      `"${FFPROBE_BIN}" -v quiet -print_format json -show_streams -show_format "${tmp}"`,
      (err, stdout) => {
        fs.unlink(tmp, () => {});
        if (!stdout || !stdout.trim()) return res.status(500).json({ error: 'ffprobe returned no output' });
        try { res.json(JSON.parse(stdout)); }
        catch { res.status(500).json({ error: 'Parse failed' }); }
      }
    );
  });
});

// ── Upload ────────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const jobId = uuidv4();
  jobs.set(jobId, {
    inputPath:    req.file.path,
    outputPath:   null,
    process:      null,
    status:       'uploaded',
    originalName: req.file.originalname
  });
  res.json({ jobId, filename: req.file.originalname, size: req.file.size });
});

// ── Audio filter builder ───────────────────────────────────────────────────
function buildAudioFilter({ dialogueBoost = 0, backgroundLevel = 0, speechEnhance = false, normalize = false }) {
  const f = [];
  f.push('highpass=f=60');
  if (dialogueBoost !== 0) {
    f.push(`equalizer=f=700:width_type=o:width=2.5:g=${(dialogueBoost * 0.6).toFixed(1)}`);
    f.push(`equalizer=f=2500:width_type=o:width=2.5:g=${(dialogueBoost * 0.8).toFixed(1)}`);
  }
  if (backgroundLevel < 0) {
    f.push(`equalizer=f=100:width_type=o:width=2:g=${backgroundLevel.toFixed(1)}`);
    f.push(`equalizer=f=8000:width_type=o:width=3:g=${(backgroundLevel * 0.7).toFixed(1)}`);
    f.push(`equalizer=f=14000:width_type=o:width=3:g=${backgroundLevel.toFixed(1)}`);
  }
  if (speechEnhance) {
    f.push('acompressor=threshold=0.089:ratio=3:attack=200:release=800:makeup=2');
    f.push('equalizer=f=3500:width_type=o:width=1.5:g=2');
  }
  if (normalize) {
    f.push('dynaudnorm=f=500:g=31:p=0.95:m=10');
  }
  return f.join(',');
}

// ── Container → extension map ──────────────────────────────────────────────
const CONTAINER_EXT = {
  mp4: '.mp4', mkv: '.mkv', webm: '.webm', mov: '.mov', avi: '.avi'
};

// ── Resolution → lisamelton-style auto bitrate ─────────────────────────────
// Two-pass CBR targets: 1080p+ → 5000 kbps, 720p → 2500, SD → 1250
function autoBitrate(resolution) {
  if (resolution === '2160p')              return 8000;
  if (resolution === '1080p')              return 5000;
  if (resolution === '720p')               return 2500;
  if (resolution === '480p')               return 1250;
  if (resolution === '360p')               return 800;
  return 5000; // source / unknown — conservative 1080p default
}

// ── FFmpeg args builder ────────────────────────────────────────────────────
// Derived from studying brarcher/video-transcoder (codec-container matrix,
// bitrate flags), lisamelton/video_transcoding (two-pass CBR for H.264,
// CRF for HEVC/AV1, resolution-based auto bitrate), and HandBrake's encoder
// presets and quality ratecontrol logic.
function buildTranscodeArgs(opts, passNumber = 0) {
  const {
    inputPath, outputPath,
    encoder       = 'libx264',
    container     = 'mp4',
    audioCodec    = 'aac',
    preset        = 'medium',
    crf           = 23,
    encodingMode  = 'crf',      // 'crf' | 'bitrate' | 'two-pass'
    videoBitrate  = 'auto',     // 'auto' or kbps number
    audioBitrate  = '192k',
    resolution    = 'source',
    fps           = 'source',
    startTime     = null,
    endTime       = null,
    audioStreamIndex = 0,
    subtitleIndex = -1,         // -1 = none, 0+ = subtitle stream index
    dialogueBoost = 0, backgroundLevel = 0, speechEnhance = false, normalize = false,
  } = opts;

  const args = ['-y'];

  // Fast seek: place -ss BEFORE -i for accurate keyframe seeking
  if (startTime && parseFloat(startTime) > 0) args.push('-ss', String(startTime));
  args.push('-i', inputPath);

  // Duration / end time
  if (endTime && parseFloat(endTime) > 0) {
    const dur = startTime ? parseFloat(endTime) - parseFloat(startTime) : parseFloat(endTime);
    if (dur > 0) args.push('-t', String(dur.toFixed(3)));
  }

  // Stream mapping: explicit map required when selecting non-default audio/subtitle
  const needsMap = audioStreamIndex > 0 || subtitleIndex >= 0;
  if (needsMap) {
    args.push('-map', '0:v:0');
    args.push('-map', `0:a:${audioStreamIndex}`);
    if (subtitleIndex >= 0) args.push('-map', `0:s:${subtitleIndex}`);
  }

  // ── Video codec + quality ratecontrol ─────────────────────────────────
  args.push('-c:v', encoder);

  const bps = (videoBitrate === 'auto' ? autoBitrate(resolution) : parseInt(videoBitrate));
  const vbv = bps * 3; // lisamelton: bufsize = bitrate × 3

  if (encodingMode === 'crf') {
    // Constant-quality ratecontrol (CRF)
    switch (encoder) {
      case 'libx264':
      case 'libx265':
        args.push('-preset', preset, '-crf', String(crf));
        break;
      case 'libvpx-vp9':
      case 'libvpx':
        args.push('-crf', String(crf), '-b:v', '0', '-deadline', 'good');
        break;
      case 'libaom-av1':
        args.push('-crf', String(crf), '-b:v', '0', '-cpu-used', '4');
        break;
      case 'libsvtav1':
        args.push('-preset', '6', '-crf', String(crf));
        break;
      case 'h264_nvenc': case 'hevc_nvenc':
        args.push('-preset', 'p4', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0');
        break;
      case 'h264_qsv': case 'hevc_qsv':
        args.push('-preset', preset, '-global_quality', String(crf));
        break;
      case 'h264_amf': case 'hevc_amf':
        args.push('-quality', 'quality', '-qp_i', String(crf), '-qp_p', String(crf));
        break;
      case 'h264_videotoolbox': case 'hevc_videotoolbox':
        args.push('-q:v', String(Math.floor(crf * 2)));
        break;
      default:
        args.push('-crf', String(crf));
    }
  } else if (encodingMode === 'bitrate' || encodingMode === 'two-pass') {
    // Bitrate / two-pass ratecontrol (lisamelton-style)
    if (encodingMode === 'two-pass' && passNumber === 1) {
      // First pass: analysis only, no audio
      args.push('-b:v', `${bps}k`, '-pass', '1');
      if (['libx264', 'libx265'].includes(encoder)) {
        args.push('-preset', preset, '-maxrate', `${bps}k`, '-bufsize', `${vbv}k`);
      }
      args.push('-an'); // no audio first pass
      args.push('-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null');
      return args;
    } else {
      args.push('-b:v', `${bps}k`);
      if (encodingMode === 'two-pass') args.push('-pass', '2');
      if (['libx264', 'libx265'].includes(encoder)) {
        args.push('-preset', preset, '-maxrate', `${bps}k`, '-bufsize', `${vbv}k`);
      }
    }
  }

  // Pixel format: broad device compatibility
  if (!['libvpx-vp9', 'libvpx', 'libaom-av1', 'libsvtav1'].includes(encoder)) {
    args.push('-pix_fmt', 'yuv420p');
  }

  // Resolution scaling
  if (resolution !== 'source') {
    const scaleMap = {
      '2160p': '3840:2160', '1080p': '1920:1080',
      '720p':  '1280:720',  '480p':  '854:480',  '360p': '640:360'
    };
    const s = scaleMap[resolution];
    if (s) {
      args.push('-vf', [
        `scale=${s}:force_original_aspect_ratio=decrease`,
        `pad=${s}:(ow-iw)/2:(oh-ih)/2`
      ].join(','));
    }
  }

  // Frame rate
  if (fps && fps !== 'source') args.push('-r', String(fps));

  // ── Audio ─────────────────────────────────────────────────────────────
  if (audioCodec === 'copy') {
    args.push('-c:a', 'copy');
  } else if (audioCodec === 'none') {
    args.push('-an');
  } else {
    args.push('-c:a', audioCodec, '-b:a', audioBitrate);
    const af = buildAudioFilter({ dialogueBoost, backgroundLevel, speechEnhance, normalize });
    if (af) args.push('-af', af);
  }

  // ── Subtitle passthrough ───────────────────────────────────────────────
  if (subtitleIndex >= 0) {
    args.push('-c:s', 'copy');
  }

  // ── Container flags ────────────────────────────────────────────────────
  if (container === 'mp4' || container === 'mov') {
    args.push('-movflags', '+faststart');
  }

  args.push(outputPath);
  return args;
}

// ── Spawn FFmpeg, emit progress/stats on socket room ─────────────────────
function runFFmpeg(args, jobId, onClose) {
  const proc = spawn(FFMPEG_BIN, args);
  let duration = 0;

  proc.stderr.on('data', chunk => {
    const line = chunk.toString();

    const dm = line.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (dm) duration = parseInt(dm[1]) * 3600 + parseInt(dm[2]) * 60 + parseFloat(dm[3]);

    const tm = line.match(/time=\s*(\d+):(\d+):(\d+\.\d+)/);
    if (tm && duration > 0) {
      const cur = parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseFloat(tm[3]);
      const pct = Math.min(99, Math.round((cur / duration) * 100));
      io.to(jobId).emit('progress', { jobId, percent: pct, time: cur, duration });
    }

    const sm = line.match(/speed=\s*([\d.]+)x/);
    const fm = line.match(/fps=\s*([\d.]+)/);
    if (sm || fm) {
      io.to(jobId).emit('stats', {
        speed: sm ? parseFloat(sm[1]) : null,
        fps:   fm ? parseFloat(fm[1]) : null
      });
    }
  });

  proc.on('close', code => onClose(code, proc));
  return proc;
}

// ── Safe output filename ───────────────────────────────────────────────────
function makeOutputPath(originalName, encoder, container, outputDir) {
  const base = path.basename(originalName, path.extname(originalName))
    .replace(/[^\w\-. ]/g, '_').slice(0, 60);
  const ext  = CONTAINER_EXT[container] || '.mp4';
  // Add short UUID segment to avoid collisions if same file transcoded twice
  const uid  = uuidv4().slice(0, 8);
  return path.join(outputDir, `${base}_${encoder.replace(/_/g,'-')}_${uid}${ext}`);
}

// ── Single transcode ───────────────────────────────────────────────────────
app.post('/api/transcode', (req, res) => {
  const {
    jobId,
    encoder       = 'libx264',
    container     = 'mp4',
    audioCodec    = 'aac',
    preset        = 'medium',
    crf           = 23,
    encodingMode  = 'crf',
    videoBitrate  = 'auto',
    audioBitrate  = '192k',
    resolution    = 'source',
    fps           = 'source',
    startTime     = null,
    endTime       = null,
    audioStreamIndex = 0,
    subtitleIndex = -1,
    dialogueBoost = 0, backgroundLevel = 0, speechEnhance = false, normalize = false,
    outputDir: clientOutputDir = null,
    sourcePath: clientSourcePath = null,  // original file path (Electron only)
  } = req.body;

  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'running') return res.status(409).json({ error: 'Already running' });

  // Resolve output directory:
  // 1. Electron: use clientOutputDir if provided
  // 2. Electron: fall back to directory of source file
  // 3. Otherwise: default OUTPUT_DIR
  let outDir = OUTPUT_DIR;
  if (IS_ELECTRON) {
    if (clientOutputDir) {
      outDir = clientOutputDir;
    } else if (clientSourcePath) {
      outDir = path.dirname(clientSourcePath);
    }
  }
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

  const transcodeOpts = {
    inputPath: job.inputPath,
    encoder, container, audioCodec, preset, crf: Number(crf),
    encodingMode, videoBitrate, audioBitrate, resolution, fps,
    startTime, endTime,
    audioStreamIndex: Number(audioStreamIndex),
    subtitleIndex: Number(subtitleIndex),
    dialogueBoost: Number(dialogueBoost), backgroundLevel: Number(backgroundLevel),
    speechEnhance: !!speechEnhance, normalize: !!normalize,
  };

  const outputPath = makeOutputPath(job.originalName, encoder, container, outDir);
  transcodeOpts.outputPath = outputPath;
  job.outputPath = outputPath;
  job.status = 'running';

  res.json({ jobId, status: 'running' });

  if (encodingMode === 'two-pass') {
    // Pass 1 → pass 2 sequentially
    const pass1 = buildTranscodeArgs(transcodeOpts, 1);
    console.log('[transcode] two-pass 1:', pass1.join(' '));

    const proc1 = runFFmpeg(pass1, jobId, (code1) => {
      if (code1 !== 0) {
        job.status = 'error';
        return io.to(jobId).emit('error', { jobId, message: `FFmpeg pass 1 failed (code ${code1})` });
      }
      io.to(jobId).emit('stats', { speed: null, fps: null, phase: 'pass2' });
      const pass2 = buildTranscodeArgs(transcodeOpts, 2);
      console.log('[transcode] two-pass 2:', pass2.join(' '));
      const proc2 = runFFmpeg(pass2, jobId, (code2) => {
        if (code2 === 0) {
          job.status = 'done';
          io.to(jobId).emit('progress', { jobId, percent: 100 });
          io.to(jobId).emit('done', { jobId, downloadUrl: `/api/download/${path.basename(outputPath)}` });
        } else {
          job.status = 'error';
          io.to(jobId).emit('error', { jobId, message: `FFmpeg pass 2 failed (code ${code2})` });
        }
      });
      job.process = proc2;
    });
    job.process = proc1;

  } else {
    const args = buildTranscodeArgs(transcodeOpts);
    console.log('[transcode]', args.join(' '));
    const proc = runFFmpeg(args, jobId, code => {
      if (code === 0) {
        job.status = 'done';
        io.to(jobId).emit('progress', { jobId, percent: 100 });
        io.to(jobId).emit('done', { jobId, downloadUrl: `/api/download/${path.basename(outputPath)}` });
      } else {
        job.status = 'error';
        io.to(jobId).emit('error', { jobId, message: `FFmpeg exited with code ${code}` });
      }
    });
    job.process = proc;
  }
});

// ── Download ──────────────────────────────────────────────────────────────
app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

// ── Cancel single job ─────────────────────────────────────────────────────
app.post('/api/cancel/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.process) { job.process.kill('SIGKILL'); job.process = null; }
  job.status = 'cancelled';
  res.json({ jobId: req.params.jobId, status: 'cancelled' });
});

// ── Batch upload ──────────────────────────────────────────────────────────
const batchUpload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 * 1024 } });
app.post('/api/batch-upload', batchUpload.array('videos'), (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'No files uploaded' });
  const batchId = uuidv4();
  const items = req.files.map(file => {
    const jobId = uuidv4();
    jobs.set(jobId, {
      inputPath:    file.path,
      outputPath:   null,
      process:      null,
      status:       'uploaded',
      originalName: file.originalname,
      batchId,
    });
    return { jobId, filename: file.originalname };
  });
  res.json({ batchId, items });
});

// ── Batch transcode ───────────────────────────────────────────────────────
app.post('/api/batch-transcode', express.json(), async (req, res) => {
  const { batchId, jobIds, transcodeOpts = {} } = req.body || {};
  if (!batchId || !Array.isArray(jobIds) || jobIds.length === 0)
    return res.status(400).json({ error: 'batchId and jobIds required' });

  res.json({ batchId, status: 'started', total: jobIds.length });

  // Process sequentially — emit socket events to the batch room
  let completed = 0;
  for (let i = 0; i < jobIds.length; i++) {
    const jobId = jobIds[i];
    const job   = jobs.get(jobId);
    if (!job) { io.to(batchId).emit('batch:file-error', { index: i }); continue; }

    io.to(batchId).emit('batch:file-start', { index: i, jobId });

    const outDir  = OUTPUT_DIR;
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

    const opts = {
      ...transcodeOpts,
      inputPath:  job.inputPath,
      outputPath: makeOutputPath(job.originalName, transcodeOpts.encoder || 'libx264', transcodeOpts.container || 'mp4', outDir),
    };
    job.outputPath = opts.outputPath;
    job.status     = 'running';

    await new Promise(resolve => {
      const args = buildTranscodeArgs(opts);
      const proc = runFFmpeg(args, jobId, code => {
        if (code === 0) {
          job.status = 'done';
          completed++;
          const dlUrl = `/api/download/${path.basename(opts.outputPath)}`;
          io.to(batchId).emit('batch:file-done', { index: i, downloadUrl: dlUrl });
          io.to(batchId).emit('batch:progress',  { index: i, percent: 100 });
        } else {
          job.status = 'error';
          io.to(batchId).emit('batch:file-error', { index: i });
        }
        resolve();
      });
      job.process = proc;
    });
  }

  io.to(batchId).emit('batch:done', { batchId, total: completed });
});

// ── Socket.io rooms ───────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join', roomId => {
    if (roomId) socket.join(roomId);
  });
});

// ── Start server ──────────────────────────────────────────────────────────
const portReady = new Promise((resolve, reject) => {
  function tryListen(port) {
    server.listen(port, '0.0.0.0')
      .on('listening', () => {
        console.log(`[server] listening on http://localhost:${port}`);
        resolve(port);
      })
      .on('error', err => {
        if (err.code === 'EADDRINUSE' && port < (parseInt(process.env.PORT || '3000') + 10)) {
          console.warn(`[server] port ${port} in use, trying ${port + 1}`);
          tryListen(port + 1);
        } else {
          reject(err);
        }
      });
  }
  tryListen(parseInt(process.env.PORT || '3000', 10));
});

module.exports = { portReady };
