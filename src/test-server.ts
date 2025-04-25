import express from "express";
const app = express();
app.get("/", (req, res) => res.send("TEST OK"));
app.listen(3000, () => console.log("✅ Minimal server running"));
