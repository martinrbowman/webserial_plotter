# Serial Plotter (Web)

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow?logo=buy-me-a-coffee)](https://buymeacoffee.com/redwolfelectronics)

**Live: https://martinrbowman.github.io/webserial_plotter/**

Browser-based serial data plotter. Uses the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) — no install, runs from static files. Chart rendering via [Chart.js](https://www.chartjs.org/).

Requires a Chromium browser (Chrome/Edge) or Firefox 151+ desktop. Not supported in Safari, or in Firefox on Android/iOS.

## Running

Double-click `index.html` to open it directly in the browser — Chrome/Edge treat `file://` as a secure context, so Web Serial works with no server.

Alternatively, serve the folder over HTTP:

```bash
cd webapp
python3 -m http.server 8000
```

Open `http://localhost:8000` in Chrome/Edge.

## Files

- `index.html` — layout, controls, about dialog
- `style.css` — dark theme styling
- `app.js` — serial I/O, line parsing, charting, logging, smoothing

## Usage

1. **Connect Port** — pick the serial device (browser permission prompt).
2. Set **Baud**, **Data Format**, and **Line Terminator** to match the device output.
3. **Start** / **Stop** streaming.
4. **Start Logging** to record incoming samples to CSV (downloads on stop).
5. **Save Plot** exports the current chart as a PNG.
6. **Clear** resets all channels and the chart.
7. **Smoothing** applies a moving-average overlay to a selected channel.

## Data formats

| # | Format | Description |
|---|--------|-------------|
| 1 | `value` | single unnamed value per line |
| 2 | `name, value` | one named value per line |
| 3 | `n,v, n,v, ...` | interleaved name/value pairs |
| 4 | `n,n,... v,v,...` | names then values, matched by position |
| 5 | `n,n,... stream` | first line is names, each following line is values (repeats) |
| 6 | `n,n,... frame` | first line is names; each line may contain multiple value groups (a "frame"), blank line triggers autorange |

Formats 3–6 use the **# Names** field to know how many name/value columns to expect.

## Notes

- Up to 1000 points are kept per channel (older points drop off).
- Channel colors are assigned in the order channels first appear.
