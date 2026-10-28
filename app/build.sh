#!/bin/bash
# ============================================================================
# Basic EPUB Reader — build the sample APK (manual aapt2/d8 pipeline,
# the same proven toolchain as the Suite and game APKs).
#
# VERSION / VERSION_CODE below are the ONLY hand-edited version
# numbers; the build stamps them into the manifest in place (aapt2
# link flags do NOT override the manifest — the game build taught
# us) and asserts the packaged badging after signing.
#
# The starter book (Joshua's sample EPUB) ships inside the APK as a
# generated www/sample-book.js (base64) so the first open has a book
# on the shelf. FATAL if the sample EPUB is missing — never ship a
# reader whose promised first book silently isn't there.
#
# Signing uses the game's RELEASE keystore — one key for Joshua's
# whole ecosystem. Its password lives in the game project's
# .keystore-pass (mode 600) and is NEVER hardcoded or echoed here.
# ============================================================================
set -e

VERSION=0.1.2
VERSION_CODE=3

export JAVA_HOME=~/workspace/.jdk/jdk17
export PATH=$JAVA_HOME/bin:$PATH
SDK=~/workspace/.android-sdk
BT=$SDK/build-tools/34.0.0
PROJ=~/workspace/basic-epub-reader/app
STAGE=$PROJ/stage
GAMEPROJ=~/workspace/game-map/project
KS=$GAMEPROJ/release.keystore
PASSFILE=$GAMEPROJ/.keystore-pass
SAMPLE=~/workspace/your_files/Adamsville-in-Miniature-SAMPLE.epub
OUT=~/workspace/your_files/Basic-EPUB-Reader-v$VERSION.apk
MANIFEST=$PROJ/src/main/AndroidManifest.xml

if [ ! -f "$KS" ]; then
  echo "FATAL: release keystore not found at $KS" >&2; exit 1
fi
if [ ! -f "$PASSFILE" ]; then
  echo "FATAL: keystore password file not found at $PASSFILE" >&2; exit 1
fi
if [ ! -f "$SAMPLE" ]; then
  echo "FATAL: sample EPUB not found at $SAMPLE" >&2; exit 1
fi
KS_PASS=$(cat "$PASSFILE")

# --- Stamp the manifest from VERSION/VERSION_CODE (in place). -------
python3 - "$MANIFEST" "$VERSION" "$VERSION_CODE" <<'PYEOF'
import re, sys
path, version, code = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path, encoding='utf-8').read()
out, n_name = re.subn(r'android:versionName="[^"]*"',
                      'android:versionName="%s"' % version, src)
out, n_code = re.subn(r'android:versionCode="[^"]*"',
                      'android:versionCode="%s"' % code, out)
if n_name != 1 or n_code != 1:
    print('FATAL: manifest stamp expected exactly 1 versionName and 1 '
          'versionCode attribute, found %d and %d' % (n_name, n_code),
          file=sys.stderr)
    sys.exit(1)
if out != src:
    open(path, 'w', encoding='utf-8').write(out)
print('manifest stamped: versionName=%s versionCode=%s' % (version, code))
PYEOF

# --- Stage the payload from scratch. --------------------------------
rm -rf "$STAGE"
mkdir -p "$STAGE/assets" "$STAGE/classes" "$STAGE/dex"
cp -r "$PROJ/www/"* "$STAGE/assets/"

# --- Generate sample-book.js (the starter book, base64). ------------
python3 - "$SAMPLE" "$STAGE/assets/sample-book.js" <<'PYEOF'
import base64, sys
data = open(sys.argv[1], 'rb').read()
with open(sys.argv[2], 'w', encoding='ascii') as f:
    f.write('window.SAMPLE_BOOK_B64="')
    f.write(base64.b64encode(data).decode('ascii'))
    f.write('";\n')
print('sample-book.js generated from %d-byte EPUB' % len(data))
PYEOF

# 1. compile resources (launcher icons + theme) + link -> unsigned APK.
$BT/aapt2 compile --dir "$PROJ/src/main/res" -o "$STAGE/res.zip"
$BT/aapt2 link -o "$STAGE/app-unsigned.apk" \
  --auto-add-overlay \
  --manifest "$MANIFEST" \
  -A "$STAGE/assets" \
  -R "$STAGE/res.zip" \
  -I "$SDK/platforms/android-34/android.jar" \
  --min-sdk-version 26 --target-sdk-version 35 \
  --version-code "$VERSION_CODE" --version-name "$VERSION"

# 2. compile java (the one shell activity).
javac -encoding UTF-8 -source 17 -target 17 \
  -cp "$SDK/platforms/android-34/android.jar" \
  -d "$STAGE/classes" \
  "$PROJ/src/main/java/com/joshua/basicepubreader/"*.java

# 3. dex. --min-api 26 matches the manifest's minSdkVersion.
$BT/d8 --min-api 26 --lib "$SDK/platforms/android-34/android.jar" \
  --output "$STAGE/dex" "$STAGE/classes/com/joshua/basicepubreader/"*.class

# 4. add classes.dex at APK root.
cp "$STAGE/app-unsigned.apk" "$STAGE/app-dex.apk"
(cd "$STAGE/dex" && zip -X ../app-dex.apk classes.dex)

# 5. align.
$BT/zipalign -f 4 "$STAGE/app-dex.apk" "$STAGE/app-aligned.apk"

# 6. sign with the release keystore.
$BT/apksigner sign --ks "$KS" --ks-pass "pass:$KS_PASS" \
  --key-pass "pass:$KS_PASS" --out "$STAGE/basic-epub-reader.apk" "$STAGE/app-aligned.apk"
unset KS_PASS

# 7. verify: badging MUST read VERSION/VERSION_CODE; signature valid;
#    payload carries the page, both libs and the generated starter book.
echo "=== badging ==="
BADGING=$($BT/aapt dump badging "$STAGE/basic-epub-reader.apk")
echo "$BADGING" | grep -E "package:|sdkVersion|targetSdkVersion|application:|launchable"
if ! echo "$BADGING" | grep -q "versionCode='$VERSION_CODE' versionName='$VERSION'"; then
  echo "FATAL: VERSION GATE — packaged APK badging does not read" >&2
  echo "  versionCode='$VERSION_CODE' versionName='$VERSION'" >&2
  exit 1
fi
echo "version gate: packaged APK reads versionCode $VERSION_CODE / versionName $VERSION"
echo "=== apksigner verify ==="
$BT/apksigner verify --print-certs "$STAGE/basic-epub-reader.apk" | head -5
echo "=== payload ==="
unzip -l "$STAGE/basic-epub-reader.apk" | grep -E "index.html|app.js|style.css|epub.min.js|jszip.min.js|sample-book.js|classes.dex"

cp "$STAGE/basic-epub-reader.apk" "$OUT"
ls -la "$OUT"
sha256sum "$OUT"
echo BUILD_OK
