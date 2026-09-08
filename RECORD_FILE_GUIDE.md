# Clean Garage V10.19.1 — Save / Load Record File

## แนวทางใช้งาน
ข้อมูลหลักยังอยู่ใน IndexedDB ของอุปกรณ์ที่กำลังใช้งาน

เมื่อจะย้ายข้อมูลระหว่างมือถือกับคอม:
1. ใช้อุปกรณ์ที่มีข้อมูลล่าสุด
2. ไปที่ Local Database > My Record
3. กด SAVE RECORD FILE
4. เก็บ `CleanGarage_Record.json` ไว้ใน Files / iCloud Drive / Google Drive / OneDrive
5. เปิด Clean Garage บนอุปกรณ์อีกเครื่อง
6. กด LOAD RECORD FILE
7. เลือกไฟล์ `CleanGarage_Record.json`
8. ตรวจ Preview แล้วกด Load and replace

## หลักสำคัญ
- ก่อนสลับอุปกรณ์ ให้ Save จากเครื่องที่มีข้อมูลล่าสุดเสมอ
- ถ้า Badge ขึ้น `Unsaved changes` แปลว่าข้อมูลใน IndexedDB ใหม่กว่า Record file ล่าสุด
- GitHub Pages ใช้โฮสต์ตัวเว็บเท่านั้น
- ไม่มี GitHub Token
- ไม่มี Cloudflare Worker
- ไม่มี Cloud Database
- JSON format เดิมยังรองรับ Backup รุ่นเก่า


## Shared Record ผ่าน GitHub Pages (V10.19.2)
1. บนอุปกรณ์ที่มีข้อมูลล่าสุด กด `SAVE RECORD FILE`
2. จะได้ `CleanGarage_Record.json`
3. อัปโหลด/Replace ไฟล์นี้ใน GitHub repo ตรง root เดียวกับ `index.html`
4. รอ GitHub Pages deploy
5. เปิด Clean Garage บนมือถือ
6. แอปจะเช็ก `./CleanGarage_Record.json` อัตโนมัติ
7. ถ้าไฟล์ใหม่กว่าและมือถือไม่มี `Unsaved changes` ระบบจะโหลดให้อัตโนมัติ
8. ถ้ามือถือมี `Unsaved changes` ระบบจะไม่เขียนทับ และจะแสดง `LOAD SHARED RECORD`

Privacy: ถ้า GitHub Pages เปิดสาธารณะ `CleanGarage_Record.json` ก็เปิดอ่านจากอินเทอร์เน็ตได้
