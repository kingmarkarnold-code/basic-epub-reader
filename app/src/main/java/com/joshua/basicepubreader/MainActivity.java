package com.joshua.basicepubreader;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/* Basic EPUB Reader shell: one WebView running the shelf + reader.
   Adds what the Suite shell lacked and the reader needs:
   - a real file picker (onShowFileChooser) so the + button can
     import EPUBs from the phone and from Google Drive;
   - a ReaderBridge so the Back key closes the book to the shelf
     instead of quitting the app;
   - (v0.1.1) the rest of Joshua's gesture spec that only the shell
     can do: immersive full screen (system bars gone, no inset
     padding — the page takes the ENTIRE screen) and read-aloud
     through the phone's own TTS engine, so the voice is whichever
     engine Joshua installed (SherpaTTS / Piper), never a voice
     baked into this app;
   - (v0.1.2) FOLDER IMPORT (Joshua, 2026-10-28 12:00): pick ONE
     folder — local or Google Drive, both through the system
     picker, no in-app sign-in — and every EPUB inside it, subfolders
     included, lands on the shelf. The tree walk is a GENERIC
     primitive (pick a tree -> its files' bytes arrive one by one,
     with a receipt ack between files), so the web layer can build
     other imports on it later. Picked folders are remembered
     (persisted URI permission) and can be re-scanned for new books;
   - (v0.1.2) the STABLE-BASE update channel: this APK is the base;
     web-layer fixes ship as numbered bundles published in the
     reader's own repo (update/channel.json + per-file sha256).
     Downloads are verified, staged, and promoted only at the next
     cold start; the WebView keeps loading the SAME
     file:///android_asset/ URL forever (bytes are intercepted and
     served from the downloaded bundle when one is active), so the
     shelf's IndexedDB origin — his books — never moves. The
     APK-bundled www is the always-available fallback: a failed or
     absent bundle can never strand him on a broken reader. */
public class MainActivity extends Activity {
    private WebView web;
    private FrameLayout container;
    private ValueCallback<Uri[]> fileCallback;
    private volatile boolean readerOpen = false;
    private volatile boolean fullscreen = false;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private SharedPreferences prefs;
    /* One folder file in flight at a time: the page acks receipt of
       each file before the next is sent, so a huge folder never
       queues megabytes of book bytes inside the WebView. */
    private final Semaphore folderAck = new Semaphore(0);
    private volatile boolean folderSessionRunning = false;
    private volatile boolean updateCheckRunning = false;
    private static final int REQ_FILE = 1001;
    private static final int REQ_TREE = 1002;
    private static final String HOME = "file:///android_asset/index.html";
    private static final String ASSET_PREFIX = "file:///android_asset/";
    /* The www inside THIS APK is channel bundle 1 (published in the
       repo alongside v0.1.2). Bump by hand at each APK release: it
       is the floor the downloaded-bundle version is compared to. */
    private static final int BUNDLED_WEB_VERSION = 1;
    private static final String CONTENTS_API =
            "https://api.github.com/repos/kingmarkarnold-code/basic-epub-reader/contents/";
    private static final String CHANNEL_URL = CONTENTS_API + "update/channel.json";

    public class ReaderBridge {
        @JavascriptInterface
        public void setReaderOpen(boolean open) {
            readerOpen = open;
        }

        /* Full screen on/off from the page's single-tap gesture. */
        @JavascriptInterface
        public void setFullscreen(boolean on) {
            runOnUiThread(() -> applyFullscreen(on));
        }

        /* Speak ONE chunk of the book. The page sends the next
           chunk when __ttsOnDone fires, so a whole book can be read
           without ever handing the engine more than it can hold. */
        @JavascriptInterface
        public void speak(String utteranceId, String text) {
            runOnUiThread(() -> {
                if (tts == null || !ttsReady) { jsTtsUnavailable(); return; }
                int r = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
                if (r == TextToSpeech.ERROR) jsTtsUnavailable();
            });
        }

        @JavascriptInterface
        public void stopSpeaking() {
            runOnUiThread(() -> { if (tts != null) tts.stop(); });
        }

        /* ---- folder import (v0.1.2) ---- */

        /* Open the system folder picker (local storage AND Google
           Drive — Drive appears because it is installed; Phase 1
           design: no sign-in inside this app). */
        @JavascriptInterface
        public void pickFolder() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                try {
                    startActivityForResult(intent, REQ_TREE);
                } catch (Exception e) {
                    jsCall("window.__folderPickFailed && window.__folderPickFailed();");
                }
            });
        }

        /* Re-scan every remembered folder for EPUBs not yet on the
           shelf (the page dedupes by content key). */
        @JavascriptInterface
        public void rescanFolders() {
            startFolderSession(null, "rescan");
        }

        /* Receipt ack from the page: it has one folder file in
           hand, the next may be sent. */
        @JavascriptInterface
        public void folderBookAck() {
            folderAck.release();
        }

        @JavascriptInterface
        public int folderCount() {
            return loadFolders().length();
        }

        /* ---- update channel (v0.1.2) ---- */

        @JavascriptInterface
        public void checkForUpdates() {
            runUpdateCheck(true);
        }

        /* The web bundle version currently SERVING (downloaded
           bundle once promoted, else the APK-bundled one). */
        @JavascriptInterface
        public int webBundleVersion() {
            return activeWebVersion();
        }

        @JavascriptInterface
        public String shellVersionName() {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pi.versionName;
            } catch (Exception e) {
                return "?";
            }
        }
    }

    private void jsCall(final String js) {
        if (web == null) return;
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    private void jsTtsCallback(String fn, String utteranceId) {
        /* utteranceId is page-generated ("ber" + counter): digits
           and letters only, safe to interpolate. */
        jsCall("window." + fn + " && window." + fn + "('" + utteranceId + "');");
    }

    private void jsTtsUnavailable() {
        jsCall("window.__ttsUnavailable && window.__ttsUnavailable();");
    }

    /* ================= folder import =================
       Generic shape: startTreeSession walks picked trees with the
       framework DocumentsContract (no AndroidX on this build),
       collects files by extension, then delivers each file's bytes
       to the page — __folderScanStart(kind, total),
       __folderBook(name, base64) per file (ack between files),
       __folderScanEnd(kind, inaccessibleCount). Any future import
       ("a folder of dictionaries", "a folder of covers") reuses
       this exact pipe with a different extension/kind. */

    private JSONArray loadFolders() {
        try {
            String raw = prefs.getString("folders_json", "[]");
            return new JSONArray(raw == null ? "[]" : raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private void rememberFolder(Uri treeUri) {
        try {
            JSONArray arr = loadFolders();
            String uriStr = treeUri.toString();
            for (int i = 0; i < arr.length(); i++) {
                if (uriStr.equals(arr.getJSONObject(i).optString("uri"))) return;
            }
            JSONObject entry = new JSONObject();
            entry.put("uri", uriStr);
            entry.put("name", treeDisplayName(treeUri));
            arr.put(entry);
            prefs.edit().putString("folders_json", arr.toString()).apply();
        } catch (Exception e) { /* remembering is a courtesy; the import itself still runs */ }
    }

    private String treeDisplayName(Uri treeUri) {
        Cursor c = null;
        try {
            String docId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
            c = getContentResolver().query(docUri,
                    new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                    null, null, null);
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && n.length() > 0) return n;
            }
        } catch (Exception e) { /* fall through to the generic name */ }
        finally { if (c != null) c.close(); }
        return "Folder";
    }

    private boolean hasReadPermission(Uri treeUri) {
        try {
            for (UriPermission p : getContentResolver().getPersistedUriPermissions()) {
                if (p.getUri().equals(treeUri) && p.isReadPermission()) return true;
            }
        } catch (Exception e) { /* treated as gone */ }
        return false;
    }

    /* Recursive tree walk. A subtree that refuses (provider gone,
       permission revoked mid-walk) is skipped, never fatal. */
    private void collectByExtension(Uri treeUri, String parentDocId,
                                    String[] extensions, List<String[]> out) {
        Cursor c = null;
        try {
            Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);
            c = getContentResolver().query(childrenUri, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE}, null, null, null);
            if (c == null) return;
            while (c.moveToNext()) {
                String docId = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    collectByExtension(treeUri, docId, extensions, out);
                } else if (name != null && endsWithAny(name, extensions)) {
                    out.add(new String[]{docId, name});
                }
            }
        } catch (Exception e) { /* skip this subtree */ }
        finally { if (c != null) c.close(); }
    }

    private static boolean endsWithAny(String name, String[] extensions) {
        String lower = name.toLowerCase(Locale.US);
        for (String ext : extensions) {
            if (lower.endsWith("." + ext)) return true;
        }
        return false;
    }

    private byte[] readDocument(Uri treeUri, String docId) throws Exception {
        Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
        InputStream in = getContentResolver().openInputStream(docUri);
        if (in == null) throw new Exception("provider returned no stream");
        try {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[64 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toByteArray();
        } finally {
            in.close();
        }
    }

    /* pickedTree == null means "every remembered folder" (rescan). */
    private void startFolderSession(final Uri pickedTree, final String kind) {
        if (folderSessionRunning) {
            jsCall("window.__folderBusy && window.__folderBusy();");
            return;
        }
        folderSessionRunning = true;
        new Thread(() -> {
            int inaccessible = 0;
            try {
                List<Uri> trees = new ArrayList<>();
                if (pickedTree != null) {
                    trees.add(pickedTree);
                } else {
                    JSONArray arr = loadFolders();
                    for (int i = 0; i < arr.length(); i++) {
                        Uri u = Uri.parse(arr.getJSONObject(i).optString("uri"));
                        if (hasReadPermission(u)) trees.add(u); else inaccessible++;
                    }
                }
                /* Collect first, so the page can show "n of N". */
                List<Object[]> files = new ArrayList<>();  // {treeUri, docId, name}
                for (Uri tree : trees) {
                    List<String[]> found = new ArrayList<>();
                    try {
                        collectByExtension(tree, DocumentsContract.getTreeDocumentId(tree),
                                new String[]{"epub"}, found);
                    } catch (Exception e) {
                        inaccessible++;
                        continue;
                    }
                    for (String[] f : found) files.add(new Object[]{tree, f[0], f[1]});
                }
                jsCall("window.__folderScanStart && window.__folderScanStart('"
                        + kind + "'," + files.size() + ");");
                for (Object[] f : files) {
                    try {
                        byte[] bytes = readDocument((Uri) f[0], (String) f[1]);
                        String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                        folderAck.drainPermits();
                        jsCall("window.__folderBook && window.__folderBook("
                                + JSONObject.quote((String) f[2]) + ",'" + b64 + "');");
                        /* One book in flight: wait for the page's
                           receipt before sending the next. A lost
                           ack (page error) times out and the scan
                           carries on — files the page never saw are
                           counted as failed by the page's own math
                           (total - added - already-there - unread). */
                        folderAck.tryAcquire(20, TimeUnit.SECONDS);
                    } catch (Exception e) {
                        /* unreadable file: skipped; the page counts
                           it in the summary's failed number */
                    }
                }
                jsCall("window.__folderScanEnd && window.__folderScanEnd('"
                        + kind + "'," + inaccessible + ");");
            } catch (Exception e) {
                jsCall("window.__folderScanEnd && window.__folderScanEnd('"
                        + kind + "'," + inaccessible + ");");
            } finally {
                folderSessionRunning = false;
            }
        }, "folder-import").start();
    }

    /* ================= update channel =================
       channel.json (in this app's repo, under update/) names a
       bundleVersion, a minShellVersion, and every web file's
       sha256. A check downloads only the files whose bytes differ
       from what is currently served, verifies each against the
       manifest, and stages a COMPLETE bundle in webbundle-next.
       Promotion to webbundle happens only here at cold start —
       a bundle never swaps mid-session. Any failure anywhere keeps
       the last-good bundle (or the APK's own www) serving. */

    private File bundleDir() { return new File(getFilesDir(), "webbundle"); }
    private File bundleNextDir() { return new File(getFilesDir(), "webbundle-next"); }

    private int activeWebVersion() {
        int downloaded = prefs.getInt("serving_web_version", 0);
        return Math.max(BUNDLED_WEB_VERSION, downloaded);
    }

    private int shellVersionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private void promotePendingBundle() {
        try {
            int pending = prefs.getInt("pending_web_version", 0);
            File next = bundleNextDir();
            if (pending > activeWebVersion() && next.isDirectory()) {
                File cur = bundleDir();
                deleteRecursive(cur);
                if (next.renameTo(cur)) {
                    prefs.edit().putInt("serving_web_version", pending)
                            .remove("pending_web_version").apply();
                }
            }
        } catch (Exception e) { /* a failed promotion just means the old bundle serves */ }
    }

    private void runUpdateCheck(final boolean manual) {
        if (updateCheckRunning) return;
        updateCheckRunning = true;
        new Thread(() -> {
            String result = "failed";
            int version = activeWebVersion();
            try {
                JSONObject channel = new JSONObject(
                        new String(fetchContentsApi(CHANNEL_URL), "UTF-8"));
                int bundleVersion = channel.getInt("bundleVersion");
                int minShell = channel.optInt("minShellVersion", 0);
                if (minShell > shellVersionCode()) {
                    result = "needs-apk";
                } else if (bundleVersion <= activeWebVersion()) {
                    result = "current";
                } else {
                    JSONObject files = channel.getJSONObject("files");
                    File staging = new File(getFilesDir(), "webbundle-staging");
                    deleteRecursive(staging);
                    if (!staging.mkdirs()) throw new Exception("no staging dir");
                    boolean complete = true;
                    Iterator<String> names = files.keys();
                    while (names.hasNext()) {
                        String name = names.next();
                        JSONObject fi = files.getJSONObject(name);
                        String wantSha = fi.getString("sha256");
                        String path = fi.optString("path", "files/" + name);
                        byte[] served = servedBytes(name);
                        if (served != null && wantSha.equals(sha256Hex(served))) {
                            writeFile(new File(staging, name), served);
                        } else {
                            byte[] downloaded = fetchContentsApi(CONTENTS_API + "update/" + path);
                            if (!wantSha.equals(sha256Hex(downloaded))) {
                                complete = false;
                                break;
                            }
                            writeFile(new File(staging, name), downloaded);
                        }
                    }
                    if (complete) {
                        File next = bundleNextDir();
                        deleteRecursive(next);
                        if (staging.renameTo(next)) {
                            prefs.edit().putInt("pending_web_version", bundleVersion).apply();
                            result = "updated";
                            version = bundleVersion;
                        }
                    } else {
                        deleteRecursive(staging);
                    }
                }
            } catch (Exception e) {
                result = "failed";
            } finally {
                updateCheckRunning = false;
            }
            if (manual || "updated".equals(result)) {
                jsCall("window.__updateCheckResult && window.__updateCheckResult('"
                        + result + "'," + version + ");");
            }
        }, "update-check").start();
    }

    /* GET a repo file through the Contents API (the repo is
       public; no credential lives in this app) and decode its
       base64 body. Contents API serves files up to 1 MB this way —
       every web file in this app is far under that. */
    private byte[] fetchContentsApi(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("Accept", "application/vnd.github+json");
        conn.setRequestProperty("User-Agent", "BasicEPUBReader");
        try {
            if (conn.getResponseCode() != 200) throw new Exception("HTTP " + conn.getResponseCode());
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            InputStream in = conn.getInputStream();
            byte[] chunk = new byte[32 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            JSONObject body = new JSONObject(new String(buf.toByteArray(), "UTF-8"));
            String content = body.getString("content").replaceAll("\\s", "");
            return Base64.decode(content, Base64.DEFAULT);
        } finally {
            conn.disconnect();
        }
    }

    /* The bytes the WebView would serve for an asset-relative name
       right now: downloaded bundle first, APK asset second. */
    private byte[] servedBytes(String name) {
        File f = new File(bundleDir(), name);
        if (f.isFile()) {
            try { return readAll(new FileInputStream(f)); } catch (Exception e) { /* fall to asset */ }
        }
        try {
            InputStream in = getAssets().open(name);
            try { return readAll(in); } finally { in.close(); }
        } catch (Exception e) {
            return null;
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[32 * 1024];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        return buf.toByteArray();
    }

    private static String sha256Hex(byte[] data) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static void writeFile(File f, byte[] data) throws Exception {
        File parent = f.getParentFile();
        if (parent != null) parent.mkdirs();
        FileOutputStream out = new FileOutputStream(f);
        try { out.write(data); } finally { out.close(); }
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        f.delete();
    }

    private static String mimeFor(String name) {
        String lower = name.toLowerCase(Locale.US);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    /* Immersive full screen: hide the system bars AND drop the
       inset padding, so the book page — not the page plus a margin
       where the bars were — fills the whole phone screen. */
    private void applyFullscreen(boolean on) {
        fullscreen = on;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                if (on) {
                    c.setSystemBarsBehavior(
                            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    c.hide(WindowInsets.Type.statusBars()
                            | WindowInsets.Type.navigationBars());
                } else {
                    c.show(WindowInsets.Type.statusBars()
                            | WindowInsets.Type.navigationBars());
                }
            }
        } else {
            View d = getWindow().getDecorView();
            if (on) {
                d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            } else {
                d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            }
        }
        if (container != null) container.requestApplyInsets();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("reader_shell", MODE_PRIVATE);
        /* Cold start: a downloaded bundle waiting in webbundle-next
           becomes the serving bundle BEFORE the WebView loads, so a
           session always runs one consistent bundle. */
        promotePendingBundle();
        container = new FrameLayout(this);
        setContentView(container);
        /* Keep the app clear of the status bar, nav bar and cutout —
           except in full screen, where the page takes it all. */
        container.setOnApplyWindowInsetsListener((v, insets) -> {
            if (fullscreen) {
                v.setPadding(0, 0, 0, 0);
                return WindowInsets.CONSUMED;
            }
            int typeMask = WindowInsets.Type.statusBars()
                    | WindowInsets.Type.navigationBars()
                    | WindowInsets.Type.displayCutout();
            android.graphics.Insets bars = insets.getInsets(typeMask);
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });

        web = new WebView(this);
        container.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        /* Local files only — but never let a stale cached copy of a
           page mask a freshly promoted bundle. */
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.addJavascriptInterface(new ReaderBridge(), "ReaderBridge");
        /* The update channel's serving trick: the page URL never
           changes (file:///android_asset/...), so the shelf's
           IndexedDB origin — his books — never moves; requests are
           answered from the active downloaded bundle when it holds
           the file, and from the APK's assets otherwise. */
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,
                                                              WebResourceRequest request) {
                try {
                    String url = request.getUrl().toString();
                    if (url.startsWith(ASSET_PREFIX)) {
                        String rel = Uri.decode(url.substring(ASSET_PREFIX.length()));
                        int cut = rel.indexOf('?');
                        if (cut >= 0) rel = rel.substring(0, cut);
                        cut = rel.indexOf('#');
                        if (cut >= 0) rel = rel.substring(0, cut);
                        File f = new File(bundleDir(), rel);
                        /* Only ever serve from inside the bundle dir. */
                        if (f.isFile() && f.getCanonicalPath()
                                .startsWith(bundleDir().getCanonicalPath())) {
                            String mime = mimeFor(rel);
                            String enc = mime.startsWith("text/")
                                    || mime.equals("application/json") ? "UTF-8" : null;
                            return new WebResourceResponse(mime, enc, new FileInputStream(f));
                        }
                    }
                } catch (Exception e) { /* any doubt: the asset serves */ }
                return null;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = null;
                try { intent = params.createIntent(); } catch (Exception e) { }
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(intent, REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        /* The phone's default TTS engine — Joshua's choice, reached
           through the standard engine slot (SherpaTTS/Piper if he
           set it). Init is async; speak() reports unavailable until
           the engine is ready and the page falls back gracefully. */
        tts = new TextToSpeech(this, status -> {
            ttsReady = (status == TextToSpeech.SUCCESS);
            if (ttsReady) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utteranceId) { }
                    @Override public void onDone(String utteranceId) {
                        jsTtsCallback("__ttsOnDone", utteranceId);
                    }
                    @Override public void onError(String utteranceId) {
                        jsTtsCallback("__ttsOnError", utteranceId);
                    }
                });
            }
        });
        web.loadUrl(HOME);
        /* Launch check for a newer web bundle (background, silent
           unless one lands; the shelf's Check-for-updates button
           runs the same check and always reports). */
        runUpdateCheck(false);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_TREE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri treeUri = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(treeUri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception e) { /* the import below can still try the live grant */ }
                rememberFolder(treeUri);
                startFolderSession(treeUri, "import");
            }
            return;
        }
        if (requestCode != REQ_FILE || fileCallback == null) return;
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                results = new Uri[n];
                for (int i = 0; i < n; i++)
                    results[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                results = new Uri[] { data.getData() };
            }
        }
        fileCallback.onReceiveValue(results);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (fullscreen && web != null) {
            /* Back steps out of full screen before it ever means
               "close the book". */
            web.evaluateJavascript(
                "window.__exitFullscreen && window.__exitFullscreen();", null);
        } else if (readerOpen && web != null) {
            web.evaluateJavascript(
                "window.__closeReader && window.__closeReader();", null);
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (tts != null) { tts.stop(); tts.shutdown(); }
        super.onDestroy();
    }
}
