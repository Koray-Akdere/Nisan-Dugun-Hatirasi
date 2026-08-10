import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use(express.static(__dirname));

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME;

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 1. FOTOĞRAFLAR & KÜÇÜK DOSYALAR İÇİN İZİN VE NOT KAYDI
app.post("/get-presigned-urls", async (req, res) => {
  try {
    const { name, note, files } = req.body;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "Dosya seçilmedi." });
    }

    const sanitizedName = (name || "Anonim").replace(/[^a-zA-Z0-9_]/g, "_");
    const timestamp = Date.now();
    const folderPath = `nisan-yuklemeleri/${sanitizedName}_${timestamp}`;

    const noteContent = `GÖNDEREN: ${name || "Anonim"}\nTEBRİK MESAJI:\n${note || "Mesaj bırakılmadı."}\n\nYÜKLEME TARİHİ: ${new Date().toLocaleString("tr-TR")}`;

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
        ContentType: file.type,
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 7200 });

      uploadData.push({
        fileName,
        uploadUrl,
      });
    }

    res.json({ success: true, uploadData, folderPath });
  } catch (error) {
    console.error("R2 İşlem Hatası:", error);
    res.status(500).json({ error: "Yükleme izni alınamadı." });
  }
});

// 2. VİDEOLAR İÇİN S3 MULTIPART UPLOAD ENDPOINT'LERİ
app.post("/api/multipart/initiate", async (req, res) => {
  try {
    const { folderPath, fileName, fileType } = req.body;
    const key = `${folderPath}/${fileName}`;

    const command = new CreateMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: fileType || "video/mp4",
    });

    const response = await s3.send(command);
    res.json({ success: true, uploadId: response.UploadId, key });
  } catch (error) {
    console.error("Multipart Başlatma Hatası:", error);
    res.status(500).json({ error: "Yükleme başlatılamadı." });
  }
});

app.post("/api/multipart/get-part-url", async (req, res) => {
  try {
    const { key, uploadId, partNumber } = req.body;

    const command = new UploadPartCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json({ success: true, url });
  } catch (error) {
    console.error("Parça URL Hatası:", error);
    res.status(500).json({ error: "Parça adresi alınamadı." });
  }
});

app.post("/api/multipart/complete", async (req, res) => {
  try {
    const { key, uploadId, parts } = req.body;

    const command = new CompleteMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    });

    await s3.send(command);
    res.json({ success: true, message: "Dosya birleştirildi." });
  } catch (error) {
    console.error("Birleştirme Hatası:", error);
    res.status(500).json({ error: "Dosya birleştirilemedi." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend sunucusu ${PORT} portunda yayında.`);
});
