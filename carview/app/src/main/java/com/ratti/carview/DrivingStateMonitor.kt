package com.ratti.carview

import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.car.app.CarContext
import androidx.car.app.hardware.CarHardwareManager
import androidx.car.app.hardware.common.CarValue
import androidx.car.app.hardware.common.OnCarDataAvailableListener
import androidx.car.app.hardware.info.Speed
import androidx.core.content.ContextCompat
import kotlin.math.abs

/**
 * Watches the car's speed and reports whether video may be shown.
 *
 * Safety rules:
 * - The car counts as moving as soon as one reading is above [PARKED_MAX_MPS].
 * - The car counts as parked only after it has stayed stopped for [PARKED_CONFIRM_MS].
 * - If the speed can't be read (no permission, unsupported car, error) the state is
 *   [State.UNKNOWN], and the app treats that the same as moving: sound only.
 */
class DrivingStateMonitor(
    private val carContext: CarContext,
    private val onChange: (State) -> Unit,
) {
    enum class State { PARKED, MOVING, UNKNOWN }

    var state: State = State.UNKNOWN
        private set

    private val handler = Handler(Looper.getMainLooper())
    private var speedListener: OnCarDataAvailableListener<Speed>? = null
    private var parkedCheckPending = false

    private val confirmParked = Runnable {
        parkedCheckPending = false
        update(State.PARKED)
    }

    fun hasSpeedPermission(): Boolean =
        ContextCompat.checkSelfPermission(carContext, SPEED_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED

    fun start() {
        stop()
        if (!hasSpeedPermission()) {
            update(State.UNKNOWN)
            return
        }
        try {
            val carInfo = carContext.getCarService(CarHardwareManager::class.java).carInfo
            val listener = OnCarDataAvailableListener<Speed> { speed -> onSpeed(speed) }
            carInfo.addSpeedListener(ContextCompat.getMainExecutor(carContext), listener)
            speedListener = listener
        } catch (e: Exception) {
            update(State.UNKNOWN)
        }
    }

    fun stop() {
        cancelParkedCheck()
        val listener = speedListener ?: return
        speedListener = null
        try {
            carContext.getCarService(CarHardwareManager::class.java).carInfo
                .removeSpeedListener(listener)
        } catch (e: Exception) {
            // The car connection is already gone; nothing to clean up.
        }
    }

    private fun onSpeed(speed: Speed) {
        val reading = speed.rawSpeedMetersPerSecond
        val value = reading.value
        if (reading.status != CarValue.STATUS_SUCCESS || value == null) {
            cancelParkedCheck()
            update(State.UNKNOWN)
            return
        }
        if (abs(value) > PARKED_MAX_MPS) {
            cancelParkedCheck()
            update(State.MOVING)
        } else if (state != State.PARKED && !parkedCheckPending) {
            parkedCheckPending = true
            handler.postDelayed(confirmParked, PARKED_CONFIRM_MS)
        }
    }

    private fun cancelParkedCheck() {
        handler.removeCallbacks(confirmParked)
        parkedCheckPending = false
    }

    private fun update(newState: State) {
        if (newState == state) return
        state = newState
        onChange(newState)
    }

    companion object {
        const val SPEED_PERMISSION = "com.google.android.gms.permission.CAR_SPEED"

        /** About 1.8 km/h: below this the car counts as stopped. */
        private const val PARKED_MAX_MPS = 0.5f

        /** How long the car must stay stopped before the picture comes back. */
        private const val PARKED_CONFIRM_MS = 3_000L
    }
}
