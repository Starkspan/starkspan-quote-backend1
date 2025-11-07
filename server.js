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

/* ---------- CORS: erlaubt alles + Preflight ---------- */
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.options("*", cors());

/* ---------- JSON Parser ---------- */
app.use(express.json());

/* ---------- Konstanten ---------- */
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

/* ---------- Upload: /tmp (Render-kompatibel) ---------- */
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const ok =
      /pdf$/i.test(file.mimetype) ||
      /^image\/(png|jpe?g)$/i.test(file.mimetype) ||
      /\.pdf$/i.test(file.originalname) ||
      /\.(png|jpe?g)$/i.test(file.originalname);
    cb(ok ? null : new Error("Unsupported file type"), ok);
  },
});

/* ---------- Helpers ---------- */
const toNum = (s) => (s == null ? null : Number(String(s).replace(",", ".")));
const round2 = (x) => Math.round(x * 100) / 100;

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

/* ---------- PDF → PNG (erste Seite) ---------- */
async function pdfToPng(pdfPath) {
  const outBase = path.join(os.tmpdir(), `page_ocr_${Date.now()}`);
  const outPng = `${outBase}.png`;
  return new Promise((resolve, reject) => {
    execFile(
      "pdftoppm",
      ["-png", "-singlefile", "-scale-to", "2000", pdfPath, outBase],
      (err) => (err ? reject(err) : resolve(outPng))
    );
  });
}

/* ---------- OCR (Tesseract) ---------- */
async function ocrPng(pngPath) {
  const worker = await createWorker({ logger: () => {} });
  try {
    await worker.loadLanguage("eng");
    await worker.initialize("eng");
    await worker.setParameters({
      // mm/Ø/x/× etc.
      tessedit_char_whitelist: "0123456789.,xX×ØømM ",
      preserve_interword_spaces: "1",
    });
    const { data } = await worker.recognize(pngPath);
    return data?.text || "";
  } finally {
    await worker.terminate();
  }
}

/* ---------- Maße aus OCR-Text abgreifen ---------- */
function extractDimsFromText(txt) {
  if (!txt) return null;
  const t = txt.replace(/\s+/g, " ").toLowerCase();

  // ØD x L   (z.B. Ø20 x 100)
  const reDiaLen = /[øØ]\s*([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*mm?/i;
  const md = t.match(reDiaLen);
  if (md) {
    return { shape: "cylinder", D_mm: toNum(md[1]), L_mm: toNum(md[2]), B_mm: null, H_mm: null, source: "ocr" };
  }

  // L x B x H
  const reLxBxH = /([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?)\s*mm?/i;
  const m3 = t.match(reLxBxH);
  if (m3) {
    return { shape: "block", L_mm: toNum(m3[1]), B_mm: toNum(m3[2]), H_mm: toNum(m3[3]), D_mm: null, source: "ocr" };
  }

  // L x B
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

/* ---------- Routes ---------- */
app.get("/", (req, res) => {
  res.type("text").send("StarkSpan Backend Running");
});

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
  let pngPath;
  try {
    const file = req.file;
    const userMaterial = req.body.material;
    const quantity = Number(req.body.quantity || 1);
    const machineTimeH = Number(String(req.body.machineTimeH || "0.5").replace(",", "."));

    if (!file) return res.status(400).json({ error: "no file uploaded" });

    const materialKey = pickMaterialKey(userMaterial);

    // 1) OCR vorbereiten
    let textForParsing = "";
    if (file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname || "")) {
      try {
        pngPath = await pdfToPng(file.path);
      } catch (e) {
        // pdftoppm fehlt -> klarer Fehlertext
        throw new Error("pdftoppm not available (install via apt.txt: poppler-utils).");
      }
      textForParsing = await ocrPng(pngPath);
    } else {
      textForParsing = await ocrPng(file.path);
    }

    // 2) Maße parsen
    const dims = extractDimsFromText(textForParsing);
    const needsManual = !dims;

    // 3) Volumen / Gewicht
    const { volume_cm3, weightKg, geometry } = computeVolumeAndWeight(dims, materialKey);

    // 4) Preise
    const pKg = pricePerKg[materialKey] ?? 7.0;
    const materialPrice = weightKg != null ? round2(weightKg * pKg) : null;

    // 5) Bearbeitung (0.5h -> 30€)
    const machining = round2((machineTimeH || 0) * 60);

    const totalPerPiece = (materialPrice ?? 0) + (machining ?? 0);
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
    });
  } catch (err) {
    console.error("API ERROR:", err);
    res.status(500).json({
      error: "OCR/Parse failed",
      detail: String(err?.message || err),
    });
  } finally {
    // Cleanup
    try { if (pngPath) await fs.unlink(pngPath); } catch {}
    try { if (req.file?.path) await fs.unlink(req.file.path); } catch {}
  }
});

/* ---------- Start ---------- */
const port = process.env.PORT || 3001;
app.listen(port, () => console.log("StarkSpan Backend live port " + port));
