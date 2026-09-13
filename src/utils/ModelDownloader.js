import * as FileSystem from 'expo-file-system/legacy';

const MODEL_URL =
  'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf';
const MODEL_DIR = FileSystem.documentDirectory + 'models/';
const MODEL_FILENAME = 'Phi-3-mini-4k-instruct-q4.gguf';
const MODEL_PATH = MODEL_DIR + MODEL_FILENAME;

export function getModelPath() {
  return MODEL_PATH;
}

export async function isModelDownloaded() {
  const info = await FileSystem.getInfoAsync(MODEL_PATH);
  return info.exists && info.size > 0;
}

export async function downloadModel(onProgress) {
  const dirInfo = await FileSystem.getInfoAsync(MODEL_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(MODEL_DIR, { intermediates: true });
  }

  const alreadyDownloaded = await isModelDownloaded();
  if (alreadyDownloaded) {
    onProgress?.(1);
    return MODEL_PATH;
  }

  const downloadResumable = FileSystem.createDownloadResumable(
    MODEL_URL,
    MODEL_PATH,
    {},
    (progressEvent) => {
      const progress =
        progressEvent.totalBytesExpectedToWrite > 0
          ? progressEvent.totalBytesWritten / progressEvent.totalBytesExpectedToWrite
          : 0;
      onProgress?.(progress);
    }
  );

  try {
    const result = await downloadResumable.downloadAsync();
    if (!result || !result.uri) {
      throw new Error('Download did not complete');
    }
    return result.uri;
  } catch (err) {
    await FileSystem.deleteAsync(MODEL_PATH, { idempotent: true });
    throw err;
  }
}
