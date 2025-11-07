import express from "express";
import cors from "cors";
import multer from "multer";
import { createRequire } from "module";
import { execFile } from "child_process";
import path from "path";
import fs from "fs/promises";
import os from "os";
const require = createRequire(import.meta.url);
const { createWorker } = require("tesseract.js");

const app = express();
app.use(cors());
app.use(express.json());

// ====== Konfiguration ======
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
  aluminium: 2.70, // g/cm³
  edelstahl: 7.90,
  stahl: 7.85,
  c45: 7.85,
  st37: 7.85,
  st52: 7.85,
  messing: 8.50,
  kupfer: 8.96,
};

// Multer speichert Uploads in /tmp (Render kompatibel)
const upload = multer({ dest: os.tmpdir() });

// ====== Helfer ======
function toNum(s) {
  if (!s) return null;
  // 12,5 oder 12.5 -> 12.5
  return Number(String(s).replace(",", "."));
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function pickMaterialKey(raw) {
  if (!raw) return "aluminium";
  const m = raw.toLowerCase();
  if (m.includes("edel")) return "edelstahl";
  if (m.includes("c45")) return "c45";
  if (m.includes("st37")) return "st37";
  if (m.includes("st52")) return "st52";
  if (m.includes("mess")) return "messing";
  if (m.includes("kupf")) return "kupfer";
  if (m.includes("stahl")) return "stahl";
  return "aluminium";
}

// PD F→PNG via poppler-utils (pdftoppm)
async function pdfToPng(pdfPath) {
  const outBase = path.join(os.tmpdir(), "page_ocr");
  const outPng = `${outBase}.png`;

  return new Promise((resolve, reject) => {
    // -singlefile -> nur erste Seite
    execFile(
      "pdftoppm",
      ["-png", "-singlefile", "-scale-to", "2000", pdfPath, outBase],
      (err) => {
        if (err) return reject(err);
        resolve(outPng);
      }
    );
  });
}

// OCR auf PNG mit tesseract.js
async function ocrPng(pngPath) {
  const worker = await createWorker({
    logger: () => {}, // stille
  });
  try {
    await worker.loadLanguage("eng");
    await worker.initialize("eng");
    // leichte Hinting: Maße, mm, Ø, x / ×
    await worker.setParameters({
      tessedit_char_whitelist:
        "0123456789.,xX×ØømM ",
      preserve_interword_spaces: "1",
    });
    const { data } = await worker.recognize(pngPath);
    return data?.text || "";
  } finally {
    await worker.terminate();
  }
}

// Maße aus Text fischen
function extractDimsFromText(txt) {
  // Klassiker:
  // 100x50x10 mm  |  100 x 50 x 10mm | Ø20 x 100 | Ø20x100mm
  const t = txt.replace(/\s+/g, " ").toLowerCase();

  // Ø / Durchmesser?
  const reDiaLen =
    /[øØ]\s*([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*mm?/i;
  const md = t.match(reDiaLen);
  if (md) {
    return {
      shape: "cylinder",
      D_mm: toNum(md[1]),
      L_mm: toNum(md[2]),
      B_mm: null,
      H_mm: null,
      source: "ocr",
    };
  }

  // LxBxH
  const reLxBxH =
    /([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*mm?/i;
  const m3 = t.match(reLxBxH);
  if (m3) {
    return {
      shape: "block",
      L_mm: toNum(m3[1]),
      B_mm: toNum(m3[2]),
      H_mm: toNum(m3[3]),
      D_mm: null,
      source: "ocr",
    };
  }

  // LxB
  const reLxB =
    /([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*mm?/i;
  const m2 = t.match(reLxB);
  if (m2) {
    return {
      shape: "plate",
      L_mm: toNum(m2[1]),
      B_mm: toNum(m2[2]),
      H_mm: null,
      D_mm: null,
      source: "ocr",
    };
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
  } else if (
    (dim.shape === "block" || dim.shape === "plate") &&
    dim.L_mm &&
    dim.B_mm &&
    dim.H_mm
  ) {
    volume_mm3 = dim.L_mm * dim.B_mm * dim.H_mm;
    geometry = "block";
  }

  if (!volume_mm3 || !isFinite(volume_mm3)) {
    return { volume_cm3: null, weightKg: null, geometry: "unknown" };
  }

  // mm³ -> cm³
  const volume_cm3 = volume_mm3 / 1000.0;
  const rho = densities[materialKey] ?? 2.7; // g/cm³
  const weight_g = volume_cm3 * rho;
  const weightKg = weight_g / 1000.0;

  return {
    volume_cm3: round2(volume_cm3),
    weightKg: round2(weightKg),
    geometry,
  };
}

// ====== ROUTES ======
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "starkspan-backend", ocr: "tesseract+pdftoppm" });
});

/**
 * POST /api/quote
 * Form-Data:
 *  - file: PDF/PNG/JPG
 *  - material (optional)
 *  - quantity (optional, default 1)
 *  - machineTimeH (optional, default 0.5)
 */
app.post("/api/quote", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const userMaterial = req.body.material;
    const quantity = Number(req.body.quantity || 1);
    const machineTimeH = Number(String(req.body.machineTimeH || "0.5").replace(",", "."));

    if (!file) {
      return res.status(400).json({ error: "no file uploaded" });
    }

    const materialKey = pickMaterialKey(userMaterial);
    let textForParsing = "";
    let dims = null;
    let pngPath = null;

    // 1) Wenn PDF → konvertieren, sonst (PNG/JPG) direkt OCR
    if (file.mimetype === "application/pdf" || file.originalname?.toLowerCase().endsWith(".pdf")) {
      pngPath = await pdfToPng(file.path);
      textForParsing = await ocrPng(pngPath);
    } else {
      // Bild direkt
      textForParsing = await ocrPng(file.path);
    }

    // 2) Maße fischen
    dims = extractDimsFromText(textForParsing);

    // 3) wenn OCR nichts gefunden hat → Hinweis
    let needsManual = false;
    if (!dims) needsManual = true;

    // 4) Volumen / Gewicht
    const { volume_cm3, weightKg, geometry } = computeVolumeAndWeight(dims, materialKey);

    // 5) Materialkosten
    const pKg = pricePerKg[materialKey] ?? 7.0;
    const materialPrice = weightKg != null ? round2(weightKg * pKg) : null;

    // 6) Bearbeitung (einfacher Ansatz aus deinem Prototyp: 30 €/h)
    const machining = round2((machineTimeH || 0) * 60); // z.B. 0.5h -> 30 €

    const totalPerPiece =
      (materialPrice != null ? materialPrice : 0) + (machining != null ? machining : 0);
    const totalAll = round2(totalPerPiece * (quantity || 1));

    res.json({
      receivedFile: file.originalname,
      material: materialKey,
      quantity,
      geometry,
      geometrySource: dims?.source || "ocr",
      dims: dims || {
        D_mm: null,
        L_mm: null,
        B_mm: null,
        H_mm: null,
      },
      volume_cm3,
      weightKg,
      pricePerKg: pKg,
      materialPrice,
      machining,
      totalPerPiece,
      totalAll,
      needsManual,
    });

    // Cleanup
    try {
      if (pngPath) await fs.unlink(pngPath);
      await fs.unlink(file.path);
    } catch (_) {}

  } catch (err) {
    console.error("API ERROR:", err);
    res.status(500).json({ error: "OCR/Parse failed", detail: String(err && err.message || err) });
  }
});

// ====== Start ======
const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log("StarkSpan Backend live port " + port);
});
