# Composer's Desktop Plug-in

The Composer's Desktop Plug-in is part of the cdp-wasm-suite - a collection of projects built using a new WebAssembly (WASM) port of the legendary Composer's Desktop Project - an amazing toolkit for offline audio processing and sound design that is full of esoteric algorithms not found elsewhere.

Composer's Desktop Plug-in embeds the toolkit with a retro computing-themed node graph editor/patcher, that makes it easy to wire up a network of CDP programs that generate or process audio files, and inspect the input and output waveforms. The output file is rendered into a simple polyphonic sampler for quick and fun musical re-pitching (the realtime aspect) - alternatively save or drag the output file to your DAW. You can quickly import a source sound or use a generator, patch things together, do spectral processing, create modulation using break-point-functions (BPFs).

The original CDP is a vast collection of command line tools which are rather difficult to understand and rather tedious to connect - but nevertheless incredibly powerful. Text files are used for breakpoint functions (which modulate parameters over time) and each program has many command line arguments that are quite complicated for mere mortals. Over the years there have been many front ends for CDP, which typically wrap the command line tools, but somehow I was still left wanting an easier and more fun way of playing with it - so I built one. Using WASM and a virtual file system I was able to make a browser based environment for patching together the programs and rendering the intermediate files in a sandbox. Render the output quickly by pressing spacebar, double click output connectors to patch things together, easily browse the vast library of CDP programs by double clicking the canvas - all these things are designed to make the experience of sound design with CDP much more fun and immediate.

Although there are many interesting algorithms in the CDP, there are some signal processing techniques that are not well covered. For this reason, I integrated the FAUST compiler, which can be used with CDP nodes to generate and process sound using all sorts of techniques.

A collection of "recipes" are provided - prebuilt node graphs for tasks such as "Additive Re-synthesis".

I've tried to integrate "manpage" documentation for all the programs as quick-help, but i've also included a manual distilled from the CDP docs.

## License

Copyright 2026 Oliver Larkin

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.