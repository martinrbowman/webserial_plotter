'use strict';

const MAX_POINTS = 1000;
const COLORS = ['#00ff88','#ff4444','#4488ff','#ffaa00','#ff44ff','#44ffff','#ffff44','#ff8800'];

// ── State ─────────────────────────────────────────────────────────────────
let port            = null;
let reader          = null;
let readLoopDone    = Promise.resolve();
let isLogging       = false;
let logRows         = [];
let inputBuffer     = '';
let channels        = {};   // name -> number[]
let channelColors   = {};   // name -> hex string
let colorIdx        = 0;
let sampleCount     = 0;
let datasetCount    = 0;
let fmt5NamesReceived = false, fmt5Names = [];
let fmt6NamesReceived = false, fmt6Names = [];
let chartDirty      = false;

// ── DOM refs ──────────────────────────────────────────────────────────────
const $           = id => document.getElementById(id);
const btnConnect  = $('btn-connect');
const btnStart    = $('btn-start');
const btnStop     = $('btn-stop');
const btnClear    = $('btn-clear');
const btnSmooth   = $('btn-smooth');
const btnLog      = $('btn-log-toggle');
const btnSave     = $('btn-save-plot');
const portStatus  = $('port-status');
const statusBar   = $('statusbar');
const smoothChSel = $('smooth-channel');
const numNamesRow = $('num-names-row');

// ── Chart ─────────────────────────────────────────────────────────────────
const bgPlugin = {
    id: 'customBg',
    beforeDraw(c) {
        const ctx = c.canvas.getContext('2d');
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.restore();
    },
};

const chart = new Chart($('plot-canvas'), {
    type: 'line',
    plugins: [bgPlugin],
    data: { labels: [], datasets: [] },
    options: {
        animation: { duration: 0 },
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
            x: {
                ticks: { color: '#888', maxTicksLimit: 10 },
                grid:  { color: 'rgba(255,255,255,0.07)' },
            },
            y: {
                ticks: { color: '#888' },
                grid:  { color: 'rgba(255,255,255,0.07)' },
            },
        },
        plugins: {
            legend: { labels: { color: '#ccc', boxWidth: 16, padding: 8 } },
        },
    },
});

// ── Helpers ───────────────────────────────────────────────────────────────
const getFormat   = () => parseInt(document.querySelector('input[name="fmt"]:checked').value);
const getTermStr  = () => {
    const v = document.querySelector('input[name="term"]:checked').value;
    return v === 'crnl' ? '\r\n' : v === 'cr' ? '\r' : '\n';
};
const getNumNames = () => Math.max(1, parseInt($('num-names').value) || 2);
const getBaudRate = () => parseInt($('baud-select').value);

// ── Format change ─────────────────────────────────────────────────────────
document.querySelectorAll('input[name="fmt"]').forEach(rb => rb.addEventListener('change', () => {
    const fmt = getFormat();
    numNamesRow.style.display = fmt >= 3 ? '' : 'none';
    if (fmt === 5) { fmt5NamesReceived = false; fmt5Names = []; }
    if (fmt === 6) { fmt6NamesReceived = false; fmt6Names = []; }
}));

// ── Web Serial ────────────────────────────────────────────────────────────
if (!('serial' in navigator)) {
    btnConnect.disabled = true;
    portStatus.textContent = 'Requires Chrome, Edge, or Firefox 151+';
}

btnConnect.addEventListener('click', async () => {
    try {
        port = await navigator.serial.requestPort();
        portStatus.textContent = 'Port selected — ready';
        portStatus.classList.add('connected');
        btnStart.disabled = false;
    } catch (e) {
        if (e.name !== 'NotFoundError') console.error(e);
    }
});

btnStart.addEventListener('click', async () => {
    if (!port) return;
    try {
        await port.open({ baudRate: getBaudRate() });
    } catch {
        // already open — ignore
    }
    inputBuffer = '';
    btnStart.disabled   = true;
    btnStop.disabled    = false;
    btnConnect.disabled = true;
    portStatus.textContent = `Running @ ${getBaudRate()}`;

    readLoopDone = runReadLoop().finally(() => {
        btnStart.disabled   = false;
        btnStop.disabled    = true;
        btnConnect.disabled = false;
        portStatus.textContent = 'Ready';
    });
});

btnStop.addEventListener('click', async () => {
    if (reader) reader.cancel().catch(() => {});
    await readLoopDone;
    port.close().catch(() => {});
    if (isLogging) stopLogging();
});

async function runReadLoop() {
    const dec = new TextDecoder();
    reader = port.readable.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            processChunk(dec.decode(value, { stream: true }));
        }
    } catch (e) {
        if (e.name !== 'AbortError') console.error('Serial error:', e.message);
    } finally {
        reader.releaseLock();
        reader = null;
    }
}

// ── Chunk / line processing ───────────────────────────────────────────────
function processChunk(chunk) {
    inputBuffer += chunk;
    const term = getTermStr();
    let idx;
    while ((idx = inputBuffer.indexOf(term)) !== -1) {
        const line = inputBuffer.slice(0, idx).trim();
        inputBuffer = inputBuffer.slice(idx + term.length);
        processLine(line);
    }
}

function processLine(line) {
    const fmt = getFormat();

    if (line === '') {
        if (fmt === 6 && fmt6NamesReceived) autoRange();
        return;
    }

    const parts  = line.split(',').map(s => s.trim());
    const parsed = {};   // name -> float

    if (fmt === 1) {
        const v = parseFloat(parts[0]);
        if (isNaN(v)) return;
        parsed['value'] = v;
        sampleCount++;

    } else if (fmt === 2) {
        if (parts.length < 2) return;
        const v = parseFloat(parts[1]);
        if (isNaN(v)) return;
        parsed[parts[0]] = v;
        sampleCount++;

    } else if (fmt === 3) {
        const n = getNumNames();
        if (parts.length < n * 2) return;
        for (let i = 0; i < n; i++) {
            const v = parseFloat(parts[i * 2 + 1]);
            if (isNaN(v)) return;
            parsed[parts[i * 2]] = v;
        }
        datasetCount++;

    } else if (fmt === 4) {
        const n = getNumNames();
        if (parts.length < n * 2) return;
        for (let i = 0; i < n; i++) {
            const v = parseFloat(parts[n + i]);
            if (isNaN(v)) return;
            parsed[parts[i]] = v;
        }
        datasetCount++;

    } else if (fmt === 5) {
        const n = getNumNames();
        if (!fmt5NamesReceived) {
            if (parts.length >= n) { fmt5Names = parts.slice(0, n); fmt5NamesReceived = true; }
            return;
        }
        if (parts.length < n) return;
        for (let i = 0; i < n; i++) {
            const v = parseFloat(parts[i]);
            if (isNaN(v)) return;
            parsed[fmt5Names[i]] = v;
        }
        datasetCount++;

    } else if (fmt === 6) {
        const n = getNumNames();
        if (!fmt6NamesReceived) {
            if (parts.length >= n) { fmt6Names = parts.slice(0, n); fmt6NamesReceived = true; }
            return;
        }
        const numGroups = Math.floor(parts.length / n);
        if (numGroups === 0) return;
        const ts = new Date().toISOString();
        for (let g = 0; g < numGroups; g++) {
            for (let i = 0; i < n; i++) {
                const v = parseFloat(parts[g * n + i]);
                if (!isNaN(v)) {
                    addChannelValue(fmt6Names[i], v);
                    if (isLogging) logRows.push([ts, fmt6Names[i], v]);
                }
            }
            datasetCount++;
        }
        syncChart();
        autoRange();
        updateStatus();
        return;
    }

    if (!Object.keys(parsed).length) return;

    const ts = new Date().toISOString();
    for (const [name, val] of Object.entries(parsed)) {
        addChannelValue(name, val);
        if (isLogging) logRows.push([ts, name, val]);
    }
    markChartDirty();
    updateStatus();
}

// ── Channel management ────────────────────────────────────────────────────
function addChannelValue(name, value) {
    if (!(name in channels)) {
        channels[name]      = [];
        const color         = COLORS[colorIdx++ % COLORS.length];
        channelColors[name] = color;
        chart.data.datasets.push({
            label:           name,
            data:            [],
            borderColor:     color,
            backgroundColor: 'transparent',
            borderWidth:     1.5,
            pointRadius:     0,
            tension:         0,
            _isSmooth:       false,
        });
        smoothChSel.appendChild(
            Object.assign(document.createElement('option'), { value: name, textContent: name })
        );
    }
    channels[name].push(value);
    if (channels[name].length > MAX_POINTS) channels[name].shift();
}

// ── Chart sync ────────────────────────────────────────────────────────────
function syncChart() {
    const maxLen = Math.max(0, ...Object.values(channels).map(d => d.length));
    if (chart.data.labels.length !== maxLen) {
        chart.data.labels = Array.from({ length: maxLen }, (_, i) => i);
    }
    for (const ds of chart.data.datasets) {
        if (ds._isSmooth) continue;
        ds.data = channels[ds.label] ? [...channels[ds.label]] : [];
    }
}

function markChartDirty() {
    if (!chartDirty) {
        chartDirty = true;
        requestAnimationFrame(() => {
            syncChart();
            chart.update('none');
            chartDirty = false;
        });
    }
}

function autoRange() {
    syncChart();
    chart.update();
}

// ── Status ────────────────────────────────────────────────────────────────
function updateStatus() {
    const fmt = getFormat();
    statusBar.textContent = fmt <= 2
        ? `Samples: ${sampleCount}`
        : `Data sets: ${datasetCount}`;
}

// ── Clear ─────────────────────────────────────────────────────────────────
btnClear.addEventListener('click', () => {
    channels = {}; channelColors = {}; colorIdx = 0;
    sampleCount = 0; datasetCount = 0;
    fmt5NamesReceived = false; fmt5Names = [];
    fmt6NamesReceived = false; fmt6Names = [];
    chart.data.labels   = [];
    chart.data.datasets = [];
    chart.update('none');
    smoothChSel.innerHTML = '';
    updateStatus();
});

// ── Smoothing ─────────────────────────────────────────────────────────────
btnSmooth.addEventListener('click', () => {
    const name = smoothChSel.value;
    if (!name || !channels[name]) return;
    const w    = Math.max(2, parseInt($('smooth-window').value) || 5);
    const data = channels[name];
    if (data.length < w) return;

    const smoothed = [];
    for (let i = w - 1; i < data.length; i++) {
        let sum = 0;
        for (let j = 0; j < w; j++) sum += data[i - j];
        smoothed.push(sum / w);
    }

    const smoothName = `${name}:Smooth`;
    const smoothData = new Array(w - 1).fill(null).concat(smoothed);
    const color      = channelColors[name] || '#ffffff';

    const existing = chart.data.datasets.findIndex(d => d.label === smoothName);
    if (existing === -1) {
        chart.data.datasets.push({
            label:           smoothName,
            data:            smoothData,
            borderColor:     color,
            backgroundColor: 'transparent',
            borderWidth:     2.5,
            borderDash:      [6, 3],
            pointRadius:     0,
            tension:         0,
            _isSmooth:       true,
        });
    } else {
        chart.data.datasets[existing].data = smoothData;
    }
    chart.update('none');
});

// ── Logging ───────────────────────────────────────────────────────────────
btnLog.addEventListener('click', () => isLogging ? stopLogging() : startLogging());

function startLogging() {
    logRows   = [['timestamp', 'channel', 'value']];
    isLogging = true;
    btnLog.textContent = 'Stop Logging';
    btnLog.classList.add('active-log');
}

function stopLogging() {
    isLogging = false;
    btnLog.textContent = 'Start Logging';
    btnLog.classList.remove('active-log');
    if (logRows.length > 1) {
        downloadBlob('serial_log.csv', logRows.map(r => r.join(',')).join('\n'), 'text/csv');
    }
    logRows = [];
}

// ── Save plot ─────────────────────────────────────────────────────────────
btnSave.addEventListener('click', () => {
    const a = Object.assign(document.createElement('a'), {
        href:     chart.toBase64Image('image/png', 1),
        download: 'plot.png',
    });
    a.click();
});

// ── About ─────────────────────────────────────────────────────────────────
const aboutOverlay = $('about-overlay');
$('btn-about').addEventListener('click', () => aboutOverlay.classList.add('visible'));
$('btn-about-close').addEventListener('click', () => aboutOverlay.classList.remove('visible'));
aboutOverlay.addEventListener('click', e => { if (e.target === aboutOverlay) aboutOverlay.classList.remove('visible'); });

// ── Download helper ───────────────────────────────────────────────────────
function downloadBlob(filename, content, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
}
