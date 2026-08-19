import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use(express.static(__dirname));

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || "",
  },
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME?.trim();

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// SABİT OTURUM İLE PRESIGNED URL VE NOT KAYDI
app.post("/get-presigned-urls", async (req, res) => {
  try {
    const { name, note, files, sessionId } = req.body;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "Dosya seçilmedi." });
    }

    const sanitizedName = (name || "Misafir")
      .trim()
      .replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_]/g, "_");
    
    // Rastgele timestamp yerine istemciden gelen sabit sessionId kullanılır
    const safeSessionId = (sessionId || Date.now().toString()).replace(/[^a-zA-Z0-9_-]/g, "");
    const folderPath = `nisan-yuklemeleri/${sanitizedName}_${safeSessionId}`;

    // not.txt dosyasını oluşturup depoya yaz
    const noteContent = `GÖNDEREN: ${name || "İsimsiz"}\nTEBRİK NOTU:\n${note || "Mesaj bırakılmadı."}\n\nYÜKLEME TARİHİ: ${new Date().toLocaleString("tr-TR")}`;

    const noteCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `${folderPath}/not.txt`,
      Body: noteContent,
      ContentType: "text/plain; charset=utf-8",
    });

    await s3.send(noteCommand);

    const uploadData = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const extension = file.name.split(".").pop();
      const fileName = `${folderPath}/dosya_${i + 1}.${extension}`;

      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
      });

      // Büyük dosyalar için link 3 saat geçerli kalır
      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 10800 });

      uploadData.push({
        fileName,
        uploadUrl,
      });
    }

    res.json({ success: true, uploadData, folderPath });
  } catch (error) {
    console.error("R2 İzin Hatası:", error);
    res.status(500).json({ error: "Yükleme izni oluşturulamadı: " + error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda aktif.`);
});