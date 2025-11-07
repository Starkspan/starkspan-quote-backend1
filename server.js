import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer(); // für file uploads

// health check root
app.get("/", (req, res) => {
  res.send("StarkSpan Backend Running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "starkspan-backend" });
});

// --- FILE ROUTE (PDF / STEP später OCR etc.)
app.post("/api/quote", upload.single("file"), async (req, res) => {
  try {
    console.log("FILE RECEIVED:", req.file?.originalname);

    if (!req.file) {
      return res.status(400).json({ error: "No file received" });
    }

    return res.json({
      status: "ok",
      message: "file received",
      fileName: req.file.originalname,
      size: req.file.size
    });

  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({ error: "server error" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log("StarkSpan Backend live port " + port));
