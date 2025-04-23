const express = require('express');
const app = express();
app.use(express.json());
app.post('*', (req, res) => {
  console.log('Path:', req.path);
  res.json({ path: req.path });
});
app.listen(3999);
