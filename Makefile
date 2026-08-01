# Convenience wrapper around the CMake presets (see CMakePresets.json).
#   make release      - configure + build all desktop formats -> build/release/out/
#   make debug        - same, Debug config -> build/debug/out/
#   make xcode        - generate the Xcode project (AUv3) -> build/xcode/       (macOS)
#   make ios          - generate the iOS Xcode project -> build/ios/            (macOS)
#   make visionos     - generate the visionOS Xcode project -> build/visionos/  (macOS)
#   make wasm         - WCLAP (WebAssembly) build via emcmake -> build/wasm/
#   make validate     - run pluginval / auval / clap-validator
#   make install      - copy the release VST3 / AU / CLAP into the per-user plug-in
#                       folders (macOS: ~/Library/Audio/Plug-Ins, Windows:
#                       %LOCALAPPDATA%\Programs\Common, Linux: ~/.vst3 and ~/.clap)
#   make clean        - remove the build directory

OUT := build/release/out
CMAKE ?= cmake

# Windows always sets OS=Windows_NT, so the host check works whether make runs
# with sh (Git Bash/MSYS) or with cmd.exe as its shell — don't reach for uname
# (or for `~`, which cmd.exe never expands) before we know which one we're on.
ifeq ($(OS),Windows_NT)
  HOST := Windows
else
  HOST := $(shell uname -s)
endif

ifeq ($(HOST),Windows)
  # Per-user locations from the VST3 / CLAP specs — no admin rights needed.
  # Normalised to forward slashes: cmake -E takes the mixed separators happily and
  # it keeps the recipes free of backslash-quoting differences between shells.
  COMMON   := $(subst \,/,$(LOCALAPPDATA))/Programs/Common
  VST3_DIR ?= $(COMMON)/VST3
  CLAP_DIR ?= $(COMMON)/CLAP
  PLUGINVAL ?= pluginval.exe
else ifeq ($(HOST),Darwin)
  VST3_DIR ?= $(HOME)/Library/Audio/Plug-Ins/VST3
  AU_DIR   ?= $(HOME)/Library/Audio/Plug-Ins/Components
  CLAP_DIR ?= $(HOME)/Library/Audio/Plug-Ins/CLAP
  PLUGINVAL ?= /Applications/pluginval.app/Contents/MacOS/pluginval
else
  VST3_DIR ?= $(HOME)/.vst3
  CLAP_DIR ?= $(HOME)/.clap
  PLUGINVAL ?= pluginval
endif

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
ifeq ($(HOST),Darwin)
	$(PLUGINVAL) --strictness-level 5 --skip-gui-tests --validate $(OUT)/cdp-plugin.vst3
	killall -9 AudioComponentRegistrar 2>/dev/null || true
	auval -v aumu CDPl oliL
	clap-validator validate $(OUT)/cdp-plugin.clap
else
	$(PLUGINVAL) --strictness-level 5 --skip-gui-tests --validate "$(OUT)/cdp-plugin.vst3"
	clap-validator validate "$(OUT)/cdp-plugin.clap"
endif

# Driven through `cmake -E` on Windows so the recipe doesn't depend on which
# shell make picked (MSYS sh vs. cmd.exe) — cmake is already a build requirement.
# There's no AU on Windows, and the loose single-file CLAP finds its editor assets
# in a sibling cdp-plugin.web/ (see the resource lookup in CMakeLists.txt), so that
# folder has to travel with it.
install: release
ifeq ($(HOST),Windows)
	$(CMAKE) -E make_directory "$(VST3_DIR)" "$(CLAP_DIR)"
	$(CMAKE) -E rm -rf "$(VST3_DIR)/cdp-plugin.vst3" \
	                   "$(CLAP_DIR)/cdp-plugin.clap" \
	                   "$(CLAP_DIR)/cdp-plugin.web"
	$(CMAKE) -E copy_directory "$(OUT)/cdp-plugin.vst3" "$(VST3_DIR)/cdp-plugin.vst3"
	$(CMAKE) -E copy "$(OUT)/cdp-plugin.clap" "$(CLAP_DIR)/cdp-plugin.clap"
	$(CMAKE) -E copy_directory "$(OUT)/cdp-plugin.web" "$(CLAP_DIR)/cdp-plugin.web"
else ifeq ($(HOST),Darwin)
	mkdir -p $(VST3_DIR) $(AU_DIR) $(CLAP_DIR)
	rm -rf $(VST3_DIR)/cdp-plugin.vst3 \
	       $(AU_DIR)/cdp-plugin.component \
	       $(CLAP_DIR)/cdp-plugin.clap
	cp -R $(OUT)/cdp-plugin.vst3 $(VST3_DIR)/
	cp -R $(OUT)/cdp-plugin.component $(AU_DIR)/
	cp -R $(OUT)/cdp-plugin.clap $(CLAP_DIR)/
else
	mkdir -p $(VST3_DIR) $(CLAP_DIR)
	rm -rf $(VST3_DIR)/cdp-plugin.vst3 $(CLAP_DIR)/cdp-plugin.clap
	cp -R $(OUT)/cdp-plugin.vst3 $(VST3_DIR)/
	cp -R $(OUT)/cdp-plugin.clap $(CLAP_DIR)/
endif

clean:
	$(CMAKE) -E rm -rf build
