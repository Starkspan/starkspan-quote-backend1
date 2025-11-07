import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();

// Basis
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer (Datei im RAM, reicht für Analyse/Weiterverarbeitung)
const upload = multer({ storage: multer.memoryStorage() });

/** Health */
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "starkspan-backend" });
});

// --------- Preis-Tabellen (vereinfachte Demo) ----------
const material€/kg = {
  "Aluminium": 7,
  "Aluminium T6": 13,
  "Edelstahl": 7.5,
  "Stahl C45": 2,
  "Stahl St37": 1.5,
  "Stahl St52": 1.5,
  "Messing": 8.5,
  "Kupfer": 10,
};

// Einfacher Maschinenstundensatz (Demo)
const MACHINING_RATE_EUR_H = 60; // später je Maschine/Kategorie

// --------- API: Quote ----------
app.post("/quote", upload.single("file"), async (req, res) => {
  try {
    const { material, quantity, machineTimeH } = req.body;

    const qty = Number(quantity) || 1;
    const timeH = Number(machineTimeH) || 0;

    // Platzhalter für Gewicht — später aus OCR/3D-Analyse
    // Wenn du weightKg im Frontend mitsendest, wird es hier benutzt.
    const weightKg = Number(req.body.weightKg) || 0;

    // Materialpreis je kg
    const pricePerKg = material€/kg[material] ?? 0;

    // Falls (noch) kein Gewicht vorliegt → nutze klare Demo-Werte,
    // damit das System stabil Preise liefert und du testen kannst.
    let materialPrice = 0;
    if (weightKg > 0 && pricePerKg > 0) {
      materialPrice = pricePerKg * weightKg;
    } else {
      // >>> Demo / Platzhalter (wie eben gesehen: 14 €)
      materialPrice = 14;
    }

    // Maschinenkosten (Zeit * Rate) – wenn keine Zeit kommt, Demo 0.5h → 30€
    let machining = 0;
    if (timeH > 0) {
      machining = timeH * MACHINING_RATE_EUR_H;
    } else {
      machining = 0.5 * MACHINING_RATE_EUR_H; // 30 €
    }

    const subtotal = (materialPrice + machining) * qty;

    // (Optional) Marge etc. kannst du hier addieren
    // const total = Math.round((subtotal * 1.25) * 100) / 100; // +25% Marge
    const total = Math.round(subtotal * 100) / 100;

    res.json({
      receivedFile: req.file?.originalname ?? null,
      material: material ?? null,
      quantity: qty,
      machineTimeH: timeH || 0.5,
      // wenn weightKg gesendet wurde, siehst du hier die echte Berechnung
      weightKg: weightKg || null,
      pricePerKg: pricePerKg || null,
      materialPrice,
      machining,
      total,
    });
  } catch (err) {
    console.error("Quote error:", err);
    res.status(500).json({ error: "internal-error" });
  }
});

// Root
app.get("/", (req, res) => {
  res.send("StarkSpan Backend Running");
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log("StarkSpan Backend live port " + port);
});
