import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json());

// Multer Storage (in Memory – ideal für OCR später)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// root test
app.get("/", (req, res) => {
  res.send("StarkSpan Backend Running");
});

// health check für Render
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "starkspan-backend" });
});

// Beispiel Price API + File Upload
app.post("/api/quote", upload.single("file"), (req, res) => {
  try {
    // file kommt als Buffer => später OCR / PDF Analyse drauf
    const pdfBuffer = req.file ? req.file.buffer : null;

    const { material, weightKg, machineTimeH, quantity } = req.body;

    // tiny calc placeholder
    const materialPrice = material * weightKg;
    const machining = machineTimeH * 60;
    const total = (materialPrice + machining) * quantity;

    res.json({
      receivedFile: req.file ? req.file.originalname : null,
      materialPrice,
      machining,
      total,
    });

  } catch (err) {
    console.error("API ERROR:", err);
    res.status(500).json({ error: "processing error" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log("StarkSpan Backend live port " + port));
