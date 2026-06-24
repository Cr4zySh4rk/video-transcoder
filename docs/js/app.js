/* ── Video Transcoder — Frontend App ────────────────────────────────────── */
'use strict';

// ── State ────────────────────────────────────────────────────────────────
// When running inside the Electron desktop app, the preload script injects
// window.electronAPI.serverPort with the actual bound port (may differ from
// 3000 if that port was taken). Use that over the localStorage value so the
// app connects correctly on first launch without any user action.
const _electronUrl = window.electronAPI
  ? `http://localhost:${window.electronAPI.serverPort}`
  : null;

const state = {
  serverUrl:   _electronUrl || localStorage.getItem('serverUrl') || 'http://localhost:3000',
  jobId:       null,
  socket:      null,
  connected:   false,
  uploading:   false,
  transcoding: false,
  preUploaded: false   // true when file was pre-uploaded on select
};

// ── DOM refs ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  connectBanner:   $('connect-banner'),
  serverUrlInput:  $('server-url-input'),
  connectBtn:      $('connect-btn'),
  statusDot:       $('status-dot'),
  statusLabel:     $('status-label'),
  dropZone:        $('drop-zone'),
  fileInput:       $('file-input'),
  fileInfo:        $('file-info'),
  fileName:        $('file-name'),
  fileSize:        $('file-size'),
  probeChips:      $('probe-chips'),
  encoderSelect:   $('encoder-select'),
  presetSelect:    $('preset-select'),
  crfInput:        $('crf-input'),
  resolutionSelect:$('resolution-select'),
  audioBitrate:    $('audio-bitrate'),
  audioStream:     $('audio-stream'),
  dialogueSlider:  $('dialogue-slider'),
  dialogueVal:     $('dialogue-val'),
  bgSlider:        $('bg-slider'),
  bgVal:           $('bg-val'),
  speechEnhance:   $('speech-enhance'),
  normalizeAudio:  $('normalize-audio'),
  hwBadges:        $('hw-badges'),
  transcodeBtn:    $('transcode-btn'),
  cancelBtn:       $('cancel-btn'),
  resetBtn:        $('reset-btn'),
  progressSection: $('progress-section'),
  progressBar:     $('progress-bar'),
  progressPct:     $('progress-pct'),
  progressTime:    $('progress-time'),
  progressSpeed:   $('progress-speed'),
  progressFps:     $('progress-fps'),
  downloadSection: $('download-section'),
  downloadLink:    $('download-link'),
  downloadMeta:    $('download-meta'),
  toastWrap:       $('toast-wrap'),
  dialogueLevelBar:$('dialogue-level-bar'),
  bgLevelBar:      $('bg-level-bar'),
};

// ── Toasts ────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 4000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  els.toastWrap.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ── Format bytes ──────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// ── Format seconds ────────────────────────────────────────────────────────
function fmtTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
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
  // Lock main panel
  document.querySelector('main').classList.add('locked');
  // Expand Get Started and show retry callout
  gsExpand(true);
  const callout = document.getElementById('gs-retry-callout');
  if (callout) callout.style.display = 'block';
  const gs = document.getElementById('get-started');
  if (gs) gs.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showConnected(url) {
  state.serverUrl = url;
  state.connected = true;
  localStorage.setItem('serverUrl', url);
  els.statusDot.classList.add('online');
  els.statusLabel.textContent = `Connected — ${url}`;
  // Unlock main panel
  document.querySelector('main').classList.remove('locked');
  // Collapse Get Started
  gsExpand(false);
  // Hide retry callout
  const callout = document.getElementById('gs-retry-callout');
  if (callout) callout.style.display = 'none';
  // Wire socket
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

async function detectHardware(url) {
  try {
    const r = await fetch(`${url}/api/detect-hw`);
    const data = await r.json();
    els.hwBadges.innerHTML = '';

    // Priority order: NVIDIA > AMD > Intel > Apple > ARM > Software
    const PRIORITY = ['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_videotoolbox', 'h264_v4l2m2m'];

    // Reset encoder dropdown to just the software option
    while (els.encoderSelect.options.length > 1) els.encoderSelect.remove(1);

    const detected = data.encoders || [];

    // Auto-select the highest-priority available GPU encoder
    const best = PRIORITY.find(id => detected.some(e => e.id === id));

    if (detected.length) {
      detected.forEach(enc => {
        const opt = document.createElement('option');
        opt.value = enc.id;
        opt.textContent = enc.label;
        els.encoderSelect.appendChild(opt);
      });

      if (best) {
        els.encoderSelect.value = best;
      }
    }

    // Rebuild hw badges — highlight the selected encoder
    const selectedId = els.encoderSelect.value;

    // Software badge
    const soft = document.createElement('div');
    soft.className = 'hw-badge' + (selectedId === 'libx264' ? ' hw-badge-active' : '');
    soft.textContent = 'Software x264';
    els.hwBadges.appendChild(soft);

    if (detected.length) {
      detected.forEach(enc => {
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

    // Keep badges in sync when user manually changes encoder
    els.encoderSelect.addEventListener('change', () => {
      const sel = els.encoderSelect.value;
      document.querySelectorAll('.hw-badge').forEach(b => b.classList.remove('hw-badge-active'));
      document.querySelectorAll('.hw-badge').forEach(b => {
        if (b.textContent.startsWith('Software') && sel === 'libx264') b.classList.add('hw-badge-active');
      });
      detected.forEach((enc, i) => {
        const badges = document.querySelectorAll('.hw-badge-gpu');
        if (badges[i]) {
          const active = enc.id === sel;
          badges[i].classList.toggle('hw-badge-active', active);
          badges[i].textContent = enc.label + (active ? ' ✓' : '');
        }
      });
    });

  } catch (e) {
    console.warn('HW detect failed', e);
  }
}

// ── File handling ─────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !file.name.match(/\.(mkv|mov|avi|wmv|flv|webm|mp4|m4v|ts|mts|m2ts|3gp|ogv|vob|divx|xvid)$/i)) {
    toast('Please select a video file', 'error');
    return;
  }

  els.fileName.textContent  = file.name;
  els.fileSize.textContent  = formatBytes(file.size);
  els.fileInfo.classList.add('visible');
  els.transcodeBtn.disabled = true;  // re-enabled after pre-upload
  els.probeChips.innerHTML  = '<span class="chip chip-info">Analyzing…</span>';
  // Immediately mark the audio select as pending so stale data is never shown
  els.audioStream.innerHTML = '<option value="0" disabled>Detecting tracks…</option>';
  state.file        = file;
  state.jobId       = null;
  state.preUploaded = false;

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
      renderProbeData(data);
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
  // Visual bar: map -12..+12 → 0..100%
  els.dialogueLevelBar.style.width = `${((v + 12) / 24) * 100}%`;
});

els.bgSlider.addEventListener('input', () => {
  const v = parseFloat(els.bgSlider.value);
  els.bgVal.textContent = `${v > 0 ? '+' : ''}${v} dB`;
  // Visual bar: map -24..0 → 0..100%
  els.bgLevelBar.style.width = `${((v + 24) / 24) * 100}%`;
});

// ── Upload + Transcode ────────────────────────────────────────────────────
els.transcodeBtn.addEventListener('click', startTranscode);

async function startTranscode() {
  if (!state.connected) {
    toast('Not connected to local server', 'error');
    return;
  }
  if (!state.file) {
    toast('Please select a video file first', 'error');
    return;
  }
  if (state.transcoding) return;

  state.transcoding = true;
  els.transcodeBtn.disabled = true;
  els.cancelBtn.disabled = false;
  els.progressSection.style.display = 'block';
  els.downloadSection.style.display = 'none';
  els.progressBar.style.width = '0%';
  els.progressPct.textContent = '0%';
  els.progressTime.textContent = '--:--';

  try {
    // 1 — Upload full file
    toast('Uploading file…');
    const formData = new FormData();
    formData.append('video', state.file);

    const upRes = await fetch(`${state.serverUrl}/api/upload`, {
      method: 'POST',
      body: formData
    });

    if (!upRes.ok) throw new Error('Upload failed');
    const { jobId } = await upRes.json();
    state.jobId = jobId;
    state.socket.emit('join', jobId);

    // 2 — Transcode
    toast('Transcoding started…');
    const opts = {
      jobId: state.jobId,
      encoder:          els.encoderSelect.value,
      preset:           els.presetSelect.value,
      crf:              parseInt(els.crfInput.value),
      resolution:       els.resolutionSelect.value,
      audioBitrate:     els.audioBitrate.value,
      audioStreamIndex: parseInt(els.audioStream.value) || 0,
      dialogueBoost:    parseFloat(els.dialogueSlider.value),
      backgroundLevel:  parseFloat(els.bgSlider.value),
      speechEnhance:    els.speechEnhance.checked,
      normalize:        els.normalizeAudio.checked
    };

    const txRes = await fetch(`${state.serverUrl}/api/transcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts)
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

// Render ffprobe JSON data into the UI (chips + audio track selector).
// Called from both the partial-probe path (on file select) and the
// full-probe path (after upload, to fill in duration/size if missing).
function renderProbeData(data) {
  const streams = data.streams || [];
  const fmt     = data.format  || {};
  const vStream = streams.find(s => s.codec_type === 'video');
  const aStreams = streams.filter(s => s.codec_type === 'audio');

  els.probeChips.innerHTML = '';

  if (vStream) {
    addChip(vStream.codec_name.toUpperCase(), 'video codec');
    if (vStream.width) addChip(`${vStream.width}×${vStream.height}`, 'resolution');
    if (vStream.r_frame_rate) {
      const [n, d] = vStream.r_frame_rate.split('/');
      const fps = Math.round((n / d) * 10) / 10;
      addChip(`${fps} fps`, 'frame rate');
    }
  }

  if (fmt.duration) addChip(fmtTime(parseFloat(fmt.duration)), 'duration');
  if (fmt.size)     addChip(formatBytes(parseInt(fmt.size)), 'file size');

  // Audio track selector
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
    if (title && title.length < 40) parts.push(`"${title}"`);

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
}

async function probeFile(jobId) {
  try {
    const r = await fetch(`${state.serverUrl}/api/probe/${jobId}`);
    if (!r.ok) throw new Error(`Probe returned ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    renderProbeData(data);
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
  }
}

function onStats({ speed, fps }) {
  if (speed !== null) els.progressSpeed.innerHTML = `Speed <span>${speed.toFixed(2)}x</span>`;
  if (fps   !== null) els.progressFps.innerHTML   = `FPS <span>${fps.toFixed(0)}</span>`;
}

function onDone({ downloadUrl }) {
  state.transcoding = false;
  els.cancelBtn.disabled = true;
  els.progressBar.style.width = '100%';
  els.progressPct.textContent = '100%';

  const fullUrl = `${state.serverUrl}${downloadUrl}`;
  els.downloadLink.href = fullUrl;
  els.downloadMeta.textContent = `Ready to download`;
  els.downloadSection.style.display = 'block';
  toast('Transcoding complete!', 'success', 6000);
}

function onTranscodeError({ message }) {
  toast(`Transcode error: ${message}`, 'error', 8000);
  resetState();
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
els.resetBtn.addEventListener('click', () => {
  state.file = null;
  state.jobId = null;
  els.fileInput.value = '';
  els.fileInfo.classList.remove('visible');
  els.probeChips.innerHTML = '';
  els.progressSection.style.display = 'none';
  els.downloadSection.style.display = 'none';
  els.transcodeBtn.disabled = true;
  state.transcoding = false;
});

function resetState() {
  state.transcoding = false;
  els.transcodeBtn.disabled = false;
  els.cancelBtn.disabled = true;
}

// ── Server URL input ──────────────────────────────────────────────────────
els.serverUrlInput.value = state.serverUrl;

els.connectBtn.addEventListener('click', () => {
  connectToServer(els.serverUrlInput.value.trim() || 'http://localhost:3000', true);
});

els.serverUrlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') els.connectBtn.click();
});

// ── Mode switching ────────────────────────────────────────────────────────
function switchMode(mode) {
  document.getElementById('single-panel').style.display = mode === 'single' ? '' : 'none';
  document.getElementById('batch-panel').style.display  = mode === 'batch'  ? '' : 'none';
  document.getElementById('tab-single').classList.toggle('active', mode === 'single');
  document.getElementById('tab-batch').classList.toggle('active',  mode === 'batch');
}

// Expose for onclick
window.switchMode = switchMode;

// ── Batch logic ───────────────────────────────────────────────────────────
const batchState = {
  files:    [],   // File objects
  items:    [],   // { jobId, filename, size, status, percent, downloadUrl }
  batchId:  null,
  running:  false
};

const batchEls = {
  dropZone:    document.getElementById('batch-drop-zone'),
  fileInput:   document.getElementById('batch-file-input'),
  queue:       document.getElementById('batch-queue'),
  queueList:   document.getElementById('batch-queue-list'),
  queueTitle:  document.getElementById('batch-queue-title'),
  summary:     document.getElementById('batch-summary'),
  startBtn:    document.getElementById('batch-start-btn'),
  cancelBtn:   document.getElementById('batch-cancel-btn'),
  clearBtn:    document.getElementById('batch-clear-btn'),
};

function addBatchFiles(files) {
  const newFiles = Array.from(files).filter(f =>
    f.type.startsWith('video/') ||
    /\.(mkv|mov|avi|wmv|flv|webm|mp4|m4v|ts|mts|m2ts|3gp|ogv|vob)$/i.test(f.name)
  );
  if (!newFiles.length) { toast('No valid video files found', 'error'); return; }

  batchState.files.push(...newFiles);
  renderBatchQueue();
  batchEls.startBtn.disabled = !state.connected || batchState.running;
  batchEls.queue.style.display = 'block';
}

function renderBatchQueue() {
  batchEls.queueTitle.textContent = `Queue (${batchState.files.length} file${batchState.files.length !== 1 ? 's' : ''})`;
  batchEls.queueList.innerHTML = '';

  batchState.files.forEach((f, i) => {
    const item = batchState.items[i] || {};
    const status  = item.status  || 'pending';
    const percent = item.percent || 0;
    const dlUrl   = item.downloadUrl || null;

    const statusIcon = { pending: '·', running: '▶', done: '✓', error: '✕', cancelled: '—' }[status] || '·';

    const row = document.createElement('div');
    row.className = 'queue-item';
    row.id = `queue-item-${i}`;
    row.innerHTML = `
      <div class="queue-status ${status}">${statusIcon}</div>
      <div class="queue-name" title="${f.name}">${f.name}</div>
      <div class="queue-size">${formatBytes(f.size)}</div>
      <div class="queue-progress">
        <div class="queue-bar-wrap"><div class="queue-bar-fill" id="qbar-${i}" style="width:${percent}%"></div></div>
        <div class="queue-pct" id="qpct-${i}">${status === 'done' ? '100%' : status === 'pending' ? '' : percent + '%'}</div>
      </div>
      <div class="queue-dl" id="qdl-${i}">
        ${dlUrl ? `<a href="${state.serverUrl}${dlUrl}" download>Download</a>` : ''}
      </div>
    `;
    batchEls.queueList.appendChild(row);
  });

  const done = batchState.items.filter(it => it.status === 'done').length;
  const total = batchState.files.length;
  if (total > 0) batchEls.summary.textContent = `${done} / ${total} done`;
}

function updateQueueItem(index, update) {
  if (!batchState.items[index]) batchState.items[index] = {};
  Object.assign(batchState.items[index], update);

  // Patch DOM without full re-render
  const status  = batchState.items[index].status  || 'pending';
  const percent = batchState.items[index].percent || 0;
  const dlUrl   = batchState.items[index].downloadUrl || null;

  const statusEl = document.querySelector(`#queue-item-${index} .queue-status`);
  const barEl    = document.getElementById(`qbar-${index}`);
  const pctEl    = document.getElementById(`qpct-${index}`);
  const dlEl     = document.getElementById(`qdl-${index}`);

  if (statusEl) {
    statusEl.className = `queue-status ${status}`;
    statusEl.textContent = { pending:'·',running:'▶',done:'✓',error:'✕',cancelled:'—' }[status]||'·';
  }
  if (barEl) barEl.style.width = `${percent}%`;
  if (pctEl) pctEl.textContent = status === 'done' ? '100%' : (percent > 0 ? percent + '%' : '');
  if (dlEl && dlUrl) dlEl.innerHTML = `<a href="${state.serverUrl}${dlUrl}" download>Download</a>`;

  const done  = batchState.items.filter(it => it && it.status === 'done').length;
  const total = batchState.files.length;
  batchEls.summary.textContent = `${done} / ${total} done`;
}

// Drag & drop
batchEls.dropZone.addEventListener('dragover', e => { e.preventDefault(); batchEls.dropZone.classList.add('drag-over'); });
batchEls.dropZone.addEventListener('dragleave', () => batchEls.dropZone.classList.remove('drag-over'));
batchEls.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  batchEls.dropZone.classList.remove('drag-over');
  addBatchFiles(e.dataTransfer.files);
});
batchEls.fileInput.addEventListener('change', () => addBatchFiles(batchEls.fileInput.files));

// Start batch
batchEls.startBtn.addEventListener('click', startBatch);

async function startBatch() {
  if (!state.connected) { toast('Not connected to server', 'error'); return; }
  if (!batchState.files.length) { toast('No files in queue', 'error'); return; }
  if (batchState.running) return;

  batchState.running = true;
  batchState.items   = [];
  batchEls.startBtn.disabled  = true;
  batchEls.cancelBtn.disabled = false;

  // 1 — Upload all files
  toast(`Uploading ${batchState.files.length} files…`);
  const formData = new FormData();
  batchState.files.forEach(f => formData.append('videos', f));

  let uploadRes;
  try {
    const r = await fetch(`${state.serverUrl}/api/batch-upload`, { method: 'POST', body: formData });
    if (!r.ok) throw new Error('Upload failed');
    uploadRes = await r.json();
  } catch (e) {
    toast(`Upload error: ${e.message}`, 'error');
    batchState.running = false;
    batchEls.startBtn.disabled = false;
    return;
  }

  batchState.batchId = uploadRes.batchId;
  // Map jobIds back to our items array
  uploadRes.items.forEach((it, i) => {
    batchState.items[i] = { jobId: it.jobId, status: 'queued', percent: 0 };
  });
  renderBatchQueue();

  // Join socket room
  state.socket.emit('join', uploadRes.batchId);

  // 2 — Start transcoding
  const transcodeOpts = {
    encoder:          els.encoderSelect.value,
    preset:           els.presetSelect.value,
    crf:              parseInt(els.crfInput.value),
    resolution:       els.resolutionSelect.value,
    audioBitrate:     els.audioBitrate.value,
    audioStreamIndex: 0,
    dialogueBoost:    parseFloat(els.dialogueSlider.value),
    backgroundLevel:  parseFloat(els.bgSlider.value),
    speechEnhance:    els.speechEnhance.checked,
    normalize:        els.normalizeAudio.checked
  };

  toast(`Batch transcode started (${batchState.files.length} files)…`);

  try {
    await fetch(`${state.serverUrl}/api/batch-transcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId:       uploadRes.batchId,
        jobIds:        uploadRes.items.map(it => it.jobId),
        transcodeOpts
      })
    });
  } catch (e) {
    toast(`Batch start error: ${e.message}`, 'error');
    batchState.running = false;
  }
}

// Cancel batch
batchEls.cancelBtn.addEventListener('click', async () => {
  if (!batchState.batchId) return;
  // Cancel the currently running job if any
  const running = batchState.items.findIndex(it => it && it.status === 'running');
  if (running >= 0 && batchState.items[running].jobId) {
    await fetch(`${state.serverUrl}/api/cancel/${batchState.items[running].jobId}`, { method: 'POST' }).catch(() => {});
  }
  batchState.running = false;
  batchEls.cancelBtn.disabled = true;
  toast('Batch cancelled');
});

// Clear queue
batchEls.clearBtn.addEventListener('click', () => {
  if (batchState.running) { toast('Stop the batch first', 'error'); return; }
  batchState.files  = [];
  batchState.items  = [];
  batchState.batchId = null;
  batchEls.queue.style.display = 'none';
  batchEls.startBtn.disabled   = true;
  batchEls.fileInput.value     = '';
});

// Batch socket events (attached once server connects)
function attachBatchSocketEvents(socket) {
  socket.on('batch:file-start', ({ index }) => {
    updateQueueItem(index, { status: 'running', percent: 0 });
  });

  socket.on('batch:progress', ({ index, percent }) => {
    updateQueueItem(index, { percent });
  });

  socket.on('batch:file-done', ({ index, downloadUrl }) => {
    updateQueueItem(index, { status: 'done', percent: 100, downloadUrl });
  });

  socket.on('batch:file-error', ({ index }) => {
    updateQueueItem(index, { status: 'error' });
  });

  socket.on('batch:done', ({ total }) => {
    batchState.running = false;
    batchEls.startBtn.disabled  = false;
    batchEls.cancelBtn.disabled = true;
    toast(`Batch complete — ${total} files transcoded`, 'success', 8000);
  });
}

// ── Get Started collapse/expand ───────────────────────────────────────────
function gsExpand(open) {
  const gs   = document.getElementById('get-started');
  const body = document.getElementById('gs-body');
  const btn  = document.getElementById('gs-toggle-btn');
  if (!gs) return;
  if (open) {
    gs.classList.remove('gs-collapsed');
    if (body) body.style.display = '';
    if (btn) btn.textContent = '▲ Hide';
  } else {
    gs.classList.add('gs-collapsed');
    if (body) body.style.display = 'none';
    if (btn) btn.textContent = '▼ Show';
  }
}
window.gsToggle = () => gsExpand(document.getElementById('get-started').classList.contains('gs-collapsed'));

// ── Init ──────────────────────────────────────────────────────────────────
(async () => {
  els.tr