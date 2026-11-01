package com.ratti.carview

import androidx.car.app.AppManager
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarIcon
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * The main car screen: a web page (YouTube by default) drawn on the car display,
 * with buttons for search, home, back and play/pause.
 *
 * Picture is shown only while the car is parked. When moving (or when the speed
 * is unknown) the picture is covered and only the sound plays.
 */
class BrowserScreen(carContext: CarContext) : Screen(carContext) {

    private val renderer = WebSurfaceRenderer(carContext)
    private val drivingMonitor = DrivingStateMonitor(carContext) { state -> applyDrivingState(state) }

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onCreate(owner: LifecycleOwner) {
                carContext.getCarService(AppManager::class.java).setSurfaceCallback(renderer)
                applyDrivingState(drivingMonitor.state)
                if (drivingMonitor.hasSpeedPermission()) {
                    drivingMonitor.start()
                } else {
                    requestSpeedPermission()
                }
            }

            override fun onDestroy(owner: LifecycleOwner) {
                drivingMonitor.stop()
                renderer.release()
            }
        })
    }

    private fun requestSpeedPermission() {
        try {
            carContext.requestPermissions(listOf(DrivingStateMonitor.SPEED_PERMISSION)) { _, _ ->
                drivingMonitor.start()
            }
        } catch (e: Exception) {
            // Older hosts can't ask from the car; the phone app asks instead.
        }
    }

    private fun applyDrivingState(state: DrivingStateMonitor.State) {
        when (state) {
            DrivingStateMonitor.State.PARKED ->
                renderer.setVideoAllowed(true, "")
            DrivingStateMonitor.State.MOVING ->
                renderer.setVideoAllowed(
                    false,
                    "🔊 กำลังเล่นเฉพาะเสียง\n\nภาพจะกลับมาเมื่อจอดรถ",
                )
            DrivingStateMonitor.State.UNKNOWN ->
                renderer.setVideoAllowed(
                    false,
                    if (drivingMonitor.hasSpeedPermission()) {
                        "🔊 กำลังเล่นเฉพาะเสียง\n\nอ่านความเร็วรถไม่ได้ จึงไม่แสดงภาพ"
                    } else {
                        "🔊 กำลังเล่นเฉพาะเสียง\n\nเปิดแอป CarView บนมือถือ\nแล้วกด \"อนุญาตให้อ่านความเร็วรถ\""
                    },
                )
        }
    }

    override fun onGetTemplate(): Template {
        val actions = ActionStrip.Builder()
            .addAction(iconAction(R.drawable.ic_search) {
                screenManager.push(
                    SearchVideoScreen(carContext) { query ->
                        renderer.loadUrl(WebSurfaceRenderer.searchUrl(query))
                    },
                )
            })
            .addAction(iconAction(R.drawable.ic_home) { renderer.loadUrl(WebSurfaceRenderer.HOME_URL) })
            .addAction(iconAction(R.drawable.ic_back) { renderer.goBack() })
            .addAction(iconAction(R.drawable.ic_play_pause) { renderer.togglePlayPause() })
            .build()

        // The pan button lets the driver-side touchpad / screen scroll the page while parked.
        val mapActions = ActionStrip.Builder()
            .addAction(Action.PAN)
            .build()

        return NavigationTemplate.Builder()
            .setActionStrip(actions)
            .setMapActionStrip(mapActions)
            .setPanModeListener { }
            .build()
    }

    private fun iconAction(iconRes: Int, onClick: () -> Unit): Action =
        Action.Builder()
            .setIcon(CarIcon.Builder(IconCompat.createWithResource(carContext, iconRes)).build())
            .setOnClickListener { onClick() }
            .build()
}
