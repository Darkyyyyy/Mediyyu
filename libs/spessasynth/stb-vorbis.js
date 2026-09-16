// Stub replacing the vendored stb-vorbis build.
//
// The upstream file is a ~110 KB single-line module holding an Ogg Vorbis decoder
// compiled to WebAssembly and inlined as one huge base64 string. Windows Defender
// flags that shape as Trojan:Script/ObfusScript.A!ml — a heuristic false positive on
// how the file looks, not on what it does (it contains no eval and makes no network
// calls). Because Defender quarantines it on any machine that scans it, shipping it
// is a liability for everyone who installs Mediyyu, not just for this checkout.
//
// The decoder is only ever reached when decompressing SF3 soundfonts, whose samples
// are Vorbis-encoded. Uncompressed SF2 and DLS soundfonts never touch it. So this
// stub keeps the module contract that spessasynth_core imports, and turns the SF3
// path into a clear message instead of a crash deep inside the synth.
//
// To restore compressed-soundfont support, drop the real build from
// https://github.com/spessasus/stb-vorbis back in here and add a Defender exclusion.

const SF3_UNSUPPORTED =
  'this soundfont is compressed (SF3). Mediyyu plays uncompressed SF2 and DLS soundfonts — convert it, or pick another one.';

class StbVorbis {
  static exports = null;

  // the real module resolves this once its WebAssembly instance is live. spessasynth
  // reads it as `isSF3DecoderReady`, so resolving to false is the honest answer here.
  static ready = Promise.resolve(false);

  static decode() {
    throw new Error(SF3_UNSUPPORTED);
  }
}

export { StbVorbis };
