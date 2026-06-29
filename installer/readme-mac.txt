Composer's Desktop Plug-in (cdp-plugin)
=======================================

Thanks for downloading Composer's Desktop Plug-in.

This disk image contains the plug-ins and the standalone application. Drag each
item into the matching folder:

  cdp-plugin.vst3       ->  /Library/Audio/Plug-Ins/VST3
  cdp-plugin.clap       ->  /Library/Audio/Plug-Ins/CLAP
  cdp-plugin.component  ->  /Library/Audio/Plug-Ins/Components   (Audio Unit)
  cdp-plugin.app        ->  /Applications

To install for the current user only, use the equivalent folders under your home
directory instead, e.g. ~/Library/Audio/Plug-Ins/VST3.

After installing the Audio Unit you may need to restart your DAW (or log out and
back in) before it is picked up.

The plug-ins and app are signed and notarized, so they open without Gatekeeper
warnings.


KNOWN ISSUES

  * Only the sampler's audio comes out of your DAW. The main CDP node graph's
    live preview (what you hear while building or auditioning a patch in the
    editor) plays through your system's default sound card, not through the DAW.
    Render the patch and play it via host MIDI or the on-screen keyboard to hear
    it through the host.


SUPPORT

Report issues at:
  https://github.com/cdp-wasm-suite/cdp-plugin/issues
