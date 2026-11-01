# CarView: บันทึกสำหรับเริ่มงานต่อ (Handoff)

> ใช้ไฟล์นี้เปิดเซสชันใหม่กับ Claude ได้เลย เช่นพิมพ์ว่า
> "อ่าน HANDOFF.md แล้วช่วยทำ CarView ต่อ"

## 1. โปรเจกต์นี้คืออะไร

**CarView** เป็นแอป Android สำหรับใช้ส่วนตัว ติดตั้งเองแบบ sideload ไม่ได้ขึ้น Play Store
แอปเปิดหน้าเว็บ YouTube (`m.youtube.com`) บนจอรถผ่าน **Android Auto** คล้ายแอป CarStream หรือ Fermata Auto
แต่มีกฎความปลอดภัยที่ตกลงกันไว้แล้ว:

| สถานะรถ | จอรถ |
|---|---|
| จอดนิ่งครบ 3 วินาที (≤ 0.5 m/s) | แสดงวิดีโอและเล่นเสียง แตะหรือเลื่อนหน้าเว็บได้ |
| รถวิ่ง (> 0.5 m/s) | ปิดภาพ **ทันที** จอดำพร้อมข้อความ เสียงยังเล่นต่อ แตะจอไม่ได้ |
| อ่านความเร็วไม่ได้ / ยังไม่ได้อนุญาต | ทำเหมือนรถวิ่ง (fail-safe) |

### ข้อตกลงที่ห้ามเปลี่ยน
- **ห้ามแสดงภาพวิดีโอบนจอรถตอนรถวิ่ง** ไม่ว่าในกรณีใด ผู้ใช้เคยขอไปแล้วและตกลงกันว่าไม่ทำ
  เพราะจอกลางอยู่ในสายตาคนขับเสมอ
- ถ้าผู้โดยสารอยากดูภาพระหว่างทาง ให้ใช้จอที่คนขับมองไม่เห็นแทน (ดูหัวข้อ 6 ข้อ 3)

## 2. ตำแหน่งไฟล์

- บนเครื่องผู้ใช้ (Windows): `H:\Carview`
- บน GitHub: repo `rbblackhack0950/ratti.github.io` branch `ccr-2cdc3bdd-sq6la8` โฟลเดอร์ `carview/`
- CI: `.github/workflows/carview-android.yml` (build debug APK แล้วอัปโหลดเป็น artifact)

```
carview/
├─ settings.gradle.kts, build.gradle.kts, gradle.properties
├─ gradlew, gradlew.bat, gradle/wrapper/   (Gradle 8.14.3)
└─ app/
   ├─ build.gradle.kts                      (AGP 8.7.3, Kotlin 2.1.0, compileSdk 35, minSdk 26)
   └─ src/main/
      ├─ AndroidManifest.xml
      ├─ res/xml/automotive_app_desc.xml
      ├─ res/drawable/ic_*.xml              (ไอคอน vector)
      ├─ res/values/strings.xml
      └─ java/com/ratti/carview/
         ├─ CarViewService.kt       จุดเข้าของ Android Auto (CarAppService + Session)
         ├─ BrowserScreen.kt        หน้าจอหลักบนรถ: NavigationTemplate + ปุ่ม 4 ปุ่ม
         ├─ SearchVideoScreen.kt    หน้าค้นหา (SearchTemplate)
         ├─ WebSurfaceRenderer.kt   วาด WebView ลง Surface ของรถ
         ├─ DrivingStateMonitor.kt  อ่านความเร็ว → PARKED / MOVING / UNKNOWN
         └─ MainActivity.kt         หน้าแอปบนมือถือ: วิธีตั้งค่า + ปุ่มขอสิทธิ์ความเร็ว
```

Dependencies:
- `androidx.car.app:app:1.4.0`
- `androidx.car.app:app-projected:1.4.0`
- `androidx.core:core-ktx:1.13.1`

## 3. หลักการทำงาน

1. แอปประกาศหมวด `androidx.car.app.category.NAVIGATION` และขอสิทธิ์
   `NAVIGATION_TEMPLATES` กับ `ACCESS_SURFACE` เพื่อให้ได้ Surface เต็มจอรถ
   (หมวดนี้ขึ้น Play Store ไม่ได้ เพราะไม่ใช่แอปนำทางจริง จึงใช้ได้แบบ sideload เท่านั้น)
2. `WebSurfaceRenderer` ทำงานตามลำดับนี้
   - สร้าง `VirtualDisplay` บน Surface ที่ได้จากรถ
   - แสดงหน้าต่าง `Presentation` บนจอเสมือนนั้น ภายในมี `FrameLayout` ซ้อนกัน 3 ชั้น
     - WebView
     - วิดีโอเต็มจอ (custom view จาก WebChromeClient)
     - แผ่นปิด (cover) สีดำ ชั้นบนสุด กินการแตะทั้งหมด
   - `onClick(x,y)` จากรถจะถูกแปลงเป็น MotionEvent DOWN/UP ส่งให้ root view
   - `onScroll` จะสั่ง JS `window.scrollBy` (ทำงานเฉพาะตอนจอด)
   - `onVisibleAreaChanged` ใส่ padding ให้หน้าเว็บไม่ถูกปุ่มของรถบัง
   - เมื่อ Surface ถูกทำลาย (เช่น เปิดหน้าค้นหา) จะทิ้ง WebView ไป แล้วเปิด `currentUrl` ใหม่เมื่อ Surface กลับมา
3. `DrivingStateMonitor` ใช้ `CarHardwareManager.carInfo.addSpeedListener`
   - ต้องได้สิทธิ์ `com.google.android.gms.permission.CAR_SPEED` ก่อน
     (ขอได้จากปุ่มในแอปบนมือถือ หรือผ่าน `carContext.requestPermissions`)
   - `minCarApiLevel = 3` เพราะ API hardware เริ่มมีที่ระดับ 3
4. ปุ่มบนจอรถ: ค้นหา · หน้าแรก · ย้อนกลับ · เล่น/หยุด (ใช้ JS สั่ง `<video>`)
   และปุ่ม `Action.PAN` ใน map action strip

## 4. สถานะตอนนี้

- [x] เขียนโค้ดครบตามข้างบนแล้ว และ push ขึ้น GitHub แล้ว
- [ ] **ยังไม่เคย build สำเร็จสักครั้ง** อาจมี compile error เล็ก ๆ
  - GitHub Actions ล้มเหลวภายใน 4 วินาทีโดยไม่มี log แปลว่างานไม่ได้เริ่มรันเลย
    น่าจะเป็นปัญหาการตั้งค่าบัญชี GitHub ไม่ใช่ที่โค้ด ยังไม่ได้ตรวจสาเหตุ
  - เครื่องคลาวด์ของ Claude เข้า `dl.google.com` ไม่ได้ จึง build Android ในนั้นไม่ได้
- [ ] ยังไม่ได้ทดสอบบน DHU หรือในรถจริง
- ผู้ใช้วางโปรเจกต์ไว้ที่ `H:\Carview` แล้ว และกำลังจะ build ด้วย Android Studio บน Windows

## 5. ขั้นตอนถัดไป

1. เปิด `H:\Carview` ใน Android Studio → รอ Gradle sync → **Build → Build APK(s)**
2. ถ้ามี error ให้แก้ทีละจุด จุดที่น่าจะต้องเช็กก่อน:
   - `SurfaceCallback.onClick` ต้องใช้ car API level 5 ให้เช็กว่ามีใน `app:1.4.0` หรือไม่
   - signature ของ `carContext.requestPermissions(...)` และ `setPanModeListener`
   - ไลบรารีเวอร์ชันใหม่กว่าที่ Android Studio แนะนำให้อัปเกรด
3. ทดสอบด้วย **Desktop Head Unit (DHU)**:
   SDK Manager → SDK Tools → *Android Auto Desktop Head Unit Emulator*
4. ทดสอบในรถจริง โดยเปิด "Unknown sources" ใน Developer settings ของ Android Auto ก่อน
5. ไฟล์ APK ที่ได้: `H:\Carview\app\build\outputs\apk\debug\app-debug.apk`

## 6. งานที่ยังไม่ได้ทำ (ไว้ทำต่อ)

1. **โหมดเสียงตอนรถวิ่งให้ดีขึ้น**: แสดงชื่อคลิป และให้แสดงปุ่มเล่น/หยุด/ข้ามบนแผ่นปิด
2. **จำตำแหน่งวิดีโอ** เมื่อ Surface ถูกสร้างใหม่ เช่น เติม `&t=` ใน URL เพื่อเล่นต่อจากเดิม
3. **แอปคู่สำหรับแท็บเล็ตของผู้โดยสาร**: เลือกคลิปจากจอรถหรือมือถือ แล้วไปเล่นบนแท็บเล็ตหลังเบาะ
   โดยส่งเสียงออกลำโพงรถ วิธีนี้ทำให้ผู้โดยสารได้ดูภาพตลอดทาง
4. ตั้ง debug keystore ให้คงที่ เพื่อให้ติดตั้งเวอร์ชันใหม่ทับตัวเก่าได้

## 7. ข้อควรระวังเรื่องกฎ

- เปิด YouTube ผ่านหน้าเว็บปกติเท่านั้น ห้ามดึงไฟล์วิดีโอตรง ห้ามตัดโฆษณา
- ใช้ `HostValidator.ALLOW_ALL_HOSTS_VALIDATOR` ซึ่งเหมาะกับการใช้ส่วนตัวเท่านั้น
- Android Auto อัปเดตเมื่อไรอาจทำให้แอปลักษณะนี้ใช้ไม่ได้ ต้องคอยตามแก้
