import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("StarkSpan Backend Running");
});

// Beispiel Price API (wir erweitern danach um deine CNC Regeln)
app.post("/api/quote", (req, res) => {
  const { material, weightKg, machineTimeH, quantity } = req.body;

  // tiny example calc: (nur placeholder jetzt)
  const materialPrice = material * weightKg;
  const machining = machineTimeH * 60;
  const total = (materialPrice + machining) * quantity;

  res.json({ materialPrice, machining, total });
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log("StarkSpan Backend live port " + port));
