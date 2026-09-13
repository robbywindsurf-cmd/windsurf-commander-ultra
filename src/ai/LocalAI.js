import { initLlama } from 'llama.rn';
import { isModelDownloaded, getModelPath } from './ModelManager';

const MAX_TOKENS = 512;
const TEMPERATURE = 0.7;
const STOP_TOKENS = ['<|end|>', '<|user|>'];

let context = null;
let loadPromise = null;

async function loadContext() {
  if (context) return context;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const modelPath = getModelPath();
    context = await initLlama({
      model: modelPath,
      n_ctx: 2048,
      n_threads: 4,
      use_mlock: false,
    });
    return context;
  })();

  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function buildPrompt(userMessage) {
  return `<|user|>\n${userMessage}<|end|>\n<|assistant|>\n`;
}

export async function generate(userMessage) {
  const downloaded = await isModelDownloaded();
  if (!downloaded) {
    throw new Error('Local AI model is not downloaded yet.');
  }

  const ctx = await loadContext();
  const { text } = await ctx.completion({
    prompt: buildPrompt(userMessage),
    n_predict: MAX_TOKENS,
    temperature: TEMPERATURE,
    stop: STOP_TOKENS,
  });
  return text.trim();
}

export async function release() {
  if (context) {
    await context.release();
    context = null;
  }
}
