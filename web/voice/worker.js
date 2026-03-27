/**
 * Whisper transcription worker using @xenova/transformers.
 *
 * Messages accepted:
 *   { model, multilingual, quantized }                          — preload model
 *   { audio: Float32Array, model, multilingual, quantized, … }  — transcribe
 *
 * Outbound messages:
 *   { status: 'initiate'|'progress'|'done', … }  — progress_callback pass-through
 *   { status: 'ready' }                           — model fully loaded
 *   { status: 'update', data: string }            — partial transcript
 *   { status: 'complete', data: string }          — final transcript text
 *   { status: 'error', data: string }             — error message
 */
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

/**
 * Returns the actual model ID to load.
 * Non-multilingual whisper models append ".en" for a smaller, English-only
 * variant.
 */
function resolveModelId(model, multilingual) {
    const isDistilWhisper = model.startsWith("distil-whisper/");
    return !isDistilWhisper && !multilingual ? model + ".en" : model;
}

let activeModelId = null;
let transcriberReady = null;

/**
 * Loads (or reloads) the ASR pipeline and returns a Promise that resolves to
 * the transcriber instance.  Posts { status: 'ready' } on success.
 */
function loadModel(modelId, quantized) {
    console.log('[worker] loadModel:', modelId, 'quantized:', quantized);
    return pipeline("automatic-speech-recognition", modelId, {
        progress_callback: (data) => {
            console.log('[worker] progress_callback:', JSON.stringify(data));
            self.postMessage(data);
        },
        quantized,
    }).then((transcriber) => {
        console.log('[worker] model loaded, posting ready');
        self.postMessage({ status: "ready" });
        return transcriber;
    }).catch((err) => {
        console.error('[worker] model load error:', err);
        self.postMessage({ status: "error", data: err.message ?? String(err) });
        return null;
    });
}

self.addEventListener("message", async (event) => {
    console.log('[worker] received message, keys:', Object.keys(event.data));
    const {
        audio,
        model = "Xenova/whisper-tiny",
        multilingual = false,
        quantized = false,
        subtask = null,
        language = null,
    } = event.data;

    const modelId = resolveModelId(model, multilingual);

    // Load or reload if the requested model differs
    if (modelId !== activeModelId) {
        activeModelId = modelId;
        transcriberReady = loadModel(modelId, quantized);
    }

    // If no audio, this was a preload-only request
    if (!audio) return;

    const transcriber = await transcriberReady;
    if (!transcriber) {
        self.postMessage({ status: "error", data: "Model failed to load" });
        return;
    }

    const isDistilWhisper = model.startsWith("distil-whisper/");

    try {
        const result = await transcriber(audio, {
            top_k: 0,
            do_sample: false,
            chunk_length_s: isDistilWhisper ? 20 : 30,
            stride_length_s: isDistilWhisper ? 3 : 5,
            return_timestamps: true,
            force_full_sequences: false,
            language,
            task: subtask,
            callback_function: (beams) => {
                if (!beams.length || !beams[0].output_token_ids) return;
                const partial = transcriber.tokenizer.decode(
                    beams[0].output_token_ids,
                    { skip_special_tokens: true },
                );
                self.postMessage({ status: "update", data: partial });
            },
        });

        self.postMessage({ status: "complete", data: result.text ?? "" });
    } catch (err) {
        self.postMessage({ status: "error", data: err.message ?? String(err) });
    }
});
