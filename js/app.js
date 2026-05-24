/**
 * app.js — UI logic & pipeline orchestration
 * Watermark Robustness Research Stand
 */

let origCanvas = null;
let resultCanvas = null;
let currentStep = 0;
let lastParams = {};
let lastMetrics = {};

const stepParamIds = ['params-lsb','params-crop','params-jpeg','params-jitter','params-upscale'];
const stepNames = [
  'LSB-рандомизация',
  'Кроп + Ресайз + Сдвиг',
  'JPEG-пересжатие',
  'Color Jitter',
  'Upscale → Downscale'
];

// ─── Tab switching ───────────────────────────────────────────
function switchTab(name, el) {
  document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
  document.getElementById('tab-' + name).style.display = '';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
}

// ─── Step selection ──────────────────────────────────────────
function selectStep(n) {
  currentStep = n;
  document.querySelectorAll('.step-item').forEach((s, i) => {
    s.classList.toggle('active', i === n);
  });
  stepParamIds.forEach((id, i) => {
    document.getElementById(id).style.display = i === n ? '' : 'none';
  });
  document.getElementById('active-step-name').textContent = stepNames[n];
}

// ─── File handling ───────────────────────────────────────────
document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadFile(file);
  e.target.value = '';
});

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = 'var(--accent)'; });
dropZone.addEventListener('dragleave', () => dropZone.style.borderColor = '');
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.style.borderColor = '';
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadFile(file);
});

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      origCanvas = document.createElement('canvas');
      origCanvas.width = img.width;
      origCanvas.height = img.height;
      origCanvas.getContext('2d').drawImage(img, 0, 0);
      resultCanvas = null;

      document.getElementById('preview-orig').src = ev.target.result;
      document.getElementById('upload-placeholder').style.display = 'none';
      document.getElementById('upload-preview').style.display = '';
      document.getElementById('img-meta').textContent =
        img.width + '×' + img.height + ' px · ' + (file.size / 1024).toFixed(1) + ' КБ';

      document.getElementById('result-area').style.display = 'none';
      document.querySelectorAll('.step-item').forEach(s => s.classList.remove('done'));
      setProgress(0);
      clearLog();
      log('Загружено: ' + img.width + '×' + img.height + ' · ' + file.name, 'ok');
      setStatus('idle', 'Готов');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

// ─── Logging ─────────────────────────────────────────────────
function log(msg, type = 'info') {
  const panel = document.getElementById('log');
  const line = document.createElement('div');
  const now = new Date();
  const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
  line.className = 'log-' + type;
  line.textContent = '[' + ts + '] ' + msg;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}
function clearLog() { document.getElementById('log').innerHTML = ''; }

// ─── Progress & Status ────────────────────────────────────────
function setProgress(pct) {
  document.getElementById('progress').style.width = pct + '%';
}
function setStatus(state, text) {
  const dot = document.querySelector('.dot');
  dot.className = 'dot ' + state;
  document.getElementById('status-text').textContent = text;
}

// ─── Get params ───────────────────────────────────────────────
function getParams() {
  return {
    seed:    parseInt(document.getElementById('p-seed').value),
    crop:    parseInt(document.getElementById('p-crop').value),
    shiftX:  parseInt(document.getElementById('p-shiftx').value),
    shiftY:  parseInt(document.getElementById('p-shifty').value),
    quality: parseInt(document.getElementById('p-quality').value),
    delta:   parseInt(document.getElementById('p-delta').value),
    upscale: parseInt(document.getElementById('p-upscale').value),
  };
}

// ─── Run full pipeline ────────────────────────────────────────
async function runPipeline() {
  if (!origCanvas) { log('Загрузите изображение', 'warn'); return; }

  const btn = document.getElementById('btn-run');
  btn.disabled = true;
  clearLog();
  setStatus('running', 'Обработка...');
  setProgress(2);

  const p = getParams();
  lastParams = p;

  let c = Processor.clone(origCanvas);

  log('[1/5] LSB-рандомизация seed=' + p.seed, 'info');
  c = Processor.lsbRandomize(c, p.seed);
  markStep(0); setProgress(18); await tick();

  log('[2/5] Кроп ' + p.crop + '% + сдвиг (' + p.shiftX + ',' + p.shiftY + ')px', 'info');
  c = Processor.cropResizeShift(c, p.crop, p.shiftX, p.shiftY);
  markStep(1); setProgress(36); await tick();

  log('[3/5] JPEG Q=' + p.quality, 'info');
  c = await Processor.jpegRecompress(c, p.quality);
  markStep(2); setProgress(54); await tick();

  log('[4/5] Color jitter ±' + p.delta, 'info');
  c = Processor.colorJitter(c, p.delta, p.seed);
  markStep(3); setProgress(72); await tick();

  log('[5/5] Upscale x' + p.upscale + ' → downscale', 'info');
  c = await Processor.upscaleDownscale(c, p.upscale);
  markStep(4); setProgress(90);

  resultCanvas = c;
  const metrics = Processor.computeMetrics(origCanvas, resultCanvas);
  lastMetrics = metrics;

  showResults(metrics, p);
  setProgress(100);
  log('Готово · PSNR=' + metrics.psnr + ' dB · SSIM=' + metrics.ssim + ' · MAE=' + metrics.mae, 'ok');
  setStatus('done', 'Готово');
  btn.disabled = false;
  buildReport(metrics, p);
}

// ─── Run single step ──────────────────────────────────────────
async function runStep() {
  if (!origCanvas) { log('Загрузите изображение', 'warn'); return; }

  const base = resultCanvas ? Processor.clone(resultCanvas) : Processor.clone(origCanvas);
  const p = getParams();
  setStatus('running', stepNames[currentStep]);

  let c = base;
  if (currentStep === 0) c = Processor.lsbRandomize(c, p.seed);
  else if (currentStep === 1) c = Processor.cropResizeShift(c, p.crop, p.shiftX, p.shiftY);
  else if (currentStep === 2) c = await Processor.jpegRecompress(c, p.quality);
  else if (currentStep === 3) c = Processor.colorJitter(c, p.delta, p.seed);
  else if (currentStep === 4) c = await Processor.upscaleDownscale(c, p.upscale);

  markStep(currentStep);
  resultCanvas = c;
  const metrics = Processor.computeMetrics(origCanvas, resultCanvas);
  lastMetrics = metrics;
  lastParams = p;
  showResults(metrics, p);
  log('Шаг «' + stepNames[currentStep] + '» · PSNR=' + metrics.psnr + ' dB', 'ok');
  setStatus('done', 'Шаг выполнен');
  buildReport(metrics, p);
}

// ─── Reset ────────────────────────────────────────────────────
function resetAll() {
  resultCanvas = null;
  document.querySelectorAll('.step-item').forEach(s => s.classList.remove('done'));
  document.getElementById('result-area').style.display = 'none';
  document.getElementById('report-body').style.display = 'none';
  document.getElementById('report-empty').style.display = '';
  clearLog();
  setProgress(0);
  setStatus('idle', 'Сброс');
  log('Результат очищен. Оригинал сохранён.', 'warn');
}

// ─── Helpers ──────────────────────────────────────────────────
function tick() { return new Promise(r => setTimeout(r, 60)); }

function markStep(n) {
  document.getElementById('step-' + n).classList.add('done');
}

function showResults(metrics, p) {
  // Previews
  document.getElementById('prev-before').src = origCanvas.toDataURL();
  document.getElementById('prev-after').src = resultCanvas.toDataURL();
  document.getElementById('after-label').textContent =
    'После: JPEG Q=' + p.quality + ' · seed=' + p.seed;

  // Metrics
  document.getElementById('mv-psnr').textContent = metrics.psnr + ' dB';
  document.getElementById('mv-ssim').textContent = metrics.ssim;
  document.getElementById('mv-mae').textContent = metrics.mae;
  const kb = Math.round(resultCanvas.toDataURL('image/jpeg', p.quality/100).length * 0.75 / 1024);
  document.getElementById('mv-size').textContent = kb + ' КБ';

  // Color coding
  const pCard = document.getElementById('mc-psnr');
  pCard.className = 'metric-card ' + (metrics.psnr > 40 ? 'good' : metrics.psnr > 28 ? 'warn' : 'bad');
  const sCard = document.getElementById('mc-ssim');
  sCard.className = 'metric-card ' + (metrics.ssim > 0.95 ? 'good' : metrics.ssim > 0.85 ? 'warn' : 'bad');

  document.getElementById('result-area').style.display = '';
}

// ─── Download ─────────────────────────────────────────────────
function downloadResult() {
  if (!resultCanvas) return;
  const url = resultCanvas.toDataURL('image/jpeg', 0.92);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'wm_processed_' + Date.now() + '.jpg';
  a.click();
}

// ─── Live comparison ──────────────────────────────────────────
async function runLiveComparison() {
  if (!origCanvas) {
    document.getElementById('live-cmp-grid').innerHTML =
      '<p style="font-size:13px;color:var(--text-3);">Загрузите изображение на вкладке «Пайплайн»</p>';
    return;
  }
  const btn = document.getElementById('btn-live-cmp');
  btn.disabled = true;
  btn.textContent = 'Обработка...';

  const attacks = [
    { name: 'LSB XOR', fn: async c => Processor.lsbRandomize(Processor.clone(c), 42) },
    { name: 'Color ±1', fn: async c => Processor.colorJitter(Processor.clone(c), 1, 42) },
    { name: 'Crop 3%', fn: async c => Processor.cropResizeShift(Processor.clone(c), 3, 2, 2) },
    { name: 'JPEG Q=75', fn: async c => Processor.jpegRecompress(Processor.clone(c), 75) },
    { name: 'JPEG Q=60', fn: async c => Processor.jpegRecompress(Processor.clone(c), 60) },
    { name: 'Upscale x2', fn: async c => Processor.upscaleDownscale(Processor.clone(c), 2) },
  ];

  const grid = document.getElementById('live-cmp-grid');
  grid.innerHTML = '<div class="live-grid" id="live-inner"></div>';
  const inner = document.getElementById('live-inner');

  for (const atk of attacks) {
    const result = await atk.fn(origCanvas);
    const m = Processor.computeMetrics(origCanvas, result);
    const card = document.createElement('div');
    card.className = 'live-card';
    card.innerHTML = `
      <img src="${result.toDataURL('image/jpeg', 0.85)}" alt="${atk.name}" />
      <div class="live-info">
        <div class="live-name">${atk.name}</div>
        <div class="live-vals">PSNR ${m.psnr} dB · SSIM ${m.ssim}</div>
      </div>`;
    inner.appendChild(card);
    await tick();
  }

  btn.disabled = false;
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Обновить';
}

// ─── Report ───────────────────────────────────────────────────
function buildReport(metrics, p) {
  const psnrQual = metrics.psnr > 40 ? 'высокое (визуальных искажений нет)' :
                   metrics.psnr > 28 ? 'умеренное (лёгкие артефакты)' : 'низкое (заметные артефакты)';
  const ssimQual = metrics.ssim > 0.97 ? 'отличное' :
                   metrics.ssim > 0.90 ? 'хорошее' : 'удовлетворительное';

  document.getElementById('report-params-table').innerHTML = `
    <tr><td>Seed (LSB XOR)</td><td>${p.seed}</td></tr>
    <tr><td>Кроп краёв</td><td>${p.crop}%</td></tr>
    <tr><td>Пиксельный сдвиг</td><td>(${p.shiftX}, ${p.shiftY}) px</td></tr>
    <tr><td>JPEG Quality</td><td>${p.quality}</td></tr>
    <tr><td>Color Jitter delta</td><td>±${p.delta}</td></tr>
    <tr><td>Upscale коэффициент</td><td>×${p.upscale}</td></tr>
    <tr><td>Размер изображения</td><td>${origCanvas.width}×${origCanvas.height} px</td></tr>
  `;

  document.getElementById('report-metrics').innerHTML = `
    <div class="metric-card ${metrics.psnr > 40 ? 'good' : metrics.psnr > 28 ? 'warn' : 'bad'}">
      <div class="m-label">PSNR</div>
      <div class="m-value">${metrics.psnr} dB</div>
      <div class="m-sub">выше = лучше</div>
    </div>
    <div class="metric-card ${metrics.ssim > 0.95 ? 'good' : metrics.ssim > 0.85 ? 'warn' : 'bad'}">
      <div class="m-label">SSIM</div>
      <div class="m-value">${metrics.ssim}</div>
      <div class="m-sub">0..1</div>
    </div>
    <div class="metric-card">
      <div class="m-label">MAE</div>
      <div class="m-value">${metrics.mae}</div>
      <div class="m-sub">пиксель</div>
    </div>
  `;

  document.getElementById('report-interpretation').innerHTML = `
    <p><strong>Качество изображения после обработки:</strong> ${psnrQual} (PSNR = ${metrics.psnr} dB).</p>
    <p><strong>Структурное сходство (SSIM):</strong> ${ssimQual} — ${metrics.ssim}. Значение ближе к 1.0 означает, что структура изображения визуально не изменилась.</p>
    <p><strong>Средняя ошибка (MAE = ${metrics.mae}):</strong> среднее отклонение яркости пикселей от оригинала. При MAE &lt; 2.0 изменения практически не различимы на глаз.</p>
    <p><strong>Вывод:</strong> Полный пайплайн из 5 шагов создаёт накопительный эффект воздействия на паттерны водяного знака. Каждый шаг по отдельности слабо влияет на восприятие изображения, однако их совокупное воздействие на бинарные паттерны SynthID значительно сильнее, чем любой отдельный метод.</p>
  `;

  document.getElementById('report-empty').style.display = 'none';
  document.getElementById('report-body').style.display = '';
}

// ─── Export report ────────────────────────────────────────────
function exportReport() {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>Отчёт — Watermark Robustness</title>
<style>
  body { font-family: Helvetica Neue, Arial, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #1a1a18; line-height: 1.7; }
  h1 { font-size: 22px; font-weight: 500; }
  h2 { font-size: 15px; font-weight: 500; margin: 28px 0 12px; border-bottom: 1px solid #e5e4e0; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 6px 0; border-bottom: 1px solid #f0efec; }
  td:first-child { color: #5a5955; width: 45%; }
  .metrics { display: flex; gap: 16px; margin: 12px 0; }
  .mc { background: #f1f0ec; border-radius: 8px; padding: 12px 16px; flex: 1; }
  .mc .val { font-size: 22px; font-weight: 500; margin: 4px 0; }
  .mc .lbl { font-size: 11px; color: #9a9893; }
  p { margin-bottom: 8px; font-size: 13px; color: #5a5955; }
  strong { color: #1a1a18; }
</style>
</head>
<body>
<h1>Отчёт исследования устойчивости водяного знака</h1>
<p>Сформировано: ${new Date().toLocaleString('ru-RU')}</p>
<h2>Параметры эксперимента</h2>
${document.getElementById('report-params-table').outerHTML}
<h2>Метрики</h2>
<div class="metrics">
  <div class="mc"><div class="lbl">PSNR</div><div class="val">${lastMetrics.psnr} dB</div></div>
  <div class="mc"><div class="lbl">SSIM</div><div class="val">${lastMetrics.ssim}</div></div>
  <div class="mc"><div class="lbl">MAE</div><div class="val">${lastMetrics.mae}</div></div>
</div>
<h2>Интерпретация</h2>
${document.getElementById('report-interpretation').innerHTML}
</body>
</html>`;

  const a = document.createElement('a');
  a.href = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  a.download = 'wm_report_' + Date.now() + '.html';
  a.click();
}

function copyReport() {
  const text = [
    'Отчёт исследования устойчивости водяного знака',
    'Дата: ' + new Date().toLocaleString('ru-RU'),
    '',
    'PSNR: ' + lastMetrics.psnr + ' dB',
    'SSIM: ' + lastMetrics.ssim,
    'MAE: ' + lastMetrics.mae,
    '',
    document.getElementById('report-interpretation').innerText
  ].join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.target;
    btn.textContent = 'Скопировано!';
    setTimeout(() => btn.textContent = 'Копировать текст', 2000);
  });
}
