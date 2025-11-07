// server.js  (vollständig)

import express from "express";
import cors from "cors";
import multer from "multer";
import { createRequire } from "module";
import { execFile } from "child_process";
import path from "path";
import fs from "fs/promises";
import os from "os";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { createWorker } = require("tesseract.js");

const app = express();
app.use(cors());
app.use(express.json());

// ------- Preis-/Dichte-Tabellen -------
const pricePerKg = {
  aluminium: 7.0,
  edelstahl: 7.5,
  stahl: 2.0,
  c45: 2.0,
  st37: 1.5,
  st52: 1.5,
  messing: 8.5,
  kupfer: 10.0,
};

const densities = {
  aluminium: 2.70,
  edelstahl: 7.90,
  stahl: 7.85,
  c45: 7.85,
  st37: 7.85,
  st52: 7.85,
  messing: 8.50,
  kupfer: 8.96,
};

// Uploads ins temp (Render kompatibel)
const upload = multer({ dest: os.tmpdir() });

// ------- Utils -------
const toNum = (s) => (s == null ? null : Number(String(s).replace(",", ".")));
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

function pickMaterialKey(raw) {
  if (!raw) return "aluminium";
  const m = String(raw).toLowerCase();
  if (m.includes("edel")) return "edelstahl";
  if (m.includes("c45")) return "c45";
  if (m.includes("st37")) return "st37";
  if (m.includes("st52")) return "st52";
  if (m.includes("mess")) return "messing";
  if (m.includes("kupf")) return "kupfer";
  if (m.includes("stahl")) return "stahl";
  return "aluminium";
}

// PDF -> PNG (erste Seite) mit 300dpi
async function pdfToPng(pdfPath) {
  const outBase = path.join(os.tmpdir(), "page_ocr");
  const outPng = `${outBase}.png`;
  await new Promise((resolve, reject) => {
    execFile("pdftoppm", ["-png", "-singlefile", "-r", "300", pdfPath, outBase], (err) =>
      err ? reject(err) : resolve()
    );
  });
  return outPng;
}

// Vorverarbeitung (deutlich bessere OCR-Qualität)
async function preprocess(imgPath) {
  const out = path.join(os.tmpdir(), `prep_${Date.now()}.png`);
  // 2000 px Breite, Graustufen, Normalisieren, leichte Binarisierung
  await sharp(imgPath)
    .resize({ width: 2000, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .linear(1.2, -10) // Kontrast leicht anheben
    .threshold(160)   // binarisieren
    .toFile(out);
  return out;
}

// Tesseract OCR
async function ocrImage(imgPath) {
  const worker = await createWorker({ logger: () => {} }); // ruhig
  try {
    await worker.loadLanguage("eng");
    await worker.initialize("eng");
    // starke Hinweise: PSM 6 (einzelner Block), 300 dpi
    await worker.setParameters({
      tessedit_pageseg_mode: "6",
      user_defined_dpi: "300",
      tessedit_char_whitelist: "0123456789.,xX×ØømM ",
      preserve_interword_spaces: "1",
    });
    const { data } = await worker.recognize(imgPath);
    return data?.text || "";
  } finally {
    await worker.terminate();
  }
}

// Maße aus Text herausziehen
function extractDimsFromText(txt) {
  const t = String(txt).replace(/\s+/g, " ").toLowerCase();

  // ØD x L  (z.B. Ø20 x 100 mm)
  const reDiaLen = /[øØ]\s*([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*mm?/i;
  const md = t.match(reDiaLen);
  if (md) {
    return { shape: "cylinder", D_mm: toNum(md[1]), L_mm: toNum(md[2]), B_mm: null, H_mm: null, source: "ocr" };
  }

  // L x B x H  (100x50x10)
  const reLxBxH = /([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*mm?/i;
  const m3 = t.match(reLxBxH);
  if (m3) {
    return { shape: "block", L_mm: toNum(m3[1]), B_mm: toNum(m3[2]), H_mm: toNum(m3[3]), D_mm: null, source: "ocr" };
  }

  // L x B  (Platte, Höhe fehlt)
  const reLxB = /([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*mm?/i;
  const m2 = t.match(reLxB);
  if (m2) {
    return { shape: "plate", L_mm: toNum(m2[1]), B_mm: toNum(m2[2]), H_mm: null, D_mm: null, source: "ocr" };
  }
  return null;
}

function computeVolumeAndWeight(dim, materialKey) {
  if (!dim) return { volume_cm3: null, weightKg: null, geometry: "unknown" };

  let volume_mm3 = null;
  let geometry = "unknown";

  if (dim.shape === "cylinder" && dim.D_mm && dim.L_mm) {
    const r = dim.D_mm / 2;
    volume_mm3 = Math.PI * r * r * dim.L_mm;
    geometry = "cylinder";
  } else if ((dim.shape === "block" || dim.shape === "plate") && dim.L_mm && dim.B_mm && dim.H_mm) {
    volume_mm3 = dim.L_mm * dim.B_mm * dim.H_mm;
    geometry = "block";
  }

  if (!volume_mm3 || !isFinite(volume_mm3)) {
    return { volume_cm3: null, weightKg: null, geometry: "unknown" };
  }

  const volume_cm3 = volume_mm3 / 1000.0; // mm³ -> cm³
  const rho = densities[materialKey] ?? 2.7; // g/cm³
  const weight_g = volume_cm3 * rho;
  const weightKg = weight_g / 1000.0;

  return { volume_cm3: round2(volume_cm3), weightKg: round2(weightKg), geometry };
}

// ---------- ROUTES ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "starkspan-backend", ocr: "tesseract+pdftoppm+sharp" });
});

/**
 * POST /api/quote
 * form-data: file, material?, quantity?, machineTimeH?
 */
app.post("/api/quote", upload.single("file"), async (req, res) => {
  let tmpToCleanup = [];
  try {
    const file = req.file;
    const userMaterial = req.body.material;
    const quantity = Number(req.body.quantity || 1);
    const machineTimeH = Number(String(req.body.machineTimeH || "0.5").replace(",", "."));

    if (!file) return res.status(400).json({ error: "no file uploaded" });

    const materialKey = pickMaterialKey(userMaterial);
    let text = "";
    let workImg = null;

    // 1) Eingabe in OCR-Bild verwandeln
    if (file.mimetype === "application/pdf" || file.originalname?.toLowerCase().endsWith(".pdf")) {
      const png = await pdfToPng(file.path);
      tmpToCleanup.push(png);
      workImg = await preprocess(png);
      tmpToCleanup.push(workImg);
    } else {
      // PNG/JPG direkt
      workImg = await preprocess(file.path);
      tmpToCleanup.push(workImg);
    }

    // 2) OCR
    text = await ocrImage(workImg);
    const ocrSample = text.trim().slice(0, 240); // Debug im Response

    // 3) Maße fischen
    const dims = extractDimsFromText(text);
    const needsManual = !dims;

    // 4) Volumen & Gewicht
    const { volume_cm3, weightKg, geometry } = computeVolumeAndWeight(dims, materialKey);

    // 5) Preise
    const pKg = pricePerKg[materialKey] ?? 7.0;
    const materialPrice = weightKg != null ? round2(weightKg * pKg) : null;
    const machining = round2((machineTimeH || 0) * 60); // 30 €/0.5h
    const totalPerPiece =
      (materialPrice != null ? materialPrice : 0) + (machining != null ? machining : 0);
    const totalAll = round2(totalPerPiece * (quantity || 1));

    res.json({
      receivedFile: file.originalname,
      material: materialKey,
      quantity,
      geometry,
      geometrySource: dims?.source || "ocr",
      dims: dims || { D_mm: null, L_mm: null, B_mm: null, H_mm: null },
      volume_cm3,
      weightKg,
      pricePerKg: pKg,
      materialPrice,
      machining,
      totalPerPiece,
      totalAll,
      needsManual,
      ocrSample, // <-- zum Debuggen
    });
  } catch (err) {
    console.error("API ERROR:", err);
    res.status(500).json({ error: "OCR/Parse failed", detail: String(err?.message || err) });
  } finally {
    // Cleanup
    for (const f of tmpToCleanup) {
      try {
        await fs.unlink(f);
      } catch {}
    }
    try {
      if (req.file?.path) await fs.unlink(req.file.path);
    } catch {}
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log("StarkSpan Backend live port " + port));
