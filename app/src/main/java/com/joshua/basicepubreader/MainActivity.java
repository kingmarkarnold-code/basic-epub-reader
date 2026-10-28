package com.joshua.basicepubreader;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

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
     baked into this app. */
public class MainActivity extends Activity {
    private WebView web;
    private FrameLayout container;
    private ValueCallback<Uri[]> fileCallback;
    private volatile boolean readerOpen = false;
    private volatile boolean fullscreen = false;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private static final int REQ_FILE = 1001;
    private static final String HOME = "file:///android_asset/index.html";

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
    }

    private void jsTtsCallback(String fn, String utteranceId) {
        /* utteranceId is page-generated ("ber" + counter): digits
           and letters only, safe to interpolate. */
        if (web == null) return;
        runOnUiThread(() -> web.evaluateJavascript(
                "window." + fn + " && window." + fn + "('" + utteranceId + "');", null));
    }

    private void jsTtsUnavailable() {
        if (web == null) return;
        runOnUiThread(() -> web.evaluateJavascript(
                "window.__ttsUnavailable && window.__ttsUnavailable();", null));
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
        web.addJavascriptInterface(new ReaderBridge(), "ReaderBridge");
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
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
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
