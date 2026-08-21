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
    const safeSessionId = (sessionId || Date.now().toString()).replace(
      /[^a-zA-Z0-9_-]/g,
      "",
    );
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
    res
      .status(500)
      .json({ error: "Yükleme izni oluşturulamadı: " + error.message });
  }
});

import { ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";

// Admin Şifresi (Ortam değişkeninden veya varsayılan)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "22Ağustos2026";

// 1. Admin Giriş Kontrolü
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({
      success: true,
      token: Buffer.from(password).toString("base64"),
    });
  }
  res.status(401).json({ error: "Geçersiz şifre." });
});

// 2. Tüm Yüklemeleri ve Notları Listeleme
app.get("/api/admin/uploads", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (
    !authHeader ||
    Buffer.from(authHeader.replace("Bearer ", ""), "base64").toString() !==
      ADMIN_PASSWORD
  ) {
    return res.status(401).json({ error: "Yetkisiz erişim." });
  }

  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: "nisan-yuklemeleri/",
    });

    const s3Response = await s3.send(listCommand);
    const contents = s3Response.Contents || [];

    // Klasörlere göre gruplama
    const folders = {};

    for (const item of contents) {
      const parts = item.Key.split("/");
      if (parts.length >= 3) {
        const folderName = parts[1];
        const fileName = parts.slice(2).join("/");

        if (!folders[folderName]) {
          folders[folderName] = {
            folder: folderName,
            note: "Yükleniyor...",
            files: [],
            lastModified: item.LastModified,
          };
        }

        if (fileName === "not.txt") {
          try {
            const noteObj = await s3.send(
              new GetObjectCommand({ Bucket: BUCKET_NAME, Key: item.Key }),
            );
            folders[folderName].note =
              await noteObj.Body.transformToString("utf-8");
          } catch (e) {
            folders[folderName].note = "Not okunamadı.";
          }
        } else {
          // İndirme / Görüntüleme için Presigned URL üret
          const fileUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET_NAME, Key: item.Key }),
            {
              expiresIn: 3600,
            },
          );
          folders[folderName].files.push({
            key: item.Key,
            name: fileName,
            url: fileUrl,
            size: item.Size,
          });
        }
      }
    }

    const result = Object.values(folders).sort(
      (a, b) => new Date(b.lastModified) - new Date(a.lastModified),
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Admin listeleme hatası:", error);
    res.status(500).json({ error: "Kayıtlar listelenemedi." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda aktif.`);
});
