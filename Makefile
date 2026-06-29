# Convenience wrapper around the CMake presets (see CMakePresets.json).
#   make release      - configure + build all desktop formats -> build/release/out/
#   make debug        - same, Debug config -> build/debug/out/
#   make xcode        - generate the Xcode project (AUv3) -> build/xcode/
#   make ios          - generate the iOS Xcode project -> build/ios/
#   make visionos     - generate the visionOS Xcode project -> build/visionos/
#   make wasm         - WCLAP (WebAssembly) build via emcmake -> build/wasm/
#   make validate     - run pluginval / auval / clap-validator
#   make install      - copy release VST3 / AU / CLAP into ~/Library/Audio/Plug-Ins
#   make clean        - remove the build directory

PLUGINVAL ?= /Applications/pluginval.app/Contents/MacOS/pluginval
OUT := build/release/out

.PHONY: release debug xcode ios visionos wasm validate install clean

release:
	cmake --preset release
	cmake --build --preset release

debug:
	cmake --preset debug
	cmake --build --preset debug

xcode:
	cmake --preset xcode

ios:
	cmake --preset ios

visionos:
	cmake --preset visionos

wasm:
	emcmake cmake -B build/wasm -G Ninja -DCMAKE_BUILD_TYPE=Release -DMPLUG_BUILD_WCLAP=ON
	cmake --build build/wasm

# auval loads the component from ~/Library, so install first.
validate: release install
	$(PLUGINVAL) --strictness-level 5 --skip-gui-tests --validate $(OUT)/cdp-plugin.vst3
	killall -9 AudioComponentRegistrar 2>/dev/null || true
	auval -v aumu CDPl oliL
	clap-validator validate $(OUT)/cdp-plugin.clap

install: release
	mkdir -p ~/Library/Audio/Plug-Ins/VST3 ~/Library/Audio/Plug-Ins/Components ~/Library/Audio/Plug-Ins/CLAP
	rm -rf ~/Library/Audio/Plug-Ins/VST3/cdp-plugin.vst3 \
	       ~/Library/Audio/Plug-Ins/Components/cdp-plugin.component \
	       ~/Library/Audio/Plug-Ins/CLAP/cdp-plugin.clap
	cp -R $(OUT)/cdp-plugin.vst3 ~/Library/Audio/Plug-Ins/VST3/
	cp -R $(OUT)/cdp-plugin.component ~/Library/Audio/Plug-Ins/Components/
	cp -R $(OUT)/cdp-plugin.clap ~/Library/Audio/Plug-Ins/CLAP/

clean:
	rm -rf build
