// Local model management: SenseVoice ASR and CAM++ speaker embedding.
//
// Auto-download uses the providers' official downloaders.  When that fails,
// the user can download the files in a browser and give this module the local
// path; files are verified, copied into the plugin's own `models/` directory,
// and (for SenseVoice) also into the DSH speech-provider cache so the existing
// provider can load them without changing the profile.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SPEAKER_MODEL, verifySpeakerModel } from './speaker.mjs';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MODELS_ROOT = path.join(PLUGIN_ROOT, 'models');

export const ASR_ASSETS = Object.freeze({
  model: {
    name: 'model.int8.onnx',
    bytes: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
    page: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/main'
  },
  tokens: {
    name: 'tokens.txt',
    bytes: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
    page: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/main'
  },
  vad: {
    name: 'silero_vad.onnx',
    bytes: 1807522,
    sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
    url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
    page: 'https://huggingface.co/csukuangfj/vad/tree/main'
  }
});

const ASR_MODEL_PAGE = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/main';
const ASR_VAD_PAGE = 'https://huggingface.co/csukuangfj/vad/tree/main';

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function asrCacheRoot() {
  return process.env.DSH_SPEECH_DATA_ROOT || path.join(homeDir(), '.dsh', 'speech-to-text', 'sensevoice');
}

/** Plugin-owned model directory; fall back to the meeting data directory if read-only. */
export async function modelsRoot(dataRoot) {
  const candidates = [DEFAULT_MODELS_ROOT, path.join(dataRoot, '.models', 'plugin')];
  for (const candidate of candidates) {
    try {
      await fsp.mkdir(candidate, { recursive: true });
      await fsp.access(candidate, fs.constants.W_OK);
      return candidate;
    } catch {
      // try the next location
    }
  }
  throw Object.assign(new Error('没有可写的模型目录'), { code: 'MODEL_DIR_UNWRITABLE', status: 500 });
}

export function speakerModelPath(root) {
  return path.join(root, 'speaker', SPEAKER_MODEL.name);
}

export function asrModelPaths(root) {
  return {
    model: path.join(root, 'asr', ASR_ASSETS.model.name),
    tokens: path.join(root, 'asr', ASR_ASSETS.tokens.name),
    vad: path.join(root, 'asr', ASR_ASSETS.vad.name)
  };
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function verifyFile(file, asset) {
  try {
    const stat = await fsp.stat(file);
    if (stat.isFile() !== true || stat.size !== asset.bytes) return false;
    return (await sha256File(file)) === asset.sha256;
  } catch {
    return false;
  }
}

function sameName(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

async function walkFiles(root, depth = 0, out = []) {
  if (out.length > 4000 || depth > 6) return out;
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(full, depth + 1, out);
    else if (entry.isFile()) out.push(full);
    if (out.length > 4000) break;
  }
  return out;
}

/** Find each wanted filename under a file or directory path. */
async function locate(sources, wanted) {
  const found = new Map();
  const files = [];
  for (const source of sources) {
    const resolved = path.resolve(String(source || ''));
    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      files.push(resolved);
      await walkFiles(path.dirname(resolved), 0, files);
    } else if (stat.isDirectory()) {
      await walkFiles(resolved, 0, files);
    }
  }
  for (const name of wanted) {
    const match = files.find((file) => sameName(path.basename(file), name));
    if (match) found.set(name, match);
  }
  return found;
}

async function copyOrLink(source, target) {
  if (path.resolve(source) === path.resolve(target)) return;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.link(source, target);
  } catch {
    await fsp.copyFile(source, target);
  }
  await fsp.chmod(target, 0o644).catch(() => {});
}

/** Status for the model-management UI; cheap stat checks only. */
export async function modelStatus(dataRoot, asrSnapshot) {
  const root = await modelsRoot(dataRoot);
  const speaker = speakerModelPath(root);
  const legacySpeaker = path.join(dataRoot, '.models', SPEAKER_MODEL.name);
  const asr = asrModelPaths(root);
  const cache = {
    model: path.join(asrCacheRoot(), 'models', 'sensevoice-onnx', ASR_ASSETS.model.name),
    tokens: path.join(asrCacheRoot(), 'models', 'sensevoice-onnx', ASR_ASSETS.tokens.name),
    vad: path.join(asrCacheRoot(), 'models', 'silero', ASR_ASSETS.vad.name)
  };
  const speakerStat = await fsp.stat(speaker).catch(() => null);
  const legacySpeakerStat = await fsp.stat(legacySpeaker).catch(() => null);
  const speakerReady = Boolean((speakerStat && speakerStat.size === SPEAKER_MODEL.bytes)
    || (legacySpeakerStat && legacySpeakerStat.size === SPEAKER_MODEL.bytes));
  const asrStat = await fsp.stat(asr.model).catch(() => null);
  const tokensStat = await fsp.stat(asr.tokens).catch(() => null);
  const vadStat = await fsp.stat(asr.vad).catch(() => null);
  const cacheModelStat = await fsp.stat(cache.model).catch(() => null);
  const cacheTokensStat = await fsp.stat(cache.tokens).catch(() => null);
  const cacheVadStat = await fsp.stat(cache.vad).catch(() => null);
  const complete = (model, tokens, vad) => Boolean(model && tokens && vad
    && model.size === ASR_ASSETS.model.bytes
    && tokens.size === ASR_ASSETS.tokens.bytes
    && vad.size === ASR_ASSETS.vad.bytes);
  const asrReady = complete(asrStat, tokensStat, vadStat) || complete(cacheModelStat, cacheTokensStat, cacheVadStat);
  return {
    modelsRoot: root,
    asrCacheRoot: asrCacheRoot(),
    models: [
      {
        id: 'asr',
        name: 'SenseVoice 语音识别',
        detail: '约 240 MB · 本地离线转写',
        phase: asrSnapshot?.phase || 'unknown',
        ready: asrReady,
        downloaded: asrReady,
        sizeBytes: ASR_ASSETS.model.bytes + ASR_ASSETS.tokens.bytes + ASR_ASSETS.vad.bytes,
        paths: asr,
        cache,
        downloadPage: ASR_MODEL_PAGE,
        downloadPages: [ASR_MODEL_PAGE, ASR_VAD_PAGE],
        files: [
          { name: ASR_ASSETS.model.name, bytes: ASR_ASSETS.model.bytes, url: ASR_ASSETS.model.url },
          { name: ASR_ASSETS.tokens.name, bytes: ASR_ASSETS.tokens.bytes, url: ASR_ASSETS.tokens.url },
          { name: ASR_ASSETS.vad.name, bytes: ASR_ASSETS.vad.bytes, url: ASR_ASSETS.vad.url }
        ]
      },
      {
        id: 'speaker',
        name: 'CAM++ 声纹模型',
        detail: '约 27 MB · 按音色区分发言人',
        phase: speakerReady ? 'ready' : 'missing',
        ready: speakerReady,
        downloaded: speakerReady,
        sizeBytes: SPEAKER_MODEL.bytes,
        paths: { model: speaker, legacy: legacySpeaker },
        downloadPage: SPEAKER_MODEL.urls[0],
        downloadPages: SPEAKER_MODEL.urls,
        files: [{ name: SPEAKER_MODEL.name, bytes: SPEAKER_MODEL.bytes, url: SPEAKER_MODEL.urls[0] }]
      }
    ]
  };
}

/**
 * Import a manually downloaded model.
 * @param {'asr'|'speaker'} id
 * @param {string|string[]} sourcePath file or directory (or several paths).
 */
export async function importModel(id, sourcePath, dataRoot) {
  const root = await modelsRoot(dataRoot);
  const sources = Array.isArray(sourcePath) ? sourcePath : [sourcePath];
  if (sources.length === 0 || sources.every((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw Object.assign(new Error('请填写下载后的模型文件或所在目录的绝对路径'), { code: 'MODEL_PATH_EMPTY', status: 400 });
  }
  if (id === 'speaker') {
    const located = await locate(sources, [SPEAKER_MODEL.name]);
    const source = located.get(SPEAKER_MODEL.name);
    if (!source) {
      throw Object.assign(new Error(`没有找到 ${SPEAKER_MODEL.name}；请选择模型文件，或包含该文件的目录`), {
        code: 'MODEL_FILES_MISSING', status: 422
      });
    }
    if (!(await verifyFile(source, SPEAKER_MODEL)) && !(await verifySpeakerModel(source))) {
      throw Object.assign(new Error('声纹模型校验失败（文件大小或 SHA-256 不匹配）'), { code: 'MODEL_INVALID', status: 422 });
    }
    const target = speakerModelPath(root);
    await copyOrLink(source, target);
    return { ok: true, id, target, copied: [target], modelsRoot: root };
  }

  if (id === 'asr') {
    const located = await locate(sources, [ASR_ASSETS.model.name, ASR_ASSETS.tokens.name, ASR_ASSETS.vad.name]);
    const missing = [ASR_ASSETS.model.name, ASR_ASSETS.tokens.name, ASR_ASSETS.vad.name]
      .filter((name) => !located.has(name));
    if (missing.length > 0) {
      throw Object.assign(new Error(`缺少模型文件：${missing.join('、')}。请选择包含这些文件的目录，或分别选择文件`), {
        code: 'MODEL_FILES_MISSING',
        status: 422,
        missing
      });
    }
    for (const asset of [ASR_ASSETS.model, ASR_ASSETS.tokens, ASR_ASSETS.vad]) {
      if (!(await verifyFile(located.get(asset.name), asset))) {
        throw Object.assign(new Error(`${asset.name} 校验失败（文件大小或 SHA-256 不匹配）`), {
          code: 'MODEL_INVALID', status: 422
        });
      }
    }
    const targets = asrModelPaths(root);
    const cache = {
      model: path.join(asrCacheRoot(), 'models', 'sensevoice-onnx', ASR_ASSETS.model.name),
      tokens: path.join(asrCacheRoot(), 'models', 'sensevoice-onnx', ASR_ASSETS.tokens.name),
      vad: path.join(asrCacheRoot(), 'models', 'silero', ASR_ASSETS.vad.name)
    };
    for (const asset of [ASR_ASSETS.model, ASR_ASSETS.tokens, ASR_ASSETS.vad]) {
      const key = asset.name === ASR_ASSETS.vad.name ? 'vad' : asset.name === ASR_ASSETS.tokens.name ? 'tokens' : 'model';
      await copyOrLink(located.get(asset.name), targets[key]);
      await copyOrLink(located.get(asset.name), cache[key]);
    }
    return { ok: true, id, target: targets.model, copied: Object.values(targets).concat(Object.values(cache)), modelsRoot: root };
  }
  throw Object.assign(new Error('未知的模型类型'), { code: 'MODEL_UNKNOWN', status: 400 });
}

export { verifyFile, asrCacheRoot, DEFAULT_MODELS_ROOT };
