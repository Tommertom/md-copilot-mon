import { initAppMenu } from '/shared.js';

// DOM refs
const recordBtn = document.getElementById('record-btn');
const stopBtn = document.getElementById('stop-btn');
const statusMsg = document.getElementById('status-message');
const modelLoadingEl = document.getElementById('model-loading');
const modelProgressEl = document.getElementById('model-progress');
const modelProgressLabelEl = document.getElementById('model-progress-label');
const transcribingEl = document.getElementById('transcribing-indicator');
const transcriptOutputEl = document.getElementById('transcript-output');
const modelSelectEl = document.getElementById('model-select');
const copyBtn = document.getElementById('copy-btn');

// State
let worker = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let isTranscribing = false;
let isModelReady = false;
let isModelLoading = false;
/** @type {Float32Array|null} Audio waiting to be transcribed if model is still loading. */
let pendingAudio = null;
/** @type {Map<string, {loaded: number, total: number}>} Per-file download progress */
const fileProgress = new Map();
/** Track files that completed so we can show progress even for cached models */
let filesInitiated = 0;
let filesDone = 0;
/** True if at least one 'progress' event with byte info was received */
let hasByteProgress = false;

function setStatus(msg) {
  statusMsg.textContent = msg;
}

function setRecordEnabled(enabled) {
  recordBtn.disabled = !enabled;
}

function getSelectedModel() {
  return modelSelectEl.value;
}

/**
 * Creates a worker with Safari compatibility.
 * Safari doesn't support type:'module' workers, but does support dynamic
 * import() in classic workers. We wrap the ESM module in a blob that uses
 * dynamic import so it works everywhere.
 * The wrapper posts { type: 'worker-ready' } once the module has loaded.
 */
function createCompatibleWorker(moduleUrl) {
  const absoluteUrl = new URL(moduleUrl, location.href).href;
  const blob = new Blob(
    [`import("${absoluteUrl}").then(() => self.postMessage({ type: "worker-ready" }));`],
    { type: 'text/javascript' },
  );
  const blobUrl = URL.createObjectURL(blob);
  const w = new Worker(blobUrl);
  URL.revokeObjectURL(blobUrl);
  return w;
}

function ensureWorker() {
  if (worker) return;
  console.log('[voice] creating worker');
  worker = createCompatibleWorker('/voice/worker.js');
  worker.addEventListener('message', handleWorkerMessage);
  worker.addEventListener('error', (event) => {
    console.error('Worker error:', event);
    isModelLoading = false;
    modelLoadingEl.hidden = true;
    transcribingEl.hidden = true;
    isTranscribing = false;
    setRecordEnabled(true);
    modelSelectEl.disabled = false;
    setStatus('Failed to load transcription engine. Check browser console for details.');
  });
  // Start model download immediately (don't wait for audio).
  // The message is queued until the worker's ESM module finishes importing.
  isModelLoading = true;
  modelLoadingEl.hidden = false;
  modelProgressLabelEl.textContent = 'Loading transcription engine…';
  worker.postMessage({ model: getSelectedModel() });
}

function sendToWorker(float32Array) {
  console.log('[voice] sendToWorker, audio length:', float32Array.length, 'model:', getSelectedModel());
  isTranscribing = true;
  transcribingEl.hidden = false;
  setRecordEnabled(false);
  setStatus('Transcribing…');
  worker.postMessage({
    audio: float32Array,
    model: getSelectedModel(),
    multilingual: false,
    quantized: false,
    subtask: null,
    language: null,
  });
}

function updateAggregateProgress() {
  let pct = 0;
  if (hasByteProgress) {
    // Use byte-level progress (precise)
    let totalLoaded = 0;
    let totalSize = 0;
    for (const entry of fileProgress.values()) {
      totalLoaded += entry.loaded;
      totalSize += entry.total;
    }
    pct = totalSize > 0 ? (totalLoaded / totalSize) * 100 : 0;
  } else if (filesInitiated > 0) {
    // Fallback: use file completion count (for cached models)
    pct = (filesDone / filesInitiated) * 100;
  }
  console.log('[voice] aggregate progress:', Math.round(pct) + '%',
    'hasByteProgress:', hasByteProgress, 'filesInitiated:', filesInitiated, 'filesDone:', filesDone);
  modelProgressEl.value = pct;
  modelProgressLabelEl.textContent = `Loading model: ${Math.round(pct)}%`;
}

function updateCopyButton() {
  copyBtn.hidden = !transcriptOutputEl.textContent;
}

/** @param {MessageEvent} event */
function handleWorkerMessage(event) {
  const msg = event.data;
  console.log('[voice] worker message:', JSON.stringify(msg));
  const { status, data, file, loaded, total, progress } = msg;

  switch (status) {
    case 'initiate':
      isModelLoading = true;
      modelLoadingEl.hidden = false;
      filesInitiated++;
      if (file) {
        fileProgress.set(file, { loaded: 0, total: 0 });
      }
      modelProgressLabelEl.textContent = 'Loading model files…';
      break;

    case 'progress':
      console.log('[voice] progress event — file:', file, 'loaded:', loaded, 'total:', total, 'progress:', progress);
      if (file && typeof loaded === 'number' && typeof total === 'number' && total > 0) {
        hasByteProgress = true;
        fileProgress.set(file, { loaded, total });
        updateAggregateProgress();
      } else if (typeof progress === 'number' && file) {
        // Fallback: some versions report only 0-100 per file
        hasByteProgress = true;
        fileProgress.set(file, { loaded: progress, total: 100 });
        updateAggregateProgress();
      }
      break;

    case 'done':
      filesDone++;
      if (file) {
        const entry = fileProgress.get(file);
        if (entry && entry.total > 0) {
          entry.loaded = entry.total;
        }
      }
      updateAggregateProgress();
      break;

    case 'ready':
      isModelReady = true;
      isModelLoading = false;
      modelLoadingEl.hidden = true;
      modelProgressEl.value = 0;
      fileProgress.clear();
      filesInitiated = 0;
      filesDone = 0;
      hasByteProgress = false;
      if (!isRecording && !isTranscribing) {
        setStatus('Ready to record');
      }
      if (pendingAudio) {
        sendToWorker(pendingAudio);
        pendingAudio = null;
      }
      break;

    case 'update':
      transcriptOutputEl.textContent = typeof data === 'string' ? data : '';
      transcribingEl.hidden = false;
      updateCopyButton();
      break;

    case 'complete':
      transcriptOutputEl.textContent = typeof data === 'string' ? data : '';
      transcribingEl.hidden = true;
      isTranscribing = false;
      setRecordEnabled(true);
      modelSelectEl.disabled = false;
      setStatus('Transcription complete');
      updateCopyButton();
      break;

    case 'error':
      transcribingEl.hidden = true;
      isTranscribing = false;
      setRecordEnabled(true);
      modelSelectEl.disabled = false;
      setStatus(`Error: ${data ?? 'Unknown error'}`);
      break;

    default:
      console.log('[voice] unhandled worker message status:', status, 'type:', msg.type);
      break;
  }
}

/**
 * Combines raw MediaRecorder chunks into a Float32Array resampled at 16 kHz,
 * which is the sample rate Whisper expects.
 * @param {Blob[]} chunks
 * @returns {Promise<Float32Array>}
 */
async function processAudio(chunks) {
  if (chunks.length === 0) {
    throw new Error('No audio was captured. Try recording for longer.');
  }

  const blob = new Blob(chunks);
  const arrayBuffer = await blob.arrayBuffer();

  const audioCtx = new AudioContext();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);

    const targetSampleRate = 16000;
    const numFrames = Math.max(1, Math.ceil(decoded.duration * targetSampleRate));
    const offlineCtx = new OfflineAudioContext(1, numFrames, targetSampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start();

    const resampled = await offlineCtx.startRendering();
    return resampled.getChannelData(0);
  } finally {
    audioCtx.close();
  }
}

recordBtn.addEventListener('click', async () => {
  if (isRecording || isTranscribing) return;

  // Disable button while waiting for mic permission to avoid double-click races
  setRecordEnabled(false);
  setStatus('Requesting microphone access…');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    });

    mediaRecorder.start();
    isRecording = true;

    recordBtn.hidden = true;
    stopBtn.hidden = false;
    stopBtn.classList.add('recording');
    modelSelectEl.disabled = true;

    setStatus('Recording… click Stop when done');

    // Create the worker once; it starts loading the model immediately
    ensureWorker();
  } catch (error) {
    setRecordEnabled(true);
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      setStatus('Microphone access denied. Please allow microphone access and try again.');
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      setStatus('No microphone found. Please connect a microphone and try again.');
    } else {
      setStatus(`Could not start recording: ${error.message}`);
      console.error('getUserMedia error:', error);
    }
  }
});

stopBtn.addEventListener('click', () => {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

  mediaRecorder.onstop = async () => {
    // Release the microphone
    mediaRecorder.stream.getTracks().forEach((track) => track.stop());

    isRecording = false;
    recordBtn.hidden = false;
    stopBtn.hidden = true;
    stopBtn.classList.remove('recording');

    setStatus('Processing audio…');

    try {
      const float32Array = await processAudio(audioChunks);

      if (isModelReady) {
        sendToWorker(float32Array);
      } else {
        // Stash audio; sendToWorker is called when worker posts 'ready'
        pendingAudio = float32Array;
        setStatus(
          isModelLoading
            ? 'Model loading — will transcribe when ready…'
            : 'Loading model, please wait…',
        );
      }
    } catch (error) {
      setRecordEnabled(true);
      modelSelectEl.disabled = false;
      setStatus(`Error processing audio: ${error.message}`);
      console.error('processAudio error:', error);
    }
  };

  mediaRecorder.stop();
});

copyBtn.addEventListener('click', async () => {
  const text = transcriptOutputEl.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const orig = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = orig; }, 1500);
  } catch {
    setStatus('Failed to copy — try selecting the text manually.');
  }
});

// When model changes, reset readiness so the new model is loaded on next record
modelSelectEl.addEventListener('change', () => {
  isModelReady = false;
  isModelLoading = false;
  modelLoadingEl.hidden = true;
  modelProgressEl.value = 0;
  fileProgress.clear();
  filesInitiated = 0;
  filesDone = 0;
  hasByteProgress = false;
});

initAppMenu();
