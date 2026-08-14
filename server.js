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

// Önbellek engelleme başlıkları
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use(express.static(__dirname));

// R2 S3 Client Yapılandırması
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

// 1. İzin Alma ve not.txt Kaydı
app.post("/get-presigned-urls", async (req, res) => {
  try {
    const { name, note, files } = req.body;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "Dosya seçilmedi." });
    }

    const sanitizedName = (name || "Misafir")
      .trim()
      .replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_]/g, "_");
    const timestamp = Date.now();
    const folderPath = `nisan-yuklemeleri/${sanitizedName}_${timestamp}`;

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

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 7200 });

      uploadData.push({
        fileName,
        uploadUrl,
      });
    }

    res.json({ success: true, uploadData, folderPath });
  } catch (error) {
    console.error("R2 İzin Hatası:", error);
    res
      .status(500)
      .json({ error: "Yükleme izni oluşturulamadı: " + error.message });
  }
});

// 2. Parçalı Yükleme Başlatma
app.post("/api/multipart/initiate", async (req, res) => {
  try {
    const { folderPath, fileName, contentType } = req.body;
    if (!folderPath || !fileName) {
      return res.status(400).json({ error: "folderPath veya fileName eksik." });
    }

    const key = `${folderPath}/${fileName}`;

    const command = new CreateMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType || "application/octet-stream",
    });

    const response = await s3.send(command);
    console.log(
      `[MULTIPART BAŞLADI] Key: ${key} | UploadId: ${response.UploadId}`,
    );
    res.json({ success: true, uploadId: response.UploadId, key });
  } catch (error) {
    console.error("Multipart Başlatma Hatası:", error);
    res
      .status(500)
      .json({ error: `R2 Hatası: ${error.name} - ${error.message}` });
  }
});

// 3. Parça URL Üretme
app.post("/api/multipart/get-part-url", async (req, res) => {
  try {
    const { key, uploadId, partNumber } = req.body;

    const command = new UploadPartCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      PartNumber: Number(partNumber),
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json({ success: true, url });
  } catch (error) {
    console.error("Parça URL Hatası:", error);
    res.status(500).json({ error: `Parça URL üretilemedi: ${error.message}` });
  }
});

// 4. Parçaları Birleştirme
app.post("/api/multipart/complete", async (req, res) => {
  try {
    const { key, uploadId, parts } = req.body;

    if (!key || !uploadId || !parts || !Array.isArray(parts)) {
      return res.status(400).json({ error: "Eksik parametre." });
    }

    const formattedParts = parts
      .map((part) => {
        const rawEtag = String(part.ETag || "")
          .replace(/^"|"$/g, "")
          .trim();
        return {
          ETag: `"${rawEtag}"`,
          PartNumber: Number(part.PartNumber),
        };
      })
      .sort((a, b) => a.PartNumber - b.PartNumber);

    const command = new CompleteMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: formattedParts,
      },
    });

    await s3.send(command);
    console.log(`✅ [MULTIPART TAMAMLANDI]: ${key}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Complete Multipart Hatası:", error);
    res
      .status(500)
      .json({ error: `Parçalar birleştirilemedi: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda aktif.`);
});
