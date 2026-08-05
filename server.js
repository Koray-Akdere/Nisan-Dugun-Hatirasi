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
app.use(express.json());

// 1. STATİK DOSYALARI SUNMA (index.html, kapak.jpeg vb. için)
app.use(express.static(__dirname));

// Cloudflare R2 Bağlantı İstemcisi
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME;

// Ana adrese girildiğinde index.html'i gönder
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Frontend'den gelen istek üzerine tek kullanımlık yükleme linki üreten endpoint
app.post("/get-presigned-urls", async (req, res) => {
  try {
    const { name, note, files } = req.body;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "Dosya seçilmedi." });
    }

    const sanitizedName = (name || "Anonim").replace(/[^a-zA-Z0-9_]/g, "_");
    const timestamp = Date.now();
    const folderPath = `nisan-yuklemeleri/${sanitizedName}_${timestamp}`;

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

    // folderPath bilgisini frontend'e geri gönderiyoruz
    res.json({ success: true, uploadData, folderPath });
  } catch (error) {
    console.error("R2 Link Üretme Hatası:", error);
    res.status(500).json({ error: "Yükleme izni alınamadı." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend sunucusu ${PORT} portunda yayında.`);
});
