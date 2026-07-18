# mediyyu

a music player + audio visualizer for windows, built with electron.

![version](https://img.shields.io/badge/version-1.0.3-blue)

## features

- **visualizer shapes** — bars, radial (+ kaleidoscope), oscilloscope wave, spectrogram falls, and a psychedelic swirl mode. each shape has its own sub-options.
- **faithful OBS Waveform port** — the full spectrum analysis pipeline (window functions, FFT, slope, temporal smoothing, interpolation, gaussian filter) from the [waveform](https://github.com/phandasm/waveform) plugin, plus the original legacy engine.
- **playback** — playlists with drag & drop reorder, shuffle, repeat modes, crossfade, 10-band EQ with presets, normalization, playback speed.
- **looks** — cover-art color themes, blurred cover ambiance background, glass UI with custom tint, trails, particles, reflections, mini mode.
- **export** — record the visualizer to MP4 (quality/fps/resolution options).
- **integrations** — media keys, windows taskbar buttons, discord rich presence, file associations, system notifications.
- **track info editor** — read & write tags (mp3/flac/ogg/m4a/wav) in place, including cover art.
- **auto-update** — checks github releases on launch; a pill shows up when a new version is out (nothing installs without a click).
- **synced lyrics** — karaoke overlay from a same-name `.lrc` or `.vtt` file, lyrics embedded in the tags, or [LRCLIB](https://lrclib.net) (free, no key). toggle with `L`.

## download

### Windows :

Installer version: [Mediyyu-Setup-1.0.3.exe](https://github.com/Darkyyyyy/Mediyyu/releases/download/v1.0.3/Mediyyu-Setup-1.0.3.exe)

Portable version: [Mediyyu-1.0.3.exe](https://github.com/Darkyyyyy/Mediyyu/releases/download/v1.0.3/Mediyyu-1.0.3.exe)


### Linux :

*should be there enventually*

### MacOS :

*same i guess???*


## dev

```bash
npm install
npm start
```

## build

```bash
npm run build:win
```

produces an NSIS installer and a portable exe in `dist/`.

## credits

- thank you very much ori for making the icon!!!
- [phandasm](https://github.com/phandasm) for making that waveform algorithm of an obs plugin!
