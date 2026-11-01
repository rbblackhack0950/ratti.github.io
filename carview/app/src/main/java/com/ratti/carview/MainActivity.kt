package com.ratti.carview

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.TypedValue
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Phone screen: setup instructions and the car-speed permission button. */
class MainActivity : Activity() {

    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (20 * resources.displayMetrics.density).toInt()

        status = TextView(this).apply { setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f) }
        val button = Button(this).apply {
            text = "อนุญาตให้อ่านความเร็วรถ"
            setOnClickListener {
                requestPermissions(arrayOf(DrivingStateMonitor.SPEED_PERMISSION), REQUEST_SPEED)
            }
        }
        val guide = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            text = GUIDE
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(TextView(context).apply {
                text = "CarView"
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            })
            addView(status)
            addView(button)
            addView(guide)
        }
        setContentView(ScrollView(this).apply { addView(column) })
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshStatus()
    }

    private fun refreshStatus() {
        val granted = checkSelfPermission(DrivingStateMonitor.SPEED_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED
        status.text = if (granted) {
            "\n✅ อนุญาตให้อ่านความเร็วรถแล้ว\n"
        } else {
            "\n⚠️ ยังไม่ได้อนุญาตให้อ่านความเร็วรถ — จะเล่นได้แค่เสียงจนกว่าจะอนุญาต\n"
        }
    }

    companion object {
        private const val REQUEST_SPEED = 1

        private const val GUIDE = """
วิธีตั้งค่า Android Auto (ทำครั้งเดียว)

1. เปิดแอป Android Auto บนมือถือ (หรือ ตั้งค่า > อุปกรณ์ที่เชื่อมต่อ > Android Auto)
2. เลื่อนลงล่างสุด แตะ "เวอร์ชัน" 10 ครั้ง จนขึ้นว่าเปิดโหมดนักพัฒนาแล้ว
3. แตะเมนู ⋮ มุมขวาบน > การตั้งค่านักพัฒนาซอฟต์แวร์
4. เปิด "แหล่งที่มาที่ไม่รู้จัก" (Unknown sources)
5. ต่อมือถือกับรถ แล้วเปิด CarView จากรายการแอปบนจอรถ

การทำงาน
• จอดรถ: ดูวิดีโอได้ตามปกติ
• รถวิ่ง: ภาพถูกปิด เล่นต่อเฉพาะเสียง
• ภาพกลับมาเองเมื่อรถหยุดนิ่ง 3 วินาที
"""
    }
}
