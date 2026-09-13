import {
  isModelDownloaded as checkModelDownloaded,
  downloadModel as runDownload,
  getModelPath as resolveModelPath,
} from '../utils/ModelDownloader';

export function isModelDownloaded() {
  return checkModelDownloaded();
}

export function downloadModel(onProgress) {
  return runDownload(onProgress);
}

export function getModelPath() {
  return resolveModelPath();
}
