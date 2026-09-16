Vendored third-party libraries, all licensed under Apache-2.0 (see LICENSE):

- spessasynth_lib 4.3.14 — https://github.com/spessasus/spessasynth_lib
- spessasynth_core 4.3.20 — https://github.com/spessasus/spessasynth_core
- stb-vorbis 0.0.6 — https://github.com/spessasus/stb-vorbis — **replaced by a stub**

Used for MIDI parsing and SoundFont2/DLS synthesis (Mediyyu's .mid playback support).

`stb-vorbis.js` is not the upstream build. The real one inlines a WebAssembly Ogg
Vorbis decoder as a single huge base64 string, and Windows Defender quarantines that
shape as `Trojan:Script/ObfusScript.A!ml` — a heuristic false positive, since the file
contains no eval and makes no network calls. Because it gets quarantined on any machine
that scans it, Mediyyu ships a stub instead.

Consequence: uncompressed SF2 and DLS soundfonts work exactly as before. Compressed SF3
soundfonts, whose samples are Vorbis-encoded, report a clear message instead of playing.
To restore SF3 support, drop the upstream build back into `stb-vorbis.js` and add a
Defender exclusion for it.
