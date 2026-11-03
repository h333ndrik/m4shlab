import { parseMp4 } from './parser/mp4.js';
import { moshH264 } from './mosh.js';

const fileInput = document.querySelector('#file-input');
const video = document.querySelector('#preview-video');
const emptyPreview = document.querySelector('#empty-preview');
const status = document.querySelector('#status');
const error = document.querySelector('#error');
const originalButton = document.querySelector('#show-original');
const modifiedButton = document.querySelector('#show-modified');
const exportButton = document.querySelector('#export-button');
const previewLabel = document.querySelector('#preview-label');
const reportPanel = document.querySelector('#report-panel');
const report = document.querySelector('#report');

let state = null;

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function setError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function clearMedia() {
  if (!state) return;
  URL.revokeObjectURL(state.originalUrl);
  if (state.modifiedUrl) URL.revokeObjectURL(state.modifiedUrl);
  state = null;
}

function videoErrorText() {
  if (!video.error) return 'Unknown playback failure.';
  const labels = {
    1: 'Playback was aborted.',
    2: 'A network error interrupted playback.',
    3: 'The browser could not decode the video bitstream.',
    4: 'The video format is not supported or the bitstream is damaged.',
  };
  return `${labels[video.error.code] ?? 'Playback failed.'} (media error ${video.error.code})`;
}

video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  setError(`Preview failed: ${videoErrorText()}`);
  status.textContent = 'The selected preview did not decode in this browser.';
});

video.addEventListener('loadeddata', () => {
  emptyPreview.hidden = true;
  if (!error.hidden && error.textContent.startsWith('Preview failed:')) setError('');
});

function showVersion(version) {
  if (!state) return;
  const isModified = version === 'modified';
  const nextUrl = isModified ? state.modifiedUrl : state.originalUrl;

  originalButton.setAttribute('aria-pressed', String(!isModified));
  modifiedButton.setAttribute('aria-pressed', String(isModified));
  previewLabel.textContent = isModified ? 'modified bitstream' : 'original / cut control';
  setError('');
  video.src = nextUrl;
  video.load();
}

async function loadFile(file) {
  clearMedia();
  setError('');
  reportPanel.hidden = true;
  originalButton.disabled = true;
  modifiedButton.disabled = true;
  exportButton.disabled = true;
  report.textContent = '';
  emptyPreview.hidden = false;
  emptyPreview.textContent = 'parsing bitstream…';
  video.removeAttribute('src');
  video.load();
  status.textContent = `Reading ${file.name}…`;

  try {
    const input = new Uint8Array(await file.arrayBuffer());
    const mp4 = parseMp4(input);
    const result = moshH264(input, mp4);
    const originalUrl = URL.createObjectURL(new Blob([result.cut], { type: 'video/mp4' }));
    const modifiedUrl = URL.createObjectURL(new Blob([result.output], { type: 'video/mp4' }));

    state = { file, result, originalUrl, modifiedUrl };
    video.src = originalUrl;
    emptyPreview.textContent = 'waiting for decoder…';
    originalButton.disabled = false;
    modifiedButton.disabled = !result.moshable;
    exportButton.disabled = !result.moshable;
    exportButton.onclick = () => {
      const link = document.createElement('a');
      link.href = modifiedUrl;
      link.download = 'm4shlab-export.mp4';
      link.click();
    };

    const { width, height, samples } = mp4.videoTrack;
    status.textContent = `${file.name} · ${width}×${height} · ${samples.length} video samples · ${formatBytes(input.byteLength)}`;
    previewLabel.textContent = 'original / cut control';
    report.textContent = JSON.stringify({
      ...result.report,
      cutByteIdentical: result.cut.byteLength === input.byteLength && result.cut.every((value, index) => value === input[index]),
    }, null, 2);
    reportPanel.hidden = false;

    if (!result.moshable) {
      setError('This clip has fewer than two IDRs, so there is no later GOP boundary to mosh at. The original is still available.');
      modifiedButton.disabled = true;
      exportButton.disabled = true;
    }
  } catch (cause) {
    clearMedia();
    status.textContent = 'No modified video created.';
    emptyPreview.hidden = false;
    emptyPreview.textContent = 'load an H.264 MP4 to begin';
    setError(cause instanceof Error ? cause.message : String(cause));
  }
}

fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  if (file) loadFile(file);
});
originalButton.addEventListener('click', () => showVersion('original'));
modifiedButton.addEventListener('click', () => showVersion('modified'));
