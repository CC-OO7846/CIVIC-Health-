# Clean Garage V10.19.5 — Reliability Audit Fixes

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
- Local Save/Load รองรับไฟล์สูงสุด 100 MB เหมือนเดิม
- ถ้า Record file ใหญ่กว่า 20 MiB แอปจะแจ้งเตือน เพราะ GitHub browser upload จำกัด 25 MiB ต่อไฟล์ แต่ยังบันทึก local backup ได้


## Shared Record ผ่าน GitHub Pages (V10.19.5)
1. บนอุปกรณ์ที่มีข้อมูลล่าสุด กด `SAVE RECORD FILE`
2. จะได้ `CleanGarage_Record.json`
3. อัปโหลด/Replace ไฟล์นี้ใน GitHub repo ตรง root เดียวกับ `index.html`
4. รอ GitHub Pages deploy
5. เปิด Clean Garage บนมือถือ
6. แอปจะเช็ก `./CleanGarage_Record.json` อัตโนมัติ
7. ถ้าไฟล์ใหม่กว่าและมือถือไม่มี `Unsaved changes` ระบบจะโหลดให้อัตโนมัติ
8. ถ้ามือถือมี `Unsaved changes` ระบบจะไม่เขียนทับ และจะแสดง `LOAD SHARED RECORD`
9. กด `CHECK FOR LATEST RECORD` เพื่อเช็กซ้ำหลัง GitHub Pages deploy เสร็จ

อุปกรณ์เดิมที่มี IndexedDB แต่ยังไม่มี timestamp ของ Record file จะแสดง `First sync required` และจะไม่ถูกเขียนทับอัตโนมัติ ให้เลือก Save ข้อมูล local ก่อน หรือกด Load Shared Record หลังตรวจข้อมูลแล้ว เมื่อ sync สำเร็จครั้งแรก ระบบจึงจะกลับมา auto-load ไฟล์ใหม่กว่าในครั้งถัดไป

ถ้า local มี Unsaved changes และ Shared Record เท่ากับหรือเก่ากว่า ระบบจะแสดง `Local changes not published` และจะไม่เสนอให้เขียนทับ local

แอปอ่านไฟล์จาก path เดียวกับหน้าเว็บเสมอ เช่น
`https://USERNAME.github.io/REPOSITORY/CleanGarage_Record.json` และจะไม่ใช้ domain root

ถ้าไฟล์ยังเป็น 404, เป็น HTML, JSON เสีย, `exportedAt` ไม่ใช่ ISO timestamp ที่ถูกต้อง, timestamp อยู่ในอนาคตเกินค่าคลาดเคลื่อนที่ยอมรับได้ หรือการเขียน IndexedDB ล้มเหลว ข้อมูล local จะไม่ถูกแทนที่

Privacy: ถ้า GitHub Pages เปิดสาธารณะ `CleanGarage_Record.json` ก็เปิดอ่านจากอินเทอร์เน็ตได้
