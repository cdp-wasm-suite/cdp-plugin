; Inno Setup script for the Composer's Desktop Plug-in (Windows).
;
; One script serves every architecture — the caller passes the arch and the
; build output directory via ISCC /D defines, e.g. from the release workflow:
;
;   iscc /DAppVersion=0.1.2 /DArchTag=x64 ^
;        /DSourceDir=build\win-x64\out installer\cdp-plugin.iss
;
; Defines (all optional; sensible fallbacks below):
;   AppVersion  plugin version, e.g. 0.1.2      (default 0.0.0)
;   ArchTag     x64 | arm64                      (default x64)
;   SourceDir   dir holding the built artifacts  (default build\win-x64\out)
;
; The installer lays down a single shared copy of the ~20 MB web app under
; Common Files and strips the per-format embedded copy from the VST3 bundle;
; every installed format then resolves the shared copy through the editor's
; resource-candidate list (see composers_desktop_plugin_editor_resources.h).
;
; Code signing is deferred — SmartScreen will warn on this unsigned installer.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef ArchTag
  #define ArchTag "x64"
#endif
#ifndef SourceDir
  #define SourceDir "build\win-x64\out"
#endif

#define AppName "cdp-plugin"
#define AppPublisher "Oli Larkin"

; Map our ArchTag onto Inno's architecture identifiers.
#if ArchTag == "arm64"
  #define ArchAllowed "arm64"
#else
  #define ArchAllowed "x64"
#endif

[Setup]
AppId={{B3B0F3E2-6C1E-4E7B-9C2D-A1B2C3D4E5F6}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
; The plug-ins install to fixed Common Files locations; only the standalone App
; uses DefaultDirName, so keep the dir page but don't force it on the user.
DisableProgramGroupPage=yes
ArchitecturesAllowed={#ArchAllowed}
ArchitecturesInstallIn64BitMode={#ArchAllowed}
OutputDir=.
OutputBaseFilename=cdp-plugin-setup-{#ArchTag}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName} ({#ArchTag})
; Installer/uninstaller wizard icon (the same artwork as the app exe). Path is
; relative to this .iss (installer/ -> ../resources).
SetupIconFile=..\resources\cdp-plugin.ico
; License page shown before install (plain text, same dir as this .iss).
LicenseFile=license.txt

[Components]
Name: "vst3"; Description: "VST3 plug-in"; Types: full custom
Name: "clap"; Description: "CLAP plug-in"; Types: full custom
Name: "app";  Description: "Standalone application"; Types: full custom

[InstallDelete]
; If a previous self-contained-zip install left an embedded web copy in the VST3
; bundle, remove it before we lay down the (web-stripped) bundle. The runtime
; lookup checks the bundle's Contents\Resources\web (candidate #1) before the
; shared Common Files copy (candidate #4), so a stale embedded copy would keep
; being served and mismatch the freshly-installed binary. Runs before [Files].
Type: filesandordirs; Name: "{commoncf}\VST3\cdp-plugin.vst3\Contents\Resources\web"; Components: vst3

[Files]
; VST3 bundle -> Common Files\VST3. Strip the embedded web copy; the shared
; copy below serves it instead (candidate #4 in the resource lookup).
Source: "{#SourceDir}\cdp-plugin.vst3\*"; DestDir: "{commoncf}\VST3\cdp-plugin.vst3"; \
  Excludes: "Contents\Resources\web\*"; Flags: recursesubdirs createallsubdirs ignoreversion; \
  Components: vst3

; CLAP single-file plug-in -> Common Files\CLAP.
Source: "{#SourceDir}\cdp-plugin.clap"; DestDir: "{commoncf}\CLAP"; \
  Flags: ignoreversion; Components: clap

; Standalone App -> Program Files\cdp-plugin.
Source: "{#SourceDir}\cdp-plugin.exe"; DestDir: "{app}"; \
  Flags: ignoreversion; Components: app

; Shared web assets -> Common Files\Oli Larkin\cdp-plugin\web. The space-separated
; component list means "install when any of these components is selected", so the
; shared copy lands whenever at least one format is chosen.
Source: "{#SourceDir}\web\*"; DestDir: "{commoncf}\{#AppPublisher}\cdp-plugin\web"; \
  Flags: recursesubdirs createallsubdirs ignoreversion; Components: vst3 clap app

; Docs -> Program Files\cdp-plugin ({app} is always created, even for a
; plugins-only install, since it holds the uninstaller). readme.txt gets the
; isreadme flag so the wizard offers to open it after installing.
Source: "readme-win.txt"; DestDir: "{app}"; DestName: "readme.txt"; Flags: isreadme ignoreversion
Source: "license.txt";    DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Only the App component gets a Start-menu entry, so a plugins-only install
; creates no Start-menu group. No uninstall shortcut — modern Windows expects
; uninstalls via Apps & Features, and Inno still registers the ARP entry there.
Name: "{group}\{#AppName}"; Filename: "{app}\cdp-plugin.exe"; Components: app

[UninstallDelete]
; Remove the shared support dir (and its parent, if left empty) on uninstall.
Type: filesandordirs; Name: "{commoncf}\{#AppPublisher}\cdp-plugin"
Type: dirifempty;     Name: "{commoncf}\{#AppPublisher}"
; Force-remove the VST3 bundle dir, but ONLY when we installed the VST3
; component — otherwise a CLAP/App-only uninstall could delete a VST3 the user
; placed there manually from the self-contained zip. (Inno's uninstall log also
; removes the files it installed; this just guarantees the dir goes too.)
Type: filesandordirs; Name: "{commoncf}\VST3\cdp-plugin.vst3"; Components: vst3
