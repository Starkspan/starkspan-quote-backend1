import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "starkspan-backend" });
});

// ---- MATERIAL PREISE / KG ----
const materialPriceKg = {
  "Aluminium": 7,
  "Aluminium T6": 13,
  "Edelstahl": 7.5,
  "Stahl C45": 2,
  "Stahl St37": 1.5,
  "Stahl St52": 1.5,
  "Messing": 8.5,
  "Kupfer": 10,
};

// Maschinenpreis pro Stunde (DEMO)
const MACHINING_RATE_EUR_H = 60;

app.post("/quote", upload.single("file"), async (req, res) => {
  try {
    const { material, quantity, machineTimeH } = req.body;

    const qty = Number(quantity) || 1;
    const timeH = Number(machineTimeH) || 0.5; // fallback 0.5h
    const weightKg = Number(req.body.weightKg) || 0;

    const pricePerKg = materialPriceKg[material] ?? 0;
    let materialPrice = (weightKg > 0 && pricePerKg > 0) ? pricePerKg * weightKg : 14;

    const machining = timeH * MACHINING_RATE_EUR_H;
    const subtotal = (materialPrice + machining) * qty;
    const total = Math.round(subtotal * 100) / 100;

    res.json({
      receivedFile: req.file?.originalname ?? null,
      material,
      quantity: qty,
      machineTimeH: timeH,
      weightKg: weightKg || null,
      pricePerKg: pricePerKg,
      materialPrice,
      machining,
      total,
    });

  } catch (err) {
    console.error("Quote error:", err);
    res.status(500).json({ error: "internal-error" });
  }
});

app.get("/", (req, res) => {
  res.send("StarkSpan Backend Running");
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log("StarkSpan Backend live port " + port);
});
