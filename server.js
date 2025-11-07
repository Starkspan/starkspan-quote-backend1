import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json());

// Speicher für Uploads (im RAM)
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.get("/", (req, res) => {
  res.send("✅ StarkSpan Backend läuft jetzt");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "starkspan-backend" });
});

app.post("/api/quote", upload.single("file"), (req, res) => {
  try {
    const fileName = req.file ? req.file.originalname : null;
    const { material, weightKg, machineTimeH, quantity } = req.body;

    // Beispielberechnung (nur Demo-Werte)
    const m = parseFloat(material || 7);        // €/kg
    const w = parseFloat(weightKg || 2);        // kg
    const t = parseFloat(machineTimeH || 0.5);  // Stunden
    const q = parseInt(quantity || 1);

    const materialPrice = m * w;
    const machining = t * 60; // 60€/h angenommen
    const total = (materialPrice + machining) * q;

    res.json({
      receivedFile: fileName,
      materialPrice,
      machining,
      total
    });

  } catch (err) {
    console.error("API ERROR:", err);
    res.status(500).json({ error: "processing error" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log("✅ StarkSpan Backend live on port " + port));
