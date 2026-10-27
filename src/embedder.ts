import { env, pipeline } from "@huggingface/transformers";

// Models are fetched from the Hugging Face Hub on first use and kept in the browser Cache API,
// so the download only happens once per model.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
// The plugin iframe is not cross-origin isolated, so multi-threaded WASM is unavailable.
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;

type Extractor = (text: string, opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array }>;

let extractor: Extractor | null = null;
let loadedId = "";
let loading: Promise<void> | null = null;

export type Progress = (info: { status: string; file?: string; progress?: number }) => void;

export function ensureModel(modelId: string, onProgress?: Progress): Promise<void> {
  if (extractor && loadedId === modelId) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    extractor = null;
    const p = await pipeline("feature-extraction", modelId, {
      dtype: "q8",
      device: "wasm",
      progress_callback: onProgress as never,
    });
    extractor = p as unknown as Extractor;
    loadedId = modelId;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

// Embedding calls are serialised: the WASM session is not re-entrant.
let queue: Promise<unknown> = Promise.resolve();

export function embed(text: string): Promise<Float32Array> {
  const job = queue.then(async () => {
    if (!extractor) throw new Error("Embedding model not loaded");
    const out = await extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(out.data);
  });
  queue = job.catch(() => undefined);
  return job;
}

// Vectors are L2-normalised, so cosine similarity is just the dot product.
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
