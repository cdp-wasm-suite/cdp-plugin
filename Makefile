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
#
# Set MPLUG_SRC (here via local.mk, or on the command line) to build against a
# local MPlug checkout rather than cloning it — see the note below.

OUT := build/release/out
CMAKE ?= cmake

# Optional machine-local overrides (MPLUG_SRC, CMAKE, PLUGINVAL, ...). Untracked,
# so it survives `make clean` without putting an absolute path in the repo.
-include local.mk

# Build against a local MPlug checkout instead of cloning it from GitHub.
# Unset, CMake's FetchContent does a non-shallow --recursive clone of MPlug and
# its 11 submodules (~700 MB of history; vst3sdk alone recurses 7 more) with no
# progress output — which reads as a hang for several minutes. Point this at a
# checkout on the pinned commit to skip the download entirely:
#   make release MPLUG_SRC=/path/to/mplug     (or set it in local.mk)
MPLUG_SRC ?=
ifneq ($(MPLUG_SRC),)
  MPLUG_FLAG := -DFETCHCONTENT_SOURCE_DIR_MPLUG=$(MPLUG_SRC)
endif

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
	cmake --preset release $(MPLUG_FLAG)
	cmake --build --preset release

debug:
	cmake --preset debug $(MPLUG_FLAG)
	cmake --build --preset debug

xcode:
	cmake --preset xcode $(MPLUG_FLAG)

ios:
	cmake --preset ios $(MPLUG_FLAG)

visionos:
	cmake --preset visionos $(MPLUG_FLAG)

wasm:
	emcmake cmake -B build/wasm -G Ninja -DCMAKE_BUILD_TYPE=Release -DMPLUG_BUILD_WCLAP=ON $(MPLUG_FLAG)
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
