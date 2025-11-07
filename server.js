// server.js
// StarkSpan Quote Backend – 2 Formen Auto-Geometrie (Zylinder + Quader)

import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Upload ----------
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Material-Daten ----------
const MATERIALS = {
  "Aluminium": { pricePerKg: 7, density_g_cm3: 2.70 },
  "Aluminium T6": { pricePerKg: 13, density_g_cm3: 2.70 },
  "Kupfer": { pricePerKg: 15, density_g_cm3: 8.96 },
  "Edelstahl": { pricePerKg: 7.5, density_g_cm3: 7.90 },
  "C45 Stahl": { pricePerKg: 2, density_g_cm3: 7.85 },
  "St37/St52": { pricePerKg: 1.5, density_g_cm3: 7.85 },
};

// ---------- Utility ----------
const mm3_to_cm3 = (v_mm3) => v_mm3 / 1000; // 1 cm³ = 1000 mm³
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Versucht aus einem Dateinamen (oder Zeichnungstitel) eine Geometrie
 * und Maße zu erkennen.
 * Unterstützte Patterns:
 * - Zylinder: "Ø20x100", "D20x100", "dia20x100", "20x100" mit "Ø" in der Nähe
 * - Quader:   "100x50x10", "100×50×10", "L100xB50xH10" etc.
 * Einheiten werden als mm interpretiert.
 */
function parseGeometryFromName(name) {
  const safe = (name || "").replace(/,/g, ".").replace(/\s+/g, "");
  // --- Zylinder: Ø/D/dia + DxL ---
  const cyl1 = safe.match(/(?:Ø|D|Dia|DIA|dia)(\d+(\.\d+)?)[xX](\d+(\.\d+)?)/);
  if (cyl1) {
    const d = parseFloat(cyl1[1]);
    const L = parseFloat(cyl1[3]);
    return { geometry: "cylinder", D_mm: d, L_mm: L, source: "filename-cyl" };
  }
  // Manche schreiben "20x100" und irgendwo vorher ein "Ø"
  const nearDia = safe.includes("Ø") || /(?:\bdia|\bD)/i.test(safe);
  const cyl2 = safe.match(/(\d+(\.\d+)?)[xX](\d+(\.\d+)?)/);
  if (nearDia && cyl2) {
    const d = parseFloat(cyl2[1]);
    const L = parseFloat(cyl2[3]);
    return { geometry: "cylinder", D_mm: d, L_mm: L, source: "filename-cyl-loose" };
  }
  // --- Quader: LxBxH / 100x50x10 / 100×50×10 ---
  const quad = safe.match(/(\d+(\.\d+)?)[xX×](\d+(\.\d+)?)[xX×](\d+(\.\d+)?)/);
  if (quad) {
    const L = parseFloat(quad[1]);
    const B = parseFloat(quad[3]);
    const H = parseFloat(quad[5]);
    return { geometry: "block", L_mm: L, B_mm: B, H_mm: H, source: "filename-block" };
  }
  return { geometry: "unknown" };
}

/**
 * Volumen & Gewicht berechnen.
 * Nur 2 Formen (Zylinder + Quader).
 * Rückgabe: { volume_cm3, weightKg }
 */
function calcWeight(geom, materialKey) {
  const mat = MATERIALS[materialKey];
  if (!mat) return { volume_cm3: null, weightKg: null };

  if (geom.geometry === "cylinder" && geom.D_mm > 0 && geom.L_mm > 0) {
    const r = geom.D_mm / 2.0;
    const volume_mm3 = Math.PI * r * r * geom.L_mm; // π r² L
    const volume_cm3 = mm3_to_cm3(volume_mm3);
    const weightKg = (volume_cm3 * mat.density_g_cm3) / 1000.0;
    return { volume_cm3, weightKg };
  }

  if (geom.geometry === "block" && geom.L_mm > 0 && geom.B_mm > 0 && geom.H_mm > 0) {
    const volume_mm3 = geom.L_mm * geom.B_mm * geom.H_mm;
    const volume_cm3 = mm3_to_cm3(volume_mm3);
    const weightKg = (volume_cm3 * mat.density_g_cm3) / 1000.0;
    return { volume_cm3, weightKg };
  }

  return { volume_cm3: null, weightKg: null };
}

// ---------- Health ----------
app.get("/", (_, res) => res.send("StarkSpan Backend Running"));
app.get("/health", (_, res) => res.json({ status: "ok", service: "starkspan-backend" }));

// ---------- Haupt-API ----------
app.post("/api/quote", upload.single("file"), async (req, res) => {
  try {
    const filename = req.file?.originalname || "unbekannt";
    const material = req.body.material || "Aluminium";
    const quantity = parseInt(req.body.quantity || "1", 10);
    const machineTimeH = parseFloat((req.body.machineTimeH || "0").toString().replace(",", "."));

    const geom = parseGeometryFromName(filename);
    const { volume_cm3, weightKg } = calcWeight(geom, material);

    // Materialpreis pro Stück
    const pricePerKg = MATERIALS[material]?.pricePerKg ?? 7;
    const materialPrice = weightKg ? round2(weightKg * pricePerKg) : null;

    // einfache Maschine: 60 €/h wie im letzten Beispiel (0,5h -> 30€)
    const machiningRatePerHour = 60;
    const machining = round2(machineTimeH * machiningRatePerHour);

    const totalPerPiece =
      materialPrice != null ? round2(materialPrice + machining) : round2(machining);

    res.json({
      receivedFile: filename,
      geometry: geom.geometry,
      geometrySource: geom.source || null,
      // erkannte Maße (mm)
      dims: {
        D_mm: geom.D_mm ?? null,
        L_mm: geom.L_mm ?? null,
        B_mm: geom.B_mm ?? null,
        H_mm: geom.H_mm ?? null,
      },
      // Physik
      volume_cm3: volume_cm3 != null ? round2(volume_cm3) : null,
      weightKg: weightKg != null ? round2(weightKg) : null,

      // Preise (pro Stück)
      material: material,
      pricePerKg,
      materialPrice,     // € / Stück
      machining,         // € / Stück
      totalPerPiece,     // € / Stück

      // Gesamt (Menge)
      quantity,
      totalAll: round2(totalPerPiece * quantity),

      // Hinweise
      needsManual: geom.geometry === "unknown" || weightKg == null,
    });
  } catch (err) {
    console.error("API ERROR:", err);
    res.status(400).json({ error: "ERR_BAD_REQUEST" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log("StarkSpan Backend live port " + port));
