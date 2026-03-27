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
const clearBtn = document.getElementById('clear-btn');

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
/** Text that existed before the current transcription started. */
let baseTranscript = '';
let hasByteProgress = false;

function setStatus(msg) {
  statusMsg.textContent = msg;
}

function setRecordEnabled(enabled) {
  recordBtn.disabled = !enabled;
}

const MODEL_STORAGE_KEY = 'voice-selected-model';

// Restore last-used model from localStorage
const savedModel = localStorage.getItem(MODEL_STORAGE_KEY);
if (savedModel && modelSelectEl.querySelector(`option[value="${CSS.escape(savedModel)}"]`)) {
  modelSelectEl.value = savedModel;
}

function getSelectedModel() {
  return modelSelectEl.value;
}

function saveSelectedModel() {
  localStorage.setItem(MODEL_STORAGE_KEY, modelSelectEl.value);
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
  // Show loading UI immediately; the actual preload message is sent once the
  // worker signals its ESM module has loaded (see 'worker-ready' in handler).
  isModelLoading = true;
  modelLoadingEl.hidden = false;
  modelProgressLabelEl.textContent = 'Loading transcription engine…';
}

/** Reset progress state and tell the worker to start loading the selected model. */
function requestModelLoad() {
  isModelReady = false;
  isModelLoading = true;
  modelLoadingEl.hidden = false;
  modelProgressEl.value = 0;
  fileProgress.clear();
  filesInitiated = 0;
  filesDone = 0;
  hasByteProgress = false;
  modelProgressLabelEl.textContent = 'Loading model…';
  setStatus('Loading model…');
  worker.postMessage({ model: getSelectedModel() });
}

function sendToWorker(float32Array) {
  console.log('[voice] sendToWorker, audio length:', float32Array.length, 'model:', getSelectedModel());
  isTranscribing = true;
  // Snapshot existing text so new results append after it
  baseTranscript = transcriptOutputEl.textContent;
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
  if (pct >= 100) {
    modelProgressLabelEl.textContent = 'Initializing model…';
  } else {
    modelProgressLabelEl.textContent = `Loading model: ${Math.round(pct)}%`;
  }
}

function updateActionButtons() {
  const hasText = !!transcriptOutputEl.textContent;
  copyBtn.hidden = !hasText;
  clearBtn.hidden = !hasText;
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

    case 'update': {
      const partial = typeof data === 'string' ? data : '';
      const sep = baseTranscript ? '\n' : '';
      transcriptOutputEl.textContent = baseTranscript + sep + partial;
      transcribingEl.hidden = false;
      updateActionButtons();
      break;
    }

    case 'complete': {
      const text = typeof data === 'string' ? data : '';
      const sep = baseTranscript ? '\n' : '';
      const fullText = text ? baseTranscript + sep + text : baseTranscript;
      transcriptOutputEl.textContent = fullText;
      transcribingEl.hidden = true;
      isTranscribing = false;
      setRecordEnabled(true);
      modelSelectEl.disabled = false;
      updateActionButtons();
      if (fullText) {
        navigator.clipboard.writeText(fullText).then(
          () => setStatus('Transcription complete — copied to clipboard'),
          () => setStatus('Transcription complete'),
        );
      } else {
        setStatus('Transcription complete');
      }
      break;
    }

    case 'error':
      transcribingEl.hidden = true;
      isTranscribing = false;
      setRecordEnabled(true);
      modelSelectEl.disabled = false;
      setStatus(`Error: ${data ?? 'Unknown error'}`);
      break;

    default:
      if (msg.type === 'worker-ready') {
        // ESM module loaded — now safe to send messages to the worker.
        console.log('[voice] worker ESM ready, sending preload');
        requestModelLoad();
      } else {
        console.log('[voice] unhandled worker message status:', status, 'type:', msg.type);
      }
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

clearBtn.addEventListener('click', () => {
  transcriptOutputEl.textContent = '';
  updateActionButtons();
});

// Keep buttons in sync when user manually edits the transcript
transcriptOutputEl.addEventListener('input', () => {
  updateActionButtons();
});

// When model changes, persist choice and immediately start loading the new model
modelSelectEl.addEventListener('change', () => {
  saveSelectedModel();
  if (worker && !isRecording && !isTranscribing) {
    requestModelLoad();
  }
});

// Start the worker and begin loading the model on page load
ensureWorker();

initAppMenu();
