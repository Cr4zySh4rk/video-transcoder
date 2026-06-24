/* ── VideoForge — Frontend App ────────────────────────────────────────────── */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────
// When running inside the Electron desktop app, the preload script injects
// window.electronAPI.serverPort with the actual bound port.
const _electronUrl = window.electronAPI
  ? `http://localhost:${window.electronAPI.serverPort}`
  : null;

const state = {
  serverUrl:    _electronUrl || localStorage.getItem('serverUrl') || 'http://localhost:3000',
  jobId:        null,
  socket:       null,
  connected:    false,
  uploading:    false,
  transcoding:  false,
  preUploaded:  false,
  file:         null,
  outputDir:    null,    // explicit destination folder (Electron only)
  sourcePath:   null,    // original file path for default-same-dir behaviour
  // All available encoders populated by detectHardware
  availableEncoders: [],
  softwareCodecs:    [],
};

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  connectBanner:     $('connect-banner'),
  serverUrlInput:    $('server-url-input'),
  connectBtn:        $('connect-btn'),
  statusDot:         $('status-dot'),
  statusLabel:       $('status-label'),
  dropZone:          $('drop-zone'),
  fileInput:         $('file-input'),
  fileInfo:          $('file-info'),
  fileName:          $('file-name'),
  fileSize:          $('file-size'),
  probeChips:        $('probe-chips'),
  encoderSelect:     $('encoder-select'),
  containerSelect:   $('container-select'),
  encodingModeSelect:$('encoding-mode-select'),
  crfField:          $('crf-field'),
  bitrateField:      $('bitrate-field'),
  crfInput:          $('crf-input'),
  bitrateSelect:     $('bitrate-select'),
  presetSelect:      $('preset-select'),
  resolutionSelect:  $('resolution-select'),
  fpsSelect:         $('fps-select'),
  audioBitrate:      $('audio-bitrate'),
  audioStream:       $('audio-stream'),
  audioCodecSelect:  $('audio-codec-select'),
  subtitleSelect:    $('subtitle-select'),
  dialogueSlider:    $('dialogue-slider'),
  dialogueVal:       $('dialogue-val'),
  bgSlider:          $('bg-slider'),
  bgVal:             $('bg-val'),
  speechEnhance:     $('speech-enhance'),
  normalizeAudio:    $('normalize-audio'),
  hwBadges:          $('hw-badges'),
  trimStart:         $('trim-start'),
  trimEnd:           $('trim-end'),
  destRow:           $('dest-row'),
  destPath:          $('dest-path'),
  destBrowseBtn:     $('dest-browse-btn'),
  destClearBtn:      $('dest-clear-btn'),
  destOpenBtn:       $('dest-open-btn'),
  transcodeBtn:      $('transcode-btn'),
  cancelBtn:         $('cancel-btn'),
  resetBtn:          $('reset-btn'),
  progressSection:   $('progress-section'),
  progressTitle:     $('progress-title'),
  progressBar:       $('progress-bar'),
  progressPct:       $('progress-pct'),
  progressTime:      $('progress-time'),
  progressSpeed:     $('progress-speed'),
  progressFps:       $('progress-fps'),
  downloadSection:   $('download-section'),
  downloadLink:      $('download-link'),
  downloadMeta:      $('download-meta'),
  toastWrap:         $('toast-wrap'),
  dialogueLevelBar:  $('dialogue-level-bar'),
  bgLevelBar:        $('bg-level-bar'),
};

// ── Container ↔ codec compatibility ──────────────────────────────────────
// Derived from brarcher/video-transcoder Android codec matrix and
// container format codec support documentation.
const CONTAINER_CODECS = {
  mp4:  ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_amf', 'h264_qsv', 'hevc_qsv', 'h264_videotoolbox', 'hevc_videotoolbox', 'h264_v4l2m2m', 'hevc_v4l2m2m'],
  mkv:  ['libx264', 'libx265', 'libvpx', 'libvpx-vp9', 'libaom-av1', 'libsvtav1', 'h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_amf', 'h264_qsv', 'hevc_qsv', 'h264_videotoolbox', 'hevc_videotoolbox', 'h264_v4l2m2m', 'hevc_v4l2m2m'],
  webm: ['libvpx', 'libvpx-vp9', 'libaom-av1', 'libsvtav1'],
  mov:  ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_amf', 'h264_qsv', 'hevc_qsv', 'h264_videotoolbox', 'hevc_videotoolbox'],
  avi:  ['libx264', 'h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_videotoolbox'],
};

// Audio codecs that work in each container
const CONTAINER_AUDIO_CODECS = {
  mp4:  ['aac', 'libmp3lame', 'ac3', 'copy'],
  mkv:  ['aac', 'libmp3lame', 'libopus', 'ac3', 'copy'],
  webm: ['libopus', 'copy'],
  mov:  ['aac', 'ac3', 'copy'],
  avi:  ['libmp3lame', 'aac', 'copy'],
};

// Pretty names for encoder options
const ENCODER_LABELS = {
  'libx264':            'Software H.264 x264 (CPU)',
  'libx265':            'Software H.265 x265 (CPU)',
  'libvpx':             'Software VP8 (CPU)',
  'libvpx-vp9':         'Software VP9 (CPU)',
  'libaom-av1':         'Software AV1 libaom (CPU — slow)',
  'libsvtav1':          'Software AV1 SVT (CPU — faster)',
  'h264_nvenc':         'NVIDIA H.264 NVENC',
  'hevc_nvenc':         'NVIDIA H.265 NVENC',
  'h264_amf':           'AMD H.264 AMF',
  'hevc_amf':           'AMD H.265 AMF',
  'h264_qsv':           'Intel H.264 Quick Sync',
  'hevc_qsv':           'Intel H.265 Quick Sync',
  'h264_videotoolbox':  'Apple H.264 VideoToolbox',
  'hevc_videotoolbox':  'Apple H.265 VideoToolbox',
  'h264_v4l2m2m':       'V4L2 H.264 (ARM/SBC)',
  'hevc_v4l2m2m':       'V4L2 H.265 (ARM/SBC)',
};

// ── Toasts ────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 4000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  els.toastWrap.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ── Format helpers ────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fmtTime(s) {
  if (!s || isNaN(s)) return '--:--';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// Parse "1:23.456", "83.456", "1:23", "83" → seconds
function parseTrimTime(str) {
  if (!str || !str.trim()) return null;
  str = str.trim();
  // MM:SS.mmm
  const m = str.match(/^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/);
  if (m) {
    const mins = parseInt(m[1]);
    const secs = parseInt(m[2]);
    const ms   = m[3] ? parseFloat('0.' + m[3]) : 0;
    return mins * 60 + secs + ms;
  }
  // Plain seconds (possibly with decimal)
  const n = parseFloat(str);
  if (!isNaN(n) && n >= 0) return n;
  return null;
}

// ── Server connection ─────────────────────────────────────────────────────
async function checkServer(url) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('bad status');
    return true;
  } catch {
    return false;
  }
}

function showNotConnected() {
  state.connected = false;
  els.statusDot.classList.remove('online');
  els.statusLabel.textContent = 'Not connected';
  document.querySelector('main').classList.add('locked');
  gsExpand(true);
  const callout = $('gs-retry-callout');
  if (callout) callout.style.display = 'block';
  const gs = $('get-started');
  if (gs) gs.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showConnected(url) {
  state.serverUrl = url;
  state.connected = true;
  localStorage.setItem('serverUrl', url);
  els.statusDot.classList.add('online');
  els.statusLabel.textContent = `Connected — ${url}`;
  document.querySelector('main').classList.remove('locked');
  gsExpand(false);
  const callout = $('gs-retry-callout');
  if (callout) callout.style.display = 'none';
  if (state.socket) state.socket.disconnect();
  state.socket = io(url, { transports: ['websocket', 'polling'] });
  state.socket.on('progress', onProgress);
  state.socket.on('stats',    onStats);
  state.socket.on('done',     onDone);
  state.socket.on('error',    onTranscodeError);
  attachBatchSocketEvents(state.socket);
  detectHardware(url);
  toast('Connected to local server', 'success');
  if (batchState.files.length > 0 && !batchState.running) batchEls.startBtn.disabled = false;
}

async function connectToServer(url, isManual = false) {
  url = url.replace(/\/$/, '');
  els.statusLabel.textContent = 'Connecting…';
  els.statusDot.classList.remove('online');
  const ok = await checkServer(url);
  if (ok) {
    showConnected(url);
    if (isManual) window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    showNotConnected();
    if (isManual) toast("Can't reach the server — is the script running?", 'error');
  }
}

// ── Hardware + software codec detection ──────────────────────────────────
// Populates the encoder dropdown with all available hardware and software
// encoders, including H.265/HEVC and VP9/AV1 where available.
async function detectHardware(url) {
  try {
    const r = await fetch(`${url}/api/detect-hw`);
    const data = await r.json();

    state.availableEncoders = data.encoders || [];
    state.softwareCodecs    = data.softwareCodecs || [];

    rebuildEncoderOptions();

  } catch (e) {
    console.warn('HW detect failed', e);
  }
}

function rebuildEncoderOptions() {
  const container     = els.containerSelect.value;
  const allowedCodecs = CONTAINER_CODECS[container] || CONTAINER_CODECS.mp4;
  const prev          = els.encoderSelect.value;

  // Build full encoder list: software first, then hardware
  const allSoftware = ['libx264', 'libx265', 'libvpx-vp9', 'libvpx', 'libaom-av1', 'libsvtav1']
    .filter(id => id === 'libx264' || state.softwareCodecs.includes(id));

  const allHardware = state.availableEncoders.map(e => e.id);
  const all = [...allSoftware, ...allHardware];
  const compatible = all.filter(id => allowedCodecs.includes(id));

  // Rebuild select
  els.encoderSelect.innerHTML = '';
  compatible.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = ENCODER_LABELS[id] || id;
    els.encoderSelect.appendChild(opt);
  });

  // Restore selection or pick best available
  if (compatible.includes(prev)) {
    els.encoderSelect.value = prev;
  } else {
    // Auto-select: prefer GPU, then libx264
    const PRIORITY = ['h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_amf', 'h264_qsv', 'hevc_qsv',
      'h264_videotoolbox', 'hevc_videotoolbox', 'h264_v4l2m2m', 'libx264', 'libx265', 'libvpx-vp9'];
    const best = PRIORITY.find(id => compatible.includes(id)) || compatible[0];
    if (best) els.encoderSelect.value = best;
  }

  rebuildAudioCodecOptions();
  rebuildHwBadges();
  updateCRFRange();
}

function rebuildAudioCodecOptions() {
  const container    = els.containerSelect.value;
  const allowed      = CONTAINER_AUDIO_CODECS[container] || CONTAINER_AUDIO_CODECS.mp4;
  const prevAudio    = els.audioCodecSelect.value;
  const AUDIO_LABELS = {
    aac:        'AAC — universal (recommended)',
    libmp3lame: 'MP3 — wide compatibility',
    libopus:    'Opus — efficient (WebM/MKV)',
    ac3:        'AC-3 / Dolby Digital',
    copy:       'Copy (passthrough — no re-encode)',
  };
  els.audioCodecSelect.innerHTML = '';
  allowed.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = AUDIO_LABELS[id] || id;
    els.audioCodecSelect.appendChild(opt);
  });
  if (allowed.includes(prevAudio)) els.audioCodecSelect.value = prevAudio;
}

function rebuildHwBadges() {
  const selectedId = els.encoderSelect.value;
  els.hwBadges.innerHTML = '';

  const allSoftware = ['libx264', 'libx265', 'libvpx-vp9', 'libvpx', 'libaom-av1', 'libsvtav1']
    .filter(id => id === 'libx264' || state.softwareCodecs.includes(id));

  allSoftware.forEach(id => {
    const badge = document.createElement('div');
    badge.className = 'hw-badge' + (id === selectedId ? ' hw-badge-active' : '');
    badge.textContent = (ENCODER_LABELS[id] || id).replace(' (CPU)', '').replace(' (CPU — slow)', '').replace(' (CPU — faster)', '');
    els.hwBadges.appendChild(badge);
  });

  if (state.availableEncoders.length) {
    state.availableEncoders.forEach(enc => {
      const badge = document.createElement('div');
      const isActive = enc.id === selectedId;
      badge.className = 'hw-badge hw-badge-gpu' + (isActive ? ' hw-badge-active' : '');
      badge.textContent = enc.label + (isActive ? ' ✓' : '');
      els.hwBadges.appendChild(badge);
    });
  } else {
    const nb = document.createElement('div');
    nb.className = 'hw-badge';
    nb.style.cssText = 'color:var(--muted);border-color:var(--border)';
    nb.textContent = 'No GPU encoders detected';
    els.hwBadges.appendChild(nb);
  }
}

function updateCRFRange() {
  const enc = els.encoderSelect.value;
  // VP9, AV1 use 0–63; NVENC CQ also 0–51; default 0–51
  const isVpxAv1 = ['libvpx', 'libvpx-vp9', 'libaom-av1', 'libsvtav1'].includes(enc);
  const max = isVpxAv1 ? 63 : 51;
  els.crfInput.max = max;
  // Clamp current value
  if (parseInt(els.crfInput.value) > max) {
    els.crfInput.value = Math.round(max * 0.45);
    $('crf-val').textContent = els.crfInput.value;
  }
  // Hide preset for codecs that don't use it
  const noPreset = ['libvpx', 'libvpx-vp9', 'libaom-av1', 'libsvtav1',
    'h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_amf', 'h264_videotoolbox', 'hevc_videotoolbox'];
  const presetField = els.presetSelect && els.presetSelect.closest('.field');
  if (presetField) presetField.style.display = noPreset.includes(enc) ? 'none' : '';
}

// ── Encoding mode toggle ──────────────────────────────────────────────────
function updateEncodingModeUI() {
  const mode = els.encodingModeSelect.value;
  els.crfField.style.display     = (mode === 'crf')     ? '' : 'none';
  els.bitrateField.style.display = (mode !== 'crf')     ? '' : 'none';
}
els.encodingModeSelect.addEventListener('change', updateEncodingModeUI);
updateEncodingModeUI();

// ── Container change cascade ──────────────────────────────────────────────
els.containerSelect.addEventListener('change', rebuildEncoderOptions);
els.encoderSelect.addEventListener('change', () => { rebuildHwBadges(); updateCRFRange(); });

// ── File handling ─────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !file.name.match(/\.(mkv|mov|avi|wmv|flv|webm|mp4|m4v|ts|mts|m2ts|3gp|ogv|vob|divx|xvid)$/i)) {
    toast('Please select a video file', 'error');
    return;
  }

  els.fileName.textContent  = file.name;
  // Use the real file size directly — do NOT wait for ffprobe fmt.size
  els.fileSize.textContent  = formatBytes(file.size);
  els.fileInfo.classList.add('visible');
  els.transcodeBtn.disabled = true;
  els.probeChips.innerHTML  = '<span class="chip chip-info">Analyzing…</span>';
  els.audioStream.innerHTML = '<option value="0" disabled>Detecting tracks…</option>';
  els.subtitleSelect.innerHTML = '<option value="-1">None</option>';
  state.file        = file;
  state.jobId       = null;
  state.preUploaded = false;

  // Electron: capture native file path for same-folder output default
  state.sourcePath = (file.path && typeof file.path === 'string' && file.path !== '') ? file.path : null;

  if (!state.connected) {
    els.transcodeBtn.disabled = false;
    els.probeChips.innerHTML  = '';
    els.audioStream.innerHTML = '<option value="0">Track 1 (default)</option>';
    return;
  }

  (async () => {
    try {
      const HEADER = 2 * 1024 * 1024;
      const ext    = encodeURIComponent(file.name.slice(file.name.lastIndexOf('.')));
      const r = await fetch(`${state.serverUrl}/api/probe-partial?ext=${ext}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body:    file.slice(0, HEADER)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      // Pass real file size so we don't show the 2 MB slice size
      renderProbeData(data, file.size);
    } catch (e) {
      console.warn('Probe failed:', e.message);
      els.probeChips.innerHTML  = '';
      els.audioStream.innerHTML = '<option value="0">Track 1 (default)</option>';
    }
    els.transcodeBtn.disabled = false;
  })();
}

els.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  els.dropZone.classList.add('drag-over');
});
els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('drag-over'));
els.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  els.dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});
els.fileInput.addEventListener('change', () => handleFile(els.fileInput.files[0]));

// ── Sliders ───────────────────────────────────────────────────────────────
els.dialogueSlider.addEventListener('input', () => {
  const v = parseFloat(els.dialogueSlider.value);
  els.dialogueVal.textContent = `${v > 0 ? '+' : ''}${v} dB`;
  els.dialogueLevelBar.style.width = `${((v + 12) / 24) * 100}%`;
});
els.bgSlider.addEventListener('input', () => {
  const v = parseFloat(els.bgSlider.value);
  els.bgVal.textContent = `${v > 0 ? '+' : ''}${v} dB`;
  els.bgLevelBar.style.width = `${((v + 24) / 24) * 100}%`;
});

// ── Destination folder (Electron only) ───────────────────────────────────
if (window.electronAPI?.isElectron) {
  // Show destination row in Electron
  if (els.destRow) els.destRow.style.display = '';

  els.destBrowseBtn.addEventListener('click', async () => {
    const folder = await window.electronAPI.pickFolder();
    if (folder) {
      state.outputDir = folder;
      els.destPath.textContent  = folder;
      els.destClearBtn.style.display = '';
      els.destOpenBtn.style.display  = '';
    }
  });

  els.destClearBtn.addEventListener('click', () => {
    state.outputDir = null;
    els.destPath.textContent  = 'Same as source file';
    els.destClearBtn.style.display = 'none';
    els.destOpenBtn.style.display  = 'none';
  });

  els.destOpenBtn.addEventListener('click', () => {
    const folder = state.outputDir;
    if (folder) window.electronAPI.showInFolder(folder);
  });
}

// ── renderProbeData ───────────────────────────────────────────────────────
// realFileSize: the File object's .size — passed from handleFile() to avoid
// displaying the 2 MB partial-probe slice size as the file size.
function renderProbeData(data, realFileSize = null) {
  const streams  = data.streams || [];
  const fmt      = data.format  || {};
  const vStream  = streams.find(s => s.codec_type === 'video');
  const aStreams  = streams.filter(s => s.codec_type === 'audio');
  const sStreams  = streams.filter(s => s.codec_type === 'subtitle');

  els.probeChips.innerHTML = '';

  if (vStream) {
    addChip(vStream.codec_name.toUpperCase(), 'video codec');
    if (vStream.width) addChip(`${vStream.width}×${vStream.height}`, 'resolution');
    if (vStream.r_frame_rate) {
      const [n, d] = vStream.r_frame_rate.split('/');
      const fps = Math.round((n / d) * 10) / 10;
      if (isFinite(fps) && fps > 0) addChip(`${fps} fps`, 'frame rate');
    }
  }

  if (fmt.duration) addChip(fmtTime(parseFloat(fmt.duration)), 'duration');

  // File size: use real File.size if available (avoids showing 2 MB slice size).
  // Only fall back to fmt.size if we know the probe was of the full file (size > 4 MB).
  if (realFileSize != null && realFileSize > 0) {
    addChip(formatBytes(realFileSize), 'file size');
  } else if (fmt.size && parseInt(fmt.size) > 4 * 1024 * 1024) {
    addChip(formatBytes(parseInt(fmt.size)), 'file size');
  }

  // ── Audio track selector ────────────────────────────────────────────────
  els.audioStream.innerHTML = '';
  aStreams.forEach((s, i) => {
    const parts = [];
    if (s.codec_name) parts.push(s.codec_name.toUpperCase());
    const ch = s.channels;
    if (ch) parts.push(ch === 1 ? 'Mono' : ch === 2 ? 'Stereo' : ch === 6 ? '5.1' : ch === 8 ? '7.1' : `${ch}ch`);
    if (s.bit_rate) parts.push(`${Math.round(parseInt(s.bit_rate) / 1000)} kbps`);
    const lang = s.tags?.language;
    if (lang && lang !== 'und') parts.push(`[${lang.toUpperCase()}]`);
    const title = s.tags?.title || s.tags?.handler_name;
    if (title && title.length < 40 && title !== 'SoundHandler') parts.push(`"${title}"`);

    const label = parts.join(' ') || `Stream ${s.index ?? i}`;
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Track ${i + 1}  —  ${label}`;
    els.audioStream.appendChild(opt);
    addChip(`Track ${i + 1}: ${label}`, 'audio');
  });

  if (aStreams.length === 0) {
    els.audioStream.innerHTML = '<option value="0">No audio detected</option>';
    addChip('No audio', 'audio');
  } else if (aStreams.length > 1) {
    els.audioStream.style.borderColor = 'rgba(99,102,241,.5)';
    els.audioStream.title = `${aStreams.length} audio tracks — pick the one you want`;
  } else {
    els.audioStream.style.borderColor = '';
    els.audioStream.title = '';
  }

  // ── Subtitle track selector ─────────────────────────────────────────────
  els.subtitleSelect.innerHTML = '<option value="-1">None</option>';
  sStreams.forEach((s, i) => {
    const parts = [];
    if (s.codec_name) parts.push(s.codec_name.toUpperCase());
    const lang = s.tags?.language;
    if (lang && lang !== 'und') parts.push(`[${lang.toUpperCase()}]`);
    const title = s.tags?.title || s.tags?.handler_name;
    if (title && title.length < 40) parts.push(`"${title}"`);
    const label = parts.join(' ') || `Stream ${s.index ?? i}`;
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Track ${i + 1}  —  ${label}`;
    els.subtitleSelect.appendChild(opt);
  });

  if (sStreams.length > 0) {
    addChip(`${sStreams.length} subtitle track${sStreams.length > 1 ? 's' : ''}`, 'subtitles');
  }
}

async function probeFile(jobId) {
  try {
    const r = await fetch(`${state.serverUrl}/api/probe/${jobId}`);
    if (!r.ok) throw new Error(`Probe returned ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    // Full probe — use fmt.size (safe: full file was uploaded)
    renderProbeData(data, null);
  } catch (e) {
    console.warn('Probe failed', e);
    els.audioStream.innerHTML = '<option value="0">Track 1 (default)</option>';
    els.probeChips.innerHTML  = '<span class="chip chip-warn">Could not read file metadata</span>';
  }
}

function addChip(text, type) {
  const c = document.createElement('div');
  c.className = 'chip';
  c.innerHTML = `<strong>${text}</strong> <span style="font-size:10px;opacity:.6">${type}</span>`;
  els.probeChips.appendChild(c);
}

// ── Socket events ─────────────────────────────────────────────────────────
function onProgress({ percent, time, duration }) {
  els.progressBar.style.width  = `${percent}%`;
  els.progressPct.textContent  = `${percent}%`;
  if (time && duration) {
    const remaining = Math.max(0, duration - time);
    els.progressTime.textContent = `${fmtTime(time)} / ${fmtTime(duration)} · ${fmtTime(remaining)} left`;
  } else if (time) {
    els.progressTime.textContent = fmtTime(time);
  }
}

function onStats({ speed, fps, phase }) {
  // Show pass label for two-pass
  if (phase === 'pass2') {
    if (els.progressTitle) els.progressTitle.textContent = 'Transcoding… (pass 2)';
    // Reset speed/fps to "Analyzing…" at the start of pass 2
    els.progressSpeed.innerHTML = `Speed <span>Analyzing…</span>`;
    els.progressFps.innerHTML   = `FPS <span>Analyzing…</span>`;
    return;
  }
  if (speed !== null && speed !== undefined) {
    els.progressSpeed.innerHTML = `Speed <span>${parseFloat(speed).toFixed(2)}x</span>`;
  }
  if (fps !== null && fps !== undefined) {
    els.progressFps.innerHTML = `FPS <span>${parseFloat(fps).toFixed(0)}</span>`;
  }
}

function onDone({ downloadUrl }) {
  state.transcoding = false;
  els.cancelBtn.disabled = true;
  els.progressBar.style.width = '100%';
  els.progressPct.textContent = '100%';

  const encoder    = els.encoderSelect.value;
  const container  = els.containerSelect.value.toUpperCase();
  const mode       = els.encodingModeSelect.value;
  const modeLabel  = mode === 'two-pass' ? 'two-pass CBR' : mode === 'bitrate' ? 'target bitrate' : 'CRF';

  const fullUrl = `${state.serverUrl}${downloadUrl}`;
  els.downloadLink.href         = fullUrl;
  els.downloadMeta.textContent  = `${container} · ${ENCODER_LABELS[encoder] || encoder} · ${modeLabel}`;
  els.downloadSection.style.display = 'block';

  // In Electron when a custom output dir is set, show the path in the meta
  if (window.electronAPI?.isElectron && (state.outputDir || state.sourcePath)) {
    const dir = state.outputDir || (state.sourcePath ? state.sourcePath.split(/[\\/]/).slice(0,-1).join('/') : null);
    if (dir) {
      els.downloadMeta.textContent += ` · Saved to ${dir}`;
      // Also reveal the open-folder button
      if (els.destOpenBtn) {
        els.destOpenBtn.style.display = '';
        if (!state.outputDir) {
          // Update dest path display to show where we saved it
          els.destPath.textContent = dir;
        }
      }
    }
  }

  toast('Transcoding complete!', 'success', 6000);
}

function onTranscodeError({ message }) {
  toast(`Transcode error: ${message}`, 'error', 8000);
  resetState();
}

// ── Upload + Transcode ────────────────────────────────────────────────────
els.transcodeBtn.addEventListener('click', startTranscode);

async function startTranscode() {
  if (!state.connected) { toast('Not connected to local server', 'error'); return; }
  if (!state.file)      { toast('Please select a video file first', 'error'); return; }
  if (state.transcoding) return;

  state.transcoding = true;
  els.transcodeBtn.disabled = true;
  els.cancelBtn.disabled    = false;
  els.progressSection.style.display = 'block';
  els.downloadSection.style.display = 'none';
  els.progressBar.style.width = '0%';
  els.progressPct.textContent = '0%';
  els.progressTime.textContent = '--:-- / --:--';

  // Reset stats to "Analyzing…" at start of each transcode
  els.progressSpeed.innerHTML = 'Speed <span>Analyzing…</span>';
  els.progressFps.innerHTML   = 'FPS <span>Analyzing…</span>';

  const mode = els.encodingModeSelect.value;
  if (els.progressTitle) {
    els.progressTitle.textContent = mode === 'two-pass' ? 'Transcoding… (pass 1)' : 'Transcoding…';
  }

  try {
    // 1 — Upload full file
    toast('Uploading file…');
    const formData = new FormData();
    formData.append('video', state.file);

    const upRes = await fetch(`${state.serverUrl}/api/upload`, { method: 'POST', body: formData });
    if (!upRes.ok) throw new Error('Upload failed');
    const { jobId } = await upRes.json();
    state.jobId = jobId;
    state.socket.emit('join', jobId);

    // 2 — Parse trim times
    const startTime = parseTrimTime(els.trimStart.value);
    const endTime   = parseTrimTime(els.trimEnd.value);

    // 3 — Build transcode options
    const opts = {
      jobId:            state.jobId,
      encoder:          els.encoderSelect.value,
      container:        els.containerSelect.value,
      audioCodec:       els.audioCodecSelect.value,
      preset:           els.presetSelect.value,
      crf:              parseInt(els.crfInput.value),
      encodingMode:     mode,
      videoBitrate:     els.bitrateSelect.value,
      resolution:       els.resolutionSelect.value,
      fps:              els.fpsSelect.value,
      audioBitrate:     els.audioBitrate.value,
      audioStreamIndex: parseInt(els.audioStream.value) || 0,
      subtitleIndex:    parseInt(els.subtitleSelect.value ?? '-1'),
      dialogueBoost:    parseFloat(els.dialogueSlider.value),
      backgroundLevel:  parseFloat(els.bgSlider.value),
      speechEnhance:    els.speechEnhance.checked,
      normalize:        els.normalizeAudio.checked,
      startTime:        startTime,
      endTime:          endTime,
      // Electron: pass destination folder and source path for default-same-dir
      outputDir:        state.outputDir  || null,
      sourcePath:       state.sourcePath || null,
    };

    toast('Transcoding started…');
    const txRes = await fetch(`${state.serverUrl}/api/transcode`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(opts)
    });

    if (!txRes.ok) {
      const err = await txRes.json();
      throw new Error(err.error || 'Transcode request failed');
    }

  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
    resetState();
  }
}

// ── Cancel ────────────────────────────────────────────────────────────────
els.cancelBtn.addEventListener('click', async () => {
  if (!state.jobId) return;
  try {
    await fetch(`${state.serverUrl}/api/cancel/${state.jobId}`, { method: 'POST' });
    toast('Transcoding cancelled');
  } catch (e) {
    console.warn(e);
  }
  resetState();
});

// ── Reset ─────────────────────────────────────────────────────────────────
els.resetBtn.add