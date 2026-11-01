package com.ratti.carview

import android.annotation.SuppressLint
import android.app.Presentation
import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.car.app.CarContext
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer

/**
 * Draws a WebView on the car's screen.
 *
 * The car gives the app a Surface. The app puts a private virtual display on that
 * Surface and shows a Presentation window (WebView + a cover) on it.
 *
 * While the car isn't parked, the cover hides the picture and blocks touches,
 * but the WebView keeps playing, so the sound continues.
 */
class WebSurfaceRenderer(private val carContext: CarContext) : SurfaceCallback {

    private val mainHandler = Handler(Looper.getMainLooper())

    private var virtualDisplay: VirtualDisplay? = null
    private var presentation: Presentation? = null
    private var root: FrameLayout? = null
    private var webView: WebView? = null
    private var cover: View? = null
    private var coverText: TextView? = null
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    private var surfaceWidth = 0
    private var surfaceHeight = 0
    private var visibleArea: Rect? = null

    /** The page to show; kept so it can be reopened when the surface comes back. */
    private var currentUrl: String = HOME_URL

    private var videoAllowed = false
    private var coverMessage = ""

    // ---- Called by the screen ---------------------------------------------------

    fun loadUrl(url: String) = onMain {
        currentUrl = url
        webView?.loadUrl(url)
    }

    fun goBack() = onMain {
        val web = webView ?: return@onMain
        if (fullscreenView != null) {
            exitFullscreen()
        } else if (web.canGoBack()) {
            web.goBack()
        }
    }

    fun togglePlayPause() = onMain {
        webView?.evaluateJavascript(TOGGLE_PLAY_JS, null)
    }

    /** Shows the picture only when [allowed] is true; otherwise covers it with [message]. */
    fun setVideoAllowed(allowed: Boolean, message: String) = onMain {
        videoAllowed = allowed
        coverMessage = message
        applyCover()
    }

    fun release() = onMain { tearDown() }

    // ---- SurfaceCallback ----------------------------------------------------------

    override fun onSurfaceAvailable(surfaceContainer: SurfaceContainer) = onMain {
        val surface = surfaceContainer.surface ?: return@onMain
        tearDown()
        surfaceWidth = surfaceContainer.width
        surfaceHeight = surfaceContainer.height
        val displayManager = carContext.getSystemService(DisplayManager::class.java)
        val display = displayManager.createVirtualDisplay(
            "CarView",
            surfaceWidth,
            surfaceHeight,
            surfaceContainer.dpi,
            surface,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY,
        )
        virtualDisplay = display
        val newPresentation = Presentation(carContext, display.display)
        presentation = newPresentation
        buildViews(newPresentation.context)
        newPresentation.setContentView(root!!)
        newPresentation.show()
        applyVisibleArea()
        applyCover()
        webView?.loadUrl(currentUrl)
    }

    override fun onSurfaceDestroyed(surfaceContainer: SurfaceContainer) = onMain { tearDown() }

    override fun onVisibleAreaChanged(visibleArea: Rect) = onMain {
        this.visibleArea = Rect(visibleArea)
        applyVisibleArea()
    }

    override fun onStableAreaChanged(stableArea: Rect) = Unit

    override fun onClick(x: Float, y: Float) = onMain {
        val target = root ?: return@onMain
        val time = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(time, time, MotionEvent.ACTION_DOWN, x, y, 0)
        val up = MotionEvent.obtain(time, time + 50, MotionEvent.ACTION_UP, x, y, 0)
        target.dispatchTouchEvent(down)
        target.dispatchTouchEvent(up)
        down.recycle()
        up.recycle()
    }

    override fun onScroll(distanceX: Float, distanceY: Float) = onMain {
        if (!videoAllowed) return@onMain
        webView?.evaluateJavascript(
            "window.scrollBy(${distanceX.toInt()}, ${distanceY.toInt()});",
            null,
        )
    }

    override fun onFling(velocityX: Float, velocityY: Float) = Unit

    override fun onScale(focusX: Float, focusY: Float, scaleFactor: Float) = Unit

    // ---- Views --------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildViews(context: Context) {
        val frame = FrameLayout(context).apply { setBackgroundColor(Color.BLACK) }
        val match = ViewGroup.LayoutParams.MATCH_PARENT

        val web = WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                    currentUrl = url
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                    enterFullscreen(view, callback)
                }

                override fun onHideCustomView() {
                    exitFullscreen()
                }
            }
        }
        frame.addView(web, FrameLayout.LayoutParams(match, match))

        val text = TextView(context).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            gravity = Gravity.CENTER
        }
        val coverView = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            // Swallow touches so nothing behind the cover can be tapped while driving.
            isClickable = true
            val pad = (32 * context.resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            addView(text)
        }
        frame.addView(coverView, FrameLayout.LayoutParams(match, match))

        root = frame
        webView = web
        cover = coverView
        coverText = text
    }

    private fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        val frame = root ?: return callback.onCustomViewHidden()
        exitFullscreen()
        fullscreenView = view
        fullscreenCallback = callback
        // Index 1: above the WebView, below the cover.
        frame.addView(
            view,
            1,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
    }

    private fun exitFullscreen() {
        val view = fullscreenView ?: return
        root?.removeView(view)
        fullscreenView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
    }

    private fun applyCover() {
        cover?.visibility = if (videoAllowed) View.GONE else View.VISIBLE
        coverText?.text = coverMessage
    }

    /** Keeps the page clear of the buttons the car draws on top of the surface. */
    private fun applyVisibleArea() {
        val frame = root ?: return
        val area = visibleArea ?: return
        if (surfaceWidth == 0 || surfaceHeight == 0 || area.isEmpty) return
        frame.setPadding(
            area.left.coerceAtLeast(0),
            area.top.coerceAtLeast(0),
            (surfaceWidth - area.right).coerceAtLeast(0),
            (surfaceHeight - area.bottom).coerceAtLeast(0),
        )
    }

    private fun tearDown() {
        exitFullscreen()
        webView?.let { web ->
            (web.parent as? ViewGroup)?.removeView(web)
            web.destroy()
        }
        webView = null
        root = null
        cover = null
        coverText = null
        presentation?.dismiss()
        presentation = null
        virtualDisplay?.release()
        virtualDisplay = null
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }

    companion object {
        const val HOME_URL = "https://m.youtube.com/"

        fun searchUrl(query: String): String =
            "https://m.youtube.com/results?search_query=" +
                java.net.URLEncoder.encode(query, "UTF-8")

        private const val TOGGLE_PLAY_JS =
            "(function(){var v=document.querySelector('video');" +
                "if(!v)return;if(v.paused){v.play();}else{v.pause();}})();"
    }
}
