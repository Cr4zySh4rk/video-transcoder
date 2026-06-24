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

// ── Use bundled FFmpeg if Electron set the path ────────────────────────────
const FFMPEG_BIN  = process.env.FFMPEG_PATH  || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── CORS middleware (allow GitHub Pages frontend) ──────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'docs')));

// ── File upload ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 * 1024 } // 50 GB
});

// ── Active jobs ────────────────────────────────────────────────────────────
const jobs = new Map(); // jobId → { process, inputPath, outputPath, status }

// ── Hardware encoder detection ─────────────────────────────────────────────
app.get('/api/detect-hw', (req, res) => {
  exec(`"${FFMPEG_BIN}" -encoders 2>&1`, (err, stdout) => {
    if (err && !stdout) return res.json({ error: 'FFmpeg not found', encoders: [] });

    const available = [];
    const checks = [
      { id: 'h264_nvenc',        label: 'NVIDIA NVENC (GPU)',       platform: 'nvidia' },
      { id: 'h264_amf',          label: 'AMD AMF (GPU)',            platform: 'amd'    },
      { id: 'h264_qsv',          label: 'Intel Quick Sync (GPU)',   platform: 'intel'  },
      { id: 'h264_videotoolbox', label: 'Apple VideoToolbox (GPU)', platform: 'apple'  },
      { id: 'h264_v4l2m2m',      label: 'V4L2 M2M (ARM/SBC)',      platform: 'arm'    },
    ];

    checks.forEach(enc => {
      if (stdout.includes(enc.id)) available.push(enc);
    });

    res.json({ encoders: available });
  });
});

// ── Probe input file ───────────────────────────────────────────────────────
app.get('/api/probe/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  exec(
    `"${FFPROBE_BIN}" -v quiet -print_format json -show_streams -show_format "${job.inputPath}"`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: 'Probe failed' });
      try {
        res.json(JSON.parse(stdout));
      } catch {
        res.status(500).json({ error: 'Parse failed' });
      }
    }
  );
});

// ── Upload endpoint ────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const jobId = uuidv4();
  jobs.set(jobId, {
    inputPath: req.file.path,
    outputPath: null,
    process: null,
    status: 'uploaded',
    originalName: req.file.originalname
  });

  res.json({ jobId, filename: req.file.originalname, size: req.file.size });
});

// ── Audio filter builder ───────────────────────────────────────────────────
function buildAudioFilter(opts) {
  const {
    dialogueBoost    = 0,   // –12 to +12 dB  — boosts speech-band EQ
    backgroundLevel  = 0,   // –24 to  0 dB  — attenuates non-speech bands
    speechEnhance    = false,
    normalize        = false,
    audioStream      = 0    // which audio stream index to use
  } = opts;

  const filters = [];

  // Remove sub-bass rumble
  filters.push('highpass=f=60');

  // Dialogue frequency boost (300 Hz – 4 kHz speech intelligibility band)
  if (dialogueBoost !== 0) {
    filters.push(`equalizer=f=700:width_type=o:width=2.5:g=${(dialogueBoost * 0.6).toFixed(1)}`);
    filters.push(`equalizer=f=2500:width_type=o:width=2.5:g=${(dialogueBoost * 0.8).toFixed(1)}`);
  }

  // Background / music attenuation (bass & air bands outside speech zone)
  if (backgroundLevel < 0) {
    const g = backgroundLevel.toFixed(1);
    filters.push(`equalizer=f=100:width_type=o:width=2:g=${g}`);
    filters.push(`equalizer=f=8000:width_type=o:width=3:g=${(backgroundLevel * 0.7).toFixed(1)}`);
    filters.push(`equalizer=f=14000:width_type=o:width=3:g=${g}`);
  }

  // Speech enhancement — gentle multi-band compression + clarity boost
  if (speechEnhance) {
    filters.push('acompressor=threshold=0.089:ratio=3:attack=200:release=800:makeup=2');
    filters.push('equalizer=f=3500:width_type=o:width=1.5:g=2');
  }

  // Loudness normalisation (EBU R128)
  if (normalize) {
    filters.push('dynaudnorm=f=500:g=31:p=0.95:m=10');
  }

  return filters.join(',');
}

// ── Transcode endpoint ────────────────────────────────────────────────────
app.post('/api/transcode', (req, res) => {
  const {
    jobId,
    encoder      = 'libx264',
    preset       = 'medium',
    crf          = 23,
    resolution   = 'source',
    audioBitrate = '192k',
    // audio mixing
    dialogueBoost   = 0,
    backgroundLevel = 0,
    speechEnhance   = false,
    normalize       = false,
    // multi-track
    audioStreamIndex = 0
  } = req.body;

  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'running') return res.status(409).json({ error: 'Already running' });

  const ext = '.mp4';
  const outName = `${uuidv4()}${ext}`;
  const outputPath = path.join(OUTPUT_DIR, outName);
  job.outputPath = outputPath;
  job.status = 'running';

  // ── Build FFmpeg args ─────────────────────────────────────────────────
  const args = ['-y', '-i', job.inputPath];

  // Select audio stream if multiple tracks
  if (audioStreamIndex > 0) {
    args.push('-map', '0:v:0', '-map', `0:a:${audioStreamIndex}`);
  }

  // Video codec
  args.push('-c:v', encoder);

  // Encoder-specific quality flags
  if (encoder === 'libx264') {
    args.push('-preset', preset, '-crf', String(crf));
  } else if (encoder === 'h264_nvenc') {
    args.push('-preset', 'p4', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0');
  } else if (encoder === 'h264_qsv') {
    args.push('-preset', preset, '-global_quality', String(crf));
  } else if (encoder === 'h264_amf') {
    args.push('-quality', 'quality', '-qp_i', String(crf), '-qp_p', String(crf));
  } else if (encoder === 'h264_videotoolbox') {
    args.push('-q:v', String(crf));
  }

  // Pixel format (broad compatibility)
  args.push('-pix_fmt', 'yuv420p');

  // Resolution scaling
  if (resolution !== 'source') {
    const scaleMap = {
      '2160p': '3840:2160', '1080p': '1920:1080',
      '720p': '1280:720',   '480p': '854:480',   '360p': '640:360'
    };
    const scale = scaleMap[resolution];
    if (scale) args.push('-vf', `scale=${scale}:force_original_aspect_ratio=decrease,pad=${scale}:(ow-iw)/2:(oh-ih)/2`);
  }

  // Audio codec
  args.push('-c:a', 'aac', '-b:a', audioBitrate);

  // Audio filters
  const audioFilter = buildAudioFilter({ dialogueBoost, backgroundLevel, speechEnhance, normalize });
  if (audioFilter) args.push('-af', audioFilter);

  // Web optimisation: moov atom at front for streaming
  args.push('-movflags', '+faststart');

  args.push(outputPath);

  // ── Spawn FFmpeg ──────────────────────────────────────────────────────
  console.log('FFmpeg args:', args.join(' '));
  const ffmpegProc = spawn(FFMPEG_BIN, args);
  job.process = ffmpegProc;

  let duration = 0;

  ffmpegProc.stderr.on('data', chunk => {
    const line = chunk.toString();

    // Extract total duration once
    const durMatch = line.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (durMatch) {
      duration =
        parseInt(durMatch[1]) * 3600 +
        parseInt(durMatch[2]) * 60 +
        parseFloat(durMatch[3]);
    }

    // Parse current time for progress
    const timeMatch = line.match(/time=\s*(\d+):(\d+):(\d+\.\d+)/);
    if (timeMatch && duration > 0) {
      const current =
        parseInt(timeMatch[1]) * 3600 +
        parseInt(timeMatch[2]) * 60 +
        parseFloat(timeMatch[3]);
      const pct = Math.min(99, Math.round((current / duration) * 100));
      io.to(jobId).emit('progress', { jobId, percent: pct, time: current, duration });
    }

    // Speed / fps info
    const speedMatch = line.match(/speed=\s*([\d.]+)x/);
    const fpsMatch   = line.match(/fps=\s*([\d.]+)/);
    if (speedMatch || fpsMatch) {
      io.to(jobId).emit('stats', {
        speed: speedMatch ? parseFloat(speedMatch[1]) : null,
        fps:   fpsMatch   ? parseFloat(fpsMatch[1])   : null
      });
    }
  });

  ffmpegProc.on('close', code => {
    if (code === 0) {
      job.status = 'done';
      io.to(jobId).emit('progress', { jobId, percent: 100 });
      io.to(jobId).emit('done', {
        jobId,
        downloadUrl: `/api/download/${path.basename(outputPath)}`
      });
    } else {
      job.status = 'error';
      io.to(jobId).emit('error', { jobId, message: `FFmpeg exited with code ${code}` });
    }
  });

  res.json({ jobId, status: 'running' });
});

// ── Cancel job ─────────────────────────────────────────────────────────────
app.post('/api/cancel/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.process) job.process.kill('SIGKILL');
  job.status = 'cancelled';
  res.json({ status: 'cancelled' });
});

// ── Batch upload ────────────────────────────────────────────────────────────
const batchUpload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 * 1024 } });

app.post('/api/batch-upload', batchUpload.array('videos', 200), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });

  const batchId = uuidv4();
  const items = req.files.map((f, i) => {
    const jobId = uuidv4();
    jobs.set(jobId, {
      inputPath:    f.path,
      outputPath:   null,
      process:      null,
      status:       'queued',
      originalName: f.originalname,
      batchId,
      batchIndex:   i
    });
    return { jobId, filename: f.originalname, size: f.size };
  });

  res.json({ batchId, items });
});

// ── Batch transcode ────────────────────────────────────────────────────────
// Processes jobs sequentially; emits batch:progress and batch:done on batchId room
app.post('/api/batch-transcode', async (req, res) => {
  const { batchId, jobIds, transcodeOpts = {} } = req.body;
  if (!batchId || !Array.isArray(jobIds) || jobIds.length === 0)
    return res.status(400).json({ error: 'Missing batchId or jobIds' });

  res.json({ batchId, status: 'running', total: jobIds.length });

  // Run jobs one at a time
  (async () => {
    for (let i = 0; i < jobIds.length; i++) {
      const jobId = jobIds[i];
      const job   = jobs.get(jobId);
      if (!job) continue;

      job.status = 'running';
      io.to(batchId).emit('batch:file-start', { batchId, jobId, index: i, total: jobIds.length, filename: job.originalName });

      await new Promise(resolve => {
        const opts = { ...transcodeOpts, jobId };
        const {
          encoder = 'libx264', preset = 'medium', crf = 23,
          resolution = 'source', audioBitrate = '192k',
          dialogueBoost = 0, backgroundLevel = 0,
          speechEnhance = false, normalize = true,
          audioStreamIndex = 0
        } = opts;

        const outName  = `${uuidv4()}.mp4`;
        const outputPath = path.join(OUTPUT_DIR, outName);
        job.outputPath = outputPath;

        const args = ['-y', '-i', job.inputPath];
        if (audioStreamIndex > 0) args.push('-map', '0:v:0', '-map', `0:a:${audioStreamIndex}`);
        args.push('-c:v', encoder);
        if (encoder === 'libx264')         args.push('-preset', preset, '-crf', String(crf));
        else if (encoder === 'h264_nvenc') args.push('-preset', 'p4', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0');
        else if (encoder === 'h264_qsv')   args.push('-preset', preset, '-global_quality', String(crf));
        else if (encoder === 'h264_amf')   args.push('-quality', 'quality', '-qp_i', String(crf), '-qp_p', String(crf));
        else if (encoder === 'h264_videotoolbox') args.push('-q:v', String(crf));
        args.push('-pix_fmt', 'yuv420p');
        if (resolution !== 'source') {
          const scaleMap = { '2160p':'3840:2160','1080p':'1920:1080','720p':'1280:720','480p':'854:480','360p':'640:360' };
          const scale = scaleMap[resolution];
          if (scale) args.push('-vf', `scale=${scale}:force_original_aspect_ratio=decrease,pad=${scale}:(ow-iw)/2:(oh-ih)/2`);
        }
        args.push('-c:a', 'aac', '-b:a', audioBitrate);
        const af = buildAudioFilter({ dialogueBoost, backgroundLevel, speechEnhance, normalize });
        if (af) args.push('-af', af);
        args.push('-movflags', '+faststart', outputPath);

        const proc = spawn(FFMPEG_BIN, args);
        job.process = proc;
        let duration = 0;

        proc.stderr.on('data', chunk => {
          const line = chunk.toString();
          const dm = line.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
          if (dm) duration = parseInt(dm[1])*3600 + parseInt(dm[2])*60 + parseFloat(dm[3]);
          const tm = line.match(/time=\s*(\d+):(\d+):(\d+\.\d+)/);
          if (tm && duration > 0) {
            const cur = parseInt(tm[1])*3600 + parseInt(tm[2])*60 + parseFloat(tm[3]);
            const pct = Math.min(99, Math.round((cur/duration)*100));
            io.to(batchId).emit('batch:progress', { batchId, jobId, index: i, total: jobIds.length, percent: pct });
          }
        });

        proc.on('close', code => {
          if (code === 0) {
            job.status = 'done';
            io.to(batchId).emit('batch:file-done', {
              batchId, jobId, index: i, total: jobIds.length,
              filename: job.originalName,
              downloadUrl: `/api/download/${path.basename(outputPath)}`
            });
          } else {
            job.status = 'error';
            io.to(batchId).emit('batch:file-error', { batchId, jobId, index: i, filename: job.originalName, message: `FFmpeg exit ${code}` });
          }
          resolve();
        });
      });
    }

    io.to(batchId).emit('batch:done', { batchId, total: jobIds.length });
  })();
});

// ── Download ───────────────────────────────────────────────────────────────
app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, `transcoded_${req.params.filename}`);
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  exec(`"${FFMPEG_BIN}" -version 2>&1`, (err, stdout) => {
    const ffmpegVersion = stdout ? stdout.split('\n')[0] : 'not found';
    res.json({ status: 'ok', ffmpeg: ffmpegVersion, uptime: process.uptime() });
  });
});

// ── Socket.io rooms ────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join', jobId => socket.join(jobId));
  socket.on('leave', jobId => socket.leave(jobId));
});

// ── Cleanup on exit ────────────────────────────────────────────────────────
process.on('exit', () => {
  jobs.forEach(job => { if (job.process) job.process.kill('SIGKILL'); });
});

server.listen(PORT, () => {
  console.log(`\n🎬  Video Transcoder running at http://localhost:${PORT}`);
  console.log(`   Open the URL above in your browser.\n`);
});
